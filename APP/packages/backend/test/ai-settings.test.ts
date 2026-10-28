import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAiReportMessages,
  compileInvestigationReport,
  composeAiReport,
  DEFAULT_AI_REPORT_SETTINGS,
  type AiChatMessage,
  type AiReportSettings,
  type Investigation,
  type InvestigationService,
} from "@investia/core";
import { createBackendApp } from "../src/api.ts";
import {
  PostgresAiSettingsStore,
  type AiSettingsRecord,
  type AiSettingsStore,
} from "../src/ai-settings-store.ts";
import { NvidiaProviderError, type NvidiaBuildGateway, type NvidiaProviderErrorKind } from "../src/nvidia-build.ts";
import type { PgClientLike, PgPoolLike, PgQueryResult } from "../src/postgres-investigation-store.ts";

const KEY = "nvapi-AbCdEfGhIjKlMnOpQrStUvWxYz-1234";
const NOW = "2026-10-28T12:00:00.000Z";

function fixture(): Investigation {
  const seed = { kind: "email" as const, value: "ana@example.com" };
  return {
    id: "investigation-1",
    name: "Caso Ana",
    intention: "Conocer la huella pública",
    revision: 3,
    createdAt: "2026-10-01T10:00:00.000Z",
    updatedAt: "2026-10-01T11:00:00.000Z",
    paused: false,
    emailSeeds: [seed],
    actions: [{
      id: "action-1",
      spec: { catalogId: "user-scanner.email.v1", provider: "user-scanner", seed },
      status: "failed",
      proposedAt: "2026-10-01T10:05:00.000Z",
      proposalReason: "Escaneo",
      failure: "stack trace host=private.example",
    }],
    evidence: [{
      id: "evidence-1", actionId: "action-1", seed, provider: "spotify", status: "registered",
      sourceId: "user-scanner", recordedAt: "2026-10-01T10:30:00.000Z",
    }],
    validations: [],
    audit: [],
  };
}

class MemorySettings implements AiSettingsStore {
  record: AiSettingsRecord | undefined;
  async load() { return this.record === undefined ? undefined : structuredClone(this.record); }
  async save(record: AiSettingsRecord) { this.record = structuredClone(record); }
}

class FakeGateway implements NvidiaBuildGateway {
  readonly calls: { apiKey: string; settings: AiReportSettings; messages: readonly AiChatMessage[] }[] = [];
  failure: NvidiaProviderErrorKind | undefined;
  async listFreeChatModels() {
    return { models: [{ id: "openai/gpt-oss-20b", name: "gpt-oss-20b", description: "Open model", reasoning: true }], source: "live" as const };
  }
  async complete(apiKey: string, settings: AiReportSettings, messages: readonly AiChatMessage[]) {
    this.calls.push({ apiKey, settings, messages });
    if (this.failure !== undefined) throw new NvidiaProviderError(this.failure);
    return "## Resumen\nPodría ser una persona melómana (confianza baja).";
  }
}

function harness() {
  const settings = new MemorySettings();
  const gateway = new FakeGateway();
  const service = {
    async loadInvestigation(id: string) { return id === "investigation-1" ? fixture() : undefined; },
  } as unknown as InvestigationService;
  const app = createBackendApp(service, {
    actionRunner: { run: async () => undefined },
    projector: { project: async (investigation: Investigation) => ({ revision: investigation.revision, status: "applied" as const }) },
    ai: { settings, gateway, clock: () => NOW },
  }, { frontendDistPath: "missing-frontend-dist" });
  return { app, settings, gateway };
}

const emptyView = {
  apiKeyConfigured: false,
  apiKeyHint: null,
  settings: DEFAULT_AI_REPORT_SETTINGS,
  defaults: DEFAULT_AI_REPORT_SETTINGS,
};

test("settings start unconfigured with editable defaults", async (t) => {
  const { app } = harness();
  t.after(() => app.close());
  const response = await app.inject({ method: "GET", url: "/settings/ai" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), emptyView);
});

