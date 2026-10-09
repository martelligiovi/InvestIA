import { readFile } from "node:fs/promises";
import {
  DEFAULT_INVESTIGATION_NAME,
  normalizeInvestigationName,
  type ActionClaim,
  type ClaimActionRequest,
  type CompleteActionInput,
  type Investigation,
  type InvestigationStore,
  type InvestigationTransaction,
} from "@investia/core";
import type { QueryResultRow } from "pg";

export interface PgQueryResult<T extends QueryResultRow = QueryResultRow> {
  readonly rows: T[];
  readonly rowCount: number | null;
}

export interface PgClientLike {
  query<T extends QueryResultRow = QueryResultRow>(sql: string, values?: unknown[]): Promise<PgQueryResult<T>>;
  release(error?: Error): void;
}

export interface PgPoolLike {
  query<T extends QueryResultRow = QueryResultRow>(sql: string, values?: unknown[]): Promise<PgQueryResult<T>>;
  connect(): Promise<PgClientLike>;
}

export class InvestigationNotFoundError extends Error {
  constructor(id: string) {
    super(`Investigation not found: ${id}`);
    this.name = "InvestigationNotFoundError";
  }
}

export class InvestigationClaimConflictError extends Error {
  constructor() {
    super("The action claim is no longer active.");
    this.name = "InvestigationClaimConflictError";
  }
}

export class InvestigationSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvestigationSchemaError";
  }
}

interface StoredRow extends QueryResultRow {
  readonly id: string;
  readonly schema_version: number;
  readonly revision: string | number;
  readonly document: unknown;
}

interface Mutation<T> {
  readonly next?: Investigation;
  readonly result: T;
}

const DOCUMENT_SCHEMA_VERSION = 1;
const MIGRATION_VERSION = 1;
const MIGRATION_LOCK_ID = 1163287874;
const MIGRATION_URL = new URL("../migrations/001_investigations.sql", import.meta.url);
const SELECT_LOCKED = `
  SELECT id, schema_version, revision, document
  FROM investigations
  WHERE id = $1
  FOR UPDATE`;
const INSERT_INVESTIGATION = `
  INSERT INTO investigations (id, schema_version, revision, created_at, updated_at, document)
  VALUES ($1, $2, $3, $4, $5, $6::jsonb)`;
const UPDATE_INVESTIGATION = `
  UPDATE investigations
  SET schema_version = $2, revision = $3, updated_at = $4, document = $5::jsonb
  WHERE id = $1`;

