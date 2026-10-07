import type { AuditEvent, EvidenceRecord, GitHubCatalogAction, Investigation } from "@investia/core";

export interface Neo4jRecordLike {
  get(key: string): unknown;
}

export interface Neo4jResultLike {
  readonly records: readonly Neo4jRecordLike[];
}

export interface Neo4jTransactionLike {
  run(query: string, parameters?: Record<string, unknown>): Promise<Neo4jResultLike>;
}

export interface Neo4jSessionLike {
  run(query: string, parameters?: Record<string, unknown>): Promise<Neo4jResultLike>;
  executeWrite<T>(operation: (transaction: Neo4jTransactionLike) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface Neo4jDriverLike {
  session(options?: { readonly database?: string }): Neo4jSessionLike;
  close(): Promise<void>;
}

export interface ProjectionResult {
  readonly revision: number;
  readonly status: "applied" | "stale";
}

export interface InvestigationProjector {
  project(investigation: Investigation): Promise<ProjectionResult>;
}

const FENCE_AND_INVESTIGATION = `
  MERGE (i:Investigation {id: $investigationId})
  ON CREATE SET i.revision = -1
  SET i.revision = CASE WHEN i.revision < $revision THEN $revision ELSE i.revision END
  WITH i
  WHERE i.revision = $revision
  SET i.createdAt = $createdAt,
      i.updatedAt = $updatedAt,
      i.paused = $paused,
      i.authorizationGranted = $authorizationGranted,
      i.authorizationAt = $authorizationAt,
      i.authorizationReason = $authorizationReason
  RETURN i.revision AS revision`;

const PROJECT_SEEDS = `
  MATCH (i:Investigation {id: $investigationId})
  WHERE i.revision = $revision
  UNWIND $seeds AS seed
  MERGE (s:EmailSeed {investigationId: $investigationId, value: seed.value})
  SET s.kind = seed.kind
  MERGE (i)-[:HAS_SEED]->(s)`;

const PROJECT_ACTIONS = `
  MATCH (i:Investigation {id: $investigationId})
  WHERE i.revision = $revision
  UNWIND $actions AS action
  MERGE (a:CatalogAction {investigationId: $investigationId, id: action.id})
  SET a.catalogId = action.catalogId,
      a.provider = action.provider,
      a.seedValue = action.seedValue,
      a.status = action.status,
      a.proposedAt = action.proposedAt,
      a.proposalReason = action.proposalReason,
      a.approvalAt = action.approvalAt,
      a.approvalReason = action.approvalReason,
      a.claimId = action.claimId,
      a.claimedAt = action.claimedAt,
      a.completedAt = action.completedAt,
      a.unsupportedObservationCount = action.unsupportedObservationCount
  MERGE (i)-[:HAS_ACTION]->(a)
  MERGE (s:EmailSeed {investigationId: $investigationId, value: action.seedValue})
  MERGE (a)-[:USES_SEED]->(s)`;

const PROJECT_EVIDENCE = `
  MATCH (i:Investigation {id: $investigationId})
  WHERE i.revision = $revision
  UNWIND $evidence AS record
  MERGE (e:Evidence {investigationId: $investigationId, id: record.id})
  SET e.actionId = record.actionId,
      e.seedValue = record.seedValue,
      e.provider = record.provider,
      e.status = record.status,
      e.sourceId = record.sourceId,
      e.recordedAt = record.recordedAt
  MERGE (i)-[:HAS_EVIDENCE]->(e)
  MERGE (s:EmailSeed {investigationId: $investigationId, value: record.seedValue})
  MERGE (s)-[:HAS_EVIDENCE]->(e)
  MERGE (a:CatalogAction {investigationId: $investigationId, id: record.actionId})
  MERGE (a)-[:PRODUCED]->(e)`;

const PROJECT_VALIDATIONS = `
  MATCH (i:Investigation {id: $investigationId})
  WHERE i.revision = $revision
  UNWIND $validations AS decision
  MERGE (v:EvidenceValidation {investigationId: $investigationId, id: decision.id})
  SET v.evidenceId = decision.evidenceId,
      v.status = decision.status,
      v.reason = decision.reason,
      v.at = decision.at,
      v.operator = decision.operator
  MERGE (i)-[:HAS_VALIDATION]->(v)
  WITH i, decision, v
  MATCH (e:Evidence {investigationId: $investigationId, id: decision.evidenceId})
  MERGE (e)-[:HAS_VALIDATION]->(v)`;

const PROJECT_AUDIT = `
  MATCH (i:Investigation {id: $investigationId})
  WHERE i.revision = $revision
  UNWIND $audit AS event
  MERGE (a:AuditEvent {investigationId: $investigationId, id: event.id})
  SET a.at = event.at,
      a.actor = event.actor,
      a.kind = event.kind,
      a.reason = event.reason,
      a.actionId = event.actionId,
      a.evidenceId = event.evidenceId,
      a.granted = event.granted,
      a.decision = event.decision,
      a.unsupportedObservationCount = event.unsupportedObservationCount
  MERGE (i)-[:HAS_AUDIT_EVENT]->(a)`;

const SCHEMA_CONSTRAINTS = [
  "CREATE CONSTRAINT investigation_id_unique IF NOT EXISTS FOR (n:Investigation) REQUIRE n.id IS UNIQUE",
  "CREATE CONSTRAINT email_seed_unique IF NOT EXISTS FOR (n:EmailSeed) REQUIRE (n.investigationId, n.value) IS UNIQUE",
  "CREATE CONSTRAINT catalog_action_unique IF NOT EXISTS FOR (n:CatalogAction) REQUIRE (n.investigationId, n.id) IS UNIQUE",
  "CREATE CONSTRAINT evidence_unique IF NOT EXISTS FOR (n:Evidence) REQUIRE (n.investigationId, n.id) IS UNIQUE",
  "CREATE CONSTRAINT validation_unique IF NOT EXISTS FOR (n:EvidenceValidation) REQUIRE (n.investigationId, n.id) IS UNIQUE",
  "CREATE CONSTRAINT audit_event_unique IF NOT EXISTS FOR (n:AuditEvent) REQUIRE (n.investigationId, n.id) IS UNIQUE",
] as const;

function actionProjection(action: GitHubCatalogAction) {
  return {
    id: action.id,
    catalogId: action.spec.catalogId,
    provider: action.spec.provider,
    seedValue: action.spec.seed.value,
    status: action.status,
    proposedAt: action.proposedAt,
    proposalReason: action.proposalReason,
    approvalAt: action.approval?.at ?? null,
    approvalReason: action.approval?.reason ?? null,
    claimId: action.claim?.id ?? null,
    claimedAt: action.claim?.claimedAt ?? null,
    completedAt: action.completedAt ?? null,
    unsupportedObservationCount: action.unsupportedObservationCount ?? null,
  };
}

function evidenceProjection(record: EvidenceRecord) {
  return {
    id: record.id,
    actionId: record.actionId,
    seedValue: record.seed.value,
    provider: record.provider,
    status: record.status,
    sourceId: record.sourceId,
    recordedAt: record.recordedAt,
  };
}

function auditProjection(event: AuditEvent) {
  return {
    id: event.id,
    at: event.at,
    actor: event.actor,
    kind: event.kind,
    reason: event.reason,
    actionId: event.actionId ?? null,
    evidenceId: event.evidenceId ?? null,
    granted: event.granted ?? null,
    decision: event.decision ?? null,
    unsupportedObservationCount: event.unsupportedObservationCount ?? null,
  };
}

function graphRevision(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "object" && value !== null && "toNumber" in value && typeof value.toNumber === "function") {
    const converted: unknown = value.toNumber();
    return typeof converted === "number" && Number.isSafeInteger(converted) ? converted : undefined;
  }
  return undefined;
}

export class Neo4jInvestigationProjector implements InvestigationProjector {
  private readonly driver: Neo4jDriverLike;
  private readonly database: string;
  private constraintsReady = false;
  private constraintsSetup?: Promise<void>;

