import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Investigation } from "@investia/core";
import { buildWorkspaceGraph, type WorkspaceGraph, type WorkspaceNode } from "../src/pages/workspace-model";
import { clientDeltaToSvgUnits, InvestigationGraph } from "../src/components/InvestigationGraph";
import { workspaceHeadline } from "../src/pages/workspace-status";

function node(id: string, x: number, y: number): WorkspaceNode {
  return {
    id,
    kind: "seed",
    title: id,
    state: "aportada",
    accessibleLabel: `Semilla: ${id}`,
    seedValue: `${id}@example.test`,
    x,
    y,
    width: 100,
    height: 100,
  };
}

const graph: WorkspaceGraph = {
  width: 400,
  height: 800,
  nodes: [node("one", 10, 100), node("two", 110, 600)],
  edges: [],
};

afterEach(cleanup);

describe("resultados terminales", () => {
  const action = {
    id: "a1", spec: { catalogId: "github.email-registration.v1", provider: "github", seed: { kind: "email", value: "test@example.test" } },
    proposedAt: "2025-03-16T12:00:00Z", proposalReason: "Catálogo", queuedByCatalog: true,
  } as const;
  function snapshot(status: Investigation["actions"][number]["status"]): Investigation {
    return { id: "case", revision: 1, createdAt: action.proposedAt, updatedAt: action.proposedAt, paused: false,
      emailSeeds: [action.spec.seed], actions: [{ ...action, status, ...(status === "failed" ? { failure: "Proveedor no disponible" } : {}) }],
      evidence: [], validations: [], audit: [] };
  }
  it.each(["queued", "claimed"] as const)("no inventa resultados para %s", (status) => {
    expect(buildWorkspaceGraph(snapshot(status)).nodes).toHaveLength(2);
  });
  it.each(["failed", "succeeded"] as const)("conecta un resultado derivado para %s sin evidencia", (status) => {
    const projected = buildWorkspaceGraph(snapshot(status));
    const result = projected.nodes.find((item) => item.kind === "result");
    expect(result).toMatchObject({ state: status === "failed" ? "failed" : "no_information" });
    expect(projected.edges).toContainEqual(expect.objectContaining({ from: "action:a1", to: result?.id }));
    const select = vi.fn();
    render(<InvestigationGraph graph={projected} selectedId={null} onSelect={select} />);
    const button = screen.getAllByRole("button", { name: new RegExp(`^Resultado:.*${status === "failed" ? "Fallida" : "Sin información"}`) }).find((element) => element.tagName.toLowerCase() === "g")!;
    if (status === "failed") {
      expect(button.querySelector("circle")).not.toBeNull();
      expect(button).toHaveTextContent("X");
    }
    fireEvent.keyDown(button, { key: "Enter" });
    fireEvent.keyDown(button, { key: " " });
    expect(select).toHaveBeenCalledTimes(2);
  });
  it("mantiene evidencia real sin agregar un resultado vacío", () => {
    const base = snapshot("succeeded");
    const projected = buildWorkspaceGraph({ ...base, evidence: [{ id: "e1", actionId: "a1", seed: action.spec.seed,
      provider: "github", status: "registered", sourceId: "mock", recordedAt: action.proposedAt }] });
    expect(projected.nodes.filter((item) => item.kind === "evidence")).toHaveLength(1);
    expect(projected.nodes.filter((item) => item.kind === "result")).toHaveLength(0);
    expect(projected.edges).toHaveLength(2);
  });
  it("conserva gates de pausa, cola histórica, modo manual y reclamo incierto", () => {
    const authorized = { ...snapshot("queued"), authorization: { granted: true, at: action.proposedAt, reason: "Consentimiento", operator: "local-operator" as const } };
    expect(buildWorkspaceGraph({ ...authorized, paused: true }).nodes[1]?.state).toBe("paused_queue");
    expect(workspaceHeadline({ ...authorized, paused: true })).toBe("Pausada");
    expect(buildWorkspaceGraph({ ...authorized, actions: [{ ...action, status: "queued", queuedByCatalog: undefined }] }).nodes[1]?.state).toBe("not_executable");
    expect(workspaceHeadline({ ...authorized, advancementMode: "manual" })).toBe("Avance manual");
    expect(workspaceHeadline({ ...authorized, advancementMode: "automatic" })).toBe("Cola automática habilitada");
    expect(workspaceHeadline({ ...authorized, actions: snapshot("claimed").actions })).toMatch(/efecto incierto/);
  });
  it("distingue cola bloqueada de cola ejecutable", () => {
    expect(buildWorkspaceGraph(snapshot("queued")).nodes[1]?.state).toBe("waiting_authorization");
    expect(buildWorkspaceGraph({ ...snapshot("queued"), authorization: { granted: true, at: action.proposedAt, reason: "Consentimiento", operator: "local-operator" } }).nodes[1]?.state).toBe("queued");
  });
});

describe("geometría del grafo", () => {
  it.each([
    { viewport: "desktop", scale: 0.8, dx: 80, dy: -40, expectedX: 100, expectedY: -50 },
    { viewport: "mobile", scale: 0.4, dx: 80, dy: -40, expectedX: 200, expectedY: -100 },
  ])("convierte el desplazamiento de puntero a unidades SVG en $viewport", ({ scale, dx, dy, expectedX, expectedY }) => {
    const delta = clientDeltaToSvgUnits(dx, dy, { a: scale, b: 0, c: 0, d: scale });
    expect(delta.x).toBeCloseTo(expectedX, 8);
    expect(delta.y).toBeCloseTo(expectedY, 8);
  });

  it("ajusta todas las cajas de nodos al ancho y alto disponibles", () => {
    render(<InvestigationGraph graph={graph} selectedId={null} onSelect={() => undefined} />);
    const svg = screen.getByRole("group", { name: /grafo factual/i }) as unknown as SVGSVGElement;
    const viewport = svg.closest(".graph-viewport") as HTMLDivElement;
    Object.defineProperty(viewport, "clientWidth", { configurable: true, value: 300 });
    Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 250 });
    Object.defineProperty(viewport, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: 20, top: 30, right: 320, bottom: 280, width: 300, height: 250 }),
    });
    Object.defineProperty(svg, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: 20, top: 30, right: 220, bottom: 430, width: 200, height: 400 }),
    });
    Object.defineProperty(svg, "getScreenCTM", {
      configurable: true,
      value: () => ({ a: 0.5, b: 0, c: 0, d: 0.5, e: 0, f: 0 }),
    });

    fireEvent.click(screen.getByRole("button", { name: "Ajustar grafo" }));

    const match = svg.querySelector("g[transform]")?.getAttribute("transform")?.match(/^translate\(([-\d.]+) ([-\d.]+)\) scale\(([-\d.]+)\)$/u);
    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBeCloseTo(208.333, 2);
    expect(Number(match?.[2])).toBeCloseTo(-83.333, 2);
    expect(Number(match?.[3])).toBeCloseTo(0.8333, 3);
  });
});
