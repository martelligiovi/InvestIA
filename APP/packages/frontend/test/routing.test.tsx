import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { parseHashRoute } from "../src/routing";

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
});

describe("parseHashRoute", () => {
  it.each(["", "#", "#/"]) ("opens the home route for %s", (hash) => {
    expect(parseHashRoute(hash)).toEqual({ kind: "home" });
  });

  it("recognizes the create route", () => {
    expect(parseHashRoute("#/nueva")).toEqual({ kind: "create" });
  });

  it("recognizes the integration settings route and the Google deep link", () => {
    expect(parseHashRoute("#/ajustes")).toEqual({ kind: "settings" });
    expect(parseHashRoute("#/ajustes?seccion=ghunt")).toEqual({ kind: "settings" });
    expect(parseHashRoute("#/ajustes/extra")).toEqual({ kind: "not-found" });
  });

  it("decodes a safe investigation identifier", () => {
    expect(parseHashRoute("#/investigaciones/caso%2042")).toEqual({
      kind: "investigation",
      id: "caso 42",
    });
  });

  it.each([
    "#/unknown",
    "#/investigaciones/",
    "#/investigaciones/%2F",
    "#/investigaciones/%5C",
    "#/investigaciones/%2e%2e",
    "#/investigaciones/%E0%A4%A",
    "#/investigaciones/a/b",
    "#/investigaciones/%00",
  ])("rejects unsafe or unknown route %s", (hash) => {
    expect(parseHashRoute(hash)).toEqual({ kind: "not-found" });
  });

  it("does not normalize traversal segments into another valid route", () => {
    expect(parseHashRoute("#/investigaciones/../nueva")).toEqual({ kind: "not-found" });
  });
});

