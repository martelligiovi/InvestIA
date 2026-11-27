import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Investigation } from "@investia/core";
import { buildWorkspaceGraph, workspaceGraphPage, type WorkspaceGraph, type WorkspaceNode } from "../src/pages/workspace-model";
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

function readGraphTransform(svg: Element) {
  const match = svg.querySelector("g[transform]")!.getAttribute("transform")!.match(/^translate\((\S+) (\S+)\) scale\((\S+)\)$/u)!;
  return { x: Number(match[1]), y: Number(match[2]), zoom: Number(match[3]) };
}

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

  it.each([
    { width: 300, height: 250, visibleWidth: 300, visibleHeight: 250, zoom: 1 / 3 },
    { width: 300, height: 200, visibleWidth: 300, visibleHeight: 200, zoom: 4 / 15 },
    { width: 100, height: 96, visibleWidth: 100, visibleHeight: 96, zoom: 0.25 },
    { width: 0, height: 0, visibleWidth: 400, visibleHeight: 800, zoom: 1 },
    { width: 1000, height: 1000, visibleWidth: 1000, visibleHeight: 1000, zoom: 1 },
  ])("fits the full node bounds at $width × $height without changing selection", ({ width, height, visibleWidth, visibleHeight, zoom }) => {
    const select = vi.fn();
    render(<InvestigationGraph graph={graph} selectedId="two" onSelect={select} />);
    const svg = screen.getByRole("group", { name: /grafo factual/i });
    const viewport = svg.closest<HTMLDivElement>(".graph-viewport")!;
    Object.defineProperties(viewport, { clientWidth: { value: width }, clientHeight: { value: height } });
    viewport.scrollLeft = 12;
    viewport.scrollTop = 90;
    expect(readGraphTransform(svg)).toEqual({ x: 0, y: 0, zoom: 1 });

    fireEvent.click(screen.getByRole("button", { name: "Centrar grafo completo" }));

    const actual = readGraphTransform(svg);
    expect(actual.zoom).toBeCloseTo(zoom, 8);
    expect(actual.x + 110 * actual.zoom).toBeCloseTo(visibleWidth / 2, 8);
    expect(actual.y + 400 * actual.zoom).toBeCloseTo(visibleHeight / 2, 8);
    expect(viewport.scrollLeft).toBe(0);
    expect(viewport.scrollTop).toBe(0);
    expect(within(svg).getByRole("button", { name: "Semilla: two" })).toHaveAttribute("aria-pressed", "true");
    expect(within(svg).getByRole("button", { name: "Semilla: one" })).toHaveAttribute("aria-pressed", "false");
    expect(select).not.toHaveBeenCalled();
  });

  it("does nothing when fitting an empty graph", () => {
    const select = vi.fn();
    render(<InvestigationGraph graph={{ ...graph, nodes: [] }} selectedId={null} onSelect={select} />);
    fireEvent.click(screen.getByRole("button", { name: "Centrar grafo completo" }));
    expect(screen.getByText("Todavía no hay semillas, acciones ni observaciones registradas.")).toBeVisible();
    expect(select).not.toHaveBeenCalled();
  });

  it("clamps zoom controls to 0.25 and 2.4", () => {
    render(<InvestigationGraph graph={graph} selectedId={null} onSelect={vi.fn()} />);
    const svg = screen.getByRole("group", { name: /grafo factual/i });
    const zoomOut = screen.getByRole("button", { name: "Alejar grafo" });
    const zoomIn = screen.getByRole("button", { name: "Acercar grafo" });
    for (let i = 0; i < 7; i++) {
      expect(zoomOut).toBeEnabled();
      fireEvent.click(zoomOut);
    }
    expect(readGraphTransform(svg).zoom).toBe(0.25);
    expect(zoomOut).toBeDisabled();
    for (let i = 0; i < 11; i++) {
      expect(zoomIn).toBeEnabled();
      fireEvent.click(zoomIn);
    }
    expect(readGraphTransform(svg).zoom).toBe(2.4);
    expect(zoomIn).toBeDisabled();
    expect(zoomOut).toBeEnabled();
  });
});


