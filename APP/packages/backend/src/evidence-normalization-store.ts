import { isValidNormalizedPageData, type EvidenceAiNormalization } from "@investia/core";
import { migrateBackendSchema, type PgPoolLike } from "./postgres-investigation-store.ts";

export interface EvidenceNormalizationStore {
  listByInvestigation(investigationId: string): Promise<readonly EvidenceAiNormalization[]>;
  save(investigationId: string, record: EvidenceAiNormalization): Promise<void>;
}

const MIGRATION_VERSION = 5;
const MIGRATION_URL = new URL("../migrations/005_evidence_ai_normalizations.sql", import.meta.url);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function isValidEvidenceNormalization(value: unknown): value is EvidenceAiNormalization {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<EvidenceAiNormalization>;
  return (
    isNonEmptyString(candidate.evidenceId) &&
    isNonEmptyString(candidate.model) &&
    isNonEmptyString(candidate.generatedAt) &&
    isNonEmptyString(candidate.sourceContentHash) &&
    isValidNormalizedPageData(candidate.data)
  );
}

export class PostgresEvidenceNormalizationStore implements EvidenceNormalizationStore {
  private readonly pool: PgPoolLike;

  constructor(pool: PgPoolLike) {
    this.pool = pool;
  }

  migrate(): Promise<void> {
    return migrateBackendSchema(this.pool, MIGRATION_URL, MIGRATION_VERSION);
  }

  async listByInvestigation(investigationId: string): Promise<readonly EvidenceAiNormalization[]> {
    if (!isNonEmptyString(investigationId)) return [];
    const result = await this.pool.query<{
      evidence_id: string;
      model: string;
      generated_at: Date | string;
      source_content_hash: string;
      normalized_json: unknown;
    }>(
      `SELECT evidence_id, model, generated_at, source_content_hash, normalized_json
       FROM evidence_ai_normalizations
       WHERE investigation_id = $1
       ORDER BY evidence_id ASC`,
      [investigationId],
    );
    const records: EvidenceAiNormalization[] = [];
    for (const row of result.rows) {
      const generatedAt = row.generated_at instanceof Date
        ? row.generated_at.toISOString()
        : String(row.generated_at ?? "");
      if (
        !isNonEmptyString(row.evidence_id) ||
        !isNonEmptyString(row.model) ||
        !isNonEmptyString(generatedAt) ||
        !isNonEmptyString(row.source_content_hash) ||
        !isValidNormalizedPageData(row.normalized_json)
      ) {
        continue;
      }
      records.push({
        evidenceId: row.evidence_id,
        model: row.model,
        generatedAt,
        sourceContentHash: row.source_content_hash,
        data: row.normalized_json,
      });
    }
    return records;
  }

  async save(investigationId: string, record: EvidenceAiNormalization): Promise<void> {
    if (!isNonEmptyString(investigationId) || !isValidEvidenceNormalization(record)) {
      throw new Error("Invalid evidence AI normalization record");
    }
    await this.pool.query(
      `INSERT INTO evidence_ai_normalizations (
         investigation_id,
         evidence_id,
         model,
         generated_at,
         source_content_hash,
         normalized_json,
         updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW())
       ON CONFLICT (investigation_id, evidence_id) DO UPDATE SET
         model = EXCLUDED.model,
         generated_at = EXCLUDED.generated_at,
         source_content_hash = EXCLUDED.source_content_hash,
         normalized_json = EXCLUDED.normalized_json,
         updated_at = NOW()`,
      [
        investigationId,
        record.evidenceId,
        record.model,
        record.generatedAt,
        record.sourceContentHash,
        JSON.stringify(record.data),
      ],
    );
  }
}
