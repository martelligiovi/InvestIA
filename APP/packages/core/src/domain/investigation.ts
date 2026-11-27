import type { EmailSeed, PhotoSeed, UrlSeed, UsernameSeed } from "./seed.ts";
import { findingSeedNodeId } from "./seed-graph.ts";
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
  | "username_proposal_accepted"
  | "username_proposal_rejected"
  | "action_proposed"
  | "action_queued"
  | "action_rerun_requested"
  | "action_rerun_succeeded"
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

/** Catalog tools that require an active investigation grant covering their scope. */
export type ScopedCatalogId = "user-scanner.email.v1" | "gravatar.email.v1" | "maigret.username.v1" | "ghunt.email.v1" | "facecheck.photo.v1" | "decodo.url.v1";
export const SCOPED_CATALOG_IDS: readonly ScopedCatalogId[] = Object.freeze([
  "user-scanner.email.v1", "gravatar.email.v1", "maigret.username.v1", "ghunt.email.v1", "facecheck.photo.v1", "decodo.url.v1",
]);
/** Seed kind each scoped tool accepts. */
export const CATALOG_INPUT_KINDS: Readonly<Record<ScopedCatalogId, "email" | "username" | "photo" | "url">> = Object.freeze({
  "user-scanner.email.v1": "email",
  "gravatar.email.v1": "email",
  "maigret.username.v1": "username",
  "ghunt.email.v1": "email",
  "facecheck.photo.v1": "photo",
  "decodo.url.v1": "url",
});
/** GHunt only applies to Google consumer accounts. */
export const GHUNT_EMAIL_DOMAINS: readonly string[] = Object.freeze(["gmail.com", "googlemail.com"]);
export function isGhuntEligibleEmail(value: string): boolean {
  const at = value.lastIndexOf("@");
  return at > 0 && GHUNT_EMAIL_DOMAINS.includes(value.slice(at + 1).toLowerCase());
}
const LEGACY_CATALOG_ID = "github.email-registration.v1";

export function isScopedCatalogId(value: unknown): value is ScopedCatalogId {
  return (SCOPED_CATALOG_IDS as readonly unknown[]).includes(value);
}

export interface AuthorizationRecord {
  /** Compatibility marker that grants only the User Scanner scope by itself. */
  readonly catalogScope?: "user-scanner.email.v1";
  /** Explicit tool scopes recorded at grant time. */
  readonly catalogScopes?: readonly ScopedCatalogId[];
  readonly granted: boolean;
  readonly at: string;
  readonly reason: string;
  readonly operator: "local-operator";
}

/**
 * Scoped tools require their own scope, except Decodo also accepts the FaceCheck scope.
 * Unknown tools are never covered. Historical GitHub actions still require only an active grant.
 */
