import { randomUUID } from "node:crypto";
import {
  isValidNormalizationJobErrorCode,
  NORMALIZATION_JOB_STATUSES,
  type EvidenceNormalizationJob,
  type EvidenceNormalizationJobStatus,
} from "@investia/core";
import { migrateBackendSchema, type PgClientLike, type PgPoolLike } from "./postgres-investigation-store.ts";

export interface EvidenceNormalizationJobStore {
  enqueue(investigationId: string, evidenceId: string): Promise<{ job: EvidenceNormalizationJob; created: boolean }>;
  claimNext(): Promise<EvidenceNormalizationJob | undefined>;
  complete(jobId: string): Promise<boolean>;
  fail(jobId: string, errorCode: unknown): Promise<boolean>;
  failOrphanedRunning(): Promise<number>;
  listByInvestigation(investigationId: string): Promise<readonly EvidenceNormalizationJob[]>;
}

const MIGRATION_URL = new URL("../migrations/006_evidence_normalization_jobs.sql", import.meta.url);

interface JobRow {
  readonly id: unknown;
  readonly investigation_id: unknown;
  readonly evidence_id: unknown;
  readonly attempt_number: unknown;
  readonly status: unknown;
  readonly error_code: unknown;
  readonly created_at: unknown;
  readonly started_at: unknown;
  readonly completed_at: unknown;
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function isStatus(value: unknown): value is EvidenceNormalizationJobStatus {
  return NORMALIZATION_JOB_STATUSES.some((status) => status === value);
}

function timestamp(value: unknown): string | undefined {
  const time = value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

function decode(row: JobRow): EvidenceNormalizationJob | undefined {
  const createdAt = timestamp(row.created_at);
  const startedAt = timestamp(row.started_at);
  const completedAt = timestamp(row.completed_at);
  if (!isId(row.id) || !isId(row.investigation_id) || !isId(row.evidence_id) || !isStatus(row.status) ||
    typeof row.attempt_number !== "number" || !Number.isSafeInteger(row.attempt_number) || row.attempt_number < 1 ||
    createdAt === undefined || (row.started_at != null && startedAt === undefined) ||
    (row.completed_at != null && completedAt === undefined)) return undefined;
  return {
    id: row.id,
    investigationId: row.investigation_id,
    evidenceId: row.evidence_id,
    attemptNumber: row.attempt_number,
    status: row.status,
    ...(row.status === "failed" ? { errorCode: safeErrorCode(row.error_code) } : {}),
    createdAt,
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(completedAt === undefined ? {} : { completedAt }),
  };
}

function safeErrorCode(value: unknown) {
  return isValidNormalizationJobErrorCode(value) ? value : "INTERNAL_ERROR";
}

function requireJob(row: JobRow | undefined): EvidenceNormalizationJob {
  const job = row === undefined ? undefined : decode(row);
  if (job === undefined) throw new Error("Invalid normalization job row");
  return job;
}

/** Match the investigation store's rollback and client eviction rules. */
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

export class PostgresEvidenceNormalizationJobStore implements EvidenceNormalizationJobStore {
  private readonly pool: PgPoolLike;

  constructor(pool: PgPoolLike) {
    this.pool = pool;
  }

  migrate(): Promise<void> {
    return migrateBackendSchema(this.pool, MIGRATION_URL, 6);
  }

  async enqueue(investigationId: string, evidenceId: string): Promise<{ job: EvidenceNormalizationJob; created: boolean }> {
    if (!isId(investigationId) || !isId(evidenceId)) throw new Error("Invalid normalization job IDs");
    return inTransaction(this.pool, async (client) => {
      const ids = [investigationId, evidenceId];
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", ids);
      const active = await client.query<JobRow>(
        `SELECT * FROM evidence_normalization_jobs
         WHERE investigation_id = $1 AND evidence_id = $2 AND status IN ('queued', 'running')`,
        ids,
      );
      if (active.rows[0] !== undefined) return { job: requireJob(active.rows[0]), created: false };
      const inserted = await client.query<JobRow>(
        `INSERT INTO evidence_normalization_jobs (id, investigation_id, evidence_id, attempt_number, status)
         VALUES ($3, $1, $2, GREATEST(
           COALESCE((SELECT MAX(attempt_number) FROM evidence_normalization_jobs
                     WHERE investigation_id = $1 AND evidence_id = $2), 0),
           CASE WHEN EXISTS (SELECT 1 FROM evidence_ai_normalizations
                             WHERE investigation_id = $1 AND evidence_id = $2) THEN 1 ELSE 0 END
         ) + 1, 'queued')
         RETURNING *`,
        [...ids, `normjob-${randomUUID()}`],
      );
      return { job: requireJob(inserted.rows[0]), created: true };
    });
  }

  async claimNext(): Promise<EvidenceNormalizationJob | undefined> {
    return inTransaction(this.pool, async (client) => {
      const queued = await client.query<JobRow>(
        `SELECT * FROM evidence_normalization_jobs WHERE status = 'queued'
         ORDER BY created_at ASC, id ASC FOR UPDATE SKIP LOCKED LIMIT 1`,
      );
      const next = queued.rows[0];
      if (next === undefined) return undefined;
      const claimed = await client.query<JobRow>(
        `UPDATE evidence_normalization_jobs SET status = 'running', started_at = NOW()
         WHERE id = $1 RETURNING *`,
        [requireJob(next).id],
      );
      return requireJob(claimed.rows[0]);
    });
  }

  async complete(jobId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE evidence_normalization_jobs SET status = 'succeeded', error_code = NULL, completed_at = NOW()
       WHERE id = $1 AND status = 'running'`,
      [jobId],
    );
    return result.rowCount === 1;
  }

  async fail(jobId: string, errorCode: unknown): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE evidence_normalization_jobs SET status = 'failed', error_code = $2, completed_at = NOW()
       WHERE id = $1 AND status = 'running'`,
      [jobId, safeErrorCode(errorCode)],
    );
    return result.rowCount === 1;
  }

  async failOrphanedRunning(): Promise<number> {
    const result = await this.pool.query(
      `UPDATE evidence_normalization_jobs SET status = 'failed', error_code = 'JOB_INTERRUPTED', completed_at = NOW()
       WHERE status = 'running'`,
    );
    return result.rowCount ?? 0;
  }

  async listByInvestigation(investigationId: string): Promise<readonly EvidenceNormalizationJob[]> {
    if (!isId(investigationId)) return [];
    const result = await this.pool.query<JobRow>(
      `SELECT * FROM evidence_normalization_jobs WHERE investigation_id = $1 ORDER BY created_at ASC, id ASC`,
      [investigationId],
    );
    const jobs: EvidenceNormalizationJob[] = [];
    for (const row of result.rows) {
      const job = decode(row);
      if (job !== undefined) jobs.push(job);
    }
    return jobs;
  }
}
