import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAiReportMessages,
  buildEvidenceNormalizationMessages,
  compileInvestigationReport,
  composeAiReport,
  countOmittedAiReportFindings,
  decodoSourceContentHash,
  DEFAULT_AI_REPORT_SETTINGS,
  type AiChatMessage,
  type AiReportSettings,
  type EvidenceAiNormalization,
  type EvidenceNormalizationJob,
  type EvidenceRecord,
  type Investigation,
  type InvestigationService,
  type NormalizedPageData,
} from "@investia/core";
import {
  createBackendApp,
  EvidenceNormalizationRunner,
  PostgresEvidenceNormalizationJobStore,
  PostgresEvidenceNormalizationStore,
  type EvidenceNormalizationJobStore,
  type EvidenceNormalizationStore,
  type PgClientLike,
  type PgPoolLike,
  type PgQueryResult,
} from "../src/index.ts";
import type { AiSettingsRecord, AiSettingsStore } from "../src/ai-settings-store.ts";
import { NvidiaProviderError, type NvidiaBuildGateway, type NvidiaProviderErrorKind } from "../src/nvidia-build.ts";

const API_KEY = "nvapi-AbCdEfGhIjKlMnOpQrStUvWxYz-5678";
const NOW = "2026-11-26T12:00:00.000Z";

function makeDecodoEvidence(id: string, overrides?: Partial<{
  url: string;
  title: string;
  description: string;
  content: string;
  links: string;
  contentTruncated: boolean;
}>): EvidenceRecord {
  const url = overrides?.url ?? `https://example.org/profiles/${id}`;
  return {
    id,
    actionId: `action-${id}`,
    seed: { kind: "url", value: url },
    provider: "decodo",
    status: "registered",
    sourceId: "decodo:url",
    recordedAt: "2026-11-26T10:00:00.000Z",
    finding: {
      target: { kind: "url", value: url },
      upstreamStatus: "Found",
      url,
      category: "webpage",
      reason: "Scraped public page",
      extra: {
        title: overrides?.title ?? "Perfil público de Ana Pérez",
        description: overrides?.description ?? "Ingeniera de software en Buenos Aires",
        preview: overrides?.description ?? "Ingeniera de software en Buenos Aires",
        content: overrides?.content ?? "# Ana Pérez\n\nIngeniera en Ejemplo Corp (@anaperez). Estudió en UBA.",
        links: overrides?.links ?? "https://github.com/anaperez",
        content_truncated: overrides?.contentTruncated ?? false,
      },
      media: {},
    },
  };
}

function makeNormalizedData(summary = "Perfil profesional público de Ana Pérez con actividad en ingeniería de software."): NormalizedPageData {
  return {
    summary,
    entityName: "Ana Pérez",
    handles: ["@anaperez"],
    rolesOrOccupations: ["Ingeniera de software"],
    organizations: ["Ejemplo Corp"],
    education: ["UBA"],
    locationsMentioned: ["Buenos Aires"],
    topicsOrInterests: ["Ingeniería de software"],
    notableFacts: ["Publica repositorios bajo github.com/anaperez"],
    relatedUrls: ["https://github.com/anaperez"],
    limitations: [],
  };
}

function makeFixture(): Investigation {
  const emailSeed = { kind: "email" as const, value: "ana@example.org" };
  const photoSeed = { kind: "photo" as const, value: "https://lh3.googleusercontent.com/a/photo" };
  const decodoOne = makeDecodoEvidence("5-pago", {
    url: "https://example.org/u/anaperez",
    content: "# Ana Pérez\n\nTexto Markdown legado con detalles públicos (@anaperez).",
  });
  const decodoTwo = makeDecodoEvidence("evidence-decodo-2", {
    url: "https://example.org/blog/ana",
    content: "Artículo técnico sobre arquitectura hexagonal.",
  });
  return {
    id: "investigation-1",
    name: "Caso Ana",
    intention: "Relevar presencia pública autorizada",
    revision: 7,
    createdAt: "2026-11-26T09:00:00.000Z",
    updatedAt: "2026-11-26T10:05:00.000Z",
    paused: false,
    emailSeeds: [emailSeed],
    actions: [
      {
        id: "action-1",
        spec: { catalogId: "user-scanner.email.v1", provider: "user-scanner", seed: emailSeed },
        status: "succeeded",
        proposedAt: "2026-11-26T09:01:00.000Z",
        completedAt: "2026-11-26T09:02:00.000Z",
        proposalReason: "Seed scan",
      },
      {
        id: "action-facecheck",
        spec: { catalogId: "facecheck.photo.v1", provider: "facecheck", seed: photoSeed },
        status: "succeeded",
        proposedAt: "2026-11-26T09:03:00.000Z",
        completedAt: "2026-11-26T09:04:00.000Z",
        proposalReason: "Photo match",
      },
    ],
    evidence: [
      {
        id: "evidence-spotify",
        actionId: "action-1",
        seed: emailSeed,
        provider: "spotify",
        status: "registered",
        sourceId: "user-scanner",
        recordedAt: "2026-11-26T09:02:00.000Z",
      },
      {
        id: "evidence-facecheck-1",
        actionId: "action-facecheck",
        seed: photoSeed,
        provider: "facecheck",
        status: "registered",
        sourceId: "facecheck:photo",
        recordedAt: "2026-11-26T09:04:00.000Z",
        finding: {
          target: { kind: "url", value: "https://example.org/u/anaperez" },
          upstreamStatus: "Found",
          url: "https://example.org/u/anaperez",
          category: "face_match",
          reason: "Score 92",
          extra: { score: 92 },
          media: {},
        },
      },
      decodoOne,
      decodoTwo,
      {
        id: "evidence-decodo-empty",
        actionId: "action-empty",
        seed: { kind: "url", value: "https://example.org/empty" },
        provider: "decodo",
        status: "registered",
        sourceId: "decodo:url",
        recordedAt: "2026-11-26T10:01:00.000Z",
      },
    ],
    validations: [
      {
        id: "val-1",
        evidenceId: "evidence-facecheck-1",
        status: "accepted",
        reason: "Coincide con la persona investigada",
        at: "2026-11-26T09:05:00.000Z",
        operator: "local-operator",
      },
    ],
    audit: [],
  };
}

interface StoredNormalizationRow {
  investigation_id: string;
  evidence_id: string;
  model: string;
  generated_at: Date | string;
  source_content_hash: string;
  normalized_json: unknown;
}

class FakeNormalizationPool implements PgPoolLike {
  readonly statements: string[] = [];
  readonly migrationVersions: number[] = [];
  readonly rows = new Map<string, StoredNormalizationRow>();
  returnDates = false;

