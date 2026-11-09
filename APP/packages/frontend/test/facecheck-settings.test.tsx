import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FacecheckSettings } from "../src/components/FacecheckSettings";
import type { FacecheckSettingsView } from "../src/api/client";

const empty: FacecheckSettingsView = { tokenConfigured: false, tokenHint: null, testingMode: true };

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function installApi(initial: FacecheckSettingsView = empty, reject = false) {
  let state = initial;
  const calls: { path: string; init?: RequestInit }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ path: String(input), init });
    if (init?.method === "PUT") {
      if (reject) return json({ error: "VALIDATION_ERROR", message: "Token inválido" }, 400);
      const body = JSON.parse(String(init.body)) as { token?: string; testingMode?: boolean };
      state = {
        tokenConfigured: state.tokenConfigured || body.token !== undefined,
        tokenHint: body.token !== undefined ? "…" : state.tokenHint,
        testingMode: body.testingMode ?? state.testingMode,
      };
    }
    if (init?.method === "DELETE") state = { ...state, tokenConfigured: false, tokenHint: null };
    return json(state);
  }));
  return calls;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("FaceCheck settings", () => {
  it("shows the token state, the testing mode switch on by default and how to get a token", async () => {
    const calls = installApi();
    render(<FacecheckSettings />);
    expect(await screen.findByText(/sin token configurado/i)).toBeInTheDocument();
    const testing = screen.getByRole("checkbox", { name: /modo prueba/i });
    expect(testing).toBeChecked();
    expect(screen.getByText(/100\.000 caras/)).toBeInTheDocument();
    expect(screen.getByText(/3 créditos/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /API de FaceCheck/i })).toHaveAttribute("href", "https://facecheck.id/en/Face-Search/API");
    expect(screen.getByLabelText("Token de la API de FaceCheck")).toHaveAttribute("type", "password");
    expect(screen.queryByRole("button", { name: "Quitar token" })).toBeNull();
    expect(calls.map((call) => [call.path, call.init?.method])).toEqual([["/settings/facecheck", undefined]]);
  });

  it("saves the token without showing it back, then removes it", async () => {
    const calls = installApi();
    const user = userEvent.setup();
    render(<FacecheckSettings />);
    const input = await screen.findByLabelText("Token de la API de FaceCheck");
    await user.type(input, "secret-facecheck-token");
    await user.click(screen.getByRole("button", { name: "Guardar token" }));
    expect(await screen.findByText(/^token configurado/i)).toBeInTheDocument();
    expect(input).toHaveValue("");
    expect(document.body).not.toHaveTextContent("secret-facecheck-token");
    expect(calls[1]?.path).toBe("/settings/facecheck");
    expect(calls[1]?.init?.method).toBe("PUT");
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ token: "secret-facecheck-token" });
    await user.click(screen.getByRole("button", { name: "Quitar token" }));
    expect(await screen.findByText(/sin token configurado/i)).toBeInTheDocument();
    expect(calls[2]?.path).toBe("/settings/facecheck/token");
    expect(calls[2]?.init?.method).toBe("DELETE");
  });

  it("turns testing mode off for real searches and warns that credits are spent", async () => {
    const calls = installApi({ tokenConfigured: true, tokenHint: "abcdef…wxyz", testingMode: true });
    const user = userEvent.setup();
    render(<FacecheckSettings />);
    expect(await screen.findByText(/abcdef…wxyz/)).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: /modo prueba/i }));
    await waitFor(() => expect(screen.getByRole("checkbox", { name: /modo prueba/i })).not.toBeChecked());
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ testingMode: false });
    expect(screen.getByText(/búsquedas reales descuentan créditos/i)).toBeInTheDocument();
  });

  it("reports a rejected token and keeps the previous state", async () => {
    installApi(empty, true);
    const user = userEvent.setup();
    render(<FacecheckSettings />);
    await user.type(await screen.findByLabelText("Token de la API de FaceCheck"), "bad");
    await user.click(screen.getByRole("button", { name: "Guardar token" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("No se pudo guardar FaceCheck: Token inválido");
    expect(screen.getByText(/sin token configurado/i)).toBeInTheDocument();
  });
});
