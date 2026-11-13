import { investigationSeedGraph, seedHasActions, findingSeedNodeId, type EvidenceRecord, type GitHubCatalogAction, type Investigation, type ValidationDecision } from "@investia/core";
import { actionDisplayState, workspaceStatusLabel } from "./workspace-status";
import { profileSeeds, type ProfileSeed } from "./profile-seeds";

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
  readonly profileSeed?: ProfileSeed;
  readonly members?: readonly WorkspaceNode[];
  /** FaceCheck candidates the operator discarded: left out of the graph, still reviewable. */
  readonly hiddenMembers?: number;
  /** Distinct observations displayed under the same linked Gravatar profile seed. */
  readonly relatedNodes?: readonly WorkspaceNode[];
  readonly relatedParentId?: string;
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
  ghunt: "GHunt",
  facecheck: "Búsqueda facial con FaceCheck",
};
const SOURCE_TOOLS: Readonly<Record<string, string>> = {
  "user-scanner:email": "user-scanner",
  "gravatar:email": "Gravatar",
  "maigret:username": "Maigret",
  "ghunt:email": "GHunt",
  "facecheck:photo": "FaceCheck",
};
const GHUNT_CATEGORIES: Readonly<Record<string, string>> = {
  "Google account": "Cuenta Google",
  Name: "Nombre",
  "Profile photo": "Foto de perfil",
  "Cover photo": "Portada",
  "Last profile edit": "Última edición",
  "Google services": "Servicios de Google",
};

function usernameNodeId(value: string): string {
  return `seed:username:${encodeURIComponent(value)}`;
}

export function actionTitle(action: GitHubCatalogAction): string {
  if (action.spec.catalogId === "ghunt.email.v1") return "GHunt";
  return ACTION_TITLES[action.spec.provider] ?? "Comprobación de registro en GitHub";
}

function hostOf(value: string): string {
  try { return new URL(value).hostname; } catch { return "sin enlace"; }
}

export function evidenceHeading(evidence: EvidenceRecord): string {
  if (evidence.finding === undefined) return "Observación de registro";
  if (evidence.sourceId === "facecheck:photo") return "Candidato de FaceCheck";
  return `Hallazgo de ${SOURCE_TOOLS[evidence.sourceId] ?? "user-scanner"}`;
}

