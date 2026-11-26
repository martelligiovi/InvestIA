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
  type EvidenceRecord,
  type Investigation,
  type InvestigationService,
  type NormalizedPageData,
} from "@investia/core";
import {
  createBackendApp,
  PostgresEvidenceNormalizationStore,
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

  async listFreeChatModels() {
    return { models: [], source: "fallback" as const };
  }

  async complete(apiKey: string, settings: AiReportSettings, messages: readonly AiChatMessage[]) {
    this.calls.push({ apiKey, settings, messages });
    if (this.failure !== undefined) throw new NvidiaProviderError(this.failure);
    return this.nextCompletion;
  }
}

function createHarness(options?: {
  investigation?: Investigation;
  withNormalizationStore?: boolean;
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
    },
  }, { frontendDistPath: "missing-frontend-dist" });
  return {
    app,
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
  assert.deepEqual(response.json(), { normalizations: [matching] });

  const withoutStore = createHarness({ withNormalizationStore: false });
  t.after(() => withoutStore.app.close());
  const emptyResponse = await withoutStore.app.inject({ method: "GET", url: "/investigations/investigation-1/normalizations" });
  assert.equal(emptyResponse.statusCode, 200);
  assert.deepEqual(emptyResponse.json(), { normalizations: [] });
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
  assert.deepEqual(listed.json(), { normalizations: [expectedRecord] });
});

test("POST /investigations/:id/report/ai sends compact aiNormalizedPage when fresh, falls back to raw metadata when stale or absent, updates budget count, and keeps factual appendix raw", async (t) => {
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
  gateway.nextCompletion = "## Resumen\nHipótesis basada en evidencia pública (confianza media).";

  const withoutNorms = await app.inject({ method: "POST", url: "/investigations/investigation-1/report/ai" });
  assert.equal(withoutNorms.statusCode, 200);
  assert.equal(countOmittedAiReportFindings(investigation), 1);
  assert.match(withoutNorms.body, /1 hallazgos no se enviaron al modelo/);

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
  assert.equal(withNorms.body, composeAiReport({
    narrative: "## Resumen\nHipótesis basada en evidencia pública (confianza media).",
    factualReport: rawFactualReport,
    model: DEFAULT_AI_REPORT_SETTINGS.model,
    generatedAt: NOW,
    omittedFindings: 0,
  }));
  assert.doesNotMatch(withNorms.body, /aiNormalizedPage/);
  assert.match(withNorms.body, /Contenido público extenso 1:/);

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
