import { actionBranch, type ActionBranch } from "./action-branch.ts";
import type { GitHubCatalogAction, Investigation } from "./investigation.ts";
import { sha256Hex } from "./sha256.ts";

export class ActionRerunConflictError extends Error {
  constructor() {
    super("The action cannot be rerun in the current state");
    this.name = "ActionRerunConflictError";
  }
}

function branchFingerprint(investigation: Investigation, rootId: string, { actionIds, evidenceIds }: ActionBranch): string {
  // The root itself moves through queued and claimed. Only its previous results and dependent data are fenced.
  const branch = [
    investigation.actions.filter(({ id }) => id !== rootId && actionIds.has(id)),
    investigation.evidence.filter(({ id }) => evidenceIds.has(id)),
    investigation.validations.filter(({ evidenceId }) => evidenceIds.has(evidenceId)),
    investigation.usernameSeeds?.filter(({ origin }) => origin.kind === "evidence" && evidenceIds.has(origin.evidenceId)) ?? [],
  ];
  return sha256Hex(JSON.stringify(branch));
}

export function prepareActionRerun(investigation: Investigation, action: GitHubCatalogAction): GitHubCatalogAction {
  if ((action.status !== "succeeded" && action.status !== "failed") || action.rerun) throw new ActionRerunConflictError();
  const branch = actionBranch(investigation, action.id);
  const blocked = pendingRerunDescendants(investigation);
  if (blocked.has(action.id) || investigation.actions.some((child) =>
    child.id !== action.id && branch.actionIds.has(child.id) && (child.status === "claimed" || child.rerun !== undefined),
  )) throw new ActionRerunConflictError();
  const { claim: _priorClaim, lastRerunFailed: _priorFailure, ...prior } = action;
  return { ...prior, status: "queued", rerun: {
    previousStatus: action.status,
    fingerprint: branchFingerprint(investigation, action.id, branch),
  } };
}

export function pendingRerunDescendants(investigation: Investigation): ReadonlySet<string> {
  const blocked = new Set<string>();
  for (const action of investigation.actions) {
    if (action.rerun === undefined) continue;
    for (const id of actionBranch(investigation, action.id).actionIds) if (id !== action.id) blocked.add(id);
  }
  return blocked;
}

export function canReplaceActionResults(investigation: Investigation, action: GitHubCatalogAction): boolean {
  if (action.rerun === undefined) return false;
  try {
    const branch = actionBranch(investigation, action.id);
    return !investigation.actions.some(({ id, status }) => id !== action.id && branch.actionIds.has(id) && status === "claimed") &&
      branchFingerprint(investigation, action.id, branch) === action.rerun.fingerprint;
  } catch {
    // Inconsistent provenance must never result in deleting existing work.
    return false;
  }
}
