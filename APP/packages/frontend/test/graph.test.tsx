import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Investigation } from "@investia/core";
import { buildWorkspaceGraph, workspaceGraphPage, type WorkspaceGraph, type WorkspaceNode } from "../src/pages/workspace-model";
import {
  clientDeltaToSvgUnits, GRAPH_BUTTON_ZOOM_IN, GRAPH_BUTTON_ZOOM_OUT, GRAPH_MAX_ZOOM, GRAPH_MIN_ZOOM,
  InvestigationGraph, wheelZoomFactor,
} from "../src/components/InvestigationGraph";
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

// jsdom has no PointerEvent: dispatch mouse events carrying the pointer fields the handlers read.
function pointer(target: Element, type: string, clientX: number, clientY: number, pointerId = 1) {
  const event = new MouseEvent(type, { bubbles: true, clientX, clientY });
  Object.defineProperty(event, "pointerId", { value: pointerId });
  fireEvent(target, event);
}

function wheel(viewport: Element, init: WheelEventInit) {
  const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: 70, clientY: 105, ...init });
  fireEvent(viewport, event);
  return event;
}

function graphCanvas() {
  const svg = screen.getByRole("group", { name: /grafo factual/i });
  return { svg, viewport: svg.closest<HTMLDivElement>(".graph-viewport")! };
}

