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
  it("keeps home intact and gives creation its own reference shell", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", {
      headers: { "content-type": "application/json" },
    })));
    const user = userEvent.setup();
    const { container } = render(<App />);
    expect(await screen.findByText("Todavía no hay investigaciones.")).toBeInTheDocument();
    expect(container.querySelector(".application-shell")).toHaveClass("application-shell--home");
    expect(screen.getByRole("complementary", { name: "Investigaciones anteriores" })).toBeInTheDocument();
    expect(container.querySelector(".site-header")).not.toBeInTheDocument();
    expect(container.querySelector(".site-footer")).not.toBeInTheDocument();
    const stitches = container.querySelectorAll("pre.ascii-stitch");
    expect(stitches.length).toBeGreaterThanOrEqual(2);
    for (const stitch of stitches) {
      expect(stitch).toHaveAttribute("aria-hidden", "true");
      expect(stitch.textContent).toMatch(/^[\x20-\x7e\n]+$/u);
      expect(stitch.textContent).toContain("x");
    }
    expect(container.querySelector(".home-mountain")).toHaveAttribute("alt", "");
    await user.click(screen.getByRole("link", { name: /^Nueva investigación/u }));
    expect(await screen.findByRole("heading", { name: "Nueva investigación" })).toBeInTheDocument();
    expect(container.querySelector(".application-shell")).not.toHaveClass("application-shell--home");
    expect(container.querySelector(".site-header")).toBeInTheDocument();
    expect(container.querySelector(".application-shell")).toHaveClass("application-shell--create");
    expect(container.querySelector(".site-footer")).not.toBeInTheDocument();
    expect(container.querySelector(".create-edge-embroidery pre.ascii-stitch")).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelector(".create-mountain")).toHaveAttribute("alt", "");
    expect(container.querySelector(".mountain-collage, .folk-strip")).not.toBeInTheDocument();
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
    expect(container.querySelector(".creation-page > .eyebrow, .create-back-link")).not.toBeInTheDocument();
    expect(container.querySelector(".creation-page .motif-divider")).toHaveAttribute("aria-hidden", "true");
  });

  it("renders a safe not-found screen for malformed investigation URLs", () => {
    window.history.replaceState(null, "", "/#/investigaciones/%2F");
    render(<App />);
    expect(screen.getByRole("heading", { name: "No encontramos esta página" })).toBeInTheDocument();
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
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Caso de prueba" })).toBeInTheDocument();
    expect(screen.getByText("caso 42")).toBeInTheDocument();
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
