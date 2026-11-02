import type { EvidenceId, Investigation } from "./investigation.ts";
import { USERNAME_SEED_PATTERN } from "./seed.ts";

/** A username a finding suggests; it becomes a seed only after an operator accepts it. */
export interface UsernameProposal {
  readonly value: string;
  /** First evidence record that suggested it. */
  readonly evidenceId: EvidenceId;
  readonly provider: string;
}

function candidates(target: { readonly kind: string; readonly value: string } | undefined, discovered: unknown): string[] {
  const values = target?.kind === "username" ? [target.value] : [];
  if (typeof discovered === "string") values.push(...discovered.split(","));
  return values.map((value) => value.trim()).filter((value) => USERNAME_SEED_PATTERN.test(value));
}

/**
 * Derived from persisted evidence, never stored: username finding targets and usernames Maigret
 * discovered, in evidence order, once each, excluding every username the case already decided.
 */
export function usernameProposals(investigation: Investigation): readonly UsernameProposal[] {
  const seen = new Set((investigation.usernameSeeds ?? []).map((record) => record.value));
  const proposals: UsernameProposal[] = [];
  for (const evidence of investigation.evidence) {
    if (evidence.finding === undefined) continue;
    for (const value of candidates(evidence.finding.target, evidence.finding.extra.discovered_usernames)) {
      if (seen.has(value)) continue;
      seen.add(value);
      proposals.push({ value, evidenceId: evidence.id, provider: evidence.provider });
    }
  }
  return proposals;
}