describe("graph selection during viewport resize", () => {
  const wideGraph: WorkspaceGraph = {
    width: 800,
    height: 700,
    nodes: [node("left", 40, 60), node("right", 600, 60)],
    edges: [],
  };

  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  function renderResizableGraph() {
    let notify: (() => void) | undefined;
    const disconnect = vi.fn();
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { notify = callback; }
      observe() {}
      disconnect = disconnect;
    });
    const select = vi.fn();
    const { rerender, unmount } = render(<InvestigationGraph graph={wideGraph} selectedId={null} onSelect={select} />);
    const { svg, viewport } = graphCanvas();
    let width = 800, height = 400;
    Object.defineProperties(viewport, {
      clientWidth: { get: () => width },
      clientHeight: { get: () => height },
    });
    function resize(nextWidth: number, nextHeight = height) {
      width = nextWidth;
      height = nextHeight;
      act(() => notify?.());
    }
    resize(width);
    return {
      svg, viewport, resize, select, unmount, disconnect,
      setSelectedId: (selectedId: string | null) => rerender(<InvestigationGraph graph={wideGraph} selectedId={selectedId} onSelect={select} />),
    };
  }

  function selectRightFromList() {
    const list = screen.getByText(/^Lista accesible de nodos/u).closest("details")!;
    fireEvent.click(within(list).getByText(/^Lista accesible de nodos/u));
    fireEvent.click(within(list).getByRole("button", { name: "Semilla: right" }));
  }

  it("re-centers the list selection in the narrowed SVG viewport without scrolling", () => {
    const { svg, viewport, resize, select, unmount, disconnect } = renderResizableGraph();
    Object.defineProperties(viewport, {
      clientLeft: { value: 2 }, clientTop: { value: 4 },
      getBoundingClientRect: { value: () => ({ left: 100, top: 200 }) },
    });
    Object.defineProperty(svg, "getScreenCTM", { value: () => ({ a: 2, b: 0, c: 0, d: 2, e: 82, f: 184 }) });
    fireEvent.click(screen.getByRole("button", { name: "Acercar grafo" }));
    selectRightFromList();
    const before = readGraphTransform(svg);
    expect(before.zoom).toBe(1);

    resize(800);
    expect(readGraphTransform(svg)).toEqual(before);
    resize(0, 0);
    expect(readGraphTransform(svg)).toEqual(before);
    resize(480, 400);

    expect(readGraphTransform(svg)).toEqual({ x: -520, y: 0, zoom: 1 });
    expect([viewport.scrollLeft, viewport.scrollTop]).toEqual([0, 0]);
    expect(select).toHaveBeenCalledExactlyOnceWith(wideGraph.nodes[1]);
    unmount();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it.each([
    { id: "right", key: null, width: 480, height: 400, x: -220, y: 0 },
    { id: "right", key: "Enter", width: 480, height: 400, x: -220, y: 0 },
    { id: "right", key: null, width: 710, height: 400, x: 0, y: 0 },
    { id: "right", key: " ", width: 100, height: 100, x: -600, y: -60 },
    { id: "left", key: null, width: 480, height: 400, x: 0, y: 0 },
  ])("reveals the $id canvas node with minimum pan at $width × $height (key: $key)", ({ id, key, width, height, x, y }) => {
    const { svg, viewport, resize, select } = renderResizableGraph();
    const button = within(svg).getByRole("button", { name: `Semilla: ${id}` });
    if (key === null) fireEvent.click(button);
    else fireEvent.keyDown(button, { key });
    expect(readGraphTransform(svg)).toEqual({ x: 0, y: 0, zoom: 1 });

    resize(width, height);

    expect(readGraphTransform(svg)).toEqual({ x, y, zoom: 1 });
    expect([viewport.scrollLeft, viewport.scrollTop]).toEqual([0, 0]);
    expect(select).toHaveBeenCalledExactlyOnceWith(wideGraph.nodes.find((item) => item.id === id));
  });

  it.each(["drag", "wheel zoom", "zoom button", "Centrar"])("does not re-center after manual %s", (control) => {
    const { svg, viewport, resize, select } = renderResizableGraph();
    selectRightFromList();
    const before = readGraphTransform(svg);
    if (control === "drag") {
      pointer(viewport, "pointerdown", 0, 0);
      pointer(viewport, "pointermove", 30, 20);
      pointer(viewport, "pointerup", 30, 20);
    } else if (control === "wheel zoom") {
      wheel(viewport, { deltaY: -100 });
    } else {
      fireEvent.click(screen.getByRole("button", { name: control === "Centrar" ? "Centrar grafo completo" : "Acercar grafo" }));
    }
    const manual = readGraphTransform(svg);
    expect(manual).not.toEqual(before);

    resize(480);

    expect(readGraphTransform(svg)).toEqual(manual);
    expect([viewport.scrollLeft, viewport.scrollTop]).toEqual([0, 0]);
    expect(select).toHaveBeenCalledExactlyOnceWith(wideGraph.nodes[1]);
  });

  it("discards a queued reveal when a drag starts in the same batch", () => {
    const { svg, viewport, resize, select } = renderResizableGraph();

    act(() => {
      // Queue the list camera first so React defers the resize updater until the batch flushes.
      selectRightFromList();
      resize(480);
      pointer(viewport, "pointerdown", 0, 0);
    });

    expect(readGraphTransform(svg)).toEqual({ x: -250, y: 240, zoom: 1 });
    expect([viewport.scrollLeft, viewport.scrollTop]).toEqual([0, 0]);
    expect(select).toHaveBeenCalledExactlyOnceWith(wideGraph.nodes[1]);
  });

  it("discards a queued reveal after the list camera has settled", () => {
    const { svg, viewport, resize, setSelectedId } = renderResizableGraph();
    selectRightFromList();
    setSelectedId("right");
    const before = readGraphTransform(svg);

    act(() => {
      resize(480);
      pointer(viewport, "pointerdown", 0, 0);
    });

    expect(readGraphTransform(svg)).toEqual(before);
  });

  it("starts a later drag from the committed reveal", () => {
    const { svg, viewport, resize, setSelectedId } = renderResizableGraph();
    selectRightFromList();
    setSelectedId("right");
    resize(480);
    const revealed = readGraphTransform(svg);
    expect(revealed).toEqual({ x: -410, y: 90, zoom: 1 });

    pointer(viewport, "pointerdown", 0, 0);
    expect(readGraphTransform(svg)).toEqual(revealed);
    pointer(viewport, "pointermove", 30, 20);
    pointer(viewport, "pointerup", 30, 20);

    expect(readGraphTransform(svg)).toEqual({ x: revealed.x + 30, y: revealed.y + 20, zoom: 1 });
  });

  it("cancels re-centering when the controlled selection is cleared", () => {
    const { svg, resize, setSelectedId } = renderResizableGraph();
    selectRightFromList();
    setSelectedId("right");
    setSelectedId(null);
    const before = readGraphTransform(svg);

    resize(480);

    expect(readGraphTransform(svg)).toEqual(before);
  });
});

