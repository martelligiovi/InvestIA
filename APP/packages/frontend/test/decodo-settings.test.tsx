import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { AiSettingsPage } from "../src/pages/AiSettingsPage";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function installApi() {
  let status = { tokenConfigured: false, tokenHint: null as string | null, apiMode: "web_data" };
  const calls: { method: string; path: string; body?: unknown }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    if (path === "/settings/facecheck") return json({ tokenConfigured: false, tokenHint: null, testingMode: true });
    if (path === "/settings/ghunt") return json({ available: false, state: "requires_connection", account: null });
    if (path === "/settings/ai/models") return json({ source: "live", models: [] });
    if (path === "/settings/ai") {
      const defaults = { model: "fixture/model", reasoningEffort: "default", temperature: 0.6, topP: 0.95, maxTokens: 4096 };
      return json({ apiKeyConfigured: false, apiKeyHint: null, settings: defaults, defaults });
    }
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as { token?: string; apiMode?: string };
    calls.push({ method, path, ...(body === undefined ? {} : { body }) });
    if (path === "/settings/decodo" && method === "GET") return json(status);
    if (path === "/settings/decodo" && method === "PUT" && body) {
      status = {
        tokenConfigured: status.tokenConfigured || body.token !== undefined,
        tokenHint: body.token === undefined ? status.tokenHint : `••••${body.token.slice(-4)}`,
        apiMode: body.apiMode ?? status.apiMode,
      };
      return json(status);
    }
    if (path === "/settings/decodo/token" && method === "DELETE") {
      status = { ...status, tokenConfigured: false, tokenHint: null };
      return json(status);
    }
    throw new Error(`Unexpected request: ${method} ${path}`);
  }));
  return calls;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("loads Decodo settings and saves a token without displaying it back", async () => {
  const calls = installApi();
  const user = userEvent.setup();
  render(<AiSettingsPage />);
  const settings = within(screen.getByRole("region", { name: "Decodo" }));
  const token = await settings.findByLabelText("Token de la API de Decodo");
  expect(token).toHaveAttribute("type", "password");
  expect(token).toHaveValue("");
  expect(settings.getByText(/sin token configurado/i)).toBeInTheDocument();
  expect(settings.getByText(/FaceCheck.*nunca.*foto/i)).toBeInTheDocument();
  expect(settings.getByText(/LinkedIn.*inicio de sesión/i)).toBeInTheDocument();
  const mode = settings.getByRole("combobox", { name: "Modo de API" });
  expect(mode).toHaveValue("web_data");
  expect(within(mode).getByRole("option", { name: "Web Data API (Bearer)" })).toHaveValue("web_data");
  expect(within(mode).getByRole("option", { name: "Web Scraping API v2 (Basic)" })).toHaveValue("scraping_v2");
  expect(calls).toEqual([{ method: "GET", path: "/settings/decodo" }]);

  await user.type(token, "  fixture-decodo-1234  ");
  await user.click(settings.getByRole("button", { name: "Guardar Decodo" }));
  expect(await settings.findByText(/token configurado \(••••1234\)/i)).toBeInTheDocument();
  expect(token).toHaveValue("");
  expect(document.body).not.toHaveTextContent("fixture-decodo-1234");

  await user.selectOptions(mode, "scraping_v2");
  expect(calls).toHaveLength(2);
  const save = settings.getByRole("button", { name: "Guardar Decodo" });
  await user.click(save);
  await waitFor(() => expect(save).toBeDisabled());
  expect(mode).toHaveValue("scraping_v2");
  expect(token).toHaveValue("");
  expect(settings.getByText(/token configurado \(••••1234\)/i)).toBeInTheDocument();

  await user.click(settings.getByRole("button", { name: "Quitar token" }));
  expect(await settings.findByText(/sin token configurado/i)).toBeInTheDocument();
  expect(settings.queryByText(/••••1234/)).not.toBeInTheDocument();
  expect(settings.queryByRole("button", { name: "Quitar token" })).not.toBeInTheDocument();
  expect(mode).toHaveValue("scraping_v2");
  expect(calls).toEqual([
    { method: "GET", path: "/settings/decodo" },
    { method: "PUT", path: "/settings/decodo", body: { token: "fixture-decodo-1234" } },
    { method: "PUT", path: "/settings/decodo", body: { apiMode: "scraping_v2" } },
    { method: "DELETE", path: "/settings/decodo/token" },
  ]);
});