  constructor(driver: Neo4jDriverLike, database: string) {
    if (database.trim().length === 0) throw new Error("Neo4j database must not be empty.");
    this.driver = driver;
    this.database = database;
  }

  private ensureConstraints(session: Neo4jSessionLike): Promise<void> {
    if (this.constraintsReady) return Promise.resolve();
    if (this.constraintsSetup === undefined) {
      this.constraintsSetup = (async () => {
        for (const query of SCHEMA_CONSTRAINTS) await session.run(query);
      })().then(() => {
        this.constraintsReady = true;
      }).finally(() => {
        this.constraintsSetup = undefined;
      });
    }
    return this.constraintsSetup;
  }

  async project(investigation: Investigation): Promise<ProjectionResult> {
    if (!Number.isSafeInteger(investigation.revision) || investigation.revision < 0) {
      throw new Error("Cannot project an invalid investigation revision.");
    }

    const session = this.driver.session({ database: this.database });
    try {
      await this.ensureConstraints(session);
      const applied = await session.executeWrite(async (transaction) => {
        const fence = await transaction.run(FENCE_AND_INVESTIGATION, {
          investigationId: investigation.id,
          revision: investigation.revision,
          createdAt: investigation.createdAt,
          updatedAt: investigation.updatedAt,
          paused: investigation.paused,
          authorizationGranted: investigation.authorization?.granted ?? null,
          authorizationAt: investigation.authorization?.at ?? null,
          authorizationReason: investigation.authorization?.reason ?? null,
        });
        const persistedRevision = graphRevision(fence.records[0]?.get("revision"));
        if (persistedRevision !== investigation.revision) return false;

        const common = { investigationId: investigation.id, revision: investigation.revision };
        await transaction.run(PROJECT_SEEDS, {
          ...common,
          seeds: investigation.emailSeeds.map((seed) => ({ kind: seed.kind, value: seed.value })),
        });
        await transaction.run(PROJECT_ACTIONS, {
          ...common,
          actions: investigation.actions.map(actionProjection),
        });
        await transaction.run(PROJECT_EVIDENCE, {
          ...common,
          evidence: investigation.evidence.map(evidenceProjection),
        });
        await transaction.run(PROJECT_VALIDATIONS, {
          ...common,
          validations: investigation.validations.map((decision) => ({ ...decision })),
        });
        await transaction.run(PROJECT_AUDIT, {
          ...common,
          audit: investigation.audit.map(auditProjection),
        });
        return true;
      });
      return { revision: investigation.revision, status: applied ? "applied" : "stale" };
    } finally {
      await session.close();
    }
  }
}
