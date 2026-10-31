import type { EmailSeed, UsernameSeed } from "./seed.ts";
import type { RegistrationStatus, ScannerFinding } from "./observation.ts";
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
export type AdvancementMode = "automatic" | "manual";

export function normalizeInvestigationIntention(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("Investigation intention must be a non-empty string");
  }
  return value.trim();
}

export function normalizeAdvancementMode(value: unknown): AdvancementMode {
  if (value !== "automatic" && value !== "manual") throw new Error("Unsupported advancement mode");
  return value;
}

export type EvidenceId = string;
export type ValidationStatus = "accepted" | "rejected" | "inconclusive";
export type InvestigationActionStatus = "proposed" | "queued" | "claimed" | "succeeded" | "failed";
export type AuditActor = "operator" | "system";
export type AuditKind =
  | "email_seed_added"
  | "username_seed_added"
  | "action_proposed"
  | "action_queued"
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

/** Catalog tools that run only under an explicit, per-tool consent scope. */
export type ScopedCatalogId = "user-scanner.email.v1" | "gravatar.email.v1" | "maigret.username.v1";
export const SCOPED_CATALOG_IDS: readonly ScopedCatalogId[] = Object.freeze(["user-scanner.email.v1", "gravatar.email.v1", "maigret.username.v1"]);
/** Seed kind each scoped tool accepts. */
export const CATALOG_INPUT_KINDS: Readonly<Record<ScopedCatalogId, "email" | "username">> = Object.freeze({
  "user-scanner.email.v1": "email",
  "gravatar.email.v1": "email",
  "maigret.username.v1": "username",
});
const LEGACY_CATALOG_ID = "github.email-registration.v1";

export function isScopedCatalogId(value: unknown): value is ScopedCatalogId {
  return (SCOPED_CATALOG_IDS as readonly unknown[]).includes(value);
}

export interface AuthorizationRecord {
  /** Missing on legacy grants; those never authorize the broader scanner command. */
  readonly catalogScope?: "user-scanner.email.v1";
  /** Every tool this grant consents to; missing on single-scope and legacy grants. */
  readonly catalogScopes?: readonly ScopedCatalogId[];
  readonly granted: boolean;
  readonly at: string;
  readonly reason: string;
  readonly operator: "local-operator";
}

/**
 * A grant authorizes a scoped tool only when it names that tool; grants never broaden to tools
 * added later. Historical GitHub actions keep their original unscoped gate.
 */
export function authorizationCovers(authorization: AuthorizationRecord | undefined, catalogId: string): boolean {
  if (authorization?.granted !== true) return false;
  if (catalogId === LEGACY_CATALOG_ID) return true;
  if (!isScopedCatalogId(catalogId)) return false;
  return authorization.catalogScopes?.includes(catalogId) === true || authorization.catalogScope === catalogId;
}

export interface GitHubActionSpec {
  readonly catalogId: "github.email-registration.v1";
  readonly provider: "github";
  readonly seed: EmailSeed;
}

export interface UserScannerActionSpec {
  readonly catalogId: "user-scanner.email.v1";
  readonly provider: "user-scanner";
  readonly seed: EmailSeed;
}

export interface GravatarActionSpec {
  readonly catalogId: "gravatar.email.v1";
  readonly provider: "gravatar";
  readonly seed: EmailSeed;
}

export interface MaigretActionSpec {
  readonly catalogId: "maigret.username.v1";
  readonly provider: "maigret";
  readonly seed: UsernameSeed;
}

/** Historical export name retained for consumers; it covers every catalog action spec. */
export interface GitHubCatalogAction {
  readonly id: InvestigationActionId;
  readonly spec: GitHubActionSpec | UserScannerActionSpec | GravatarActionSpec | MaigretActionSpec;
  /**
   * Explicit input seed reference (see seed-graph.ts). Absent on historical actions and on
   * actions whose input is the operator email embedded in their spec.
   */
  readonly sourceSeedId?: string;
  readonly status: InvestigationActionStatus;
  readonly proposedAt: string;
  readonly proposalReason: string;
  /** System catalog eligibility, not a human approval. Absent on historical actions. */
  readonly queuedByCatalog?: true;
  readonly approval?: ActionApproval;
  readonly claim?: { readonly id: string; readonly claimedAt: string };
  readonly completedAt?: string;
  readonly failure?: string;
  readonly unsupportedObservationCount?: number;
}

export interface EvidenceRecord {
  readonly id: EvidenceId;
  readonly actionId: InvestigationActionId;
  /** Seed of the action that produced it: an email or a confirmed username. */
  readonly seed: EmailSeed | UsernameSeed;
  readonly provider: string;
  readonly status: RegistrationStatus;
  /** Absent on historical registration observations. */
  readonly finding?: ScannerFinding;
  readonly sourceId: string;
  readonly recordedAt: string;
}

export type UsernameSeedStatus = "proposed" | "accepted" | "rejected";

/** Username seed: added by the operator, or proposed from a finding and confirmed by the operator. */
export interface UsernameSeedRecord {
  readonly kind: "username";
  readonly value: string;
  readonly origin: { readonly kind: "operator" } | { readonly kind: "evidence"; readonly evidenceId: EvidenceId };
  readonly status: UsernameSeedStatus;
  /** When the seed was added or proposed. */
  readonly at: string;
  readonly reason: string;
  /** Operator decision on a proposed seed; absent on operator-added seeds. */
  readonly decision?: { readonly at: string; readonly reason: string; readonly operator: "local-operator" };
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
  /** Missing on legacy snapshots; empty when no historical intention was supplied. */
  readonly intention?: string;
  /** Missing on legacy snapshots means manual, never automatic. */
  readonly advancementMode?: AdvancementMode;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly paused: boolean;
  readonly authorization?: AuthorizationRecord;
  readonly emailSeeds: readonly EmailSeed[];
  /** Missing on snapshots created before username seeds existed; read as empty. */
  readonly usernameSeeds?: readonly UsernameSeedRecord[];
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

export function createInitialInvestigation(
  id: InvestigationId,
  at: string,
  name?: string,
  intention?: string,
  advancementMode: AdvancementMode = "automatic",
): Investigation {
  if (id.trim().length === 0) throw new Error("Investigation id must not be empty");
  return {
    id,
    name: name === undefined ? DEFAULT_INVESTIGATION_NAME : normalizeInvestigationName(name),
    intention: intention === undefined ? "" : normalizeInvestigationIntention(intention),
    advancementMode: normalizeAdvancementMode(advancementMode),
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