async function inTransaction<T>(pool: PgPoolLike, operation: (client: PgClientLike) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let started = false;
  let failed = false;
  let discardError: Error | undefined;
  try {
    await client.query("BEGIN");
    started = true;
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    failed = true;
    if (started) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        discardError = rollbackError instanceof Error ? rollbackError : new Error("Transaction rollback failed.");
      }
    }
    throw error;
  } finally {
    try {
      client.release(discardError);
    } catch (releaseError) {
      if (!failed) throw releaseError;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNormalizedInvestigationName(value: unknown): value is string {
  try {
    return normalizeInvestigationName(value) === value;
  } catch {
    return false;
  }
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isApproval(value: unknown): boolean {
  return isRecord(value) && isTimestamp(value.at) && isNonEmptyString(value.reason) &&
    value.operator === "local-operator";
}

function isAuthorization(value: unknown): boolean {
  return isRecord(value) && typeof value.granted === "boolean" && isTimestamp(value.at) &&
    isNonEmptyString(value.reason) && value.operator === "local-operator";
}

function isStoredAction(value: unknown): boolean {
  if (!isRecord(value) || !isNonEmptyString(value.id) || !isRecord(value.spec)) return false;
  const seed = value.spec.seed;
  if (
    value.spec.catalogId !== "github.email-registration.v1" || value.spec.provider !== "github" ||
    !isRecord(seed) || seed.kind !== "email" || !isNonEmptyString(seed.value) ||
    !["proposed", "queued", "claimed", "succeeded", "failed"].includes(String(value.status)) ||
    !isTimestamp(value.proposedAt) || !isNonEmptyString(value.proposalReason)
  ) return false;

  const approvalPresent = value.approval !== undefined;
  if (approvalPresent && !isApproval(value.approval)) return false;
  if (value.queuedByCatalog !== undefined && value.queuedByCatalog !== true) return false;
  if (["queued", "claimed", "succeeded", "failed"].includes(String(value.status)) &&
    !approvalPresent && value.queuedByCatalog !== true) return false;

  const claimPresent = value.claim !== undefined;
  if (claimPresent && (!isRecord(value.claim) || !isNonEmptyString(value.claim.id) || !isTimestamp(value.claim.claimedAt))) {
    return false;
  }
  if (value.status === "claimed" && !claimPresent) return false;
  return true;
}

function decode(row: StoredRow): Investigation {
  if (row.schema_version !== DOCUMENT_SCHEMA_VERSION) {
    throw new InvestigationSchemaError(`Unsupported investigation schema version: ${row.schema_version}`);
  }
  let document: unknown = row.document;
  if (typeof document === "string") {
    try {
      document = JSON.parse(document) as unknown;
    } catch {
      throw new InvestigationSchemaError("Stored investigation JSON is invalid.");
    }
  }
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    throw new InvestigationSchemaError("Stored investigation document must be an object.");
  }
  const candidate = document as Partial<Investigation>;
  let name: string;
  try {
    name = Object.prototype.hasOwnProperty.call(document, "name")
      ? normalizeInvestigationName(candidate.name)
      : DEFAULT_INVESTIGATION_NAME;
  } catch {
    throw new InvestigationSchemaError("Stored investigation name is invalid.");
  }
  const intention = Object.prototype.hasOwnProperty.call(document, "intention") ? candidate.intention : "";
  const advancementMode = Object.prototype.hasOwnProperty.call(document, "advancementMode")
    ? candidate.advancementMode : "manual";
  if (typeof intention !== "string" || intention !== intention.trim() ||
    (advancementMode !== "automatic" && advancementMode !== "manual")) {
    throw new InvestigationSchemaError("Stored investigation creation metadata is invalid.");
  }
  const revision = Number(row.revision);
  if (
    candidate.id !== row.id || !Number.isSafeInteger(revision) || revision < 0 ||
    candidate.revision !== revision || typeof candidate.createdAt !== "string" ||
    typeof candidate.updatedAt !== "string" || !Number.isFinite(Date.parse(candidate.createdAt)) ||
    !Number.isFinite(Date.parse(candidate.updatedAt)) || typeof candidate.paused !== "boolean" ||
    !Array.isArray(candidate.emailSeeds) || !Array.isArray(candidate.actions) ||
    !Array.isArray(candidate.evidence) || !Array.isArray(candidate.validations) || !Array.isArray(candidate.audit) ||
    (candidate.authorization !== undefined && !isAuthorization(candidate.authorization)) ||
    !candidate.actions.every(isStoredAction)
  ) throw new InvestigationSchemaError("Stored investigation document does not match its schema.");
  return structuredClone({ ...candidate, name, intention, advancementMode } as Investigation);
}

function assertSnapshot(investigation: Investigation): void {
  if (
    typeof investigation.id !== "string" || investigation.id.trim().length === 0 ||
    !isNormalizedInvestigationName(investigation.name) ||
    (investigation.intention !== undefined &&
      (typeof investigation.intention !== "string" || investigation.intention !== investigation.intention.trim())) ||
    (investigation.advancementMode !== undefined &&
      investigation.advancementMode !== "automatic" && investigation.advancementMode !== "manual") ||
    !Number.isSafeInteger(investigation.revision) || investigation.revision < 0 ||
    !Number.isFinite(Date.parse(investigation.createdAt)) || !Number.isFinite(Date.parse(investigation.updatedAt)) ||
    typeof investigation.paused !== "boolean" || !Array.isArray(investigation.emailSeeds) ||
    !Array.isArray(investigation.actions) || !Array.isArray(investigation.evidence) ||
    !Array.isArray(investigation.validations) || !Array.isArray(investigation.audit)
  ) throw new InvestigationSchemaError("Investigation snapshot is invalid.");
}

function assertMutation(current: Investigation, next: Investigation): void {
  assertSnapshot(next);
  if (next.id !== current.id || next.revision !== current.revision + 1) {
    throw new InvestigationSchemaError("Every persisted mutation must preserve identity and increment revision once.");
  }
}

function revise(current: Investigation, at: string, changes: Partial<Investigation>): Investigation {
  const next: Investigation = { ...current, ...changes, revision: current.revision + 1, updatedAt: at };
  assertMutation(current, next);
  return next;
}

export class PostgresInvestigationStore implements InvestigationStore {
  private readonly pool: PgPoolLike;

  constructor(pool: PgPoolLike) {
    this.pool = pool;
  }

  async migrate(): Promise<void> {
    const migration = await readFile(MIGRATION_URL, "utf8");
    await inTransaction(this.pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_ID]);
      await client.query(migration);
      await client.query(
        "INSERT INTO backend_schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING",
        [MIGRATION_VERSION],
      );
    });
  }

  async create(investigation: Investigation): Promise<void> {
    assertSnapshot(investigation);
    await this.pool.query(INSERT_INVESTIGATION, [
      investigation.id,
      DOCUMENT_SCHEMA_VERSION,
      investigation.revision,
      investigation.createdAt,
      investigation.updatedAt,
      JSON.stringify(investigation),
    ]);
  }

  async get(id: string): Promise<Investigation | undefined> {
    const result = await this.pool.query<StoredRow>(
      "SELECT id, schema_version, revision, document FROM investigations WHERE id = $1",
      [id],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : decode(row);
  }

  async list(): Promise<readonly Investigation[]> {
    const result = await this.pool.query<StoredRow>(
      "SELECT id, schema_version, revision, document FROM investigations ORDER BY id",
    );
    return result.rows.map(decode);
  }

  async transact<T>(
    id: string,
    operation: (current: Investigation) => InvestigationTransaction<T>,
  ): Promise<T> {
    return this.mutate(id, (current) => {
      const { next, result } = operation(structuredClone(current));
      assertMutation(current, next);
      return { next, result };
    });
  }

  async claimNextAction(input: ClaimActionRequest): Promise<ActionClaim | undefined> {
    return this.mutate(input.investigationId, (current) => {
      if (current.paused || current.authorization?.granted !== true ||
        (input.automaticOnly === true && current.advancementMode !== "automatic")) return { result: undefined };
      const action = current.actions.find((candidate) => candidate.status === "queued" &&
        (candidate.queuedByCatalog === true || candidate.approval !== undefined));
      if (action === undefined) return { result: undefined };
      const claimedAction = {
        ...action,
        status: "claimed" as const,
        claim: { id: input.claimId, claimedAt: input.claimedAt },
      };
      const next = revise(current, input.claimedAt, {
        actions: current.actions.map((candidate) => candidate.id === action.id ? claimedAction : candidate),
        audit: [...current.audit, { ...input.auditEvent, actionId: action.id }],
      });
      return {
        next,
        result: {
          action: claimedAction,
          permit: { authorized: true, approved: true, paused: false },
        },
      };
    });
  }

  async completeAction(input: CompleteActionInput): Promise<Investigation> {
    return this.mutate(input.investigationId, (current) => {
      const action = current.actions.find((candidate) => candidate.id === input.actionId);
      if (action?.status !== "claimed" || action.claim?.id !== input.claimId) {
        throw new InvestigationClaimConflictError();
      }
      const completed = {
        ...action,
        status: input.result.kind === "success" ? "succeeded" as const : "failed" as const,
        completedAt: input.completedAt,
        ...(input.result.kind === "failure" ? { failure: input.result.error } : {
          unsupportedObservationCount: input.result.unsupportedObservationCount,
        }),
      };
      const next = revise(current, input.completedAt, {
        actions: current.actions.map((candidate) => candidate.id === input.actionId ? completed : candidate),
        evidence: input.result.kind === "success"
          ? [...current.evidence, ...input.result.evidence]
          : current.evidence,
        audit: [...current.audit, { ...input.auditEvent, actionId: input.actionId }],
      });
      return { next, result: next };
    });
  }

  private async mutate<T>(id: string, operation: (current: Investigation) => Mutation<T>): Promise<T> {
    return inTransaction(this.pool, async (client) => {
      const result = await client.query<StoredRow>(SELECT_LOCKED, [id]);
      const row = result.rows[0];
      if (row === undefined) throw new InvestigationNotFoundError(id);
      const current = decode(row);
      const mutation = operation(current);
      if (mutation.next !== undefined) {
        assertMutation(current, mutation.next);
        const updated = await client.query(UPDATE_INVESTIGATION, [
          id,
          DOCUMENT_SCHEMA_VERSION,
          mutation.next.revision,
          mutation.next.updatedAt,
          JSON.stringify(mutation.next),
        ]);
        if (updated.rowCount !== 1) throw new InvestigationSchemaError("Locked investigation disappeared during mutation.");
      }
      return mutation.result;
    });
  }
}