test("saving only the API key yields a working default configuration and never returns the key", async (t) => {
  const { app, settings } = harness();
  t.after(() => app.close());
  const response = await app.inject({ method: "PUT", url: "/settings/ai", payload: { apiKey: `  ${KEY}  ` } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { ...emptyView, apiKeyConfigured: true, apiKeyHint: "nvapi-…1234" });
  assert.doesNotMatch(response.body, /AbCdEf/);
  assert.doesNotMatch((await app.inject({ method: "GET", url: "/settings/ai" })).body, /AbCdEf/);
  assert.deepEqual(settings.record, { apiKey: KEY, settings: DEFAULT_AI_REPORT_SETTINGS });
});

test("editing parameters keeps the stored key, and the key can be removed", async (t) => {
  const { app, settings } = harness();
  t.after(() => app.close());
  await app.inject({ method: "PUT", url: "/settings/ai", payload: { apiKey: KEY } });
  const edited = { model: "openai/gpt-oss-20b", reasoningEffort: "high", temperature: 0.2, topP: 0.9, maxTokens: 8192 };
  const response = await app.inject({ method: "PUT", url: "/settings/ai", payload: { settings: edited } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { ...emptyView, apiKeyConfigured: true, apiKeyHint: "nvapi-…1234", settings: edited });
  assert.deepEqual(settings.record, { apiKey: KEY, settings: edited });

  const removed = await app.inject({ method: "DELETE", url: "/settings/ai/api-key" });
  assert.equal(removed.statusCode, 200);
  assert.deepEqual(removed.json(), { ...emptyView, settings: edited });
  assert.deepEqual(settings.record, { apiKey: null, settings: edited });
});

test("invalid settings are rejected and leave stored settings unchanged", async (t) => {
  const { app, settings } = harness();
  t.after(() => app.close());
  await app.inject({ method: "PUT", url: "/settings/ai", payload: { apiKey: KEY } });
  const before = structuredClone(settings.record);
  for (const payload of [
    {},
    { apiKey: "" },
    { apiKey: "nvapi has spaces" },
    { apiKey: "x".repeat(513) },
    { settings: { model: "not a model" } },
    { settings: { reasoningEffort: "max" } },
    { settings: { temperature: 3 } },
    { settings: { maxTokens: 10 } },
    { settings: { unknown: true } },
    { apiKey: KEY, extra: true },
  ]) {
    const response = await app.inject({ method: "PUT", url: "/settings/ai", payload });
    assert.equal(response.statusCode, 400, JSON.stringify(payload));
    assert.deepEqual(response.json(), { error: "INVALID_REQUEST", message: "Invalid request" });
    assert.deepEqual(settings.record, before);
  }
});

test("lists the free endpoint models offered by the gateway", async (t) => {
  const { app } = harness();
  t.after(() => app.close());
  const response = await app.inject({ method: "GET", url: "/settings/ai/models" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    models: [{ id: "openai/gpt-oss-20b", name: "gpt-oss-20b", description: "Open model", reasoning: true }],
    source: "live",
  });
});

test("AI report requires a configured key and never calls the provider without one", async (t) => {
  const { app, gateway } = harness();
  t.after(() => app.close());
  const response = await app.inject({ method: "POST", url: "/investigations/investigation-1/report/ai" });
  assert.equal(response.statusCode, 409);
  assert.deepEqual(response.json(), { error: "AI_NOT_CONFIGURED", message: "Configure an NVIDIA Build API key first" });
  assert.equal(gateway.calls.length, 0);
});

test("AI report sends the collected data and appends every fact used", async (t) => {
  const { app, gateway } = harness();
  t.after(() => app.close());
  await app.inject({ method: "PUT", url: "/settings/ai", payload: { apiKey: KEY, settings: { model: "openai/gpt-oss-20b" } } });
  const response = await app.inject({ method: "POST", url: "/investigations/investigation-1/report/ai" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["content-type"], "text/markdown; charset=utf-8");
  const settings = { ...DEFAULT_AI_REPORT_SETTINGS, model: "openai/gpt-oss-20b" };
  const publicFixture = { ...fixture(), actions: [{ ...fixture().actions[0]!, failure: "Execution failed." }] };
  assert.deepEqual(gateway.calls, [{ apiKey: KEY, settings, messages: buildAiReportMessages(publicFixture) }]);
  assert.equal(response.body, composeAiReport({
    narrative: "## Resumen\nPodría ser una persona melómana (confianza baja).",
    factualReport: compileInvestigationReport(publicFixture),
    model: "openai/gpt-oss-20b",
    generatedAt: NOW,
  }));
  assert.doesNotMatch(response.body, /private\.example/);

  assert.equal((await app.inject({ method: "POST", url: "/investigations/missing/report/ai" })).statusCode, 404);
  assert.equal(gateway.calls.length, 1);
});

test("provider failures map to safe error codes", async (t) => {
  const { app, gateway } = harness();
  t.after(() => app.close());
  await app.inject({ method: "PUT", url: "/settings/ai", payload: { apiKey: KEY } });
  for (const [kind, code] of [
    ["unauthorized", "AI_PROVIDER_UNAUTHORIZED"],
    ["rate_limited", "AI_PROVIDER_RATE_LIMITED"],
    ["rejected", "AI_PROVIDER_REJECTED"],
    ["unavailable", "AI_PROVIDER_UNAVAILABLE"],
    ["invalid_response", "AI_PROVIDER_UNAVAILABLE"],
  ] as const) {
    gateway.failure = kind;
    const response = await app.inject({ method: "POST", url: "/investigations/investigation-1/report/ai" });
    assert.equal(response.statusCode, 502, kind);
    assert.equal(response.json<{ error: string }>().error, code);
    assert.doesNotMatch(response.body, /nvapi/);
  }
});

class FakePool implements PgPoolLike {
  row: { api_key: string | null; settings: unknown } | undefined;
  readonly statements: string[] = [];
  async query<T extends Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<PgQueryResult<T>> {
    this.statements.push(sql);
    if (/^\s*SELECT api_key/i.test(sql)) {
      return { rows: (this.row === undefined ? [] : [this.row]) as unknown as T[], rowCount: this.row === undefined ? 0 : 1 };
    }
    if (/^\s*INSERT INTO ai_settings/i.test(sql)) {
      this.row = { api_key: values[0] as string | null, settings: JSON.parse(values[1] as string) };
    }
    return { rows: [], rowCount: 1 };
  }
  async connect(): Promise<PgClientLike> {
    return { query: (sql, values) => this.query(sql, values), release: () => undefined };
  }
}

test("PostgreSQL store round-trips the record and falls back to defaults for unreadable settings", async () => {
  const pool = new FakePool();
  const store = new PostgresAiSettingsStore(pool);
  await store.migrate();
  assert.ok(pool.statements.some((sql) => sql.includes("CREATE TABLE IF NOT EXISTS ai_settings")));
  assert.equal(await store.load(), undefined);
  await store.save({ apiKey: KEY, settings: { ...DEFAULT_AI_REPORT_SETTINGS, maxTokens: 1024 } }, NOW);
  assert.deepEqual(await store.load(), { apiKey: KEY, settings: { ...DEFAULT_AI_REPORT_SETTINGS, maxTokens: 1024 } });
  pool.row = { api_key: KEY, settings: { maxTokens: "lots" } };
  assert.deepEqual(await store.load(), { apiKey: KEY, settings: DEFAULT_AI_REPORT_SETTINGS });
});
