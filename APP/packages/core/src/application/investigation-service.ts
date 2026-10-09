import type { Observation, RegistrationObservation, RegistrationStatus } from "../domain/observation.ts";
import type { EmailSeed } from "../domain/seed.ts";
import type { SeedBox } from "../domain/seed-box.ts";
import {
  createInitialInvestigation,
  DEFAULT_INVESTIGATION_NAME,
  type AdvancementMode,
  type AuditEvent,
  type AuditKind,
  type EvidenceRecord,
  type GitHubCatalogAction,
  type Investigation,
  type InvestigationActionId,
  type InvestigationSummary,
  type ValidationStatus,
} from "../domain/investigation.ts";
import {
  executeSeedBox,
  type ExecutionState,
} from "./execute-seed-box.ts";
import type {
  ActionClaim,
  ClaimActionRequest,
  CompleteActionInput,
  ExecutionPermit,
  InvestigationExecutor,
  InvestigationStore,
} from "../ports/investigation-store.ts";

export type InvestigationIdKind = "investigation" | "audit" | "action" | "evidence" | "validation" | "claim";

export interface InvestigationServiceDependencies {
  readonly store: InvestigationStore;
  readonly executor: InvestigationExecutor;
  readonly clock: () => string;
  readonly createId: (kind: InvestigationIdKind) => string;
}

