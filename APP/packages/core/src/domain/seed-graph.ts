import type {
  EvidenceId,
  EvidenceRecord,
  Investigation,
  InvestigationActionId,
  UsernameSeedRecord,
} from "./investigation.ts";

export type InvestigationSeedId = string;

/** Operator-supplied input seed. For now the only accepted entry seed. */
export interface EmailSeedNode {
  readonly kind: "email";
  readonly id: InvestigationSeedId;
  readonly value: string;
  readonly origin: { readonly kind: "operator" };
}

/** Username accepted as a seed, by the operator or from a confirmed proposal. */
export interface UsernameSeedNode {
  readonly kind: "username";
  readonly id: InvestigationSeedId;
  readonly value: string;
  readonly origin: UsernameSeedRecord["origin"];
}

/** Seed derived from one evidence record, such as "registered at Canva". */
export interface FindingSeedNode {
  readonly kind: "finding";
  readonly id: InvestigationSeedId;
  readonly evidence: EvidenceRecord;
  readonly origin: {
    readonly kind: "action";
    readonly actionId: InvestigationActionId;
    readonly evidenceId: EvidenceId;
  };
}

export type InvestigationSeedNode = EmailSeedNode | UsernameSeedNode | FindingSeedNode;

export interface InvestigationSeedGraph {
  readonly seeds: readonly InvestigationSeedNode[];
  /** Input seed per action id; undefined when no explicit input resolves. */
  readonly actionInputs: ReadonlyMap<InvestigationActionId, InvestigationSeedId | undefined>;
}

export function emailSeedNodeId(value: string): InvestigationSeedId {
  return `seed:email:${encodeURIComponent(value)}`;
}

export function usernameSeedNodeId(value: string): InvestigationSeedId {
  return `seed:username:${encodeURIComponent(value)}`;
}

export function findingSeedNodeId(evidenceId: EvidenceId): InvestigationSeedId {
  return `seed:evidence:${encodeURIComponent(evidenceId)}`;
}

/**
 * Read model of seeds and the actions they feed. Links come only from explicit references:
 * an action's sourceSeedId or the operator email embedded in its spec. Equal discovered
 * values (finding targets) never imply causality.
 */
export function investigationSeedGraph(investigation: Investigation): InvestigationSeedGraph {
  const seeds: InvestigationSeedNode[] = [];
  const seedIds = new Set<InvestigationSeedId>();
  const emailSeedIds = new Map<string, InvestigationSeedId>();

  for (const seed of investigation.emailSeeds) {
    const id = emailSeedNodeId(seed.value);
    if (seedIds.has(id)) continue;
    seedIds.add(id);
    emailSeedIds.set(seed.value, id);
    seeds.push({ kind: "email", id, value: seed.value, origin: { kind: "operator" } });
  }

  for (const record of investigation.usernameSeeds ?? []) {
    // Proposed and rejected usernames are not seeds; only accepted ones feed actions.
    if (record.status !== "accepted") continue;
    const id = usernameSeedNodeId(record.value);
    if (seedIds.has(id)) continue;
    seedIds.add(id);
    seeds.push({ kind: "username", id, value: record.value, origin: record.origin });
  }

  for (const evidence of investigation.evidence) {
    const id = findingSeedNodeId(evidence.id);
    if (seedIds.has(id)) continue;
    seedIds.add(id);
    seeds.push({
      kind: "finding",
      id,
      evidence,
      origin: { kind: "action", actionId: evidence.actionId, evidenceId: evidence.id },
    });
  }

  const actionInputs = new Map<InvestigationActionId, InvestigationSeedId | undefined>();
  for (const action of investigation.actions) {
    if (action.sourceSeedId !== undefined) {
      actionInputs.set(action.id, seedIds.has(action.sourceSeedId) ? action.sourceSeedId : undefined);
    } else {
      actionInputs.set(action.id, action.spec.seed.kind === "email" ? emailSeedIds.get(action.spec.seed.value) : undefined);
    }
  }

  return { seeds, actionInputs };
}

/** A seed without actions is a leaf. */
export function seedHasActions(graph: InvestigationSeedGraph, seedId: InvestigationSeedId): boolean {
  for (const input of graph.actionInputs.values()) {
    if (input === seedId) return true;
  }
  return false;
}
