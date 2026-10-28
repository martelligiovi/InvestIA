import { readFile } from "node:fs/promises";
import {
  DEFAULT_AI_REPORT_SETTINGS,
  normalizeAiReportSettings,
  type AiReportSettings,
} from "@investia/core";
import type { PgPoolLike } from "./postgres-investigation-store.ts";

export interface AiSettingsRecord {
  readonly apiKey: string | null;
  readonly settings: AiReportSettings;
}

export interface AiSettingsStore {
  load(): Promise<AiSettingsRecord | undefined>;
  save(record: AiSettingsRecord, at: string): Promise<void>;
}

const MIGRATION_VERSION = 2;
/** Shares the investigation store's advisory lock so concurrent startups migrate serially. */
const MIGRATION_LOCK_ID = 1163287874;
const MIGRATION_URL = new URL("../migrations/002_ai_settings.sql", import.meta.url);
const ROW_ID = "nvidia-build";

function readableSettings(value: unknown): AiReportSettings {
  try {
    return normalizeAiReportSettings(typeof value === "object" && value !== null ? value : undefined);
  } catch {
    return DEFAULT_AI_REPORT_SETTINGS;
  }
}

export class PostgresAiSettingsStore implements AiSettingsStore {
  readonly #pool: PgPoolLike;

  constructor(pool: PgPoolLike) {
    this.#pool = pool;
  }

  async migrate(): Promise<void> {
    const migration = await readFile(MIGRATION_URL, "utf8");
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_ID]);
      await client.query(migration);
      await client.query(
        "INSERT INTO backend_schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING",
        [MIGRATION_VERSION],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async load(): Promise<AiSettingsRecord | undefined> {
    const result = await this.#pool.query<{ api_key: string | null; settings: unknown }>(
      "SELECT api_key, settings FROM ai_settings WHERE id = $1",
      [ROW_ID],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return { apiKey: row.api_key, settings: readableSettings(row.settings) };
  }

  async save(record: AiSettingsRecord, at: string): Promise<void> {
    await this.#pool.query(
      `INSERT INTO ai_settings (id, api_key, settings, updated_at) VALUES ($4, $1, $2::jsonb, $3)
       ON CONFLICT (id) DO UPDATE SET api_key = EXCLUDED.api_key, settings = EXCLUDED.settings, updated_at = EXCLUDED.updated_at`,
      [record.apiKey, JSON.stringify(record.settings), at, ROW_ID],
    );
  }
}
