import { useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { GRAPH_PAGE_SIZE, workspaceGraphPage, type WorkspaceGraph, type WorkspaceNode } from "../pages/workspace-model";
import { workspaceStatusLabel } from "../pages/workspace-status";

export interface InvestigationGraphProps {
  readonly graph: WorkspaceGraph;
  readonly selectedId: string | null;
  readonly onSelect: (node: WorkspaceNode) => void;
}

interface SvgPoint {
  readonly x: number;
  readonly y: number;
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

function fallbackClientDeltaToSvgUnits(deltaX: number, deltaY: number, svg: SVGSVGElement, graph: WorkspaceGraph): SvgPoint {
  const rect = svg.getBoundingClientRect();
  const scaleX = rect.width / graph.width;
  const scaleY = rect.height / graph.height;
  return {
    x: scaleX > 0 ? deltaX / scaleX : deltaX,
    y: scaleY > 0 ? deltaY / scaleY : deltaY,
  };
}

export function InvestigationGraph({ graph: fullGraph, selectedId, onSelect }: InvestigationGraphProps) {
  const [page, setPage] = useState(0);
  const evidenceCount = fullGraph.nodes.filter((node) => node.kind === "evidence").length;
  const pageCount = Math.max(1, Math.ceil(evidenceCount / GRAPH_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const graph = useMemo(() => workspaceGraphPage(fullGraph, currentPage), [fullGraph, currentPage]);
  const viewHeight = Math.max(graph.height, 700);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const viewportRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ pointerId: number; x: number; y: number; startX: number; startY: number } | null>(null);
  const empty = graph.nodes.length === 0;

  function viewportCenter(): SvgPoint {
    const svg = svgRef.current, viewport = viewportRef.current;
    if (!svg || !viewport) return { x: graph.width / 2, y: viewHeight / 2 };
    const rect = viewport.getBoundingClientRect();
    const matrix = svg.getScreenCTM?.();
    if (matrix) return clientDeltaToSvgUnits(rect.left + viewport.clientWidth / 2 - matrix.e, rect.top + viewport.clientHeight / 2 - matrix.f, matrix);
    return { x: graph.width / 2, y: viewHeight / 2 };
  }

  function changeZoom(factor: number) {
    const next = Math.min(2.4, Math.max(1, zoom * factor));
    const center = viewportCenter();
    setPan({ x: center.x - (center.x - pan.x) * next / zoom, y: center.y - (center.y - pan.y) * next / zoom });
    setZoom(next);
  }

  function selectFromList(node: WorkspaceNode) {
    const center = viewportCenter();
    setZoom(1);
    setPan({ x: center.x - node.x - node.width / 2, y: center.y - node.y - node.height / 2 });
    onSelect(node);
  }

  function changePage(next: number) {
    const bounded = Math.max(0, Math.min(pageCount - 1, next));
    setPage(bounded);
    setZoom(1);
    setPan({ x: 0, y: 0 });
    const first = workspaceGraphPage(fullGraph, bounded).nodes.find((node) => node.kind === "evidence");
    if (first) {
      const viewport = viewportRef.current;
      if (viewport) {
        viewport.scrollLeft = Math.max(0, first.x + first.width / 2 - viewport.clientWidth / 2);
        viewport.scrollTop = Math.max(0, first.y + first.height / 2 - viewport.clientHeight / 2);
      }
      onSelect(first);
    }
  }

  function beginPan(event: PointerEvent<HTMLDivElement>) {
    // Pan from empty canvas only: the SVG background or the viewport area around a smaller graph.
    const onEmptyCanvas = event.target === event.currentTarget || (event.target as Element).tagName.toLowerCase() === "svg";
    if (!onEmptyCanvas || svgRef.current === null) return;
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
      ? fallbackClientDeltaToSvgUnits(deltaX, deltaY, svg, { ...graph, height: viewHeight })
      : clientDeltaToSvgUnits(deltaX, deltaY, matrix);
    setPan({ x: active.startX + delta.x, y: active.startY + delta.y });
  }

  function finishPan(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }

  function centerSelectedNode() {
    const node = graph.nodes.find((item) => item.id === selectedId) ?? graph.nodes[0];
    if (node) selectFromList(node);
  }

  return (
    <section className="graph-panel" aria-labelledby="graph-heading">
      <div className="graph-heading-row">
        <div>
          <h2 id="graph-heading" className="sr-only">Grafo factual</h2>
          <details className="graph-description">
            <summary>Sobre el grafo</summary>
            <p id="graph-description" className="graph-caption">Las líneas expresan referencias registradas, no relaciones personales. Seleccioná un nodo con Enter o espacio; arrastrá el fondo o usá las barras de desplazamiento. Centrar lleva el nodo seleccionado al centro sin achicarlo.</p>
          </details>
        </div>
        <div className="graph-controls" aria-label="Controles del grafo">
          <button type="button" aria-label="Alejar grafo" disabled={zoom <= 1} onClick={() => changeZoom(0.8)}>−</button>
          <button type="button" aria-label="Acercar grafo" onClick={() => changeZoom(1.25)}>+</button>
          <button type="button" aria-label="Centrar nodo seleccionado" onClick={centerSelectedNode}>Centrar</button>
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
            aria-label="Área del grafo; arrastrá el fondo para desplazarlo"
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
                  const active = selectedId === node.id;
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
                      onClick={() => onSelect(node)}
                      onKeyDown={(event) => handleNodeKey(event, node, onSelect)}
                    >
                      <title>{node.accessibleLabel}</title>
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
                    aria-pressed={selectedId === node.id}
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
