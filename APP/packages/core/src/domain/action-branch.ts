import type { EvidenceId, EvidenceRecord, Investigation, InvestigationActionId } from "./investigation.ts";
import { findingSeedNodeId } from "./seed-graph.ts";

export interface ActionBranch {
  /** Includes the root action, which survives a successful replacement. */
  readonly actionIds: ReadonlySet<InvestigationActionId>;
  readonly evidenceIds: ReadonlySet<EvidenceId>;
}

function append<K, V>(index: Map<K, V[]>, key: K, value: V): void {
  const entries = index.get(key);
  if (entries) entries.push(value);
  else index.set(key, [value]);
}

/** Follow explicit provenance only; equal seed values never establish ownership. */
export function actionBranch(investigation: Investigation, rootId: InvestigationActionId): ActionBranch {
  const childrenBySeed = new Map<string, InvestigationActionId[]>();
  const evidenceByAction = new Map<InvestigationActionId, EvidenceRecord[]>();
  for (const action of investigation.actions) {
    if (action.sourceSeedId !== undefined) append(childrenBySeed, action.sourceSeedId, action.id);
  }
  for (const evidence of investigation.evidence) append(evidenceByAction, evidence.actionId, evidence);

  const actionIds = new Set([rootId]);
  const evidenceIds = new Set<EvidenceId>();
  // Set iteration visits entries added during traversal as well as the initial root.
  for (const actionId of actionIds) {
    for (const evidence of evidenceByAction.get(actionId) ?? []) {
      evidenceIds.add(evidence.id);
      for (const child of childrenBySeed.get(findingSeedNodeId(evidence.id)) ?? []) {
        if (child === rootId) throw new Error("Cannot replace a cyclic action branch");
        actionIds.add(child);
      }
    }
  }
  return { actionIds, evidenceIds };
}

/** Prepare the active snapshot for a replacement; the caller commits it only upon success. */
export function withoutActionResults(investigation: Investigation, rootId: InvestigationActionId): Investigation {
  const { actionIds, evidenceIds } = actionBranch(investigation, rootId);
  return {
    ...investigation,
    actions: investigation.actions.filter(({ id }) => id === rootId || !actionIds.has(id)),
    evidence: investigation.evidence.filter(({ id }) => !evidenceIds.has(id)),
    validations: investigation.validations.filter(({ evidenceId }) => !evidenceIds.has(evidenceId)),
    ...(investigation.usernameSeeds === undefined ? {} : {
      usernameSeeds: investigation.usernameSeeds.filter(({ origin }) => origin.kind !== "evidence" || !evidenceIds.has(origin.evidenceId)),
    }),
  };
}