function expectWheelAnchor(svg: Element, x: number, y: number) {
  const { x: panX, y: panY, zoom } = readGraphTransform(svg);
  expect((x - panX) / zoom).toBeCloseTo(x, 8);
  expect((y - panY) / zoom).toBeCloseTo(y, 8);
}

describe("wheelZoomFactor", () => {
  it.each([0, NaN, Infinity, -Infinity])("returns 1 for delta %s", (deltaY) => {
    expect(wheelZoomFactor(deltaY)).toBe(1);
  });

  it("changes zoom progressively with reciprocal steps gentler than the buttons", () => {
    const zoomIn = wheelZoomFactor(-100);
    const zoomOut = wheelZoomFactor(100);
    expect(zoomIn).toBeCloseTo(Math.exp(0.08), 12);
    expect(zoomOut).toBeCloseTo(Math.exp(-0.08), 12);
    expect(zoomIn * zoomOut).toBeCloseTo(1, 12);
    expect(wheelZoomFactor(-5)).toBeGreaterThan(1);
    expect(wheelZoomFactor(-5)).toBeLessThan(zoomIn);
    expect(wheelZoomFactor(5)).toBeGreaterThan(zoomOut);
    expect(wheelZoomFactor(5)).toBeLessThan(1);
  });

  it("normalizes line and page deltas and clamps all modes below button speed", () => {
    expect(wheelZoomFactor(-2, 1)).toBe(wheelZoomFactor(-64));
    expect(wheelZoomFactor(0.25, 2, 128)).toBe(wheelZoomFactor(32));
    expect(wheelZoomFactor(0.25, 2)).toBe(wheelZoomFactor(100));
    for (const invalid of [0, -20, NaN, Infinity]) {
      expect(wheelZoomFactor(0.25, 2, invalid)).toBe(wheelZoomFactor(100));
    }
    for (const mode of [0, 1, 2]) {
      const zoomIn = wheelZoomFactor(-500, mode);
      const zoomOut = wheelZoomFactor(500, mode);
      expect(zoomIn).toBeCloseTo(Math.exp(0.16), 12);
      expect(zoomOut).toBeCloseTo(Math.exp(-0.16), 12);
      expect(zoomIn).toBeLessThan(GRAPH_BUTTON_ZOOM_IN);
      expect(zoomOut).toBeGreaterThan(GRAPH_BUTTON_ZOOM_OUT);
    }
  });
});

