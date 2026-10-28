import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiReportSettings } from "@investia/core";
import { AiSettingsPage } from "../src/pages/AiSettingsPage";

type CapturedCall = { input: RequestInfo | URL; init?: RequestInit };

const defaults: AiReportSettings = {
  model: "deepseek-ai/deepseek-v4.1-flash",
  reasoningEffort: "default",
  temperature: 0.6,
  topP: 0.95,
  maxTokens: 4096,
};

const liveModels = {
  source: "live",
  models: [
    { id: "deepseek-ai/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", description: "Fast chat model.", reasoning: false },
    { id: "openai/gpt-oss-20b", name: "gpt-oss-20b", description: "Open-weight reasoning model.", reasoning: true },
  ],
};

interface SettingsView {
  apiKeyConfigured: boolean;
  apiKeyHint: string | null;
  settings: AiReportSettings;
  defaults: AiReportSettings;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function bodyOf(call: CapturedCall): unknown {
  return call.init?.body === undefined ? undefined : JSON.parse(String(call.init.body));
}

/** Fakes the settings API with an in-memory store that mirrors the backend contract. */
function installSettingsApi(initial: Partial<SettingsView> = {}, models: unknown = liveModels) {
  let view: SettingsView = { apiKeyConfigured: false, apiKeyHint: null, settings: defaults, defaults, ...initial };
  const calls: CapturedCall[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { input, init };
    calls.push(call);
    const path = String(input);
    if (path === "/settings/ai/models") return json(models);
    if (path === "/settings/ai" && init?.method === undefined) return json(view);
    if (path === "/settings/ai" && init?.method === "PUT") {
      const body = bodyOf(call) as { apiKey?: string; settings?: Partial<AiReportSettings> };
      view = {
        ...view,
        ...(body.apiKey === undefined ? {} : { apiKeyConfigured: true, apiKeyHint: `••••${body.apiKey.slice(-4)}` }),
        settings: { ...view.settings, ...body.settings },
      };
      return json(view);
    }
    if (path === "/settings/ai/api-key" && init?.method === "DELETE") {
      view = { ...view, apiKeyConfigured: false, apiKeyHint: null };
      return json(view);
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${path}`);
  }));
  return { calls };
}

function writes(calls: readonly CapturedCall[]) {
  return calls.filter((call) => call.init?.method !== undefined).map((call) => [String(call.input), call.init?.method, bodyOf(call)]);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ajustes de IA", () => {
  it("muestra la API key sin configurar, los valores por defecto y los modelos Free Endpoint", async () => {
    installSettingsApi();
    const user = userEvent.setup();
    render(<AiSettingsPage />);

    expect(await screen.findByText("Sin configurar")).toBeInTheDocument();
    expect(screen.getByLabelText("API key de NVIDIA Build")).toHaveAttribute("type", "password");
    expect(screen.getByLabelText("API key de NVIDIA Build")).toHaveValue("");
    expect(screen.getByRole("link", { name: /build\.nvidia\.com\/models/u })).toHaveAttribute("href", "https://build.nvidia.com/models");
    expect(screen.getByRole("button", { name: "Quitar API key" })).toBeDisabled();
    const model = screen.getByLabelText("Modelo");
    await waitFor(() => expect(within(model).getAllByRole("option")).toHaveLength(2));
    expect(model).toHaveValue("deepseek-ai/deepseek-v4.1-flash");
    expect(within(model).getByRole("option", { name: /gpt-oss-20b · razonamiento/u })).toBeInTheDocument();
    expect(screen.getByText(/Free Endpoint/u)).toBeInTheDocument();
    expect(screen.getByText(/se envían a NVIDIA Build/u)).toBeInTheDocument();

    await user.click(screen.getByText("Parámetros avanzados"));
    expect(screen.getByLabelText("Esfuerzo de razonamiento")).toHaveValue("default");
    expect(within(screen.getByLabelText("Esfuerzo de razonamiento")).getByRole("option", { name: "Predeterminado del modelo" })).toBeInTheDocument();
    expect(screen.getByLabelText("Temperatura")).toHaveValue(0.6);
    expect(screen.getByLabelText("Top P")).toHaveValue(0.95);
    expect(screen.getByLabelText("Máximo de tokens")).toHaveValue(4096);
  });

  it("guarda solo la API key con la configuración y muestra la pista enmascarada", async () => {
    const { calls } = installSettingsApi();
    const user = userEvent.setup();
    render(<AiSettingsPage />);
    await screen.findByText("Sin configurar");

    await user.type(screen.getByLabelText("API key de NVIDIA Build"), "nvapi-secret-1234");
    await user.click(screen.getByRole("button", { name: "Guardar" }));

    expect(await screen.findByText("Configurada (••••1234)")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Ajustes guardados.");
    expect(screen.getByLabelText("API key de NVIDIA Build")).toHaveValue("");
    expect(writes(calls)).toEqual([
      ["/settings/ai", "PUT", { apiKey: "nvapi-secret-1234", settings: defaults }],
    ]);
    expect(document.body).not.toHaveTextContent("nvapi-secret-1234");
  });

  it("edita parámetros avanzados y modelo sin reenviar la API key guardada", async () => {
    const { calls } = installSettingsApi({ apiKeyConfigured: true, apiKeyHint: "••••abcd" });
    const user = userEvent.setup();
    render(<AiSettingsPage />);
    expect(await screen.findByText("Configurada (••••abcd)")).toBeInTheDocument();
    await waitFor(() => expect(within(screen.getByLabelText("Modelo")).getAllByRole("option")).toHaveLength(2));

    await user.selectOptions(screen.getByLabelText("Modelo"), "openai/gpt-oss-20b");
    await user.click(screen.getByText("Parámetros avanzados"));
    await user.selectOptions(screen.getByLabelText("Esfuerzo de razonamiento"), "high");
    fireEvent.change(screen.getByLabelText("Temperatura"), { target: { value: "1.2" } });
    fireEvent.change(screen.getByLabelText("Top P"), { target: { value: "0.8" } });
    await user.clear(screen.getByLabelText("Máximo de tokens"));
    await user.type(screen.getByLabelText("Máximo de tokens"), "8192");
    await user.click(screen.getByRole("button", { name: "Guardar" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Ajustes guardados.");
    expect(writes(calls)).toEqual([
      ["/settings/ai", "PUT", { settings: { model: "openai/gpt-oss-20b", reasoningEffort: "high", temperature: 1.2, topP: 0.8, maxTokens: 8192 } }],
    ]);
  });

  it("rechaza parámetros fuera de rango sin enviar cambios", async () => {
    const { calls } = installSettingsApi();
    const user = userEvent.setup();
    render(<AiSettingsPage />);
    await screen.findByText("Sin configurar");

    await user.click(screen.getByText("Parámetros avanzados"));
    await user.clear(screen.getByLabelText("Máximo de tokens"));
    await user.type(screen.getByLabelText("Máximo de tokens"), "100");
    await user.click(screen.getByRole("button", { name: "Guardar" }));

    expect(screen.getByRole("alert")).toHaveTextContent(/Revisá los parámetros/u);
    expect(screen.getByLabelText("Máximo de tokens")).toHaveAttribute("aria-invalid", "true");
    expect(writes(calls)).toEqual([]);
  });

  it("restaura los valores por defecto en el formulario y los aplica solo al guardar", async () => {
    const custom: AiReportSettings = { model: "openai/gpt-oss-20b", reasoningEffort: "low", temperature: 1, topP: 0.5, maxTokens: 1024 };
    const { calls } = installSettingsApi({ apiKeyConfigured: true, apiKeyHint: "••••abcd", settings: custom });
    const user = userEvent.setup();
    render(<AiSettingsPage />);
    await screen.findByText("Configurada (••••abcd)");
    await waitFor(() => expect(screen.getByLabelText("Modelo")).toHaveValue("openai/gpt-oss-20b"));

    await user.click(screen.getByRole("button", { name: "Restaurar valores por defecto" }));
    await user.click(screen.getByText("Parámetros avanzados"));
    expect(screen.getByLabelText("Modelo")).toHaveValue(defaults.model);
    expect(screen.getByLabelText("Esfuerzo de razonamiento")).toHaveValue("default");
    expect(screen.getByLabelText("Temperatura")).toHaveValue(0.6);
    expect(screen.getByLabelText("Top P")).toHaveValue(0.95);
    expect(screen.getByLabelText("Máximo de tokens")).toHaveValue(4096);
    expect(writes(calls)).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Guardar" }));
    await screen.findByText("Ajustes guardados.");
    expect(writes(calls)).toEqual([["/settings/ai", "PUT", { settings: defaults }]]);
  });

  it("quita la API key guardada", async () => {
    const { calls } = installSettingsApi({ apiKeyConfigured: true, apiKeyHint: "••••abcd" });
    const user = userEvent.setup();
    render(<AiSettingsPage />);
    await screen.findByText("Configurada (••••abcd)");

    await user.click(screen.getByRole("button", { name: "Quitar API key" }));

    expect(await screen.findByText("Sin configurar")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("API key quitada.");
    expect(screen.getByRole("button", { name: "Quitar API key" })).toBeDisabled();
    expect(writes(calls)).toEqual([["/settings/ai/api-key", "DELETE", undefined]]);
  });

  it("avisa cuando la lista de modelos es de respaldo y conserva un modelo guardado fuera de la lista", async () => {
    installSettingsApi(
      { settings: { ...defaults, model: "acme/legacy-chat" } },
      { ...liveModels, source: "fallback" },
    );
    render(<AiSettingsPage />);
    await screen.findByText("Sin configurar");

    expect(await screen.findByText(/lista de respaldo/u)).toBeInTheDocument();
    const model = screen.getByLabelText("Modelo");
    await waitFor(() => expect(within(model).getAllByRole("option")).toHaveLength(3));
    expect(model).toHaveValue("acme/legacy-chat");
    expect(within(model).getByRole("option", { name: /acme\/legacy-chat/u })).toBeInTheDocument();
  });

  it("informa errores al cargar o guardar", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input) === "/settings/ai/models"
      ? json(liveModels)
      : json({ error: "UNAVAILABLE", message: "sin conexión" }, 503)));
    render(<AiSettingsPage />);

    expect(await screen.findByRole("alert")).toHaveTextContent("No se pudieron cargar los ajustes de IA: sin conexión");
    expect(screen.getByRole("button", { name: "Intentar de nuevo" })).toBeInTheDocument();
  });
});