it("pages evidence without losing records, references or changing the input graph", () => {
  const evidence = Array.from({ length: 2722 }, (_, i) => ({ ...node(`e${i}`, 836, 64 + i * 138), kind: "evidence" as const }));
  const full: WorkspaceGraph = { width: 1100, height: 375764, nodes: [node("seed", 32, 64), node("action", 434, 64), ...evidence],
    edges: evidence.map((item) => ({ id: item.id, from: "action", to: item.id, path: "original" })) };
  const original = JSON.stringify(full);
  const seen: string[] = [];
  for (let page = 0; page < 55; page++) {
    const projected = workspaceGraphPage(full, page);
    const rows = projected.nodes.filter((item) => item.kind === "evidence");
    expect(rows.length).toBe(page === 54 ? 22 : 50);
    expect(rows[0]?.y).toBe(64);
    expect(projected.edges).toHaveLength(rows.length);
    expect(projected.edges.every((edge) => projected.nodes.some((item) => item.id === edge.to))).toBe(true);
    seen.push(...rows.map((item) => item.id));
  }
  expect(seen).toEqual(evidence.map((item) => item.id));
  expect(JSON.stringify(full)).toBe(original);
  expect(workspaceGraphPage(graph, 0)).toBe(graph);
});

it("keeps zoom centered using the SVG screen origin and resets to readable scale from the accessible list", () => {
  const select = vi.fn();
  render(<InvestigationGraph graph={graph} selectedId={null} onSelect={select} />);
  const svg = screen.getByRole("group", { name: /grafo factual/i }) as unknown as SVGSVGElement;
  const viewport = svg.closest(".graph-viewport") as HTMLDivElement;
  Object.defineProperties(viewport, {
    clientWidth: { value: 300 }, clientHeight: { value: 250 },
    getBoundingClientRect: { value: () => ({ left: 20, top: 30, width: 300, height: 250 }) },
  });
  Object.defineProperties(svg, {
    getBoundingClientRect: { value: () => ({ left: 20, top: 30, width: 300, height: 250 }) },
    getScreenCTM: { value: () => ({ a: 0.5, b: 0, c: 0, d: 0.5, e: 70, f: 30 }) },
  });
  const zoomIn = screen.getByRole("button", { name: "Acercar grafo" });
  const zoomOut = screen.getByRole("button", { name: "Alejar grafo" });
  for (const button of [zoomOut, zoomIn, zoomIn]) {
    fireEvent.click(button);
    const { x, y, zoom } = readGraphTransform(svg);
    expect((200 - x) / zoom).toBeCloseTo(200);
    expect((250 - y) / zoom).toBeCloseTo(250);
  }
  expect(readGraphTransform(svg).zoom).toBe(1.25);
  fireEvent.click(screen.getByText(/^Lista accesible de nodos/u));
  fireEvent.click(screen.getAllByRole("button", { name: "Semilla: one" }).find((button) => button.tagName === "BUTTON")!);
  expect(readGraphTransform(svg)).toEqual({ x: 140, y: 100, zoom: 1 });
  expect(select).toHaveBeenCalledTimes(1);
  expect(select).toHaveBeenCalledWith(graph.nodes[0]);
});

describe("desplazamiento del lienzo", () => {
  // jsdom has no PointerEvent: dispatch mouse events carrying the pointer fields the handlers read.
  function pointer(target: Element, type: string, clientX: number, clientY: number) {
    const event = new MouseEvent(type, { bubbles: true, clientX, clientY });
    Object.defineProperty(event, "pointerId", { value: 1 });
    fireEvent(target, event);
  }

  function transform(container: HTMLElement) {
    return container.querySelector(".investigation-graph > g")!.getAttribute("transform");
  }

  it("desplaza el grafo al arrastrar el fondo vacío del área, aunque quede fuera del SVG", () => {
    const { container } = render(<InvestigationGraph graph={graph} selectedId={null} onSelect={vi.fn()} />);
    const viewport = container.querySelector<HTMLElement>(".graph-viewport")!;
    pointer(viewport, "pointerdown", 0, 0);
    pointer(viewport, "pointermove", 30, 20);
    pointer(viewport, "pointerup", 30, 20);
    expect(transform(container)).toBe("translate(30 20) scale(1)");
  });

  it("no inicia el desplazamiento desde un nodo", () => {
    const { container } = render(<InvestigationGraph graph={graph} selectedId={null} onSelect={vi.fn()} />);
    const viewport = container.querySelector<HTMLElement>(".graph-viewport")!;
    pointer(container.querySelector(".graph-node")!, "pointerdown", 0, 0);
    pointer(viewport, "pointermove", 30, 20);
    expect(transform(container)).toBe("translate(0 0) scale(1)");
  });
});