describe("graph wheel zoom", () => {
  it("zooms in under the pointer using the SVG screen matrix and cancels vertical scrolling", () => {
    const select = vi.fn();
    render(<InvestigationGraph graph={graph} selectedId="two" onSelect={select} />);
    const { svg, viewport } = graphCanvas();
    Object.defineProperty(svg, "getScreenCTM", { value: () => ({ a: 0.5, b: 0, c: 0, d: 0.5, e: 20, f: 30 }) });
    expect(viewport).toHaveAttribute("aria-label", "Área del grafo; arrastrá el fondo para desplazarlo o usá la rueda del mouse para hacer zoom");
    expect(screen.getByText(/Seleccioná un nodo con Enter o espacio; arrastrá el fondo para desplazarlo\. Usá Centrar para ajustar el grafo completo a la vista, la rueda del mouse para hacer zoom progresivo, − para alejarlo y \+ para acercarlo\./u)).toBeInTheDocument();

    expect(wheel(viewport, { deltaY: -100, ctrlKey: true }).defaultPrevented).toBe(true);

    const { zoom } = readGraphTransform(svg);
    expect(zoom).toBeGreaterThan(1);
    expect(zoom).toBeLessThan(GRAPH_BUTTON_ZOOM_IN);
    expectWheelAnchor(svg, 100, 150);
    expect(within(svg).getByRole("button", { name: "Semilla: two" })).toHaveAttribute("aria-pressed", "true");
    expect(select).not.toHaveBeenCalled();
  });

  it("zooms out progressively, keeps batched ticks and stops at both bounds without pan drift", () => {
    render(<InvestigationGraph graph={graph} selectedId={null} onSelect={vi.fn()} />);
    const { svg, viewport } = graphCanvas();
    const zoomOut = screen.getByRole("button", { name: "Alejar grafo" });
    const zoomIn = screen.getByRole("button", { name: "Acercar grafo" });
    const tick = (deltaY: number, clientX = 70) => {
      expect(wheel(viewport, { deltaY, clientX }).defaultPrevented).toBe(true);
    };

    tick(100);
    const first = readGraphTransform(svg).zoom;
    expect(first).toBeGreaterThan(GRAPH_BUTTON_ZOOM_OUT);
    expect(first).toBeLessThan(1);
    act(() => { for (let i = 0; i < 3; i++) tick(100); });
    expect(readGraphTransform(svg).zoom).toBeCloseTo(Math.exp(-0.32), 8);
    expectWheelAnchor(svg, 200, 400);

    act(() => { for (let i = 0; i < 20; i++) tick(100); });
    const minView = readGraphTransform(svg);
    expect(minView.zoom).toBe(GRAPH_MIN_ZOOM);
    expect(zoomOut).toBeDisabled();
    expect(zoomIn).toBeEnabled();
    tick(100, 180);
    expect(readGraphTransform(svg)).toEqual(minView);

    act(() => { for (let i = 0; i < 30; i++) tick(-100); });
    const maxView = readGraphTransform(svg);
    expect(maxView.zoom).toBe(GRAPH_MAX_ZOOM);
    expect(zoomIn).toBeDisabled();
    expect(zoomOut).toBeEnabled();
    tick(-100, 180);
    expect(readGraphTransform(svg)).toEqual(maxView);
  });

  it("leaves horizontal-only and non-finite wheel events untouched", () => {
    render(<InvestigationGraph graph={graph} selectedId={null} onSelect={vi.fn()} />);
    const { svg, viewport } = graphCanvas();
    fireEvent.click(screen.getByRole("button", { name: "Acercar grafo" }));
    const before = readGraphTransform(svg);

    expect(wheel(viewport, { deltaY: 0, deltaX: 120 }).defaultPrevented).toBe(false);
    const invalid = new WheelEvent("wheel", { bubbles: true, cancelable: true });
    Object.defineProperty(invalid, "deltaY", { value: Infinity });
    fireEvent(viewport, invalid);
    expect(invalid.defaultPrevented).toBe(false);
    expect(readGraphTransform(svg)).toEqual(before);
  });

  it("cancels vertical scroll but does not zoom during an active background drag, even after resizing", () => {
    const select = vi.fn();
    const { rerender } = render(<InvestigationGraph graph={graph} selectedId={null} onSelect={select} />);
    const { svg, viewport } = graphCanvas();
    pointer(viewport, "pointerdown", 0, 0);
    pointer(viewport, "pointermove", 30, 20);
    const before = readGraphTransform(svg);

    expect(wheel(viewport, { deltaY: -100 }).defaultPrevented).toBe(true);
    expect(readGraphTransform(svg)).toEqual(before);
    rerender(<InvestigationGraph graph={{ ...graph, width: 800 }} selectedId={null} onSelect={select} />);
    expect(graphCanvas().viewport).toBe(viewport);
    expect(wheel(viewport, { deltaY: -100 }).defaultPrevented).toBe(true);
    expect(readGraphTransform(svg)).toEqual(before);
    pointer(viewport, "pointermove", 50, 40);
    expect(readGraphTransform(svg)).toEqual({ x: 50, y: 40, zoom: 1 });
    pointer(viewport, "pointerup", 50, 40);
    expect(wheel(viewport, { deltaY: -100 }).defaultPrevented).toBe(true);
    expect(readGraphTransform(svg).zoom).toBeGreaterThan(1);
  });

  it("resumes wheel zoom on the replacement viewport after the graph empties during a drag", () => {
    const select = vi.fn();
    const { rerender } = render(<InvestigationGraph graph={graph} selectedId={null} onSelect={select} />);
    const { viewport } = graphCanvas();
    pointer(viewport, "pointerdown", 0, 0);

    rerender(<InvestigationGraph graph={{ ...graph, nodes: [] }} selectedId={null} onSelect={select} />);
    expect(viewport).not.toBeInTheDocument();
    rerender(<InvestigationGraph graph={graph} selectedId={null} onSelect={select} />);
    const { svg, viewport: replacement } = graphCanvas();
    expect(replacement).not.toBe(viewport);

    expect(wheel(replacement, { deltaY: -100 }).defaultPrevented).toBe(true);
    expect(readGraphTransform(svg).zoom).toBeCloseTo(Math.exp(0.08), 8);
  });

  it("resumes wheel zoom when the active pointer loses capture without releasing it again", () => {
    render(<InvestigationGraph graph={graph} selectedId={null} onSelect={vi.fn()} />);
    const { svg, viewport } = graphCanvas();
    const release = vi.fn();
    Object.defineProperty(viewport, "releasePointerCapture", { value: release });
    pointer(viewport, "pointerdown", 0, 0);
    const before = readGraphTransform(svg);

    pointer(viewport, "lostpointercapture", 0, 0, 2);
    expect(wheel(viewport, { deltaY: -100 }).defaultPrevented).toBe(true);
    expect(readGraphTransform(svg)).toEqual(before);

    pointer(viewport, "lostpointercapture", 0, 0);
    expect(release).not.toHaveBeenCalled();
    expect(wheel(viewport, { deltaY: -100 }).defaultPrevented).toBe(true);
    expect(readGraphTransform(svg).zoom).toBeCloseTo(Math.exp(0.08), 8);
  });

  it("uses the current SVG rectangle and viewBox after the graph becomes nonempty and resizes", () => {
    const select = vi.fn();
    const { rerender } = render(<InvestigationGraph graph={{ ...graph, nodes: [] }} selectedId={null} onSelect={select} />);
    const smallGraph = { ...graph, height: 300 };
    rerender(<InvestigationGraph graph={smallGraph} selectedId={null} onSelect={select} />);
    const { svg, viewport } = graphCanvas();
    Object.defineProperties(svg, {
      getScreenCTM: { value: () => null },
      getBoundingClientRect: { value: () => ({ left: 20, top: 30, width: 200, height: 350 }) },
    });
    Object.defineProperty(viewport, "clientHeight", { value: 128 });

    expect(wheel(viewport, { deltaY: -0.25, deltaMode: 2 }).defaultPrevented).toBe(true);
    expect(readGraphTransform(svg).zoom).toBeCloseTo(Math.exp(0.0256), 8);
    expectWheelAnchor(svg, 100, 150);
    wheel(viewport, { deltaY: 0.25, deltaMode: 2 });
    rerender(<InvestigationGraph graph={{ ...smallGraph, width: 800, height: 1400 }} selectedId={null} onSelect={select} />);

    expect(wheel(viewport, { deltaY: -100 }).defaultPrevented).toBe(true);
    expect(readGraphTransform(svg).zoom).toBeCloseTo(Math.exp(0.08), 8);
    expectWheelAnchor(svg, 200, 300);
  });
});

