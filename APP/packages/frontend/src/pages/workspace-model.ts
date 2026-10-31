import { investigationSeedGraph, seedHasActions, findingSeedNodeId, type EvidenceRecord, type GitHubCatalogAction, type Investigation, type ValidationDecision } from "@investia/core";
import { actionDisplayState, workspaceStatusLabel } from "./workspace-status";

export type WorkspaceNodeKind = "seed" | "action" | "evidence" | "result" | "leaf-group";

export interface WorkspaceNode {
  readonly id: string;
  readonly kind: WorkspaceNodeKind;
  readonly title: string;
  readonly state: string;
  readonly accessibleLabel: string;
  readonly seedValue?: string;
  readonly action?: GitHubCatalogAction;
  readonly evidence?: EvidenceRecord;
  readonly members?: readonly WorkspaceNode[];
  readonly groupId?: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface WorkspaceEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly path: string;
}

export interface WorkspaceGraph {
  readonly width: number;
  readonly height: number;
  readonly nodes: readonly WorkspaceNode[];
  readonly edges: readonly WorkspaceEdge[];
}

const NODE_WIDTH = 232;
const NODE_HEIGHT = 92;
const ROW_GAP = 138;
const TOP = 64;

function seedNodeId(value: string): string {
  return `seed:${encodeURIComponent(value)}`;
}

const ACTION_TITLES: Readonly<Record<string, string>> = {
  "user-scanner": "Búsqueda de email y enlaces con user-scanner",
  gravatar: "Perfil público de Gravatar",
  maigret: "Búsqueda de username con Maigret",
};
const SOURCE_TOOLS: Readonly<Record<string, string>> = {
  "user-scanner:email": "user-scanner",
  "gravatar:email": "Gravatar",
  "maigret:username": "Maigret",
};

function usernameNodeId(value: string): string {
  return `seed:username:${encodeURIComponent(value)}`;
}

export function actionTitle(action: GitHubCatalogAction): string {
  return ACTION_TITLES[action.spec.provider] ?? "Comprobación de registro en GitHub";
}

export function evidenceHeading(evidence: EvidenceRecord): string {
  if (evidence.finding === undefined) return "Observación de registro";
  return `Hallazgo de ${SOURCE_TOOLS[evidence.sourceId] ?? "user-scanner"}`;
}

function nodeLabel(kind: WorkspaceNodeKind, title: string, state: string): string {
  const noun = kind === "seed" ? "Semilla" : kind === "action" ? "Acción" : kind === "result" ? "Resultado" : "Evidencia";
  return `${noun}: ${title}. Estado: ${workspaceStatusLabel(state)}.`;
}

