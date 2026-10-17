import { cleanup, render, screen } from "@testing-library/react";
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
    const { container } = render(<App />);
    expect(await screen.findByText("Todavía no hay investigaciones.")).toBeInTheDocument();
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
    expect(container.querySelector(".creation-page > .eyebrow, .create-back-link, .motif-divider")).not.toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual([
      "Expediente",
      "Semillas iniciales",
      "Avance y autorización",
      "Cómo se abre un expediente",
    ]);
    expect(screen.getByRole("complementary", { name: "Cómo se abre un expediente" })).toBeInTheDocument();
    expect(container.querySelector(".create-guide .ascii-art--tree")).toHaveAttribute("aria-hidden", "true");
  });

  it("renders a safe not-found screen for malformed investigation URLs", () => {
    window.history.replaceState(null, "", "/#/investigaciones/%2F");
    const { container } = render(<App />);
    expect(screen.getByRole("heading", { name: "No encontramos esta página" })).toBeInTheDocument();
    expect(container.querySelector(".document-page .ascii-art--tree")).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelector(".new-investigation-link")).toHaveAttribute("href", "#/nueva");
  });

  it("loads the workspace for its decoded identifier", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
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
    }), { status: 200, headers: { "content-type": "application/json" } })));
    window.history.replaceState(null, "", "/#/investigaciones/caso%2042");
    const { container } = render(<App />);
    expect(await screen.findByRole("heading", { name: "Caso de prueba" })).toBeInTheDocument();
    expect(screen.getByText("caso 42")).toBeInTheDocument();
    expect(container.querySelector(".application-shell")).toHaveClass("application-shell--quiet");
    expect(container.querySelector(".site-header .new-investigation-link")).toHaveAttribute("href", "#/nueva");
    expect(container.querySelector(".site-footer")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Volver al historial" })).toHaveAttribute("href", "#/");
    expect(container.querySelector(".workspace-brand, .workspace-landscape, .workspace-mountain")).not.toBeInTheDocument();
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