it.each([
  { layout: "without viewport dimensions", size: null, pan: { x: 0, y: 0 } },
  { layout: "with an off-screen first node", size: { width: 300, height: 180 }, pan: { x: -736, y: -24 } },
])("resets zoom and pans without scrolling on page change $layout", ({ size, pan }) => {
  const select = vi.fn();
  const evidence = Array.from({ length: 51 }, (_, i) => ({ ...node(`e${i}`, 836, i * 138), kind: "evidence" as const }));
  render(<InvestigationGraph graph={{ ...graph, nodes: evidence }} selectedId={null} onSelect={select} />);
  const { svg, viewport } = graphCanvas();
  if (size) {
    Object.defineProperties(viewport, { clientWidth: { value: size.width }, clientHeight: { value: size.height } });
  } else {
    expect(viewport.clientWidth).toBe(0);
    expect(viewport.clientHeight).toBe(0);
  }
  viewport.scrollLeft = 12;
  viewport.scrollTop = 90;
  fireEvent.click(screen.getByRole("button", { name: "Acercar grafo" }));
  expect(readGraphTransform(svg).zoom).toBe(GRAPH_BUTTON_ZOOM_IN);

  fireEvent.click(screen.getByRole("button", { name: "Siguiente página de resultados" }));

  expect(viewport.scrollLeft).toBe(0);
  expect(viewport.scrollTop).toBe(0);
  expect(readGraphTransform(svg)).toEqual({ ...pan, zoom: 1 });
  expect(screen.getByRole("status")).toHaveTextContent("Resultados 51–51 de 51");
  expect(select).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: "e50", x: 836, y: 64, width: 100, height: 100 }));
});

describe("desplazamiento del lienzo", () => {
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
