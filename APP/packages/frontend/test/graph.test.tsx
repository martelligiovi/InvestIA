import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkspaceGraph, WorkspaceNode } from "../src/pages/workspace-model";
import { clientDeltaToSvgUnits, InvestigationGraph } from "../src/components/InvestigationGraph";

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
