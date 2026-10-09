import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { WorkspaceGraph, WorkspaceNode } from "../pages/workspace-model";
import homeMountain from "../assets/home-mountain-engraving.svg";
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

interface GraphBounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
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

function graphBounds(graph: WorkspaceGraph): GraphBounds {
  return graph.nodes.reduce<GraphBounds>((bounds, node) => ({
    minX: Math.min(bounds.minX, node.x),
    minY: Math.min(bounds.minY, node.y),
    maxX: Math.max(bounds.maxX, node.x + node.width),
    maxY: Math.max(bounds.maxY, node.y + node.height),
  }), {
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
  });
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

export function InvestigationGraph({ graph, selectedId, onSelect }: InvestigationGraphProps) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const viewportRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ pointerId: number; x: number; y: number; startX: number; startY: number } | null>(null);
  const empty = graph.nodes.length === 0;

  function beginPan(event: PointerEvent<HTMLDivElement>) {
    if ((event.target as Element).tagName.toLowerCase() !== "svg" || svgRef.current === null) return;
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
      ? fallbackClientDeltaToSvgUnits(deltaX, deltaY, svg, graph)
      : clientDeltaToSvgUnits(deltaX, deltaY, matrix);
    setPan({ x: active.startX + delta.x, y: active.startY + delta.y });
  }

  function finishPan(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }

  function fitGraphToViewport() {
    const viewport = viewportRef.current;
    const svg = svgRef.current;
    if (viewport === null || svg === null || graph.nodes.length === 0) return;
    const bounds = graphBounds(graph);
    const width = bounds.maxX - bounds.minX;
    const height = bounds.maxY - bounds.minY;
    const viewportRect = viewport.getBoundingClientRect();
    const svgRect = svg.getBoundingClientRect();
    const matrix = svg.getScreenCTM?.() ?? null;
    const scaleX = matrix === null ? svgRect.width / graph.width : Math.hypot(matrix.a, matrix.b);
    const scaleY = matrix === null ? svgRect.height / graph.height : Math.hypot(matrix.c, matrix.d);
    if (width <= 0 || height <= 0 || scaleX <= 0 || scaleY <= 0 || viewport.clientWidth <= 0 || viewport.clientHeight <= 0) {
      setZoom(1);
      setPan({ x: 0, y: 0 });
      return;
    }

    const fitZoom = Math.min(
      2.4,
      viewport.clientWidth / (scaleX * width),
      viewport.clientHeight / (scaleY * height),
    );
    const centerX = (bounds.minX + bounds.maxX) / 2;
    const centerY = (bounds.minY + bounds.maxY) / 2;
    const svgOffsetX = svgRect.left - viewportRect.left;
    const svgOffsetY = svgRect.top - viewportRect.top;
    setZoom(fitZoom);
    setPan({
      x: (viewport.clientWidth / 2 - svgOffsetX) / scaleX - fitZoom * centerX,
      y: (viewport.clientHeight / 2 - svgOffsetY) / scaleY - fitZoom * centerY,
    });
  }

  return (
    <section className="graph-panel" aria-labelledby="graph-heading">
      <div className="graph-heading-row">
        <div>
          <h2 id="graph-heading" className="sr-only">Grafo factual</h2>
          <details className="graph-description">
            <summary>Sobre el grafo</summary>
            <p id="graph-description" className="graph-caption">Las líneas expresan referencias registradas, no relaciones personales. Seleccioná un nodo con Enter o espacio; arrastrá el fondo para desplazarlo.</p>
          </details>
        </div>
        <div className="graph-controls" aria-label="Controles del grafo">
          <button type="button" aria-label="Alejar grafo" onClick={() => setZoom((value) => Math.max(0.05, value * 0.8))}>−</button>
          <button type="button" aria-label="Acercar grafo" onClick={() => setZoom((value) => Math.min(2.4, value * 1.25))}>+</button>
          <button type="button" aria-label="Ajustar grafo" onClick={fitGraphToViewport}>Ajustar</button>
        </div>
      </div>
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
              viewBox={`0 0 ${graph.width} ${graph.height}`}
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
                    onClick={() => onSelect(node)}
                  >
                    <span>{node.accessibleLabel}</span>
                  </button>
                </li>
              ))}
            </ul>
          </details>
        </>
      )}
      <div className="workspace-landscape" aria-hidden="true"><img className="workspace-mountain" src={homeMountain} alt="" /></div>
    </section>
  );
}
