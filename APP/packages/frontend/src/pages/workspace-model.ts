import type { EvidenceRecord, GitHubCatalogAction, Investigation, ValidationDecision } from "@investia/core";
import { workspaceStatusLabel } from "./workspace-status";

export type WorkspaceNodeKind = "seed" | "action" | "evidence";

export interface WorkspaceNode {
  readonly id: string;
  readonly kind: WorkspaceNodeKind;
  readonly title: string;
  readonly state: string;
  readonly accessibleLabel: string;
  readonly seedValue?: string;
  readonly action?: GitHubCatalogAction;
  readonly evidence?: EvidenceRecord;
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

function nodeLabel(kind: WorkspaceNodeKind, title: string, state: string): string {
  const noun = kind === "seed" ? "Semilla" : kind === "action" ? "Acción" : "Evidencia";
  return `${noun}: ${title}. Estado: ${workspaceStatusLabel(state)}.`;
}

export function buildWorkspaceGraph(investigation: Investigation): WorkspaceGraph {
  const nodes: WorkspaceNode[] = [];
  const seedIds = new Map<string, string>();
  const actionIds = new Set(investigation.actions.map((action) => action.id));

  investigation.emailSeeds.forEach((seed, index) => {
    const id = seedNodeId(seed.value);
    seedIds.set(seed.value, id);
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

  investigation.actions.forEach((action, index) => {
    const title = "Comprobación de registro en GitHub";
    nodes.push({
      id: `action:${action.id}`,
      kind: "action",
      title,
      state: action.status,
      accessibleLabel: nodeLabel("action", `${action.id}. ${title}`, action.status),
      action,
      x: 434,
      y: TOP + index * ROW_GAP,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    });
  });

  investigation.evidence.forEach((record, index) => {
    const title = `Observación de registro GitHub · ${workspaceStatusLabel(record.status)}`;
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

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const edges: WorkspaceEdge[] = [];
  for (const action of investigation.actions) {
    const seedId = seedIds.get(action.spec.seed.value);
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
    const to = nodeById.get(`evidence:${record.id}`);
    if (from !== undefined && to !== undefined) {
      edges.push({
        id: `action-evidence:${record.id}`,
        from: from.id,
        to: to.id,
        path: orthogonalPath(from, to),
      });
    }
  }

  const rowCount = Math.max(
    investigation.emailSeeds.length,
    investigation.actions.length,
    investigation.evidence.length,
    1,
  );
  return { width: 1100, height: TOP * 2 + rowCount * ROW_GAP, nodes, edges };
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