  async query<T extends Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<PgQueryResult<T>> {
    this.statements.push(sql);
    if (/INSERT INTO backend_schema_migrations/i.test(sql)) {
      this.migrationVersions.push(values[0] as number);
      return { rows: [], rowCount: 1 };
    }
    if (/^\s*INSERT INTO evidence_ai_normalizations/i.test(sql)) {
      const investigationId = values[0] as string;
      const evidenceId = values[1] as string;
      const model = values[2] as string;
      const generatedAt = values[3] as string;
      const sourceContentHash = values[4] as string;
      const normalizedJson = JSON.parse(values[5] as string) as unknown;
      this.rows.set(`${investigationId}::${evidenceId}`, {
        investigation_id: investigationId,
        evidence_id: evidenceId,
        model,
        generated_at: this.returnDates ? new Date(generatedAt) : generatedAt,
        source_content_hash: sourceContentHash,
        normalized_json: normalizedJson,
      });
      return { rows: [], rowCount: 1 };
    }
    if (/^\s*SELECT\b[\s\S]*FROM evidence_ai_normalizations/i.test(sql)) {
      const investigationId = values[0] as string;
      const matching = [...this.rows.values()]
        .filter((row) => row.investigation_id === investigationId)
        .sort((left, right) => left.evidence_id.localeCompare(right.evidence_id));
      return {
        rows: matching as unknown as T[],
        rowCount: matching.length,
      };
    }
    return { rows: [], rowCount: 1 };
  }

  async connect(): Promise<PgClientLike> {
    return {
      query: (sql, values) => this.query(sql, values),
      release: () => undefined,
    };
  }
}

class MemoryAiSettings implements AiSettingsStore {
  record: AiSettingsRecord | undefined;
  async load() {
    return this.record === undefined ? undefined : structuredClone(this.record);
  }
  async save(record: AiSettingsRecord, _at?: string) {
    this.record = structuredClone(record);
  }
}

class MemoryNormalizations implements EvidenceNormalizationStore {
  readonly items = new Map<string, EvidenceAiNormalization>();
  writes = 0;

  async listByInvestigation(investigationId: string): Promise<readonly EvidenceAiNormalization[]> {
    const result: EvidenceAiNormalization[] = [];
    for (const [key, value] of this.items.entries()) {
      if (key.startsWith(`${investigationId}::`)) {
        result.push(structuredClone(value));
      }
    }
    return result;
  }

  async save(investigationId: string, record: EvidenceAiNormalization): Promise<void> {
    this.writes++;
    this.items.set(`${investigationId}::${record.evidenceId}`, structuredClone(record));
  }
}

class FakeGateway implements NvidiaBuildGateway {
  readonly calls: { apiKey: string; settings: AiReportSettings; messages: readonly AiChatMessage[] }[] = [];
  failure: NvidiaProviderErrorKind | undefined;
  nextCompletion = JSON.stringify(makeNormalizedData());
  onComplete?: () => string | Promise<string>;

  async listFreeChatModels() {
    return { models: [], source: "fallback" as const };
  }

  async complete(apiKey: string, settings: AiReportSettings, messages: readonly AiChatMessage[]) {
    this.calls.push({ apiKey, settings, messages });
    if (this.failure !== undefined) throw new NvidiaProviderError(this.failure);
    return this.onComplete?.() ?? this.nextCompletion;
  }
}

function createHarness(options?: {
  investigation?: Investigation;
  withNormalizationStore?: boolean;
  jobs?: EvidenceNormalizationJobStore;
  wakeNormalizations?: () => void;
}) {
  let storedInvestigation = structuredClone(options?.investigation ?? makeFixture());
  const settings = new MemoryAiSettings();
  const gateway = new FakeGateway();
  const normalizations = options?.withNormalizationStore === false ? undefined : new MemoryNormalizations();
  const service = {
    async loadInvestigation(id: string) {
      return id === storedInvestigation.id ? structuredClone(storedInvestigation) : undefined;
    },
  } as unknown as InvestigationService;
  const app = createBackendApp(service, {
    actionRunner: { run: async () => undefined },
    projector: { project: async (inv: Investigation) => ({ revision: inv.revision, status: "applied" as const }) },
    ai: {
      settings,
      gateway,
      clock: () => NOW,
      ...(normalizations === undefined ? {} : { normalizations }),
      ...(options?.jobs === undefined ? {} : { normalizationJobs: options.jobs }),
      ...(options?.wakeNormalizations === undefined ? {} : { wakeNormalizations: options.wakeNormalizations }),
    },
  }, { frontendDistPath: "missing-frontend-dist" });
  return {
    app,
    service,
    settings,
    gateway,
    normalizations,
    getInvestigation: () => structuredClone(storedInvestigation),
    setInvestigation: (next: Investigation) => { storedInvestigation = structuredClone(next); },
  };
}

test("PostgresEvidenceNormalizationStore migrates v5, round-trips, upserts, normalizes Date, and rejects malformed records", async () => {
  const pool = new FakeNormalizationPool();
  pool.returnDates = true;
  const store = new PostgresEvidenceNormalizationStore(pool);

  await store.migrate();
  assert.ok(pool.statements.some((sql) => sql.includes("CREATE TABLE IF NOT EXISTS evidence_ai_normalizations")));
  assert.deepEqual(pool.migrationVersions, [5]);
  assert.deepEqual(await store.listByInvestigation("investigation-1"), []);

  const initial: EvidenceAiNormalization = {
    evidenceId: "5-pago",
    model: DEFAULT_AI_REPORT_SETTINGS.model,
    generatedAt: "2026-11-26T12:00:00.000Z",
    sourceContentHash: "a".repeat(64),
    data: makeNormalizedData(),
  };
  await store.save("investigation-1", initial);
  await store.save("investigation-2", {
    ...initial,
    evidenceId: "other-ev",
  });

  assert.deepEqual(await store.listByInvestigation("investigation-1"), [initial]);

  const updatedData: NormalizedPageData = {
    ...makeNormalizedData("Resumen actualizado tras re-normalización."),
    entityName: undefined,
  };
  const { entityName: _ignored, ...expectedDataWithoutEntity } = updatedData;
  const updated: EvidenceAiNormalization = {
    evidenceId: "5-pago",
    model: "openai/gpt-oss-20b",
    generatedAt: "2026-11-26T13:30:00.000Z",
    sourceContentHash: "b".repeat(64),
    data: expectedDataWithoutEntity,
  };
  await store.save("investigation-1", updated);
  assert.deepEqual(await store.listByInvestigation("investigation-1"), [updated]);

  const statementCountBeforeBadWrites = pool.statements.length;
  for (const [invId, badRecord] of [
    ["", updated],
    ["   ", updated],
    ["investigation-1", { ...updated, evidenceId: "" }],
    ["investigation-1", { ...updated, model: "  " }],
    ["investigation-1", { ...updated, generatedAt: "" }],
    ["investigation-1", { ...updated, sourceContentHash: "" }],
    ["investigation-1", { ...updated, data: { ...expectedDataWithoutEntity, summary: "" } }],
    ["investigation-1", { ...updated, data: { ...expectedDataWithoutEntity, relatedUrls: ["http://127.0.0.1/private"] } }],
    ["investigation-1", { ...updated, data: { ...expectedDataWithoutEntity, extraField: "forbidden" } as unknown as NormalizedPageData }],
  ] as const) {
    await assert.rejects(() => store.save(invId, badRecord));
  }
  assert.equal(pool.statements.length, statementCountBeforeBadWrites);
  assert.deepEqual(await store.listByInvestigation("investigation-1"), [updated]);

  pool.rows.set("investigation-1::corrupt-row", {
    investigation_id: "investigation-1",
    evidence_id: "corrupt-row",
    model: "openai/gpt-oss-20b",
    generated_at: NOW,
    source_content_hash: "c".repeat(64),
    normalized_json: { summary: "", handles: "not-an-array" },
  });
  assert.deepEqual(await store.listByInvestigation("investigation-1"), [updated]);
});

