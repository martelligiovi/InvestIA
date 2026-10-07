import type { EmailSeed } from "./seed.ts";
import type { RegistrationStatus } from "./observation.ts";
export type { RegistrationStatus } from "./observation.ts";

export type InvestigationId = string;
export type InvestigationActionId = string;
export const DEFAULT_INVESTIGATION_NAME = "Untitled investigation";
export const INVESTIGATION_NAME_MAX_LENGTH = 120;

export function normalizeInvestigationName(value: unknown): string {
  if (typeof value !== "string") throw new Error("Investigation name must be a string");
  const name = value.trim();
  if (name.length === 0) throw new Error("Investigation name must not be empty");
  if ([...name].length > INVESTIGATION_NAME_MAX_LENGTH) {
    throw new Error(`Investigation name must be at most ${INVESTIGATION_NAME_MAX_LENGTH} characters`);
  }
  return name;
}
export type EvidenceId = string;
export type ValidationStatus = "accepted" | "rejected" | "inconclusive";
export type InvestigationActionStatus = "proposed" | "queued" | "claimed" | "succeeded" | "failed";
export type AuditActor = "operator" | "system";
export type AuditKind =
  | "email_seed_added"
  | "action_proposed"
  | "authorization_changed"
  | "action_approved"
  | "paused"
  | "resumed"
  | "action_claimed"
  | "action_succeeded"
  | "action_failed"
  | "evidence_validated";

export interface ActionApproval {
  readonly at: string;
  readonly reason: string;
  readonly operator: "local-operator";
}

export interface AuthorizationRecord {
  readonly granted: boolean;
  readonly at: string;
  readonly reason: string;
  readonly operator: "local-operator";
}

export interface GitHubActionSpec {
  readonly catalogId: "github.email-registration.v1";
  readonly provider: "github";
  readonly seed: EmailSeed;
}

export interface GitHubCatalogAction {
  readonly id: InvestigationActionId;
  readonly spec: GitHubActionSpec;
  readonly status: InvestigationActionStatus;
  readonly proposedAt: string;
  readonly proposalReason: string;
  readonly approval?: ActionApproval;
  readonly claim?: { readonly id: string; readonly claimedAt: string };
  readonly completedAt?: string;
  readonly failure?: string;
  readonly unsupportedObservationCount?: number;
}

export interface EvidenceRecord {
  readonly id: EvidenceId;
  readonly actionId: InvestigationActionId;
  readonly seed: EmailSeed;
  readonly provider: "github";
  readonly status: RegistrationStatus;
  readonly sourceId: string;
  readonly recordedAt: string;
}

export interface ValidationDecision {
  readonly id: string;
  readonly evidenceId: EvidenceId;
  readonly status: ValidationStatus;
  readonly reason: string;
  readonly at: string;
  readonly operator: "local-operator";
}

export interface AuditEvent {
  readonly id: string;
  readonly at: string;
  readonly actor: AuditActor;
  readonly kind: AuditKind;
  readonly reason: string;
  readonly actionId?: InvestigationActionId;
  readonly evidenceId?: EvidenceId;
  readonly granted?: boolean;
  readonly decision?: ValidationStatus;
  readonly unsupportedObservationCount?: number;
}

export interface Investigation {
  readonly id: InvestigationId;
  /** Optional only for schema-v1 snapshots created before names were persisted. */
  readonly name?: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly paused: boolean;
  readonly authorization?: AuthorizationRecord;
  readonly emailSeeds: readonly EmailSeed[];
  readonly actions: readonly GitHubCatalogAction[];
  readonly evidence: readonly EvidenceRecord[];
  readonly validations: readonly ValidationDecision[];
  readonly audit: readonly AuditEvent[];
}

export interface InvestigationSummary {
  readonly id: InvestigationId;
  readonly name: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly paused: boolean;
  readonly emailSeedCount: number;
  readonly actionCount: number;
}

export function createInitialInvestigation(id: InvestigationId, at: string, name?: string): Investigation {
  if (id.trim().length === 0) throw new Error("Investigation id must not be empty");
  return {
    id,
    name: name === undefined ? DEFAULT_INVESTIGATION_NAME : normalizeInvestigationName(name),
    revision: 0,
    createdAt: at,
    updatedAt: at,
    paused: false,
    emailSeeds: [],
    actions: [],
    evidence: [],
    validations: [],
    audit: [],
  };
}