const CATALOG_ID = "github.email-registration.v1" as const;
const REGISTRATION_STATUSES: readonly RegistrationStatus[] = [
  "registered", "not_registered", "rate_limited", "error", "unknown",
];
const VALIDATION_STATUSES: readonly ValidationStatus[] = ["accepted", "rejected", "inconclusive"];
const EMAIL_PATTERN = /^(?!\.)(?!.*\.\.)([A-Z0-9_'+.\-]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9-]*\.)+[A-Z]{2,}$/i;

function timestamp(clock: () => string): string {
  const value = clock();
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error("Clock must return a valid timestamp");
  return new Date(milliseconds).toISOString();
}

function newId(createId: InvestigationServiceDependencies["createId"], kind: InvestigationIdKind): string {
  const id = createId(kind);
  if (typeof id !== "string" || id.trim().length === 0) throw new Error(`Id factory returned an empty ${kind} id`);
  return id;
}

function reasonText(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error("A non-empty reason is required");
  return value.trim();
}

function emailSeed(value: string): EmailSeed {
  const normalized = value.trim();
  if (!EMAIL_PATTERN.test(normalized)) throw new Error("A valid email seed is required");
  return { kind: "email", value: normalized };
}

function withRevision(
  current: Investigation,
  at: string,
  changes: Partial<Omit<Investigation, "id" | "revision" | "createdAt" | "updatedAt">>,
): Investigation {
  return { ...current, ...changes, revision: current.revision + 1, updatedAt: at };
}

function auditEvent(
  createId: InvestigationServiceDependencies["createId"],
  at: string,
  actor: AuditEvent["actor"],
  kind: AuditKind,
  reason: string,
  extra: Partial<Pick<AuditEvent, "actionId" | "evidenceId" | "granted" | "decision" | "unsupportedObservationCount">> = {},
): AuditEvent {
  return { id: newId(createId, "audit"), at, actor, kind, reason, ...extra };
}

function isRegistrationObservation(
  value: unknown,
): value is RegistrationObservation & { readonly seed: EmailSeed } {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as {
    readonly kind?: unknown;
    readonly seed?: { readonly kind?: unknown; readonly value?: unknown };
    readonly provider?: unknown;
    readonly status?: unknown;
  };
  return candidate.kind === "registration" &&
    candidate.seed?.kind === "email" && typeof candidate.seed.value === "string" &&
    typeof candidate.provider === "string" &&
    REGISTRATION_STATUSES.includes(candidate.status as RegistrationStatus);
}

function failureMessage(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return "Executor failed with an unprintable error.";
  }
}

function getAction(investigation: Investigation, actionId: InvestigationActionId): GitHubCatalogAction {
  const action = investigation.actions.find((candidate) => candidate.id === actionId);
  if (action === undefined) throw new Error(`Action not found: ${actionId}`);
  return action;
}

export class InvestigationService {
  private readonly dependencies: InvestigationServiceDependencies;

  constructor(dependencies: InvestigationServiceDependencies) {
    if (dependencies.executor.id.trim().length === 0) throw new Error("Executor id must not be empty");
    this.dependencies = dependencies;
  }

  async createInvestigation(name?: string, intention?: string, advancementMode?: AdvancementMode): Promise<Investigation> {
    const at = timestamp(this.dependencies.clock);
    const investigation = createInitialInvestigation(
      newId(this.dependencies.createId, "investigation"), at, name, intention, advancementMode,
    );
    await this.dependencies.store.create(investigation);
    return investigation;
  }

  async listInvestigations(): Promise<readonly InvestigationSummary[]> {
    const investigations = await this.dependencies.store.list();
    return investigations
      .map((investigation) => ({
        id: investigation.id,
        name: investigation.name ?? DEFAULT_INVESTIGATION_NAME,
        revision: investigation.revision,
        createdAt: investigation.createdAt,
        updatedAt: investigation.updatedAt,
        paused: investigation.paused,
        emailSeedCount: investigation.emailSeeds.length,
        actionCount: investigation.actions.length,
      }))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  }

  loadInvestigation(id: string): Promise<Investigation | undefined> {
    return this.dependencies.store.get(id);
  }

  async addEmailSeed(id: string, value: string, reason: string = "Email seed supplied at case level."): Promise<Investigation> {
    const seed = emailSeed(value);
    const why = reasonText(reason);
    const at = timestamp(this.dependencies.clock);
    const event = auditEvent(this.dependencies.createId, at, "operator", "email_seed_added", why);
    const action: GitHubCatalogAction = {
      id: newId(this.dependencies.createId, "action"),
      spec: { catalogId: CATALOG_ID, provider: "github", seed: { ...seed } },
      status: "queued",
      queuedByCatalog: true,
      proposedAt: at,
      proposalReason: "Catalog policy queued a GitHub registration check for the recorded email seed.",
    };
    const queued = auditEvent(this.dependencies.createId, at, "system", "action_queued", action.proposalReason, { actionId: action.id });
    return this.dependencies.store.transact(id, (current) => {
      if (current.emailSeeds.some((existing) => existing.value === seed.value)) {
        throw new Error("Email seed already exists in this investigation");
      }
      const next = withRevision(current, at, {
        emailSeeds: [...current.emailSeeds, seed],
        actions: [...current.actions, action],
        audit: [...current.audit, event, queued],
      });
      return { next, result: next };
    });
  }

  async proposeGitHubAction(id: string, email: string, reason: string): Promise<GitHubCatalogAction> {
    const seed = emailSeed(email);
    const why = reasonText(reason);
    const at = timestamp(this.dependencies.clock);
    const actionId = newId(this.dependencies.createId, "action");
    const action: GitHubCatalogAction = {
      id: actionId,
      spec: Object.freeze({ catalogId: CATALOG_ID, provider: "github", seed: Object.freeze({ ...seed }) }),
      status: "proposed",
      proposedAt: at,
      proposalReason: why,
    };
    const event = auditEvent(this.dependencies.createId, at, "operator", "action_proposed", why, { actionId });
    return this.dependencies.store.transact(id, (current) => {
      if (!current.emailSeeds.some((existing) => existing.value === seed.value)) {
        throw new Error("GitHub actions require an email seed already recorded in this investigation");
      }
      const existing = current.actions.find((candidate) => candidate.spec.catalogId === CATALOG_ID && candidate.spec.seed.value === seed.value);
      // Compatibility: an explicit historical proposal request may replace an unclaimed
      // catalog queue entry with the old proposed/approval workflow. Never alter claimed work.
      if (existing !== undefined && !(existing.status === "queued" && existing.queuedByCatalog === true && existing.approval === undefined)) {
        throw new Error("A GitHub catalog action already exists for this email seed");
      }
      const proposed = existing === undefined ? action : { ...action, id: existing.id };
      const next = withRevision(current, at, {
        actions: existing === undefined ? [...current.actions, proposed] : current.actions.map((candidate) => candidate.id === existing.id ? proposed : candidate),
        audit: [...current.audit, { ...event, actionId: proposed.id }],
      });
      return { next, result: proposed };
    });
  }

  async authorize(id: string, granted: boolean, reason: string): Promise<Investigation> {
    if (typeof granted !== "boolean") throw new Error("Authorization must be explicitly granted or denied");
    const why = reasonText(reason);
    const at = timestamp(this.dependencies.clock);
    const authorization = { granted, at, reason: why, operator: "local-operator" as const };
    const event = auditEvent(this.dependencies.createId, at, "operator", "authorization_changed", why, { granted });
    return this.dependencies.store.transact(id, (current) => {
      const next = withRevision(current, at, { authorization, audit: [...current.audit, event] });
      return { next, result: next };
    });
  }

  async approveAction(id: string, actionId: string, reason: string): Promise<GitHubCatalogAction> {
    const why = reasonText(reason);
    const at = timestamp(this.dependencies.clock);
    const approval = { at, reason: why, operator: "local-operator" as const };
    const event = auditEvent(this.dependencies.createId, at, "operator", "action_approved", why, { actionId });
    return this.dependencies.store.transact(id, (current) => {
      const action = getAction(current, actionId);
      if (action.status !== "proposed" || action.approval !== undefined) {
        throw new Error("Only a proposed action can be approved");
      }
      const approved: GitHubCatalogAction = { ...action, status: "queued", approval };
      const next = withRevision(current, at, {
        actions: current.actions.map((candidate) => candidate.id === actionId ? approved : candidate),
        audit: [...current.audit, event],
      });
      return { next, result: approved };
    });
  }

  async pause(id: string, reason: string): Promise<Investigation> {
    return this.setPaused(id, true, "paused", reason);
  }

  async resume(id: string, reason: string): Promise<Investigation> {
    return this.setPaused(id, false, "resumed", reason);
  }

  private async setPaused(id: string, paused: boolean, kind: "paused" | "resumed", reason: string): Promise<Investigation> {
    const why = reasonText(reason);
    const at = timestamp(this.dependencies.clock);
    const event = auditEvent(this.dependencies.createId, at, "operator", kind, why);
    return this.dependencies.store.transact(id, (current) => {
      const next = withRevision(current, at, { paused, audit: [...current.audit, event] });
      return { next, result: next };
    });
  }

  async validateEvidence(
    id: string,
    evidenceId: string,
    status: ValidationStatus,
    reason: string,
  ): Promise<Investigation> {
    if (!VALIDATION_STATUSES.includes(status)) throw new Error("Unsupported validation decision");
    const why = reasonText(reason);
    const at = timestamp(this.dependencies.clock);
    const decision = {
      id: newId(this.dependencies.createId, "validation"),
      evidenceId,
      status,
      reason: why,
      at,
      operator: "local-operator" as const,
    };
    const event = auditEvent(this.dependencies.createId, at, "operator", "evidence_validated", why, {
      evidenceId,
      decision: status,
    });
    return this.dependencies.store.transact(id, (current) => {
      if (!current.evidence.some((record) => record.id === evidenceId)) throw new Error(`Evidence not found: ${evidenceId}`);
      const next = withRevision(current, at, {
        validations: [...current.validations, decision],
        audit: [...current.audit, event],
      });
      return { next, result: next };
    });
  }

  async executeNextAction(id: string, automaticOnly = false): Promise<GitHubCatalogAction | undefined> {
    const claimedAt = timestamp(this.dependencies.clock);
    const claimRequest: ClaimActionRequest = {
      investigationId: id,
      automaticOnly,
      claimId: newId(this.dependencies.createId, "claim"),
      claimedAt,
      auditEvent: auditEvent(
        this.dependencies.createId,
        claimedAt,
        "system",
        "action_claimed",
        "Persisted authorization, catalog eligibility or historical approval, and unpaused state allowed this claim.",
      ),
    };
    const claim = await this.dependencies.store.claimNextAction(claimRequest);
    if (claim === undefined) return undefined;

    let observations: readonly Observation[];
    try {
      observations = await this.dependencies.executor.execute(claim.action, claim.permit);
      if (!Array.isArray(observations)) throw new Error("Executor returned a non-array result");
    } catch (error) {
      const completedAt = timestamp(this.dependencies.clock);
      const message = failureMessage(error);
      const failed = await this.dependencies.store.completeAction(this.completion(
        claim, id, completedAt, { kind: "failure", error: message },
        "Execution failed; the terminal failure was retained and automatic retries are disabled.",
      ));
      return getAction(failed, claim.action.id);
    }

    const completedAt = timestamp(this.dependencies.clock);
    const evidence: EvidenceRecord[] = [];
    let unsupportedObservationCount = 0;
    for (const observation of observations as readonly unknown[]) {
      if (
        !isRegistrationObservation(observation) || observation.provider !== "github" ||
        observation.seed.value !== claim.action.spec.seed.value
      ) {
        unsupportedObservationCount++;
        continue;
      }
      evidence.push({
        id: newId(this.dependencies.createId, "evidence"),
        actionId: claim.action.id,
        seed: { ...claim.action.spec.seed },
        provider: "github",
        status: observation.status,
        sourceId: this.dependencies.executor.id,
        recordedAt: completedAt,
      });
    }
    const completed = await this.dependencies.store.completeAction(this.completion(
      claim,
      id,
      completedAt,
      { kind: "success", evidence, unsupportedObservationCount },
      "Execution completed; supported GitHub registration observations were retained without identity attribution.",
    ));
    return getAction(completed, claim.action.id);
  }

  private completion(
    claim: ActionClaim,
    investigationId: string,
    completedAt: string,
    result: CompleteActionInput["result"],
    reason: string,
  ): CompleteActionInput {
    const successDetails = result.kind === "success"
      ? { unsupportedObservationCount: result.unsupportedObservationCount }
      : {};
    return {
      investigationId,
      actionId: claim.action.id,
      claimId: claim.action.claim.id,
      completedAt,
      result,
      auditEvent: auditEvent(
        this.dependencies.createId,
        completedAt,
        "system",
        result.kind === "success" ? "action_succeeded" : "action_failed",
        reason,
        { actionId: claim.action.id, ...successDetails },
      ),
    };
  }
}

export function createInvestigationService(dependencies: InvestigationServiceDependencies): InvestigationService {
  return new InvestigationService(dependencies);
}

export function createSeedBoxExecutor(box: SeedBox<EmailSeed, Observation>): InvestigationExecutor {
  if (box.inputKind !== "email") throw new Error("GitHub catalog execution requires an email SeedBox");
  return {
    id: box.id,
    async execute(action: GitHubCatalogAction, permit: ExecutionPermit): Promise<readonly Observation[]> {
      if (
        typeof action !== "object" || action === null || action.status !== "claimed" ||
        typeof action.claim !== "object" || action.claim === null ||
        typeof action.claim.id !== "string" || action.claim.id.trim().length === 0 ||
        typeof action.claim.claimedAt !== "string" || action.claim.claimedAt.length === 0
      ) throw new Error("SeedBox executor requires a claimed action");
      return executeSeedBox(box, action.spec.seed, permit as ExecutionState);
    },
  };
}
