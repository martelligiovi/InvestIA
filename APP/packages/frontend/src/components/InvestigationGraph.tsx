import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { GRAPH_PAGE_SIZE, workspaceGraphPage, workspacePageEvidence, workspaceNodeSelected, type WorkspaceGraph, type WorkspaceNode } from "../pages/workspace-model";
import { workspaceStatusLabel } from "../pages/workspace-status";

export const GRAPH_MIN_ZOOM = 0.25;
export const GRAPH_MAX_ZOOM = 2.4;
export const GRAPH_BUTTON_ZOOM_OUT = 0.8;
export const GRAPH_BUTTON_ZOOM_IN = 1.25;
export const GRAPH_WHEEL_ZOOM_SENSITIVITY = 0.0008;
export const GRAPH_WHEEL_MAX_DELTA = 200;

export function wheelZoomFactor(deltaY: number, deltaMode = 0, pageHeight = 400): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) return 1;
  let pixels = deltaY;
  if (deltaMode === 1) pixels *= 32;
  if (deltaMode === 2) pixels *= Number.isFinite(pageHeight) && pageHeight > 0 ? pageHeight : 400;
  const clamped = Math.min(GRAPH_WHEEL_MAX_DELTA, Math.max(-GRAPH_WHEEL_MAX_DELTA, pixels));
  return Math.exp(-clamped * GRAPH_WHEEL_ZOOM_SENSITIVITY);
}

export interface InvestigationGraphProps {
  readonly graph: WorkspaceGraph;
  readonly selectedId: string | null;
  readonly onSelect: (node: WorkspaceNode) => void;
}

interface SvgPoint {
  readonly x: number;
  readonly y: number;
}

interface GraphView {
  zoom: number;
  pan: SvgPoint;
}

function displayLines(value: string, limit = 27): readonly string[] {
  const lines: string[] = [];
  let line = "";
  for (const originalWord of value.split(/\s+/u)) {
    let word = originalWord;
    while (word.length > limit) {
      if (line.length > 0) {
        lines.push(line);
        line = "";
      }
      lines.push(word.slice(0, limit));
      word = word.slice(limit);
    }
    const candidate = line.length === 0 ? word : `${line} ${word}`;
    if (candidate.length > limit && line.length > 0) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line.length > 0) lines.push(line);
  if (lines.length > 2) {
    const second = lines[1] ?? "";
    lines.splice(1, lines.length - 1, `${second.slice(0, Math.max(0, limit - 1))}…`);
  }
  return lines;
}

function nodeHeading(node: WorkspaceNode): string {
  if (node.kind === "seed") return "✉ Semilla";
  if (node.kind === "action") return "⚙ Acción";
  if (node.kind === "leaf-group") return "▤ Semillas agrupadas";
  return "▤ Resultado";
}

function handleNodeKey(event: KeyboardEvent<SVGGElement>, node: WorkspaceNode, onSelect: (node: WorkspaceNode) => void) {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  onSelect(node);
}

export function clientDeltaToSvgUnits(
  deltaX: number,
  deltaY: number,
  matrix: Pick<DOMMatrixReadOnly, "a" | "b" | "c" | "d">,
): SvgPoint {
  const determinant = matrix.a * matrix.d - matrix.b * matrix.c;
  if (!Number.isFinite(determinant) || determinant === 0) return { x: deltaX, y: deltaY };
  return {
    x: (matrix.d * deltaX - matrix.c * deltaY) / determinant,
    y: (-matrix.b * deltaX + matrix.a * deltaY) / determinant,
  };
}

function fallbackClientDeltaToSvgUnits(
  deltaX: number,
  deltaY: number,
  rect: Pick<DOMRectReadOnly, "width" | "height">,
  viewWidth: number,
  viewHeight: number,
): SvgPoint {
  const scaleX = rect.width / viewWidth;
  const scaleY = rect.height / viewHeight;
  return {
    x: scaleX > 0 ? deltaX / scaleX : deltaX,
    y: scaleY > 0 ? deltaY / scaleY : deltaY,
  };
}

function nearestRevealPan(pan: number, start: number, end: number, visibleStart: number, visibleEnd: number): number {
  const minPan = visibleStart - start;
  const maxPan = visibleEnd - end;
  // An oversized node has no pan that fits it, so center it on this axis.
  return minPan > maxPan ? (minPan + maxPan) / 2 : Math.min(maxPan, Math.max(minPan, pan));
}

