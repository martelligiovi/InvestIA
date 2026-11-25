import { isDecodoApiMode, normalizeDecodoToken, type DecodoApiMode } from "../../adapter-decodo/src/index.ts";
import { migrateBackendSchema, type PgPoolLike } from "./postgres-investigation-store.ts";

export interface DecodoSettingsRecord {
  readonly token: string | undefined;
  readonly apiMode: DecodoApiMode;
}

interface DecodoSettingsChanges {
  readonly token?: string;
  readonly apiMode?: DecodoApiMode;
}

export interface DecodoSettingsStore {
  load(): Promise<DecodoSettingsRecord>;
  update(changes: DecodoSettingsChanges): Promise<void>;
  clearToken(): Promise<void>;
}

const DEFAULT_API_MODE: DecodoApiMode = "web_data";
const MIGRATION_URL = new URL("../migrations/004_decodo_settings.sql", import.meta.url);
const SCHEME_PREFIX = /^(?:Bearer|Basic)(?:\s|$)/i;

export function isValidDecodoToken(value: unknown, apiMode?: DecodoApiMode): value is string {
  return "token" in normalizeDecodoToken(value, apiMode);
}

export class PostgresDecodoSettingsStore implements DecodoSettingsStore {
  private readonly pool: PgPoolLike;

  constructor(pool: PgPoolLike) { this.pool = pool; }

  migrate(): Promise<void> {
    return migrateBackendSchema(this.pool, MIGRATION_URL, 4);
  }

  async load(): Promise<DecodoSettingsRecord> {
    const result = await this.pool.query<{ token: string | null; api_mode: DecodoApiMode }>(
      "SELECT token, api_mode FROM decodo_settings WHERE id = 'decodo'",
    );
    return { token: result.rows[0]?.token ?? undefined, apiMode: result.rows[0]?.api_mode ?? DEFAULT_API_MODE };
  }

  async update({ token, apiMode }: DecodoSettingsChanges): Promise<void> {
    if (apiMode !== undefined && !isDecodoApiMode(apiMode)) throw new Error("Invalid Decodo API mode");
    if (token === undefined && apiMode === undefined) return;
    let normalizedToken: string | undefined;
    if (token !== undefined) {
      const effectiveMode = apiMode ?? (SCHEME_PREFIX.test(token.trimStart()) ? (await this.load()).apiMode : undefined);
      const normalized = normalizeDecodoToken(token, effectiveMode);
      if (!("token" in normalized)) throw new Error("Invalid Decodo API token");
      normalizedToken = normalized.token;
    }
    await this.write(normalizedToken, apiMode);
  }

  async clearToken(): Promise<void> {
    await this.write(null, undefined);
  }

  private async write(token: string | null | undefined, apiMode: DecodoApiMode | undefined): Promise<void> {
    await this.pool.query(
      `INSERT INTO decodo_settings (id, token, api_mode) VALUES ('decodo', $1, COALESCE($2::text, '${DEFAULT_API_MODE}'))
       ON CONFLICT (id) DO UPDATE SET token = CASE WHEN $3::boolean THEN EXCLUDED.token ELSE decodo_settings.token END,
       api_mode = CASE WHEN $4::boolean THEN EXCLUDED.api_mode ELSE decodo_settings.api_mode END,
       updated_at = NOW()`,
      [token, apiMode, token !== undefined, apiMode !== undefined],
    );
  }
}