export function buildWorkspaceGraph(investigation: Investigation): WorkspaceGraph {
  const nodes: WorkspaceNode[] = [];
  const actionIds = new Set(investigation.actions.map((action) => action.id));
  const seedGraph = investigationSeedGraph(investigation);
  const visualSeedIds = new Map(seedGraph.seeds.map((seed) => [seed.id,
    seed.kind === "email" ? seedNodeId(seed.value) : seed.kind === "username" ? usernameNodeId(seed.value) : `evidence:${seed.evidence.id}`]));
  const usernameSeeds = seedGraph.seeds.filter((seed) => seed.kind === "username");

  investigation.emailSeeds.forEach((seed, index) => {
    const id = seedNodeId(seed.value);
    nodes.push({
      id,
      kind: "seed",
      title: seed.value,
      state: "aportada",
      accessibleLabel: nodeLabel("seed", seed.value, "aportada"),
      seedValue: seed.value,
      x: 32,
      y: TOP + index * ROW_GAP,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    });
  });

  usernameSeeds.forEach((seed, index) => {
    const id = usernameNodeId(seed.value);
    nodes.push({
      id,
      kind: "seed",
      title: seed.value,
      state: "aportada",
      accessibleLabel: nodeLabel("seed", seed.value, "aportada"),
      seedValue: seed.value,
      x: 32,
      y: TOP + (investigation.emailSeeds.length + index) * ROW_GAP,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    });
  });

  investigation.actions.forEach((action, index) => {
    const title = actionTitle(action);
    const state = actionDisplayState(investigation, action);
    nodes.push({
      id: `action:${action.id}`,
      kind: "action",
      title,
      state,
      accessibleLabel: nodeLabel("action", `${action.id}. ${title}`, state),
      action,
      x: 434,
      y: TOP + index * ROW_GAP,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    });
  });

  investigation.evidence.forEach((record, index) => {
    const title = record.finding
      ? `${record.provider} · ${record.finding.target.value} · ${record.finding.upstreamStatus}`
      : `Observación de registro ${record.provider} · ${workspaceStatusLabel(record.status)}`;
    nodes.push({
      id: `evidence:${record.id}`,
      kind: "evidence",
      title,
      state: record.status,
      accessibleLabel: nodeLabel("evidence", `${record.id}. ${title}`, record.status),
      evidence: record,
      x: 836,
      y: TOP + index * ROW_GAP,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    });
  });

  let resultRow = investigation.evidence.length;
  for (const action of investigation.actions) {
    const failed = action.status === "failed";
    const hasEvidence = investigation.evidence.some((record) => record.actionId === action.id);
    if (!failed && (action.status !== "succeeded" || hasEvidence)) continue;
    const state = failed ? "failed" : "no_information";
    const title = failed ? "Error de ejecución" : "Sin información admitida";
    nodes.push({
      id: `result:${action.id}`,
      kind: "result",
      title,
      state,
      action,
      accessibleLabel: nodeLabel("result", `${action.id}. ${title}`, state),
      x: 836,
      y: TOP + resultRow++ * ROW_GAP,
      width: failed ? NODE_HEIGHT : NODE_WIDTH,
      height: NODE_HEIGHT,
    });
  }

  // Only sibling leaves collapse; seeds which feed another action remain visible.
  const leavesByAction = new Map<string, WorkspaceNode[]>();
  for (const node of nodes) {
    if (node.evidence === undefined || !actionIds.has(node.evidence.actionId) ||
      seedHasActions(seedGraph, findingSeedNodeId(node.evidence.id))) continue;
    const leaves = leavesByAction.get(node.evidence.actionId) ?? [];
    leaves.push(node);
    leavesByAction.set(node.evidence.actionId, leaves);
  }
  const groupedIds = new Set<string>();
  for (const [actionId, leaves] of leavesByAction) {
    if (leaves.length < 2) continue;
    const id = `leaf-group:${actionId}`;
    const title = `${leaves.length} resultados sin acciones`;
    const members = leaves.map((node) => ({ ...node, groupId: id }));
    for (const member of members) {
      groupedIds.add(member.id);
      visualSeedIds.set(findingSeedNodeId(member.evidence!.id), id);
    }
    nodes.push({ id, kind: "leaf-group", title, state: "leaf_group", members,
      accessibleLabel: `Grupo de semillas: ${title}.`,
      x: 836, y: TOP, width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  const visibleNodes = nodes.filter((node) => !groupedIds.has(node.id));

  // Follow recorded provenance, not discovered-value equality, to lay out branches.
  const seedsById = new Map(seedGraph.seeds.map((seed) => [seed.id, seed]));
  const actionById = new Map(investigation.actions.map((action) => [action.id, action]));
  const depthByAction = new Map<string, number>();
  function actionDepth(id: string, visiting = new Set<string>()): number {
    const cached = depthByAction.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 1; // Malformed cyclic references must not hang the view.
    visiting.add(id);
    const input = seedGraph.actionInputs.get(id);
    const seed = input === undefined ? undefined : seedsById.get(input);
    const producer = seed?.origin.kind === "action" ? seed.origin.actionId : undefined;
    const depth = producer !== undefined && actionById.has(producer) ? actionDepth(producer, visiting) + 2 : 1;
    visiting.delete(id);
    depthByAction.set(id, depth);
    return depth;
  }
  const rowsByDepth = new Map<number, number>();
  const laidOut = visibleNodes.map((node) => {
    const producer = node.evidence?.actionId ?? node.action?.id ??
      (node.kind === "leaf-group" ? node.members?.[0]?.evidence?.actionId : undefined);
    const depth = node.kind === "seed" ? 0 : node.kind === "action" ? actionDepth(node.action!.id) :
      producer !== undefined && actionIds.has(producer) ? actionDepth(producer) + 1 : 2;
    const row = rowsByDepth.get(depth) ?? 0;
    rowsByDepth.set(depth, row + 1);
    return { ...node, x: 32 + depth * 402, y: TOP + row * ROW_GAP };
  });
  const nodeById = new Map(laidOut.map((node) => [node.id, node]));
  const edges: WorkspaceEdge[] = [];
  for (const action of investigation.actions) {
    const input = seedGraph.actionInputs.get(action.id);
    const seedId = input === undefined ? undefined : visualSeedIds.get(input);
    const from = seedId === undefined ? undefined : nodeById.get(seedId);
    const to = nodeById.get(`action:${action.id}`);
    if (from !== undefined && to !== undefined) {
      edges.push({
        id: `seed-action:${action.id}`,
        from: from.id,
        to: to.id,
        path: orthogonalPath(from, to),
      });
    }
  }
  for (const record of investigation.evidence) {
    if (!actionIds.has(record.actionId)) continue;
    const from = nodeById.get(`action:${record.actionId}`);
    const to = nodeById.get(visualSeedIds.get(findingSeedNodeId(record.id)) ?? `evidence:${record.id}`);
    if (from !== undefined && to !== undefined && !edges.some((edge) => edge.from === from.id && edge.to === to.id)) {
      edges.push({
        id: to.kind === "leaf-group" ? `action-group:${record.actionId}` : `action-evidence:${record.id}`,
        from: from.id,
        to: to.id,
        path: orthogonalPath(from, to),
      });
    }
  }

  for (const node of laidOut) {
    if (node.kind !== "result" || node.action === undefined) continue;
    const from = nodeById.get(`action:${node.action.id}`);
    if (from !== undefined) {
      edges.push({
        id: `action-result:${node.action.id}`,
        from: from.id,
        to: node.id,
        path: orthogonalPath(from, node),
      });
    }
  }

  const rowCount = Math.max(...rowsByDepth.values(), 1);
  return { width: Math.max(1100, ...laidOut.map((node) => node.x + node.width + 32)),
    height: TOP * 2 + rowCount * ROW_GAP, nodes: laidOut, edges };
}

export function findWorkspaceNode(graph: WorkspaceGraph, id: string | null): WorkspaceNode | undefined {
  return graph.nodes.find((node) => node.id === id) ??
    graph.nodes.flatMap((node) => node.members ?? []).find((node) => node.id === id);
}

export function workspaceNodeSelected(node: WorkspaceNode, id: string | null): boolean {
  return node.id === id || node.members?.some((member) => member.id === id) === true;
}

export const GRAPH_PAGE_SIZE = 50;

/** Branch inputs stay visible on every page so no action loses its recorded source. */
export function workspacePageEvidence(graph: WorkspaceGraph): readonly WorkspaceNode[] {
  const actions = new Set(graph.nodes.filter((node) => node.kind === "action").map((node) => node.id));
  const branches = new Set(graph.edges.filter((edge) => actions.has(edge.to)).map((edge) => edge.from));
  return graph.nodes.filter((node) => node.kind === "evidence" && !branches.has(node.id));
}

/** Project a bounded view without changing the persisted investigation or evidence. */
export function workspaceGraphPage(graph: WorkspaceGraph, page: number): WorkspaceGraph {
  const evidence = workspacePageEvidence(graph);
  if (evidence.length <= GRAPH_PAGE_SIZE) return graph;
  const lastPage = Math.ceil(evidence.length / GRAPH_PAGE_SIZE) - 1;
  const offset = Math.max(0, Math.min(lastPage, page)) * GRAPH_PAGE_SIZE;
  const visible = evidence.slice(offset, offset + GRAPH_PAGE_SIZE);
  const pageable = new Set(evidence.map((node) => node.id));
  const rows = new Map<number, number>();
  const nodes = [
    ...graph.nodes.filter((node) => !pageable.has(node.id) && node.kind !== "result"),
    ...visible,
    ...graph.nodes.filter((node) => node.kind === "result"),
  ].map((node) => {
    const row = rows.get(node.x) ?? 0;
    rows.set(node.x, row + 1);
    return { ...node, y: TOP + row * ROW_GAP };
  });
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edges = graph.edges.flatMap((edge) => {
    const from = byId.get(edge.from), to = byId.get(edge.to);
    return from && to ? [{ ...edge, path: orthogonalPath(from, to) }] : [];
  });
  return { width: graph.width, height: Math.max(TOP * 2, ...nodes.map((node) => node.y + node.height + TOP)), nodes, edges };
}

function orthogonalPath(from: WorkspaceNode, to: WorkspaceNode): string {
  const startX = from.x + from.width;
  const startY = from.y + from.height / 2;
  const endX = to.x;
  const endY = to.y + to.height / 2;
  const middleX = Math.round((startX + endX) / 2);
  return `M ${startX} ${startY} H ${middleX} V ${endY} H ${endX}`;
}

export function validationHistoryFor(
  evidenceId: string,
  validations: readonly ValidationDecision[],
): readonly ValidationDecision[] {
  return validations.filter((decision) => decision.evidenceId === evidenceId);
}