test("GET /investigations/:id/normalizations enforces 404 and filters out stale, orphaned, and non-Decodo records", async (t) => {
  const { app, normalizations, getInvestigation } = createHarness();
  t.after(() => app.close());

  assert.deepEqual(
    (await app.inject({ method: "GET", url: "/investigations/missing/normalizations" })).json(),
    { error: "NOT_FOUND", message: "Investigation not found" },
  );
  assert.equal((await app.inject({ method: "GET", url: "/investigations/missing/normalizations" })).statusCode, 404);

  const investigation = getInvestigation();
  const decodoOne = investigation.evidence.find((item) => item.id === "5-pago")!;
  const matching: EvidenceAiNormalization = {
    evidenceId: "5-pago",
    model: DEFAULT_AI_REPORT_SETTINGS.model,
    generatedAt: NOW,
    sourceContentHash: decodoSourceContentHash(decodoOne),
    data: makeNormalizedData(),
  };
  await normalizations!.save("investigation-1", matching);
  await normalizations!.save("investigation-1", {
    ...matching,
    evidenceId: "evidence-decodo-2",
    sourceContentHash: "stale-hash-does-not-match",
  });
  await normalizations!.save("investigation-1", {
    ...matching,
    evidenceId: "deleted-evidence",
  });
  await normalizations!.save("investigation-1", {
    ...matching,
    evidenceId: "evidence-spotify",
  });
  await normalizations!.save("investigation-1", {
    ...matching,
    evidenceId: "evidence-decodo-empty",
  });

  const response = await app.inject({ method: "GET", url: "/investigations/investigation-1/normalizations" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { normalizations: [matching], jobs: [] });

  const withoutStore = createHarness({ withNormalizationStore: false });
  t.after(() => withoutStore.app.close());
  const emptyResponse = await withoutStore.app.inject({ method: "GET", url: "/investigations/investigation-1/normalizations" });
  assert.equal(emptyResponse.statusCode, 200);
  assert.deepEqual(emptyResponse.json(), { normalizations: [], jobs: [] });
});

test("POST /investigations/:id/evidence/:evidenceId/normalize enforces body validation and strict lookup precedence before AI key check", async (t) => {
  const { app, gateway, normalizations, getInvestigation } = createHarness();
  t.after(() => app.close());
  const before = getInvestigation();

  const badBody = await app.inject({
    method: "POST",
    url: "/investigations/investigation-1/evidence/5-pago/normalize",
    payload: { unexpected: true },
  });
  assert.equal(badBody.statusCode, 400);
  assert.deepEqual(badBody.json(), { error: "INVALID_REQUEST", message: "Invalid request" });

  const missingCase = await app.inject({
    method: "POST",
    url: "/investigations/missing-case/evidence/5-pago/normalize",
  });
  assert.equal(missingCase.statusCode, 404);
  assert.deepEqual(missingCase.json(), { error: "NOT_FOUND", message: "Investigation not found" });

  const missingEvidence = await app.inject({
    method: "POST",
    url: "/investigations/investigation-1/evidence/missing-evidence/normalize",
  });
  assert.equal(missingEvidence.statusCode, 404);
  assert.deepEqual(missingEvidence.json(), { error: "NOT_FOUND", message: "Record not found" });

  for (const ineligibleId of ["evidence-spotify", "evidence-facecheck-1", "evidence-decodo-empty"]) {
    const conflict = await app.inject({
      method: "POST",
      url: `/investigations/investigation-1/evidence/${ineligibleId}/normalize`,
    });
    assert.equal(conflict.statusCode, 409, ineligibleId);
    assert.deepEqual(conflict.json(), {
      error: "CONFLICT",
      message: "Only Decodo page evidence can be normalized",
    });
  }

  const unconfigured = await app.inject({
    method: "POST",
    url: "/investigations/investigation-1/evidence/5-pago/normalize",
  });
  assert.equal(unconfigured.statusCode, 409);
  assert.deepEqual(unconfigured.json(), {
    error: "AI_NOT_CONFIGURED",
    message: "Configure an NVIDIA Build API key first",
  });

  assert.equal(gateway.calls.length, 0);
  assert.equal(normalizations!.writes, 0);
  assert.deepEqual(getInvestigation(), before);
});

test("POST /investigations/:id/evidence/:evidenceId/normalize propagates provider errors, rejects bad JSON with 502 and zero writes, and persists valid normalizations without mutating investigation", async (t) => {
  const { app, settings, gateway, normalizations, getInvestigation } = createHarness();
  t.after(() => app.close());

  const configuredSettings: AiReportSettings = {
    ...DEFAULT_AI_REPORT_SETTINGS,
    model: "openai/gpt-oss-20b",
  };
  await settings.save({ apiKey: API_KEY, settings: configuredSettings }, NOW);

  for (const [kind, code] of [
    ["unauthorized", "AI_PROVIDER_UNAUTHORIZED"],
    ["rate_limited", "AI_PROVIDER_RATE_LIMITED"],
    ["rejected", "AI_PROVIDER_REJECTED"],
    ["unavailable", "AI_PROVIDER_UNAVAILABLE"],
    ["invalid_response", "AI_PROVIDER_UNAVAILABLE"],
    ["timeout", "AI_PROVIDER_TIMEOUT"],
    ["truncated", "AI_PROVIDER_TRUNCATED"],
  ] as const) {
    gateway.failure = kind;
    const response = await app.inject({
      method: "POST",
      url: "/investigations/investigation-1/evidence/5-pago/normalize",
    });
    assert.equal(response.statusCode, 502, kind);
    assert.equal(response.json<{ error: string }>().error, code);
    assert.doesNotMatch(response.body, /nvapi/);
    assert.equal(normalizations!.writes, 0);
  }

  gateway.failure = undefined;
  for (const invalidOutput of [
    "No puedo devolver JSON.",
    "{}",
    JSON.stringify({ summary: "   " }),
    "<think>razonando</think>texto plano",
  ]) {
    gateway.nextCompletion = invalidOutput;
    const badJson = await app.inject({
      method: "POST",
      url: "/investigations/investigation-1/evidence/5-pago/normalize",
    });
    assert.equal(badJson.statusCode, 502, invalidOutput);
    assert.deepEqual(badJson.json(), {
      error: "AI_PROVIDER_INVALID_RESPONSE",
      message: "NVIDIA Build did not return valid normalized JSON",
    });
    assert.equal(normalizations!.writes, 0);
  }

  const before = getInvestigation();
  const targetEvidence = before.evidence.find((item) => item.id === "5-pago")!;
  const expectedData = makeNormalizedData();
  gateway.calls.length = 0;
  gateway.nextCompletion = `<think>Analizando la página...</think>\n\`\`\`json\n${JSON.stringify(expectedData)}\n\`\`\``;

  const ok = await app.inject({
    method: "POST",
    url: "/investigations/investigation-1/evidence/5-pago/normalize",
  });
  assert.equal(ok.statusCode, 200);
  const expectedRecord: EvidenceAiNormalization = {
    evidenceId: "5-pago",
    model: "openai/gpt-oss-20b",
    generatedAt: NOW,
    sourceContentHash: decodoSourceContentHash(targetEvidence),
    data: expectedData,
  };
  assert.deepEqual(ok.json(), expectedRecord);
  assert.equal(normalizations!.writes, 1);
  assert.deepEqual(gateway.calls, [{
    apiKey: API_KEY,
    settings: configuredSettings,
    messages: buildEvidenceNormalizationMessages(targetEvidence),
  }]);
  assert.deepEqual(getInvestigation(), before);

  const listed = await app.inject({ method: "GET", url: "/investigations/investigation-1/normalizations" });
  assert.equal(listed.statusCode, 200);
  assert.deepEqual(listed.json(), { normalizations: [expectedRecord], jobs: [] });
});

test("POST /investigations/:id/report/ai sends compact aiNormalizedPage when fresh, falls back to raw metadata when stale or absent, updates budget count, and omits raw factual appendix", async (t) => {
  const heavyFindings = Array.from({ length: 6 }, (_, index) =>
    makeDecodoEvidence(`decodo-heavy-${index + 1}`, {
      url: `https://example.org/heavy/${index + 1}`,
      content: `Contenido público extenso ${index + 1}: ${"x".repeat(10_500)}`,
    }),
  );
  const base = makeFixture();
  const investigation: Investigation = {
    ...base,
    evidence: [
      base.evidence[0]!,
      base.evidence[1]!,
      ...heavyFindings,
    ],
  };

  const { app, settings, gateway, normalizations, setInvestigation } = createHarness({ investigation });
  t.after(() => app.close());

  await settings.save({ apiKey: API_KEY, settings: DEFAULT_AI_REPORT_SETTINGS }, NOW);
  gateway.nextCompletion = "## Perfil general\nPersona con actividad pública en proyectos digitales.";

  const withoutNorms = await app.inject({ method: "POST", url: "/investigations/investigation-1/report/ai" });
  assert.equal(withoutNorms.statusCode, 200);
  assert.equal(countOmittedAiReportFindings(investigation), 1);
  assert.match(withoutNorms.body, /Por límite de contexto se omitieron 1 registros\./);

  for (const ev of heavyFindings) {
    await normalizations!.save("investigation-1", {
      evidenceId: ev.id,
      model: DEFAULT_AI_REPORT_SETTINGS.model,
      generatedAt: NOW,
      sourceContentHash: decodoSourceContentHash(ev),
      data: makeNormalizedData(`Resumen compacto de ${ev.id}.`),
    });
  }

  gateway.calls.length = 0;
  const withNorms = await app.inject({ method: "POST", url: "/investigations/investigation-1/report/ai" });
  assert.equal(withNorms.statusCode, 200);

  const storedList = await normalizations!.listByInvestigation("investigation-1");
  const normMap = new Map(storedList.map((item) => [item.evidenceId, item]));
  assert.equal(countOmittedAiReportFindings(investigation, normMap), 0);
  assert.deepEqual(gateway.calls[0]?.messages, buildAiReportMessages(investigation, normMap));

  const promptContent = gateway.calls[0]!.messages[1]!.content;
  assert.match(promptContent, /"aiNormalizedPage":/);
  assert.doesNotMatch(promptContent, /xxxxxxxxxx/);

  const rawFactualReport = compileInvestigationReport(investigation);
  assert.match(rawFactualReport, /Contenido público extenso 1:/);
  assert.doesNotMatch(rawFactualReport, /aiNormalizedPage/);
  assert.equal(withNorms.body, composeAiReport({
    narrative: "## Perfil general\nPersona con actividad pública en proyectos digitales.",
    model: DEFAULT_AI_REPORT_SETTINGS.model,
    generatedAt: NOW,
    omittedFindings: 0,
  }));
  assert.doesNotMatch(withNorms.body, /aiNormalizedPage|Datos utilizados|Contenido público extenso 1:/);

  const mutatedFirst = makeDecodoEvidence("decodo-heavy-1", {
    url: "https://example.org/heavy/1",
    content: "Contenido modificado después de la normalización.",
  });
  const staleInvestigation: Investigation = {
    ...investigation,
    evidence: [
      investigation.evidence[0]!,
      investigation.evidence[1]!,
      mutatedFirst,
      ...heavyFindings.slice(1),
    ],
  };
  setInvestigation(staleInvestigation);
  gateway.calls.length = 0;

  const withStaleFirst = await app.inject({ method: "POST", url: "/investigations/investigation-1/report/ai" });
  assert.equal(withStaleFirst.statusCode, 200);
  const stalePrompt = gateway.calls[0]!.messages[1]!.content;
  assert.match(stalePrompt, /Contenido modificado después de la normalización\./);
  assert.doesNotMatch(stalePrompt, /Resumen compacto de decodo-heavy-1\./);
  assert.match(stalePrompt, /Resumen compacto de decodo-heavy-2\./);
});

interface StoredJobRow {
  id: string;
  investigation_id: string;
  evidence_id: string;
  attempt_number: number;
  status: string;
  error_code: unknown;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
}

class FakeJobPool extends FakeNormalizationPool {
  private readonly jobRows: StoredJobRow[] = [];
  extraListRows: readonly Record<string, unknown>[] = [];
  recoveryCalls = 0;
  recoveryError?: Error;
  completionError?: Error;
  failureWriteError?: Error;

  override async query<T extends Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<PgQueryResult<T>> {
    const statement = sql.trim().replace(/\s+/g, " ");
    if (!/^(?:SELECT \* FROM|INSERT INTO|UPDATE) evidence_normalization_jobs\b/.test(statement)) {
      return super.query<T>(sql, values);
    }
    this.statements.push(sql);
    const result = (rows: readonly object[] = [], rowCount = rows.length): PgQueryResult<T> => ({
      rows: rows.map((row) => ({ ...(row as T) })), rowCount,
    });
    const ordered = [...this.jobRows].sort((a, b) => a.created_at.getTime() - b.created_at.getTime() || a.id.localeCompare(b.id));
    const [id, otherId] = values;
    if (statement.startsWith("SELECT")) {
      if (statement.includes("status IN ('queued', 'running')")) {
        return result(ordered.filter((row) => row.investigation_id === id && row.evidence_id === otherId &&
          (row.status === "queued" || row.status === "running")));
      }
      assert.match(statement, /ORDER BY created_at ASC, id ASC/);
      if (statement.includes("FOR UPDATE SKIP LOCKED")) {
        assert.match(statement, /WHERE status = 'queued'.*LIMIT 1/);
        return result(ordered.filter((row) => row.status === "queued").slice(0, 1));
      }
      assert.match(statement, /WHERE investigation_id = \$1/);
      return result([...ordered.filter((row) => row.investigation_id === id), ...this.extraListRows]);
    }
    if (statement.startsWith("INSERT")) {
      assert.match(statement, /GREATEST\(\s*COALESCE\(\(SELECT MAX\(attempt_number\)/);
      assert.match(statement, /CASE WHEN EXISTS \(SELECT 1 FROM evidence_ai_normalizations/);
      const [investigationId, evidenceId, jobId] = values as [string, string, string];
      const maxAttempt = Math.max(this.rows.has(`${investigationId}::${evidenceId}`) ? 1 : 0,
        ...ordered.filter((row) => row.investigation_id === investigationId && row.evidence_id === evidenceId)
          .map((row) => row.attempt_number));
      const row: StoredJobRow = {
        id: jobId, investigation_id: investigationId, evidence_id: evidenceId,
        attempt_number: maxAttempt + 1, status: "queued", error_code: null,
        created_at: new Date(Date.parse(NOW) + this.jobRows.length), started_at: null, completed_at: null,
      };
      this.jobRows.push(row);
      return result([row]);
    }
    if (statement.includes("'JOB_INTERRUPTED'")) {
      this.recoveryCalls++;
      if (this.recoveryError !== undefined) {
        const error = this.recoveryError;
        this.recoveryError = undefined;
        throw error;
      }
      assert.match(statement, /WHERE status = 'running'$/);
      const running = ordered.filter((row) => row.status === "running");
      for (const row of running) Object.assign(row, { status: "failed", error_code: "JOB_INTERRUPTED", completed_at: new Date(NOW) });
      return result([], running.length);
    }
    const row = ordered.find((candidate) => candidate.id === id);
    if (statement.includes("SET status = 'running'")) {
      assert.equal(row?.status, "queued");
      Object.assign(row!, { status: "running", started_at: new Date(NOW) });
      return result([row!]);
    }
    assert.match(statement, /WHERE id = \$1 AND status = 'running'$/);
    if (row?.status !== "running") return result();
    const succeeded = statement.includes("SET status = 'succeeded'");
    const error = succeeded ? this.completionError : this.failureWriteError;
    if (error !== undefined) {
      if (succeeded) this.completionError = undefined;
      else this.failureWriteError = undefined;
      throw error;
    }
    Object.assign(row, { status: succeeded ? "succeeded" : "failed", error_code: succeeded ? null : otherId, completed_at: new Date(NOW) });
    return result([], 1);
  }
}

const CASE_ID = "investigation-1";
const FIRST = "5-pago";
const SECOND = "evidence-decodo-2";
const configuration = { apiKey: API_KEY, settings: DEFAULT_AI_REPORT_SETTINGS };
const clock = () => NOW;

function makeJobStore() {
  const pool = new FakeJobPool();
  return { pool, jobs: new PostgresEvidenceNormalizationJobStore(pool) };
}

function normalizationRecord(evidence: EvidenceRecord): EvidenceAiNormalization {
  return { evidenceId: evidence.id, model: configuration.settings.model, generatedAt: NOW,
    sourceContentHash: decodoSourceContentHash(evidence), data: makeNormalizedData() };
}

function running(job: EvidenceNormalizationJob): EvidenceNormalizationJob {
  return { ...job, status: "running", startedAt: NOW };
}

function terminal(job: EvidenceNormalizationJob, errorCode?: EvidenceNormalizationJob["errorCode"]): EvidenceNormalizationJob {
  return { ...running(job), completedAt: NOW,
    ...(errorCode === undefined ? { status: "succeeded" } : { status: "failed", errorCode }) };
}

test("job store migrates v6, assigns attempts, preserves FIFO and terminal history, and recovers only running jobs", async () => {
  const { pool, jobs } = makeJobStore();
  await jobs.migrate();
  const ddl = pool.statements.find((sql) => sql.includes("CREATE TABLE IF NOT EXISTS evidence_normalization_jobs"));
  assert.ok(ddl);
  assert.match(ddl, /CREATE UNIQUE INDEX IF NOT EXISTS evidence_normalization_jobs_active_idx[\s\S]*WHERE status IN \('queued', 'running'\)/);
  assert.match(ddl, /CREATE INDEX IF NOT EXISTS evidence_normalization_jobs_investigation_idx[\s\S]*\(investigation_id, created_at ASC, id ASC\)/);
  assert.match(ddl, /CREATE INDEX IF NOT EXISTS evidence_normalization_jobs_queued_idx[\s\S]*WHERE status = 'queued'/);
  assert.deepEqual(pool.migrationVersions, [6]);
  await new PostgresEvidenceNormalizationStore(pool).save(CASE_ID, normalizationRecord(makeDecodoEvidence(SECOND)));

  const start = pool.statements.length;
  for (const [id, evidenceId] of [["", FIRST], [CASE_ID, "   "], [` ${CASE_ID}`, FIRST]] as const) {
    await assert.rejects(jobs.enqueue(id, evidenceId), /Invalid normalization job IDs/);
  }
  assert.equal(pool.statements.length, start);
  const first = await jobs.enqueue(CASE_ID, FIRST);
  assert.deepEqual(first, { created: true, job: { id: first.job.id, investigationId: CASE_ID,
    evidenceId: FIRST, attemptNumber: 1, status: "queued", createdAt: NOW } });
  assert.match(first.job.id, /^normjob-[a-f0-9-]{36}$/);
  const enqueueQueries = pool.statements.slice(start);
  assert.equal(enqueueQueries[0], "BEGIN");
  assert.match(enqueueQueries[1]!, /pg_advisory_xact_lock\(hashtext\(\$1\), hashtext\(\$2\)\)/);
  assert.equal(enqueueQueries.at(-1), "COMMIT");
  assert.deepEqual(await jobs.enqueue(CASE_ID, FIRST), { job: first.job, created: false });
  const second = (await jobs.enqueue(CASE_ID, SECOND)).job;
  assert.equal(second.attemptNumber, 2);
  const other = (await jobs.enqueue("investigation-2", FIRST)).job;
  assert.equal(await jobs.complete(first.job.id), false);
  assert.equal(await jobs.fail(first.job.id, "AI_NOT_CONFIGURED"), false);
  assert.deepEqual(await jobs.listByInvestigation(CASE_ID), [first.job, second]);
  assert.deepEqual(await jobs.claimNext(), running(first.job));
  assert.deepEqual(await jobs.enqueue(CASE_ID, FIRST), { job: running(first.job), created: false });
  assert.equal(await jobs.complete(first.job.id), true);
  assert.equal(await jobs.complete(first.job.id), false);
  assert.deepEqual(await jobs.claimNext(), running(second));
  assert.equal(await jobs.fail(second.id, "untrusted provider details"), true);
  const retry = (await jobs.enqueue(CASE_ID, SECOND)).job;
  assert.equal(retry.attemptNumber, 3);
  assert.deepEqual(await jobs.claimNext(), running(other));
  assert.equal(await jobs.failOrphanedRunning(), 1);
  assert.equal(await jobs.failOrphanedRunning(), 0);
  assert.deepEqual(await jobs.listByInvestigation("investigation-2"), [terminal(other, "JOB_INTERRUPTED")]);
  assert.deepEqual(await jobs.listByInvestigation(CASE_ID), [terminal(first.job), terminal(second, "INTERNAL_ERROR"), retry]);
  assert.deepEqual(await jobs.claimNext(), running(retry));
  assert.equal(await jobs.fail(retry.id, "AI_PROVIDER_TIMEOUT"), true);
  assert.equal(await jobs.claimNext(), undefined);
  assert.deepEqual(await jobs.listByInvestigation(CASE_ID), [
    terminal(first.job), terminal(second, "INTERNAL_ERROR"), terminal(retry, "AI_PROVIDER_TIMEOUT"),
  ]);
});

test("job listing skips malformed rows and never exposes unrecognized failure details", async () => {
  const { pool, jobs } = makeJobStore();
  const failed = { id: "legacy-job", investigation_id: CASE_ID, evidence_id: FIRST,
    attempt_number: 1, status: "failed", error_code: "raw error text",
    created_at: NOW, started_at: new Date(NOW), completed_at: NOW };
  pool.extraListRows = [
    { ...failed, id: "malformed-status", status: "unknown" },
    { ...failed, id: "malformed-date", created_at: new Date(NaN) },
    { ...failed, id: "malformed-attempt", attempt_number: 0 },
    { ...failed, id: "malformed-start", started_at: "not a date" },
    failed,
  ];
  assert.deepEqual(await jobs.listByInvestigation(CASE_ID), [terminal({ id: "legacy-job", investigationId: CASE_ID,
    evidenceId: FIRST, attemptNumber: 1, status: "queued", createdAt: NOW }, "INTERNAL_ERROR")]);
});

test("enqueue rolls back on a dedicated client and evicts it when rollback fails", async () => {
  for (const rollbackError of [undefined, new Error("Rollback unavailable")]) {
    const failure = new Error("Lock unavailable");
    const commands: string[] = [];
    const releases: (Error | undefined)[] = [];
    const client: PgClientLike = {
      async query(sql) {
        commands.push(sql);
        if (sql.startsWith("SELECT")) throw failure;
        if (sql === "ROLLBACK" && rollbackError !== undefined) throw rollbackError;
        return { rows: [], rowCount: null };
      },
      release(error) { releases.push(error); },
    };
    const jobs = new PostgresEvidenceNormalizationJobStore({
      async connect() { return client; },
      async query() { throw new Error("Expected a dedicated client"); },
    });
    await assert.rejects(jobs.enqueue(CASE_ID, FIRST), (error) => error === failure);
    assert.deepEqual(commands, ["BEGIN", "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", "ROLLBACK"]);
    assert.deepEqual(releases, [rollbackError]);
  }
});

test("runner recovers before an early wake and single-flights bounded FIFO sweeps", async (t) => {
  const { pool, jobs } = makeJobStore();
  const base = makeFixture();
  const extra = makeDecodoEvidence("evidence-decodo-3");
  const harness = createHarness({ investigation: { ...base, evidence: [...base.evidence, extra] } });
  t.after(() => harness.app.close());
  const { service, settings, gateway, normalizations } = harness;
  await settings.save(configuration);
  const orphan = (await jobs.enqueue(CASE_ID, FIRST)).job;
  await jobs.claimNext();
  const first = (await jobs.enqueue(CASE_ID, SECOND)).job;
  const second = (await jobs.enqueue(CASE_ID, extra.id)).job;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const firstCall = new Promise<void>((resolve) => { entered = resolve; });
  gateway.onComplete = async () => {
    if (gateway.calls.length === 1) { entered(); await gate; }
    return gateway.nextCompletion;
  };
  const runner = new EvidenceNormalizationRunner({ service, jobs, settings, gateway, normalizations: normalizations!, clock }, {
    maxJobsPerSweep: 2, intervalMs: 60_000,
  });
  t.after(async () => { release(); await runner.stop(); });
  const sweep = runner.drain();
  runner.start();
  assert.equal(runner.drain(), sweep);
  await Promise.race([firstCall, sweep]);
  assert.equal(gateway.calls.length, 1);
  const third = (await jobs.enqueue(CASE_ID, FIRST)).job;
  const interrupted = terminal(orphan, "JOB_INTERRUPTED");
  assert.deepEqual(await jobs.listByInvestigation(CASE_ID), [interrupted, running(first), second, third]);
  assert.deepEqual(await normalizations!.listByInvestigation(CASE_ID), []);
  release();
  await sweep;
  assert.deepEqual(await jobs.listByInvestigation(CASE_ID), [interrupted, terminal(first), terminal(second), third]);
  await runner.drain();
  assert.equal(pool.recoveryCalls, 1);
  assert.deepEqual(await jobs.listByInvestigation(CASE_ID), [interrupted, terminal(first), terminal(second), terminal(third)]);
  const expected = [base.evidence.find((item) => item.id === SECOND)!, extra, base.evidence.find((item) => item.id === FIRST)!];
  assert.deepEqual(gateway.calls.map((call) => call.messages), expected.map(buildEvidenceNormalizationMessages));
  assert.deepEqual(await normalizations!.listByInvestigation(CASE_ID), expected.map(normalizationRecord));
});

test("runner retries recovery before claiming and cleans up save and completion errors", async (t) => {
  const { pool, jobs } = makeJobStore();
  const { app, service, settings, gateway, normalizations } = createHarness();
  t.after(() => app.close());
  await settings.save(configuration);
  const recoveryError = new Error("Recovery temporarily unavailable");
  const saveError = new Error("Save temporarily unavailable");
  const completionError = new Error("Completion temporarily unavailable");
  const failureWriteError = new Error("Failure write temporarily unavailable");
  const errors: unknown[] = [];
  const runner = new EvidenceNormalizationRunner({ service, jobs, settings, gateway, clock, normalizations: {
    listByInvestigation: (id) => normalizations!.listByInvestigation(id),
    async save(id, record) {
      if (record.evidenceId === FIRST) throw saveError;
      await normalizations!.save(id, record);
    },
  } }, { onError: (error) => errors.push(error) });
  t.after(() => runner.stop());
  const first = (await jobs.enqueue(CASE_ID, FIRST)).job;
  const second = (await jobs.enqueue(CASE_ID, SECOND)).job;
  pool.recoveryError = recoveryError;
  pool.completionError = completionError;
  pool.failureWriteError = failureWriteError;
  await runner.drain();
  assert.equal(gateway.calls.length, 0);
  assert.deepEqual(await jobs.listByInvestigation(CASE_ID), [first, second]);
  await runner.drain();
  assert.equal(gateway.calls.length, 1);
  assert.deepEqual(await jobs.listByInvestigation(CASE_ID), [running(first), second]);
  assert.deepEqual(await normalizations!.listByInvestigation(CASE_ID), []);
  await runner.drain();
  assert.equal(gateway.calls.length, 2);
  assert.equal(pool.recoveryCalls, 2);
  assert.deepEqual(await jobs.listByInvestigation(CASE_ID), [terminal(first, "INTERNAL_ERROR"), terminal(second, "INTERNAL_ERROR")]);
  assert.deepEqual(errors, [recoveryError, saveError, failureWriteError, completionError]);
  assert.equal(normalizations!.writes, 1);
});

test("runner records only symbolic errors for missing settings, ineligible and stale evidence, and provider failures", async (t) => {
  const { jobs } = makeJobStore();
  const { app, service, settings, gateway, normalizations, getInvestigation, setInvestigation } = createHarness();
  t.after(() => app.close());
  const runner = new EvidenceNormalizationRunner({ service, jobs, settings, gateway, normalizations: normalizations!, clock });
  t.after(() => runner.stop());
  const before = getInvestigation();
  const history: EvidenceNormalizationJob[] = [];
  async function expectFailure(id: string, code: NonNullable<EvidenceNormalizationJob["errorCode"]>, providerCalls: number) {
    const callCount = gateway.calls.length;
    const { job } = await jobs.enqueue(CASE_ID, id);
    await runner.drain();
    history.push(terminal(job, code));
    assert.deepEqual(await jobs.listByInvestigation(CASE_ID), history);
    assert.deepEqual(await normalizations!.listByInvestigation(CASE_ID), []);
    assert.equal(normalizations!.writes, 0);
    assert.equal(gateway.calls.length - callCount, providerCalls);
  }
  await expectFailure(FIRST, "AI_NOT_CONFIGURED", 0);
  await settings.save(configuration);
  for (const id of ["removed", "evidence-facecheck-1", "evidence-decodo-empty"]) await expectFailure(id, "EVIDENCE_UNAVAILABLE", 0);
  for (const [kind, code] of [
    ["unauthorized", "AI_PROVIDER_UNAUTHORIZED"], ["rate_limited", "AI_PROVIDER_RATE_LIMITED"],
    ["rejected", "AI_PROVIDER_REJECTED"], ["timeout", "AI_PROVIDER_TIMEOUT"], ["truncated", "AI_PROVIDER_TRUNCATED"],
    ["unavailable", "AI_PROVIDER_UNAVAILABLE"], ["invalid_response", "AI_PROVIDER_UNAVAILABLE"],
  ] as const) {
    gateway.failure = kind;
    await expectFailure(FIRST, code, 1);
  }
  gateway.failure = undefined;
  gateway.onComplete = () => "not JSON";
  await expectFailure(FIRST, "AI_PROVIDER_INVALID_RESPONSE", 1);
  gateway.onComplete = () => { throw new Error("Unexpected provider detail"); };
  await expectFailure(FIRST, "INTERNAL_ERROR", 1);
  for (const replacement of [undefined, makeDecodoEvidence(FIRST, { content: "Updated page text" })]) {
    setInvestigation(before);
    gateway.onComplete = () => {
      const evidence = before.evidence.filter((item) => item.id !== FIRST);
      setInvestigation({ ...before, evidence: replacement === undefined ? evidence : [...evidence, replacement] });
      return gateway.nextCompletion;
    };
    await expectFailure(FIRST, "EVIDENCE_UNAVAILABLE", 1);
  }
});

const queueRoute = (evidenceId: string, id = CASE_ID) => `/investigations/${id}/evidence/${evidenceId}/normalize/queue`;
const localHeaders = { host: "localhost:4317", origin: "http://localhost:4317" };

test("queue API validates local origin, body, investigation, evidence, key, and queue before enqueueing", async (t) => {
  const { jobs } = makeJobStore();
  let wakes = 0;
  const { app, gateway, normalizations, getInvestigation } = createHarness({ jobs, wakeNormalizations: () => { wakes++; } });
  t.after(() => app.close());
  const before = getInvestigation();
  const url = queueRoute(FIRST);
  const cases = [
    [{ url, headers: { ...localHeaders, origin: "https://example.org" }, payload: { extra: true } }, 403, "FORBIDDEN", "Evidence normalization can only be queued from this computer's InvestIA page"],
    [{ url, payload: { extra: true } }, 400, "INVALID_REQUEST", "Invalid request"],
    ...["null", "[]"].map((payload) => [
      { url, payload, headers: { ...localHeaders, "content-type": "application/json" } }, 400, "INVALID_REQUEST", "Invalid request",
    ] as const),
    [{ url: queueRoute(FIRST, "missing") }, 404, "NOT_FOUND", "Investigation not found"],
    [{ url: queueRoute("removed") }, 404, "NOT_FOUND", "Record not found"],
    ...["evidence-spotify", "evidence-facecheck-1", "evidence-decodo-empty"].map((id) => [
      { url: queueRoute(id) }, 409, "CONFLICT", "Only Decodo page evidence can be normalized",
    ] as const),
    [{ url }, 409, "AI_NOT_CONFIGURED", "Configure an NVIDIA Build API key first"],
  ] as const;
  for (const [request, status, error, message] of cases) {
    const response = await app.inject({ method: "POST", headers: localHeaders, ...request });
    assert.equal(response.statusCode, status);
    assert.deepEqual(response.json(), { error, message });
  }
  assert.equal(wakes, 0);
  assert.equal(gateway.calls.length, 0);
  assert.equal(normalizations!.writes, 0);
  assert.deepEqual(getInvestigation(), before);
  assert.deepEqual(await jobs.listByInvestigation(CASE_ID), []);
  const noQueue = createHarness();
  t.after(() => noQueue.app.close());
  await noQueue.settings.save(configuration);
  const unavailable = await noQueue.app.inject({ method: "POST", url, headers: localHeaders });
  assert.equal(unavailable.statusCode, 503);
  assert.deepEqual(unavailable.json(), { error: "NORMALIZATION_QUEUE_UNAVAILABLE", message: "Evidence normalization queue is unavailable" });
  assert.equal(noQueue.gateway.calls.length, 0);
  assert.equal(noQueue.normalizations!.writes, 0);
});

test("queue API responds immediately, wakes on idempotent requests, and lists jobs alongside current normalizations", async (t) => {
  const { jobs } = makeJobStore();
  let wakes = 0;
  const { app, settings, gateway, normalizations, getInvestigation } = createHarness({ jobs, wakeNormalizations: () => { wakes++; } });
  t.after(() => app.close());
  const before = getInvestigation();
  const record = normalizationRecord(before.evidence.find((item) => item.id === FIRST)!);
  await normalizations!.save(CASE_ID, record);
  await settings.save(configuration);
  const first = await app.inject({ method: "POST", url: queueRoute(FIRST), headers: localHeaders });
  const second = await app.inject({ method: "POST", url: queueRoute(SECOND), headers: localHeaders, payload: {} });
  const duplicate = await app.inject({ method: "POST", url: queueRoute(FIRST), headers: localHeaders, payload: {} });
  for (const response of [first, second, duplicate]) assert.equal(response.statusCode, 202);
  const firstJob = first.json<{ job: EvidenceNormalizationJob }>().job;
  const secondJob = second.json<{ job: EvidenceNormalizationJob }>().job;
  assert.deepEqual(first.json(), { created: true, job: { id: firstJob.id, evidenceId: FIRST,
    investigationId: CASE_ID, attemptNumber: 1, status: "queued", createdAt: NOW } });
  assert.deepEqual(second.json(), { created: true, job: { id: secondJob.id, evidenceId: SECOND,
    investigationId: CASE_ID, attemptNumber: 1, status: "queued", createdAt: new Date(Date.parse(NOW) + 1).toISOString() } });
  assert.notEqual(firstJob.id, secondJob.id);
  assert.deepEqual(duplicate.json(), { created: false, job: firstJob });
  assert.equal(wakes, 3);
  assert.equal(gateway.calls.length, 0);
  assert.equal(normalizations!.writes, 1);
  assert.deepEqual(getInvestigation(), before);
  const listed = await app.inject({ method: "GET", url: `/investigations/${CASE_ID}/normalizations` });
  assert.equal(listed.statusCode, 200);
  assert.deepEqual(listed.json(), { normalizations: [record], jobs: [firstJob, secondJob] });
});

test("a claim whose COMMIT response is lost is recovered on the next sweep without stranding the queue", async (t) => {
  const { pool, jobs } = makeJobStore();
  const h = createHarness();
  t.after(() => h.app.close());
  await h.settings.save(configuration);
  await jobs.enqueue(CASE_ID, FIRST);
  await jobs.enqueue(CASE_ID, SECOND);
  const connect = pool.connect.bind(pool);
  let injectFault = true;
  pool.connect = async () => {
    const client = await connect();
    let claiming = false;
    return {
      release: client.release,
      async query<T extends Record<string, unknown>>(sql: string, values?: unknown[]) {
        const result = await client.query<T>(sql, values);
        claiming ||= sql.includes("SET status = 'running'");
        if (sql === "COMMIT" && claiming && injectFault) {
          injectFault = false;
          throw new Error("COMMIT applied; connection lost before acknowledgement");
        }
        return result;
      },
    };
  };
  const runner = new EvidenceNormalizationRunner({
    service: h.service, jobs, settings: h.settings, gateway: h.gateway, normalizations: h.normalizations!, clock,
  });
  t.after(() => runner.stop());
  await runner.drain();
  await runner.drain();
  const history = await jobs.listByInvestigation(CASE_ID);
  assert.equal(history.length, 2);
  assert.equal(history[0]?.status, "failed");
  assert.equal(history[0]?.errorCode, "JOB_INTERRUPTED");
  assert.equal(history[1]?.status, "succeeded");
});

test("pruning evidence at the clock boundary before final recheck skips saving a stale normalization", async (t) => {
  const { jobs } = makeJobStore();
  const h = createHarness();
  t.after(() => h.app.close());
  await h.settings.save(configuration);
  const { job } = await jobs.enqueue(CASE_ID, FIRST);
  const runner = new EvidenceNormalizationRunner({
    service: h.service, jobs, settings: h.settings, gateway: h.gateway, normalizations: h.normalizations!,
    clock: () => {
      const current = h.getInvestigation();
      h.setInvestigation({ ...current, evidence: current.evidence.filter(({ id }) => id !== FIRST) });
      return NOW;
    },
  });
  t.after(() => runner.stop());
  await runner.drain();
  assert.deepEqual(await h.normalizations!.listByInvestigation(CASE_ID), []);
  assert.deepEqual(await jobs.listByInvestigation(CASE_ID), [terminal(job, "EVIDENCE_UNAVAILABLE")]);
});

test("AI report does not serve a model-written source appendix or change the factual report", async (t) => {
  const { app, settings, gateway } = createHarness();
  t.after(() => app.close());
  await settings.save({ apiKey: API_KEY, settings: DEFAULT_AI_REPORT_SETTINGS }, NOW);

  const url = "/investigations/investigation-1/report";
  const before = await app.inject({ method: "GET", url });
  assert.equal(before.statusCode, 200);

  gateway.nextCompletion = "## Perfil general\nNo hay datos suficientes para describir el perfil.";
  const valid = await app.inject({ method: "POST", url: `${url}/ai` });
  assert.equal(valid.statusCode, 200);
  assert.equal(valid.body.match(/^> Síntesis asistida por IA\b/gm)?.length, 1);

  gateway.nextCompletion += "\n\n## Datos utilizados\n| Decodo | https://example.org | evidence-1 |";
  const cleaned = await app.inject({ method: "POST", url: `${url}/ai` });
  assert.equal(cleaned.statusCode, 200);
  assert.doesNotMatch(cleaned.body, /Datos utilizados|Decodo|https?:\/\/|evidence-1|^\|/m);
  assert.equal(cleaned.body.match(/^> Síntesis asistida por IA\b/gm)?.length, 1);

  const after = await app.inject({ method: "GET", url });
  assert.equal(after.statusCode, 200);
  assert.equal(after.body, before.body);
});
