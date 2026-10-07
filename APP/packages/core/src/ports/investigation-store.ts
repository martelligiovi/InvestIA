import type { Observation } from "../domain/observation.ts";
import type {
  AuditEvent,
  EvidenceRecord,
  GitHubCatalogAction,
  Investigation,
  InvestigationId,
} from "../domain/investigation.ts";

export interface InvestigationTransaction<T> {
  readonly next: Investigation;
  readonly result: T;
}

export interface ExecutionPermit {
  readonly authorized: true;
  readonly approved: true;
  readonly paused: false;
}

export interface ActionClaim {
  readonly action: GitHubCatalogAction & {
    readonly status: "claimed";
    readonly claim: { readonly id: string; readonly claimedAt: string };
  };
  readonly permit: ExecutionPermit;
}

export interface ClaimActionRequest {
  readonly investigationId: InvestigationId;
  readonly claimId: string;
  readonly claimedAt: string;
  readonly auditEvent: AuditEvent;
}

export type ActionCompletion =
  | {
      readonly kind: "success";
      readonly evidence: readonly EvidenceRecord[];
      readonly unsupportedObservationCount: number;
    }
  | { readonly kind: "failure"; readonly error: string };

export interface CompleteActionInput {
  readonly investigationId: InvestigationId;
  readonly actionId: string;
  readonly claimId: string;
  readonly completedAt: string;
  readonly result: ActionCompletion;
  readonly auditEvent: AuditEvent;
}

/**
 * PostgreSQL is the durable source of truth; any graph store is only a downstream projection.
 * Durable adapters must commit transact(), claimNextAction(), and completeAction() atomically,
 * incrementing revision once per committed mutation. A claimed action is never made claimable
 * again: after a crash its external outcome is unknown and requires operator review, not retry.
 * This prevents duplicate application dispatches, but does not guarantee exactly-once remote effects.
 */
export interface InvestigationStore {
  create(investigation: Investigation): Promise<void>;
  get(id: InvestigationId): Promise<Investigation | undefined>;
  list(): Promise<readonly Investigation[]>;
  transact<T>(
    id: InvestigationId,
    operation: (current: Investigation) => InvestigationTransaction<T>,
  ): Promise<T>;
  /** Atomically checks persisted authorization, action approval, and pause state while claiming. */
  claimNextAction(input: ClaimActionRequest): Promise<ActionClaim | undefined>;
  /** Atomically records a terminal outcome only for the matching in-flight claim. */
  completeAction(input: CompleteActionInput): Promise<Investigation>;
}

/** Executor port deliberately accepts only a claimed action and its store-issued permit. */
export interface InvestigationExecutor {
  readonly id: string;
  execute(action: ActionClaim["action"], permit: ExecutionPermit): Promise<readonly Observation[]>;
}
