import { readFile } from "node:fs/promises";
import type { PgPoolLike } from "./postgres-investigation-store.ts";

export interface FacecheckSettingsRecord {
  readonly token: string | undefined;
  readonly testingMode: boolean;
}

export interface FacecheckSettingsStore {
  load(): Promise<FacecheckSettingsRecord>;
  update(changes: { readonly token?: string; readonly testingMode?: boolean }): Promise<void>;
  clearToken(): Promise<void>;
}

export class PostgresFacecheckSettingsStore implements FacecheckSettingsStore {
  private readonly pool: PgPoolLike;

  constructor(pool: PgPoolLike) { this.pool = pool; }

  async migrate(): Promise<void> {
    const migration = await readFile(new URL("../migrations/003_facecheck_settings.sql", import.meta.url), "utf8");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [1163287874]);
      await client.query(migration);
      await client.query("INSERT INTO backend_schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING", [3]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async load(): Promise<FacecheckSettingsRecord> {
    const result = await this.pool.query<{ token: string | null; testing_mode: boolean }>(
      "SELECT token, testing_mode FROM facecheck_settings WHERE id = 'facecheck'",
    );
    return { token: result.rows[0]?.token ?? undefined, testingMode: result.rows[0]?.testing_mode ?? true };
  }

  async update(changes: { readonly token?: string; readonly testingMode?: boolean }): Promise<void> {
    await this.write(changes.token, changes.testingMode, changes.token !== undefined, changes.testingMode !== undefined);
  }

  async clearToken(): Promise<void> {
    await this.write(null, undefined, true, false);
  }

  private async write(token: string | null | undefined, testingMode: boolean | undefined, setToken: boolean, setMode: boolean): Promise<void> {
    await this.pool.query(
      `INSERT INTO facecheck_settings (id, token, testing_mode) VALUES ('facecheck', $1, COALESCE($2::boolean, true))
       ON CONFLICT (id) DO UPDATE SET token = CASE WHEN $3::boolean THEN EXCLUDED.token ELSE facecheck_settings.token END,
       testing_mode = CASE WHEN $4::boolean THEN EXCLUDED.testing_mode ELSE facecheck_settings.testing_mode END`,
      [token, testingMode, setToken, setMode],
    );
  }
}