export function InvestigationGraph({ graph: fullGraph, selectedId, onSelect }: InvestigationGraphProps) {
  const [page, setPage] = useState(0);
  const evidenceCount = workspacePageEvidence(fullGraph).length;
  const pageCount = Math.max(1, Math.ceil(evidenceCount / GRAPH_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const graph = useMemo(() => workspaceGraphPage(fullGraph, currentPage), [fullGraph, currentPage]);
  const viewHeight = Math.max(graph.height, 700);
  const [view, setView] = useState<GraphView>({ zoom: 1, pan: { x: 0, y: 0 } });
  const { zoom, pan } = view;
  const viewportRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ pointerId: number; x: number; y: number; startX: number; startY: number } | null>(null);
  const pendingRevealRef = useRef<{ nodeId: string; mode: "center" | "nearest" } | null>(null);
  const revealRollbackRef = useRef<GraphView | null>(null);
  const nodesRef = useRef(graph.nodes);
  const prevSelectedIdRef = useRef(selectedId);
  nodesRef.current = graph.nodes;
  if (prevSelectedIdRef.current !== null && selectedId === null) pendingRevealRef.current = null;
  prevSelectedIdRef.current = selectedId;
  const empty = graph.nodes.length === 0;

  useLayoutEffect(() => { revealRollbackRef.current = null; }, [view]);

  function cancelPendingReveal() {
    pendingRevealRef.current = null;
    const rollback = revealRollbackRef.current;
    if (rollback !== null) {
      revealRollbackRef.current = null;
      setView(rollback);
    }
  }

  function viewportCenter(): SvgPoint {
    const svg = svgRef.current, viewport = viewportRef.current;
    if (!svg || !viewport) return { x: graph.width / 2, y: viewHeight / 2 };
    const rect = viewport.getBoundingClientRect();
    const matrix = svg.getScreenCTM?.();
    if (matrix) return clientDeltaToSvgUnits(rect.left + viewport.clientWidth / 2 - matrix.e, rect.top + viewport.clientHeight / 2 - matrix.f, matrix);
    return { x: graph.width / 2, y: viewHeight / 2 };
  }

  function clientPointToSvg(clientX: number, clientY: number): SvgPoint {
    const svg = svgRef.current;
    if (svg) {
      const matrix = svg.getScreenCTM?.();
      if (matrix) return clientDeltaToSvgUnits(clientX - matrix.e, clientY - matrix.f, matrix);
      const rect = svg.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        return fallbackClientDeltaToSvgUnits(clientX - rect.left, clientY - rect.top, rect, graph.width, viewHeight);
      }
    }
    return viewportCenter();
  }

  function applyZoom(factor: number, anchor: SvgPoint) {
    setView((current) => {
      const nextZoom = Math.min(GRAPH_MAX_ZOOM, Math.max(GRAPH_MIN_ZOOM, current.zoom * factor));
      if (nextZoom === current.zoom) return current;
      return {
        zoom: nextZoom,
        pan: {
          x: anchor.x - (anchor.x - current.pan.x) * nextZoom / current.zoom,
          y: anchor.y - (anchor.y - current.pan.y) * nextZoom / current.zoom,
        },
      };
    });
  }

  function changeZoom(factor: number) {
    cancelPendingReveal();
    applyZoom(factor, viewportCenter());
  }

  useEffect(() => {
    if (empty) {
      drag.current = null;
      cancelPendingReveal();
    }
  }, [empty]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (empty || !viewport || typeof ResizeObserver === "undefined") return;
    let lastWidth = viewport.clientWidth;
    let lastHeight = viewport.clientHeight;

    // The detail drawer changes the canvas width; scrolling cannot reveal nodes on a clipped canvas.
    const observer = new ResizeObserver(() => {
      const width = viewport.clientWidth;
      const height = viewport.clientHeight;
      if (width <= 0 || height <= 0 || (width === lastWidth && height === lastHeight)) return;
      lastWidth = width;
      lastHeight = height;

      const pending = pendingRevealRef.current;
      if (!pending) return;
      const target = nodesRef.current.find((node) => workspaceNodeSelected(node, pending.nodeId));
      if (!target) return;

      let topLeft = { x: 0, y: 0 };
      let bottomRight = { x: width, y: height };
      const matrix = svgRef.current?.getScreenCTM?.();
      if (matrix) {
        const rect = viewport.getBoundingClientRect();
        const x = rect.left + viewport.clientLeft - matrix.e;
        const y = rect.top + viewport.clientTop - matrix.f;
        topLeft = clientDeltaToSvgUnits(x, y, matrix);
        bottomRight = clientDeltaToSvgUnits(x + width, y + height, matrix);
      }

      setView((current) => {
        if (pendingRevealRef.current !== pending) return current;
        const { zoom, pan } = current;
        const nextPan = pending.mode === "center"
          ? {
              x: (topLeft.x + bottomRight.x) / 2 - (target.x + target.width / 2) * zoom,
              y: (topLeft.y + bottomRight.y) / 2 - (target.y + target.height / 2) * zoom,
            }
          : {
              x: nearestRevealPan(pan.x, target.x * zoom, (target.x + target.width) * zoom, topLeft.x, bottomRight.x),
              y: nearestRevealPan(pan.y, target.y * zoom, (target.y + target.height) * zoom, topLeft.y, bottomRight.y),
            };
        if (nextPan.x === pan.x && nextPan.y === pan.y) return current;
        // An idle React queue can evaluate this updater before a same-batch camera control cancels the reveal.
        if (revealRollbackRef.current === null) revealRollbackRef.current = current;
        return { ...current, pan: nextPan };
      });
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [empty]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (empty || !viewport) return;
    function onWheel(event: WheelEvent) {
      if (!Number.isFinite(event.deltaY) || event.deltaY === 0) return;
      event.preventDefault();
      if (drag.current !== null) return;
      cancelPendingReveal();
      const factor = wheelZoomFactor(event.deltaY, event.deltaMode, viewport!.clientHeight);
      const anchor = clientPointToSvg(event.clientX, event.clientY);
      applyZoom(factor, anchor);
    }
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheel);
  }, [empty, graph.width, viewHeight]);

  function selectFromList(node: WorkspaceNode) {
    pendingRevealRef.current = { nodeId: node.id, mode: "center" };
    const center = viewportCenter();
    setView({ zoom: 1, pan: { x: center.x - node.x - node.width / 2, y: center.y - node.y - node.height / 2 } });
    onSelect(node);
  }

  function selectFromCanvas(node: WorkspaceNode) {
    pendingRevealRef.current = { nodeId: node.id, mode: "nearest" };
    onSelect(node);
  }

  function changePage(next: number) {
    const bounded = Math.max(0, Math.min(pageCount - 1, next));
    setPage(bounded);
    const projected = workspaceGraphPage(fullGraph, bounded);
    const pageable = new Set(workspacePageEvidence(fullGraph).map((node) => node.id));
    const first = projected.nodes.find((node) => pageable.has(node.id));
    pendingRevealRef.current = first ? { nodeId: first.id, mode: "nearest" } : null;
    const viewport = viewportRef.current;
    if (viewport) {
      viewport.scrollLeft = 0;
      viewport.scrollTop = 0;
    }
    if (first && viewport && viewport.clientWidth > 0 && viewport.clientHeight > 0) {
      setView({
        zoom: 1,
        pan: {
          x: Math.min(0, viewport.clientWidth / 2 - first.x - first.width / 2),
          y: Math.min(0, viewport.clientHeight / 2 - first.y - first.height / 2),
        },
      });
    } else {
      setView({ zoom: 1, pan: { x: 0, y: 0 } });
    }
    if (first) onSelect(first);
  }

  function beginPan(event: PointerEvent<HTMLDivElement>) {
    // Pan from empty canvas only: the SVG background or the viewport area around a smaller graph.
    const onEmptyCanvas = event.target === event.currentTarget || (event.target as Element).tagName.toLowerCase() === "svg";
    if (!onEmptyCanvas || svgRef.current === null) return;
    cancelPendingReveal();
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, startX: pan.x, startY: pan.y };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function movePan(event: PointerEvent<HTMLDivElement>) {
    const active = drag.current;
    const svg = svgRef.current;
    if (active === null || active.pointerId !== event.pointerId || svg === null) return;
    const deltaX = event.clientX - active.x;
    const deltaY = event.clientY - active.y;
    const matrix = svg.getScreenCTM?.() ?? null;
    const delta = matrix === null
      ? fallbackClientDeltaToSvgUnits(deltaX, deltaY, svg.getBoundingClientRect(), graph.width, viewHeight)
      : clientDeltaToSvgUnits(deltaX, deltaY, matrix);
    setView((current) => ({ ...current, pan: { x: active.startX + delta.x, y: active.startY + delta.y } }));
  }

  function finishPan(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }

  function fitGraphToViewport() {
    if (empty) {
      cancelPendingReveal();
      return;
    }
    pendingRevealRef.current = null;
    revealRollbackRef.current = null;
    const viewport = viewportRef.current;
    if (viewport) {
      viewport.scrollLeft = 0;
      viewport.scrollTop = 0;
    }

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const node of graph.nodes) {
      minX = Math.min(minX, node.x);
      minY = Math.min(minY, node.y);
      maxX = Math.max(maxX, node.x + node.width);
      maxY = Math.max(maxY, node.y + node.height);
    }
    const vw = viewport && viewport.clientWidth > 0 ? viewport.clientWidth : graph.width;
    const vh = viewport && viewport.clientHeight > 0 ? viewport.clientHeight : viewHeight;
    const pad = Math.min(32, Math.floor(Math.min(vw, vh) * 0.1));
    const availW = Math.max(1, vw - pad * 2);
    const availH = Math.max(1, vh - pad * 2);
    const rawScale = Math.min(availW / (maxX - minX), availH / (maxY - minY), 1);
    const nextZoom = Math.min(GRAPH_MAX_ZOOM, Math.max(GRAPH_MIN_ZOOM, rawScale));

    setView({
      zoom: nextZoom,
      pan: {
        x: vw / 2 - ((minX + maxX) / 2) * nextZoom,
        y: vh / 2 - ((minY + maxY) / 2) * nextZoom,
      },
    });
  }

  return (
    <section className="graph-panel" aria-labelledby="graph-heading">
      <div className="graph-heading-row">
        <div>
          <h2 id="graph-heading" className="sr-only">Grafo factual</h2>
          <details className="graph-description">
            <summary>Sobre el grafo</summary>
            <p id="graph-description" className="graph-caption">Las líneas expresan referencias registradas, no relaciones personales. Las semillas sin acciones de una misma rama se agrupan; seleccioná la pila para consultar cada resultado. Seleccioná un nodo con Enter o espacio; arrastrá el fondo para desplazarlo. Usá Centrar para ajustar el grafo completo a la vista, la rueda del mouse para hacer zoom progresivo, − para alejarlo y + para acercarlo.</p>
          </details>
        </div>
        <div className="graph-controls" aria-label="Controles del grafo">
          <button type="button" aria-label="Alejar grafo" disabled={zoom <= GRAPH_MIN_ZOOM} onClick={() => changeZoom(GRAPH_BUTTON_ZOOM_OUT)}>−</button>
          <button type="button" aria-label="Acercar grafo" disabled={zoom >= GRAPH_MAX_ZOOM} onClick={() => changeZoom(GRAPH_BUTTON_ZOOM_IN)}>+</button>
          <button type="button" aria-label="Centrar grafo completo" onClick={fitGraphToViewport}>Centrar</button>
        </div>
      </div>
      {pageCount > 1 && (
        <nav className="graph-pagination" aria-label="Páginas de resultados">
          <p role="status">Resultados {currentPage * GRAPH_PAGE_SIZE + 1}–{Math.min((currentPage + 1) * GRAPH_PAGE_SIZE, evidenceCount)} de {evidenceCount}</p>
          <div>
            <button type="button" aria-label="Primera página de resultados" disabled={currentPage === 0} onClick={() => changePage(0)}>«</button>
            <button type="button" aria-label="Página anterior de resultados" disabled={currentPage === 0} onClick={() => changePage(currentPage - 1)}>Anterior</button>
            <span>{currentPage + 1} / {pageCount}</span>
            <button type="button" aria-label="Siguiente página de resultados" disabled={currentPage === pageCount - 1} onClick={() => changePage(currentPage + 1)}>Siguiente</button>
            <button type="button" aria-label="Última página de resultados" disabled={currentPage === pageCount - 1} onClick={() => changePage(pageCount - 1)}>»</button>
          </div>
        </nav>
      )}
      {empty ? (
        <p className="graph-empty">Todavía no hay semillas, acciones ni observaciones registradas.</p>
      ) : (
        <>
          <div
            ref={viewportRef}
            className="graph-viewport"
            onPointerDown={beginPan}
            onPointerMove={movePan}
            onPointerUp={finishPan}
            onPointerCancel={finishPan}
            onLostPointerCapture={(event) => {
              if (drag.current?.pointerId === event.pointerId) drag.current = null;
            }}
            aria-label="Área del grafo; arrastrá el fondo para desplazarlo o usá la rueda del mouse para hacer zoom"
          >
            <svg
              ref={svgRef}
              className="investigation-graph"
              role="group"
              aria-label="Grafo factual de semillas, acciones y observaciones"
              aria-describedby="graph-description"
              style={{ width: graph.width, height: viewHeight }}
              viewBox={`0 0 ${graph.width} ${viewHeight}`}
              xmlns="http://www.w3.org/2000/svg"
            >
              <defs>
                <marker id="investigation-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" />
                </marker>
              </defs>
              <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
                {graph.edges.map((edge) => (
                  <path
                    key={edge.id}
                    data-edge={edge.id}
                    className="graph-edge"
                    d={edge.path}
                    markerEnd="url(#investigation-arrow)"
                  />
                ))}
                {graph.nodes.map((node) => {
                  const lines = displayLines(node.title);
                  const active = workspaceNodeSelected(node, selectedId);
                  const failure = node.kind === "result" && node.state === "failed";
                  return (
                    <g
                      key={node.id}
                      className={`graph-node graph-node--${node.kind}${failure ? " graph-node--failure" : ""}${active ? " is-selected" : ""}`}
                      data-node-id={node.id}
                      role="button"
                      tabIndex={0}
                      aria-label={node.accessibleLabel}
                      aria-pressed={active}
                      onClick={() => selectFromCanvas(node)}
                      onKeyDown={(event) => handleNodeKey(event, node, selectFromCanvas)}
                    >
                      <title>{node.accessibleLabel}</title>
                      {node.kind === "leaf-group" && [-3, 2.5].map((angle) => (
                        <rect key={angle} className="graph-stack-sheet" aria-hidden="true"
                          x={node.x} y={node.y} width={node.width} height={node.height} rx={2}
                          transform={`rotate(${angle} ${node.x + node.width / 2} ${node.y + node.height / 2})`} />
                      ))}
                      {failure ? (
                        <>
                          <circle className="graph-node-card" cx={node.x + node.width / 2} cy={node.y + node.height / 2} r={node.height / 2} />
                          <text className="graph-failure-x" x={node.x + node.width / 2} y={node.y + node.height / 2} textAnchor="middle" dominantBaseline="central">X</text>
                        </>
                      ) : <rect className="graph-node-card" x={node.x} y={node.y} width={node.width} height={node.height} rx={2} />}
                      {!failure && (
                        <>
                          <text className="graph-node-kicker" x={node.x + 14} y={node.y + 21}>{nodeHeading(node)}</text>
                          {lines.map((line, index) => (
                            <text key={`${node.id}:${index}`} className="graph-node-title" x={node.x + 14} y={node.y + 43 + index * 18}>{line}</text>
                          ))}
                          <rect className="graph-state-badge" x={node.x + 10} y={node.y + 68} width={node.width - 20} height={18} />
                          <text className="graph-node-state" x={node.x + 16} y={node.y + 81}>{workspaceStatusLabel(node.state)}</text>
                        </>
                      )}
                    </g>
                  );
                })}
              </g>
            </svg>
          </div>
          <details className="graph-node-list">
            <summary>Lista accesible de nodos · {graph.nodes.length}</summary>
            <ul>
              {graph.nodes.map((node) => (
                <li key={`list:${node.id}`}>
                  <button
                    type="button"
                    aria-pressed={workspaceNodeSelected(node, selectedId)}
                    onClick={() => selectFromList(node)}
                  >
                    <span>{node.accessibleLabel}</span>
                  </button>
                </li>
              ))}
            </ul>
          </details>
        </>
      )}
    </section>
  );
}