function nodeLabel(kind: WorkspaceNodeKind, title: string, state: string): string {
  const noun = kind === "seed" ? "Semilla" : kind === "action" ? "Acción" : kind === "result" ? "Resultado" : "Evidencia";
  return `${noun}: ${title}. Estado: ${workspaceStatusLabel(state)}.`;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Discarded FaceCheck candidates leave the graph; accepted ones lead, unreviewed ones follow. */
function facecheckGroupReview(leaves: readonly WorkspaceNode[], latest: ReadonlyMap<string, string>) {
  const status = (node: WorkspaceNode) => latest.get(node.evidence!.id);
  const score = (node: WorkspaceNode) => { const value = node.evidence?.finding?.extra.score; return typeof value === "number" ? value : 0; };
  leaves = [...leaves].sort((left, right) => score(right) - score(left));
  const accepted = leaves.filter((node) => status(node) === "accepted");
  const pending = leaves.filter((node) => status(node) !== "accepted" && status(node) !== "rejected");
  const discarded = leaves.length - accepted.length - pending.length;
  const title = accepted.length > 0 && pending.length > 0
    ? `${plural(accepted.length, "aceptado", "aceptados")} · ${pending.length} por revisar`
    : accepted.length > 0 ? plural(accepted.length, "candidato aceptado", "candidatos aceptados")
    : pending.length > 0 ? `${plural(pending.length, "candidato", "candidatos")} por revisar`
    : "Ningún candidato aceptado";
  return { title, visible: [...accepted, ...pending], discarded };
}

export function buildWorkspaceGraph(investigation: Investigation, ghuntConnected: boolean | null = null): WorkspaceGraph {
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
    const state = actionDisplayState(investigation, action, ghuntConnected);
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
    const discovered = profileSeeds(record);
    for (const seed of discovered) {
      const title = `${seed.label} · ${seed.value}`;
      nodes.push({ id: `profile:${encodeURIComponent(record.id)}:${encodeURIComponent(seed.field)}`,
        kind: "evidence", title, state: "discovered", seedValue: seed.value, profileSeed: seed,
        evidence: record, accessibleLabel: `Semilla descubierta: ${title}.`,
        x: 836, y: TOP + index * ROW_GAP, width: NODE_WIDTH, height: NODE_HEIGHT });
    }
    // Keep historical input references addressable when a finding already feeds an action.
    if (discovered.length > 0 && !seedHasActions(seedGraph, findingSeedNodeId(record.id))) return;
    const title = record.finding && record.sourceId === "ghunt:email"
      ? `GHunt · ${GHUNT_CATEGORIES[record.finding.category] ?? record.finding.category}`
      : record.finding && record.sourceId === "facecheck:photo"
      ? `FaceCheck · ${String(record.finding.extra.score ?? "?")} · ${hostOf(record.finding.url)}`
      : record.finding
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

  // One scanner can report the same Gravatar profile by email and username. When one
  // observation feeds an action, retain the other under that seed rather than as a leaf.
  // Exact profile URL and producer matching are display grouping only, not identity proof.
  function gravatarProfileKey(node: WorkspaceNode): string | undefined {
    const record = node.evidence;
    const finding = record?.finding;
    if (node.profileSeed !== undefined || record?.sourceId !== "user-scanner:email" ||
      record.provider.trim().toLowerCase() !== "gravatar" || !finding) return undefined;
    try {
      const url = new URL(finding.url);
      if (url.protocol !== "https:" || !["gravatar.com", "www.gravatar.com"].includes(url.hostname.toLowerCase()) ||
        url.pathname === "/" || url.username || url.password) return undefined;
      return JSON.stringify([record.actionId, finding.url]);
    } catch { return undefined; }
  }
  const linkedProfiles = new Map<string, WorkspaceNode[]>();
  for (const node of nodes) {
    const key = gravatarProfileKey(node);
    if (key === undefined || !node.evidence || !seedHasActions(seedGraph, findingSeedNodeId(node.evidence.id))) continue;
    linkedProfiles.set(key, [...(linkedProfiles.get(key) ?? []), node]);
  }
  const relatedByParent = new Map<string, WorkspaceNode[]>();
  const relatedIds = new Set<string>();
  for (const node of nodes) {
    const key = gravatarProfileKey(node);
    if (key === undefined || !node.evidence || seedHasActions(seedGraph, findingSeedNodeId(node.evidence.id))) continue;
    const parents = linkedProfiles.get(key) ?? [];
    if (parents.length !== 1 || parents[0]!.evidence?.finding?.target.kind === node.evidence.finding?.target.kind) continue;
    const parent = parents[0]!;
    const related = { ...node, relatedParentId: parent.id };
    relatedByParent.set(parent.id, [...(relatedByParent.get(parent.id) ?? []), related]);
    relatedIds.add(node.id);
  }
  for (let index = 0; index < nodes.length; index++) {
    const relatedNodes = relatedByParent.get(nodes[index]!.id);
    if (relatedNodes !== undefined) nodes[index] = { ...nodes[index]!, relatedNodes };
  }

  // Only sibling leaves collapse; seeds which feed another action remain visible.
  const leavesByAction = new Map<string, WorkspaceNode[]>();
  for (const node of nodes) {
    if (node.evidence === undefined || relatedIds.has(node.id) || !actionIds.has(node.evidence.actionId) ||
      seedHasActions(seedGraph, findingSeedNodeId(node.evidence.id))) continue;
    const leaves = leavesByAction.get(node.evidence.actionId) ?? [];
    leaves.push(node);
    leavesByAction.set(node.evidence.actionId, leaves);
  }
  const groupedIds = new Set<string>();
  const latestDecision = new Map(investigation.validations.map((decision) => [decision.evidenceId, decision.status]));
  for (const [actionId, leaves] of leavesByAction) {
    const facecheck = leaves.every((leaf) => leaf.evidence?.sourceId === "facecheck:photo");
    // FaceCheck candidates always collapse so that discarded ones never surface as loose nodes.
    if (leaves.length < 2 && !facecheck) continue;
    const id = `leaf-group:${actionId}`;
    const review = facecheck ? facecheckGroupReview(leaves, latestDecision) : undefined;
    const title = review !== undefined ? review.title
      : leaves.every((leaf) => leaf.profileSeed !== undefined)
      ? `${leaves.length} semillas de Gravatar` : `${leaves.length} resultados sin acciones`;
    const members = (review?.visible ?? leaves).map((node) => ({ ...node, groupId: id }));
    for (const leaf of leaves) {
      groupedIds.add(leaf.id);
      visualSeedIds.set(findingSeedNodeId(leaf.evidence!.id), id);
    }
    nodes.push({ id, kind: "leaf-group", title, state: "leaf_group", members,
      ...(review !== undefined ? { hiddenMembers: review.discarded } : {}),
      accessibleLabel: `Grupo de semillas: ${title}.`,
      x: 836, y: TOP, width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  const visibleNodes = nodes.filter((node) => !groupedIds.has(node.id) && !relatedIds.has(node.id));

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
    const outputs = laidOut.filter((node) => node.evidence?.id === record.id ||
      node.members?.some((member) => member.evidence?.id === record.id));
    for (const to of outputs) {
      if (from === undefined || edges.some((edge) => edge.from === from.id && edge.to === to.id)) continue;
      const id = to.kind === "leaf-group" ? `action-group:${record.actionId}`
        : to.profileSeed ? `action-profile:${to.id}` : `action-evidence:${record.id}`;
      edges.push({ id, from: from.id, to: to.id, path: orthogonalPath(from, to) });
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

  return layoutBranches(laidOut, edges);
}

export function findWorkspaceNode(graph: WorkspaceGraph, id: string | null): WorkspaceNode | undefined {
  return graph.nodes.find((node) => node.id === id) ??
    graph.nodes.flatMap((node) => [...(node.members ?? []), ...(node.relatedNodes ?? [])]).find((node) => node.id === id);
}

export function workspaceNodeSelected(node: WorkspaceNode, id: string | null): boolean {
  return node.id === id || node.members?.some((member) => member.id === id) === true ||
    node.relatedNodes?.some((related) => related.id === id) === true;
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
  const nodes = [
    ...graph.nodes.filter((node) => !pageable.has(node.id) && node.kind !== "result"),
    ...visible,
    ...graph.nodes.filter((node) => node.kind === "result"),
  ];
  const ids = new Set(nodes.map((node) => node.id));
  return layoutBranches(nodes, graph.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)));
}

/** Allocate whole provenance branches together, not independent rows per column. */
function layoutBranches(nodes: readonly WorkspaceNode[], edges: readonly WorkspaceEdge[]): WorkspaceGraph {
  const children = new Map<string, string[]>();
  const incoming = new Set(edges.map((edge) => edge.to));
  for (const edge of edges) children.set(edge.from, [...(children.get(edge.from) ?? []), edge.to]);
  const positions = new Map<string, number>();
  const visiting = new Set<string>();
  let row = 0;
  function place(id: string): number {
    const existing = positions.get(id);
    if (existing !== undefined) return existing;
    if (visiting.has(id)) return TOP + row++ * ROW_GAP;
    visiting.add(id);
    const ys = (children.get(id) ?? []).map(place);
    const y = ys.length === 0 ? TOP + row++ * ROW_GAP : (ys[0]! + ys.at(-1)!) / 2;
    positions.set(id, y);
    visiting.delete(id);
    return y;
  }
  for (const node of nodes) if (!incoming.has(node.id) && children.has(node.id)) place(node.id);
  // Isolated records may share rows in different columns, but never overlap in their own.
  const bottomByColumn = new Map<number, number>();
  for (const node of nodes) {
    const y = positions.get(node.id);
    if (y !== undefined) bottomByColumn.set(node.x, Math.max(bottomByColumn.get(node.x) ?? TOP - ROW_GAP, y));
  }
  for (const node of nodes) {
    if (positions.has(node.id)) continue;
    if (children.has(node.id)) { place(node.id); continue; }
    const y = (bottomByColumn.get(node.x) ?? TOP - ROW_GAP) + ROW_GAP;
    positions.set(node.id, y);
    bottomByColumn.set(node.x, y);
  }
  const laidOut = nodes.map((node) => ({ ...node, y: positions.get(node.id)! }));
  const byId = new Map(laidOut.map((node) => [node.id, node]));
  return { width: Math.max(1100, ...laidOut.map((node) => node.x + node.width + 32)),
    height: Math.max(TOP * 2, ...laidOut.map((node) => node.y + node.height + TOP)), nodes: laidOut,
    edges: edges.map((edge) => ({ ...edge, path: orthogonalPath(byId.get(edge.from)!, byId.get(edge.to)!) })) };
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