export function authorizationCovers(authorization: AuthorizationRecord | undefined, catalogId: string): boolean {
  if (authorization?.granted !== true) return false;
  if (catalogId === LEGACY_CATALOG_ID) return true;
  if (!isScopedCatalogId(catalogId)) return false;
  if (authorization.catalogScope === catalogId) return true;
  const scopes = authorization.catalogScopes;
  return Array.isArray(scopes) && (scopes.includes(catalogId) ||
    (catalogId === "decodo.url.v1" && scopes.includes("facecheck.photo.v1")));
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

export interface GhuntActionSpec {
  readonly catalogId: "ghunt.email.v1";
  readonly provider: "ghunt";
  readonly seed: EmailSeed;
}

export interface FacecheckActionSpec {
  readonly catalogId: "facecheck.photo.v1";
  readonly provider: "facecheck";
  readonly seed: PhotoSeed;
}

export interface DecodoActionSpec {
  readonly catalogId: "decodo.url.v1";
  readonly provider: "decodo";
  readonly seed: UrlSeed;
}

/** Historical export name retained for consumers; it covers every catalog action spec. */
export interface GitHubCatalogAction {
  readonly id: InvestigationActionId;
  readonly spec: GitHubActionSpec | UserScannerActionSpec | GravatarActionSpec | MaigretActionSpec | GhuntActionSpec | FacecheckActionSpec | DecodoActionSpec;
  /**
   * Explicit input seed reference (see seed-graph.ts). Absent on historical actions and on
   * actions whose input is the operator email embedded in their spec.
   */
  readonly sourceSeedId?: string;
  /** Producing action for a follow-up with no finding seed. */
  readonly sourceActionId?: InvestigationActionId;
  readonly status: InvestigationActionStatus;
  /** Prior results stay active while a replacement claim is queued or running. */
  readonly rerun?: { readonly previousStatus: "succeeded" | "failed"; readonly fingerprint: string };
  readonly lastRerunFailed?: true;
  readonly lastRerunFailure?: string;
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
  /** Seed of the producing action: an email, confirmed username, profile photo or page URL. */
  readonly seed: EmailSeed | UsernameSeed | PhotoSeed | UrlSeed;
  readonly provider: string;
  readonly status: RegistrationStatus;
  /** Absent on historical registration observations. */
  readonly finding?: ScannerFinding;
  readonly sourceId: string;
  readonly recordedAt: string;
}

export type UsernameSeedStatus = "accepted" | "rejected";

/**
 * Username decided by the operator: added directly, or a proposal derived from a finding that the
 * operator accepted or rejected. Undecided proposals are derived from evidence, never stored.
 */
export interface UsernameSeedRecord {
  readonly kind: "username";
  readonly value: string;
  readonly origin: { readonly kind: "operator" } | { readonly kind: "evidence"; readonly evidenceId: EvidenceId };
  readonly status: UsernameSeedStatus;
  /** When the operator added it or decided on its proposal. */
  readonly at: string;
  /** Why it was added, or which finding proposed it. */
  readonly reason: string;
  /** Operator decision on a proposal; absent on operator-added seeds. */
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
  /** Per-attempt detail for an action failure; public views must sanitize it. */
  readonly failure?: string;
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

export function latestValidationStatus(investigation: Investigation, evidenceId: EvidenceId): ValidationStatus | undefined {
  for (let index = investigation.validations.length - 1; index >= 0; index--) {
    const decision = investigation.validations[index]!;
    if (decision.evidenceId === evidenceId) return decision.status;
  }
  return undefined;
}

export function facecheckParentEvidence(investigation: Investigation, sourceSeedId: string | undefined): EvidenceRecord | undefined {
  if (sourceSeedId === undefined) return undefined;
  return investigation.evidence.find((record) => record.sourceId === "facecheck:photo" && findingSeedNodeId(record.id) === sourceSeedId);
}

/** Recheck against the persisted snapshot when claiming a linked scrape. */
export function isActionEligibleByParentValidation(investigation: Investigation, action: GitHubCatalogAction): boolean {
  if (action.spec.catalogId !== "decodo.url.v1" || action.sourceSeedId === undefined) return true;
  const parent = facecheckParentEvidence(investigation, action.sourceSeedId);
  return parent !== undefined && latestValidationStatus(investigation, parent.id) === "accepted";
}

export type InvestigationOperationalStatus =
  | "paused"
  | "awaiting_authorization"
  | "claimed_uncertain"
  | "awaiting_google_connection"
  | "google_connection_unknown"
  | "manual_queue"
  | "automatic_queue"
  | "no_executable_actions";

export interface InvestigationOperationalReadiness {
  readonly ghuntConnected?: boolean | null;
  readonly decodoConfigured?: boolean | null;
}

export function hasCatalogAuthorization(investigation: Investigation): boolean {
  return investigation.authorization?.granted === true &&
    investigation.actions.every((action) => authorizationCovers(investigation.authorization, action.spec.catalogId));
}

export function actionOperationalState(
  investigation: Investigation,
  action: GitHubCatalogAction,
  { ghuntConnected, decodoConfigured }: InvestigationOperationalReadiness = {},
) {
  if (action.status !== "queued") return action.status;
  if (!authorizationCovers(investigation.authorization, action.spec.catalogId)) return "waiting_authorization";
  if (investigation.paused) return "paused_queue";
  if (action.spec.catalogId === "ghunt.email.v1" && ghuntConnected !== true) return ghuntConnected === false ? "waiting_google" : "unknown_google";
  if (!action.queuedByCatalog && action.approval === undefined) return "not_executable";
  if (action.spec.catalogId === "decodo.url.v1") {
    if (!isActionEligibleByParentValidation(investigation, action)) return "waiting_facecheck_acceptance";
    if (decodoConfigured !== true) return decodoConfigured === false ? "waiting_decodo_token" : "unknown_decodo_token";
  }
  // Historical unlinked Gravatar queues run only after their user-scanner result links them.
  if (action.spec.catalogId === "gravatar.email.v1" && action.sourceSeedId === undefined && action.approval === undefined) {
    return "waiting_scanner";
  }
  return "queued";
}

export function investigationOperationalStatus(
  investigation: Investigation,
  readiness?: InvestigationOperationalReadiness,
): InvestigationOperationalStatus {
  if (investigation.paused) return "paused";
  if (!hasCatalogAuthorization(investigation)) return "awaiting_authorization";
  if (investigation.actions.some((action) => action.status === "claimed")) return "claimed_uncertain";
  let waitingGoogle = false;
  let unknownGoogle = false;
  for (const action of investigation.actions) {
    const state = actionOperationalState(investigation, action, readiness);
    if (state === "queued") return investigation.advancementMode === "automatic" ? "automatic_queue" : "manual_queue";
    if (state === "waiting_google") waitingGoogle = true;
    if (state === "unknown_google") unknownGoogle = true;
  }
  if (waitingGoogle) return "awaiting_google_connection";
  if (unknownGoogle) return "google_connection_unknown";
  return investigation.advancementMode === "automatic" ? "no_executable_actions" : "manual_queue";
}

export interface InvestigationSummary {
  readonly id: InvestigationId;
  readonly name: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly paused: boolean;
  readonly status: InvestigationOperationalStatus;
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