describe("App route scaffold", () => {
  it("shares one top bar and stitched footer between home and creation", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", {
      headers: { "content-type": "application/json" },
    })));
    const user = userEvent.setup();
    window.history.replaceState(null, "", "/#/");
    const { container } = render(<App />);
    expect(await screen.findByText("Todavía no hay investigaciones.")).toBeInTheDocument();
    expect(screen.getByText("Semillas", { exact: true })).toBeInTheDocument();
    expect(screen.getByText("Evidencia", { exact: true })).toBeInTheDocument();
    expect(screen.queryByText("Decisión", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText("Vos validás; nada se confirma solo.")).not.toBeInTheDocument();
    expect(container.querySelector(".application-shell")).toHaveClass("application-shell--home");
    expect(screen.getByRole("complementary", { name: "Investigaciones anteriores" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "InvestIA, inicio" })).toHaveAttribute("href", "#/");
    expect(screen.queryByRole("link", { name: /Inicio|Volver/u })).not.toBeInTheDocument();
    expect(container.querySelector(".new-investigation-link")).not.toBeInTheDocument();
    expect(container.querySelector(".site-footer .ascii-art--band")).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelector(".home-emblem .ascii-art--rosette")).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelector(".history-empty .ascii-art--tree")).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelector("pre.ascii-stitch, .home-mountain, .mountain-collage, .folk-strip")).not.toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: /^Nueva investigación/u }));
    expect(await screen.findByRole("heading", { name: "Nueva investigación" })).toBeInTheDocument();
    expect(container.querySelector(".application-shell")).not.toHaveClass("application-shell--home");
    expect(container.querySelector(".application-shell")).toHaveClass("application-shell--create");
    expect(container.querySelector(".site-header")).toBeInTheDocument();
    expect(container.querySelector(".site-footer")).toBeInTheDocument();
    expect(container.querySelector(".new-investigation-link")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Volver" })).toHaveAttribute("href", "#/");
  });
  it("renders the Spanish create screen for its hash route", () => {
    window.history.replaceState(null, "", "/#/nueva");
    const { container } = render(<App />);
    expect(screen.getByRole("heading", { name: "Nueva investigación" })).toBeInTheDocument();
    expect(screen.getByText("Cargá los datos que tenés como punto de partida")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Datos iniciales" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Semillas iniciales" })).toBeInTheDocument();
    expect(screen.getByLabelText("Nombre de la investigación")).toHaveAccessibleDescription(/Hasta/u);
    expect(screen.getByLabelText("Correo electrónico 1")).toHaveAttribute("type", "email");
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(container.querySelector(".creation-page > .eyebrow, .create-back-link, .motif-divider")).not.toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual([
      "Expediente",
      "Semillas iniciales",
      "Cómo se abre un expediente",
    ]);
    const guide = within(screen.getByRole("complementary", { name: "Cómo se abre un expediente" }));
    expect(guide.getAllByRole("listitem")).toHaveLength(2);
    expect(guide.queryByText(/Creá el expediente para iniciar el avance automático/u)).not.toBeInTheDocument();
    expect(container.querySelector(".create-guide .ascii-art--tree")).toHaveAttribute("aria-hidden", "true");
  });

  it("renders a safe not-found screen for malformed investigation URLs", () => {
    window.history.replaceState(null, "", "/#/investigaciones/%2F");
    const { container } = render(<App />);
    expect(screen.getByRole("heading", { name: "No encontramos esta página" })).toBeInTheDocument();
    expect(container.querySelector(".document-page .ascii-art--tree")).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelector(".new-investigation-link")).toHaveAttribute("href", "#/nueva");
  });

  it("loads the workspace for its decoded identifier without a case-controls popover", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) !== "/investigations/caso%2042" || (init?.method ?? "GET") !== "GET") {
        throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${String(input)}`);
      }
      return new Response(JSON.stringify({
        id: "caso 42",
        name: "Caso de prueba",
        revision: 1,
        createdAt: "2025-03-16T12:00:00.000Z",
        updatedAt: "2025-03-16T12:00:00.000Z",
        paused: false,
        emailSeeds: [],
        actions: [],
        evidence: [],
        validations: [],
        audit: [],
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetch);
    window.history.replaceState(null, "", "/#/investigaciones/caso%20%342");
    const { container } = render(<App />);
    expect(await screen.findByRole("heading", { name: "Caso de prueba" })).toBeInTheDocument();
    expect(fetch.mock.calls.map(([input]) => String(input))).toEqual(["/investigations/caso%2042"]);
    expect(screen.queryByText("Controles del expediente", { exact: true })).not.toBeInTheDocument();
    expect(container.querySelector(".application-shell")).toHaveClass("application-shell--quiet");
    expect(container.querySelector(".site-header .new-investigation-link")).toHaveAttribute("href", "#/nueva");
    expect(container.querySelector(".site-footer")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Volver al historial" })).toHaveAttribute("href", "#/");
    expect(container.querySelector(".workspace-brand, .workspace-landscape, .workspace-mountain")).not.toBeInTheDocument();
  });

  it("opens one settings page whose index focuses all four integrations without leaving the route", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(
      String(input) === "/settings/ai/models"
        ? { models: [], source: "live" }
        : String(input) === "/settings/ai"
          ? {
            apiKeyConfigured: false,
            apiKeyHint: null,
            settings: { model: "deepseek-ai/deepseek-v4.1-flash", reasoningEffort: "default", temperature: 0.6, topP: 0.95, maxTokens: 4096 },
            defaults: { model: "deepseek-ai/deepseek-v4.1-flash", reasoningEffort: "default", temperature: 0.6, topP: 0.95, maxTokens: 4096 },
          }
          : String(input) === "/settings/ghunt"
            ? { available: true, state: "requires_connection", account: null }
            : String(input) === "/settings/facecheck"
              ? { tokenConfigured: false, tokenHint: null, testingMode: true }
              : String(input) === "/settings/decodo"
                ? { tokenConfigured: false, tokenHint: null, apiMode: "web_data" }
                : [],
    ), { headers: { "content-type": "application/json" } })));
    const user = userEvent.setup();
    window.history.replaceState(null, "", "/#/");
    const { unmount } = render(<App />);
    expect(screen.getByRole("link", { name: /^Ajustes$/ })).toHaveAttribute("href", "#/ajustes");

    await user.click(screen.getByRole("link", { name: /^Ajustes$/ }));
    expect(await screen.findByRole("heading", { name: "Ajustes", level: 1 })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /^Ajustes$/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Inicio" })).toHaveAttribute("href", "#/");
    const settings = within(screen.getByRole("region", { name: /^Ajustes$/ }));
    const index = within(settings.getByRole("navigation", { name: "Integraciones" }));
    const integrations = ["Inteligencia artificial", "Google (GHunt)", "FaceCheck.id", "Decodo"];
    expect(settings.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual(integrations);
    expect(index.getAllByRole("button")).toHaveLength(integrations.length);
    for (const name of integrations) {
      const button = index.getByRole("button", { name });
      expect(button).toHaveAttribute("type", "button");
      await user.click(button);
      expect(settings.getByRole("region", { name })).toHaveFocus();
      expect(window.location.hash).toBe("#/ajustes");
    }

    unmount();
    window.history.replaceState(null, "", "/#/ajustes?seccion=ghunt");
    render(<App />);
    expect(await screen.findByLabelText("Código de GHunt Companion")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Google (GHunt)" })).toHaveFocus();
    expect(window.location.hash).toBe("#/ajustes?seccion=ghunt");
  });

  it("does not scroll back to GHunt when a late AI response arrives after the user scrolled away", async () => {
    const defaults = { model: "deepseek-ai/deepseek-v4.1-flash", reasoningEffort: "default", temperature: 0.6, topP: 0.95, maxTokens: 4096 };
    let resolveAi!: (response: Response) => void;
    const aiPromise = new Promise<Response>((resolve) => { resolveAi = resolve; });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      if (String(input) === "/settings/ai") return aiPromise;
      const body = String(input) === "/settings/ai/models"
        ? { source: "live", models: [] }
        : String(input) === "/settings/ghunt"
          ? { available: true, state: "requires_connection", account: null }
          : String(input) === "/settings/facecheck"
            ? { tokenConfigured: false, tokenHint: null, testingMode: true }
            : String(input) === "/settings/decodo"
              ? { tokenConfigured: false, tokenHint: null, apiMode: "web_data" }
              : [];
      return Promise.resolve(new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }));
    }));
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
    try {
      window.history.replaceState(null, "", "/#/ajustes?seccion=ghunt");
      render(<App />);
      const google = screen.getByRole("region", { name: "Google (GHunt)" });
      expect(google).toHaveFocus();
      expect(scrollIntoView).toHaveBeenCalledTimes(1);

      window.dispatchEvent(new Event("wheel"));
      resolveAi(new Response(JSON.stringify({ apiKeyConfigured: false, apiKeyHint: null, settings: defaults, defaults }), {
        headers: { "content-type": "application/json" },
      }));
      expect(await screen.findByLabelText("API key de NVIDIA Build")).toBeInTheDocument();
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(google).toHaveFocus();
    } finally {
      Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: originalScrollIntoView });
    }
  });

  it("navigates from the brand preview to the create scaffold", async () => {
    window.history.replaceState(null, "", "/#/");
    const user = userEvent.setup();
    render(<App />);

    expect(screen.getByRole("heading", { name: "Invest IA" })).toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: /^Nueva investigación/u }));
    expect(await screen.findByRole("heading", { name: "Nueva investigación" })).toBeInTheDocument();
  });

  it("moves focus to the main content without turning the skip link into a route", async () => {
    window.history.replaceState(null, "", "/#/");
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("link", { name: "Saltar al contenido" }));

    expect(window.location.hash).toBe("#/");
    expect(screen.getByRole("heading", { name: "Invest IA" })).toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByRole("main"));
  });
});
