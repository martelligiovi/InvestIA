import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GhuntSettings } from "../src/components/GhuntSettings";
import type { GhuntSettingsView } from "../src/api/client";

const disconnected: GhuntSettingsView = { available: true, state: "requires_connection", account: null };
const connected: GhuntSettingsView = { available: true, state: "connected", account: "test@example.test" };

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function installApi(initial: GhuntSettingsView = disconnected, reject = false) {
  let state = initial;
  const calls: { path: string; init?: RequestInit }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ path: String(input), init });
    if (init?.method === "POST") {
      if (reject) return json({ error: "GHUNT_INVALID_CODE", message: "Código inválido" }, 400);
      state = connected;
    }
    if (init?.method === "DELETE") state = disconnected;
    return json(state);
  }));
  return calls;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Google GHunt settings", () => {
  it.each<[GhuntSettingsView, RegExp]>([
    [connected, /conectado.*test@example.test/i],
    [disconnected, /requiere conexión/i],
    [{ available: true, state: "invalid_session", account: null }, /sesión inválida/i],
    [{ available: false, state: "requires_connection", account: null }, /GHunt no está instalado en esta instancia/i],
  ])("shows the session state", async (initial, label) => {
    const calls = installApi(initial);
    render(<GhuntSettings />);
    expect(await screen.findByText(label)).toBeInTheDocument();
    expect(calls.map((call) => [call.path, call.init?.method])).toEqual([["/settings/ghunt", undefined]]);
    expect(screen.queryByRole("button", { name: "Conectar Google" }) !== null).toBe(initial.available && initial.state !== "connected");
    expect(screen.queryByRole("button", { name: "Desconectar" }) !== null).toBe(initial.state !== "requires_connection");
  });

  it("connects with the code, clears it and disconnects", async () => {
    const calls = installApi();
    const user = userEvent.setup();
    render(<GhuntSettings />);
    const input = await screen.findByLabelText("Código de GHunt Companion");
    expect(input).toHaveAttribute("type", "password");
    expect(screen.getByRole("link", { name: "GHunt Companion" })).toHaveAttribute("href", "https://github.com/mxrch/ghunt_companion");
    await user.type(input, "secret-code");
    await user.click(screen.getByRole("button", { name: "Conectar Google" }));
    expect(await screen.findByText(/conectado.*test@example.test/i)).toBeInTheDocument();
    expect(input).toHaveValue("");
    expect(document.body).not.toHaveTextContent("secret-code");
    expect(calls[1]?.path).toBe("/settings/ghunt/session");
    expect(calls[1]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ code: "secret-code" });
    await user.click(screen.getByRole("button", { name: "Desconectar" }));
    await waitFor(() => expect(screen.getByText(/requiere conexión/i)).toBeInTheDocument());
    expect(calls[2]?.path).toBe("/settings/ghunt/session");
    expect(calls[2]?.init?.method).toBe("DELETE");
  });

  it("clears the code and disables submission while connecting", async () => {
    let resolve!: (response: Response) => void;
    const pending = new Promise<Response>((done) => { resolve = done; });
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => init?.method === "POST" ? pending : json(disconnected));
    vi.stubGlobal("fetch", fetcher);
    const user = userEvent.setup();
    render(<GhuntSettings />);
    const input = await screen.findByLabelText("Código de GHunt Companion");
    await user.type(input, "pending-secret");
    await user.click(screen.getByRole("button", { name: "Conectar Google" }));
    expect(input).toHaveValue("");
    expect(input).toBeDisabled();
    expect(screen.getByRole("button", { name: "Conectando…" })).toBeDisabled();
    expect(fetcher).toHaveBeenCalledTimes(2);
    resolve(json(connected));
    expect(await screen.findByText(/conectado.*test@example.test/i)).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("pending-secret");
  });

  it("clears rejected input, shows the backend message and retains the state", async () => {
    const calls = installApi(disconnected, true);
    const user = userEvent.setup();
    render(<GhuntSettings />);
    const input = await screen.findByLabelText("Código de GHunt Companion");
    await user.type(input, "bad-code");
    await user.click(screen.getByRole("button", { name: "Conectar Google" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Código inválido");
    expect(input).toHaveValue("");
    expect(screen.getByText(/requiere conexión/i)).toBeInTheDocument();
    expect(calls).toHaveLength(2);
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ code: "bad-code" });
    expect(document.body).not.toHaveTextContent("bad-code");
  });
});
