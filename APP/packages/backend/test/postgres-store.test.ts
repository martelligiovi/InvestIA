import assert from "node:assert/strict";
import test from "node:test";
import {
  createCatalogExecutor,
  createInitialInvestigation,
  createInvestigationService,
  type ClaimActionRequest,
  type CompleteActionInput,
  type Investigation,
  type InvestigationExecutor,
  type ScopedCatalogId,
} from "@investia/core";
import { createGravatarBox } from "../../adapter-gravatar/src/index.ts";
import {
  InvestigationClaimConflictError,
  InvestigationSchemaError,
  PostgresInvestigationStore,
  type PgClientLike,
  type PgPoolLike,
  type PgQueryResult,
} from "../src/postgres-investigation-store.ts";

interface Row {
  id: string;
  schema_version: number;
  revision: string;
  created_at: string;
  updated_at: string;
  document: Investigation;
}

class FakePostgres implements PgPoolLike {
  records = new Map<string, Row>();
  readonly history: { sql: string; values: unknown[] }[] = [];
  readonly releaseErrors: (Error | undefined)[] = [];
  rollbackFailure?: Error;

  async query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values: unknown[] = [],
  ): Promise<PgQueryResult<T>> {
    return this.execute<T>(sql, values, this.records);
  }

  async connect(): Promise<PgClientLike> {
    return new FakeClient(this);
  }

  async execute<T extends Record<string, unknown>>(
    sql: string,
    values: unknown[],
    records: Map<string, Row>,
  ): Promise<PgQueryResult<T>> {
    this.history.push({ sql, values: structuredClone(values) });
    const normalized = sql.trim().toLowerCase().replace(/\s+/g, " ");
    let rows: Record<string, unknown>[] = [];
    let rowCount: number | null = null;
    if (normalized.startsWith("insert into investigations")) {
      const [id, schemaVersion, revision, createdAt, updatedAt, document] = values as [
        string, number, number, string, string, string,
      ];
      const value = JSON.parse(document) as Investigation;
      records.set(id, { id, schema_version: schemaVersion, revision: String(revision), created_at: createdAt, updated_at: updatedAt, document: value });
      rowCount = 1;
    } else if (normalized.startsWith("select") && normalized.includes("from investigations where id = $1")) {
      const row = records.get(String(values[0]));
      rows = row === undefined ? [] : [row as unknown as Record<string, unknown>];
    } else if (normalized.startsWith("select") && normalized.includes("from investigations order by")) {
      rows = [...records.values()].map((row) => row as unknown as Record<string, unknown>);
    } else if (normalized.startsWith("update investigations")) {
      const [id, schemaVersion, revision, updatedAt, document] = values as [
        string, number, number, string, string,
      ];
      const previous = records.get(id);
      if (previous !== undefined) {
        records.set(id, {
          ...previous,
          schema_version: schemaVersion,
          revision: String(revision),
          updated_at: updatedAt,
          document: JSON.parse(document) as Investigation,
        });
        rowCount = 1;
      } else rowCount = 0;
    }
    return { rows: rows as T[], rowCount };
  }
}

class FakeClient implements PgClientLike {
  #transaction?: Map<string, Row>;
  private readonly database: FakePostgres;

  constructor(database: FakePostgres) {
    this.database = database;
  }

  async query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values: unknown[] = [],
  ): Promise<PgQueryResult<T>> {
    const normalized = sql.trim().toLowerCase();
    if (normalized === "begin") this.#transaction = new Map(this.database.records);
    if (normalized === "commit" && this.#transaction !== undefined) {
      this.database.records = this.#transaction;
      this.#transaction = undefined;
      return { rows: [], rowCount: null };
    }
    if (normalized === "rollback") {
      this.database.history.push({ sql, values: structuredClone(values) });
      if (this.database.rollbackFailure !== undefined) throw this.database.rollbackFailure;
      this.#transaction = undefined;
      return { rows: [], rowCount: null };
    }
    return this.database.execute(sql, values, this.#transaction ?? this.database.records);
  }

  release(error?: Error): void {
    this.database.releaseErrors.push(error);
  }
}

/** Older workflow tests pin a user-scanner-only queue; Gravatar tests pass the full catalog. */
function makeStoreHarness(seedCatalog: readonly ScopedCatalogId[] = ["user-scanner.email.v1"]) {
  const database = new FakePostgres();
  const store = new PostgresInvestigationStore(database);
  let sequence = 0;
  let ticks = 0;
  const executor: InvestigationExecutor = { id: "not-called", async execute() { return []; } };
  const service = createInvestigationService({
    store,
    executor,
    clock: () => `2025-03-01T00:00:${String(ticks++).padStart(2, "0")}.000Z`,
    createId: (kind) => `${kind}-${++sequence}`,
    seedCatalog,
  });
  return { database, store, service };
}

function auditEvent(id: string, kind: "action_claimed" | "action_succeeded"): CompleteActionInput["auditEvent"] {
  return { id, at: "2025-03-01T00:01:00.000Z", actor: "system", kind, reason: "offline test" };
}

test("offline SQL fake verifies versioned JSON migration and parameterized adapter behavior", async () => {
  const { database, store } = makeStoreHarness();
  await store.migrate();
  const hostileId = "id' OR 1=1 --";
  const initial = createInitialInvestigation(hostileId, "2025-03-01T00:00:00.000Z");
  await store.create(initial);
  assert.equal(database.records.get(hostileId)?.schema_version, 1);
  assert.deepEqual(database.records.get(hostileId)?.document, initial);
  const loaded = await store.get(hostileId);
  assert.deepEqual(loaded, initial);
  const row = database.records.get(hostileId)!;
  row.schema_version = 2;
  await assert.rejects(store.get(hostileId), /Unsupported investigation schema version/);
  row.schema_version = 1;
  assert.equal((await store.list()).length, 1);

  const select = database.history.find((entry) => entry.sql.toLowerCase().includes("where id = $1"));
  assert.equal(select?.values[0], hostileId);
  assert.doesNotMatch(select?.sql ?? "", /OR 1=1/);
  assert.ok(database.history.some((entry) => entry.sql.includes("pg_advisory_xact_lock")));
  assert.ok(database.history.some((entry) => entry.sql.includes("schema_version")));
  const migration = database.history.find((entry) => entry.sql.includes("CREATE TABLE IF NOT EXISTS investigations"))?.sql;
  assert.ok(migration);
  assert.match(migration, /jsonb_typeof\(document -> 'id'\) IS NOT NULL/);
  assert.match(migration, /jsonb_typeof\(document -> 'revision'\) IS NOT NULL/);
});

test("scanner actions and cross-target findings round-trip, malformed new findings never write", async () => {
  const { database, store, service } = makeStoreHarness();
  const created = await service.createInvestigation();
  const seeded = await service.addEmailSeed(created.id, "seed@example.org");
  assert.equal((await store.get(created.id))?.actions[0]?.spec.catalogId, "user-scanner.email.v1");
  const finding = {
    target: { kind: "username" as const, value: "derived" }, upstreamStatus: "Found" as const,
    url: "https://example.org/derived", category: "Social", reason: "",
    extra: { confidence: "candidate", pivot_source: "profile link" }, media: {},
  };
  const withFinding: Investigation = { ...seeded, revision: seeded.revision + 1, evidence: [{
    id: "evidence", actionId: seeded.actions[0]!.id, seed: seeded.emailSeeds[0]!, provider: "Example", status: "registered",
    sourceId: "user-scanner:email", recordedAt: seeded.updatedAt, finding,
  }] };
  await store.transact(created.id, () => ({ next: withFinding, result: undefined }));
  assert.deepEqual((await store.get(created.id))?.evidence[0]?.finding, finding);
  const before = structuredClone(database.records.get(created.id));
  const corrupt = { ...withFinding, revision: withFinding.revision + 1, evidence: [{ ...withFinding.evidence[0]!, finding: { ...finding, media: { avatar: 42 } } }] } as unknown as Investigation;
  await assert.rejects(store.transact(created.id, () => ({ next: corrupt, result: undefined })), InvestigationSchemaError);
  assert.deepEqual(database.records.get(created.id), before);
});

test("explicit action sourceSeedId round-trips, legacy actions load without it, malformed values never write", async () => {
  const { database, store, service } = makeStoreHarness();
  const created = await service.createInvestigation();
  const seeded = await service.addEmailSeed(created.id, "seed@example.org");
  const legacy = await store.get(created.id);
  assert.equal(legacy?.actions[0]?.sourceSeedId, undefined);
  assert.ok(!Object.prototype.hasOwnProperty.call(database.records.get(created.id)!.document.actions[0], "sourceSeedId"));
  assert.deepEqual(legacy, seeded);

  const linked: Investigation = {
    ...seeded,
    revision: seeded.revision + 1,
    actions: seeded.actions.map((action) => ({ ...action, sourceSeedId: "seed:evidence:ev-1" })),
  };
  await store.transact(created.id, () => ({ next: linked, result: undefined }));
  assert.equal((await store.get(created.id))?.actions[0]?.sourceSeedId, "seed:evidence:ev-1");

  const before = structuredClone(database.records.get(created.id));
  for (const invalid of ["", "   ", 42, null]) {
    const corrupt = {
      ...linked,
      revision: linked.revision + 1,
      actions: linked.actions.map((action) => ({ ...action, sourceSeedId: invalid })),
    } as unknown as Investigation;
    await assert.rejects(store.transact(created.id, () => ({ next: corrupt, result: undefined })), InvestigationSchemaError);
    assert.deepEqual(database.records.get(created.id), before);
  }
  const row = database.records.get(created.id)!;
  row.document = { ...linked, actions: linked.actions.map((action) => ({ ...action, sourceSeedId: 7 })) } as unknown as Investigation;
  await assert.rejects(store.get(created.id), InvestigationSchemaError);
});

test("catalog queues round-trip without approvals and automatic claims recheck mode and gates", async () => {
  const { database, store, service } = makeStoreHarness();
  const created = await service.createInvestigation("Automático", "Intención única");
  await service.addEmailSeed(created.id, "catalog@example.test");
  const request: ClaimActionRequest = { investigationId: created.id, automaticOnly: true, claimId: "worker-claim", claimedAt: "2025-03-01T00:01:00.000Z", auditEvent: auditEvent("claim", "action_claimed") };
  assert.equal(await store.claimNextAction(request), undefined);
  await service.authorize(created.id, true, "Autorización del caso");
  await service.pause(created.id, "Pausa del caso");
  assert.equal(await store.claimNextAction(request), undefined);
  await service.resume(created.id, "Reanudar caso");
  const row = database.records.get(created.id)!;
  row.document = { ...row.document, advancementMode: "manual" };
  assert.equal(await store.claimNextAction(request), undefined);
  const { advancementMode: _mode, ...legacy } = row.document;
  row.document = legacy;
  assert.equal(await store.claimNextAction(request), undefined, "legacy mode fails closed inside the claim");
  row.document = { ...row.document, advancementMode: "automatic" };
  const claim = await store.claimNextAction(request);
  assert.equal(claim?.action.approval, undefined);
  assert.equal(claim?.action.queuedByCatalog, true);
  assert.equal(await store.claimNextAction({ ...request, claimId: "second-worker" }), undefined);
  const restarted = new PostgresInvestigationStore(database);
  assert.equal(await restarted.claimNextAction({ ...request, claimId: "restart" }), undefined, "restart must retain claimed fencing");
  const persisted = await restarted.get(created.id);
  assert.ok(!persisted?.audit.some((event) => event.kind === "action_approved"));
  assert.equal(persisted?.intention, created.intention);
});

test("legacy authorization cannot silently broaden into a loud cross-scan", async () => {
  const { database, store, service } = makeStoreHarness();
  const created = await service.createInvestigation();
  await service.addEmailSeed(created.id, "seed@example.org");
  await service.authorize(created.id, true, "Authorized scanner");
  const row = database.records.get(created.id)!;
  const authorization = { granted: true, at: row.document.updatedAt, reason: "Old GitHub authorization", operator: "local-operator" as const };
  row.document = { ...row.document, authorization };
  const before = structuredClone(row);
  const input: ClaimActionRequest = { investigationId: created.id, claimId: "claim", claimedAt: "2025-03-01T00:01:00Z", auditEvent: auditEvent("claim", "action_claimed") };
  assert.equal(await store.claimNextAction(input), undefined);
  assert.deepEqual(database.records.get(created.id), before);
  await service.authorize(created.id, true, "Explicitly authorize scanner, loud modules and cross-targets");
  assert.ok(await store.claimNextAction(input));
});

test("per-tool consent scopes round-trip, unknown scopes never write and empty scopes never claim", async () => {
  const { database, store, service } = makeStoreHarness();
  const created = await service.createInvestigation();
  await service.addEmailSeed(created.id, "seed@example.org");
  const granted = await service.authorize(created.id, true, "Authorize the listed tools");
  assert.deepEqual(granted.authorization?.catalogScopes, ["user-scanner.email.v1", "gravatar.email.v1", "maigret.username.v1"]);
  assert.deepEqual((await store.get(created.id))?.authorization?.catalogScopes, ["user-scanner.email.v1", "gravatar.email.v1", "maigret.username.v1"]);

  const before = structuredClone(database.records.get(created.id));
  for (const catalogScopes of [["unknown.tool.v1"], ["user-scanner.email.v1", "user-scanner.email.v1"], "user-scanner.email.v1"]) {
    const corrupt = { ...granted, revision: granted.revision + 1, authorization: { ...granted.authorization!, catalogScopes } } as unknown as Investigation;
    await assert.rejects(store.transact(created.id, () => ({ next: corrupt, result: undefined })), InvestigationSchemaError);
    assert.deepEqual(database.records.get(created.id), before);
  }

  const row = database.records.get(created.id)!;
  const { catalogScope: _single, ...rest } = row.document.authorization!;
  row.document = { ...row.document, authorization: { ...rest, catalogScopes: [] } };
  const unscoped = structuredClone(row);
  const input: ClaimActionRequest = { investigationId: created.id, claimId: "claim", claimedAt: "2025-03-01T00:01:00Z", auditEvent: auditEvent("claim", "action_claimed") };
  assert.equal(await store.claimNextAction(input), undefined);
  assert.deepEqual(database.records.get(created.id), unscoped);
});

test("each email seed queues user-scanner then Gravatar, and a user-scanner-only grant never claims Gravatar", async () => {
  const { database, store, service } = makeStoreHarness(["user-scanner.email.v1", "gravatar.email.v1"]);
  const created = await service.createInvestigation();
  const seeded = await service.addEmailSeed(created.id, "seed@example.org");
  assert.deepEqual(seeded.actions.map((action) => [action.spec.catalogId, action.spec.provider, action.status, action.queuedByCatalog]), [
    ["user-scanner.email.v1", "user-scanner", "queued", true],
    ["gravatar.email.v1", "gravatar", "queued", true],
  ]);
  assert.deepEqual(await store.get(created.id), seeded, "the Gravatar spec round-trips");
  const granted = await service.authorize(created.id, true, "Authorize the listed tools");
  assert.deepEqual(granted.authorization?.catalogScopes, ["user-scanner.email.v1", "gravatar.email.v1", "maigret.username.v1"]);

  const row = database.records.get(created.id)!;
  row.document = { ...row.document, authorization: { ...row.document.authorization!, catalogScopes: ["user-scanner.email.v1"] } };
  const input: ClaimActionRequest = { investigationId: created.id, claimId: "claim-1", claimedAt: "2025-03-01T00:01:00Z", auditEvent: auditEvent("claim", "action_claimed") };
  assert.equal((await store.claimNextAction(input))?.action.spec.catalogId, "user-scanner.email.v1");
  const afterFirst = structuredClone(database.records.get(created.id));
  assert.equal(await store.claimNextAction({ ...input, claimId: "claim-2" }), undefined);
  assert.deepEqual(database.records.get(created.id), afterFirst);

  const corrupt = { ...seeded, revision: (await store.get(created.id))!.revision + 1, actions: seeded.actions.map((action) =>
    action.spec.catalogId === "gravatar.email.v1" ? { ...action, spec: { ...action.spec, provider: "user-scanner" } } : action) } as unknown as Investigation;
  await assert.rejects(store.transact(created.id, () => ({ next: corrupt, result: undefined })), InvestigationSchemaError);
  assert.deepEqual(database.records.get(created.id), afterFirst);
});

test("username seeds, Maigret actions and username evidence round-trip while legacy snapshots load unchanged", async () => {
  const { database, store, service } = makeStoreHarness();
  const legacy = await service.createInvestigation();
  await service.addEmailSeed(legacy.id, "seed@example.org");
  const legacyDocument = structuredClone(database.records.get(legacy.id)!.document);
  assert.ok(!Object.prototype.hasOwnProperty.call(legacyDocument, "usernameSeeds"));
  assert.deepEqual(await store.get(legacy.id), legacyDocument);

  const created = await service.createInvestigation();
  const seeded = await service.addUsernameSeed(created.id, "anaexample", "Username supplied by the operator.");
  assert.deepEqual(await store.get(created.id), seeded);
  const withEvidence: Investigation = { ...seeded, revision: seeded.revision + 1, evidence: [{
    id: "evidence", actionId: seeded.actions[0]!.id, seed: { kind: "username", value: "anaexample" }, provider: "GitHub",
    status: "registered", sourceId: "maigret:username", recordedAt: seeded.updatedAt, finding: {
      target: { kind: "username", value: "anaexample" }, upstreamStatus: "Found", url: "https://github.com/anaexample",
      category: "coding", reason: "", extra: { source: "maigret" }, media: {},
    },
  }] };
  await store.transact(created.id, () => ({ next: withEvidence, result: undefined }));
  assert.deepEqual(await store.get(created.id), withEvidence);

  const before = structuredClone(database.records.get(created.id));
  const record = withEvidence.usernameSeeds![0]!;
  const corruptions: unknown[] = [
    { usernameSeeds: [{ ...record, value: "--help" }] },
    { usernameSeeds: [{ ...record, kind: "email" }] },
    { usernameSeeds: [{ ...record, status: "maybe" }] },
    { usernameSeeds: [{ ...record, origin: { kind: "evidence" } }] },
    { usernameSeeds: [record, record] },
    { usernameSeeds: "anaexample" },
    { actions: [{ ...withEvidence.actions[0]!, spec: { ...withEvidence.actions[0]!.spec, seed: { kind: "email", value: "a@example.org" } } }] },
    { actions: [{ ...withEvidence.actions[0]!, spec: { catalogId: "user-scanner.email.v1", provider: "user-scanner", seed: { kind: "username", value: "anaexample" } } }] },
    { evidence: [{ ...withEvidence.evidence[0]!, seed: { kind: "username", value: "--help" } }] },
  ];
  for (const corruption of corruptions) {
    const corrupt = { ...withEvidence, revision: withEvidence.revision + 1, ...(corruption as object) } as unknown as Investigation;
    await assert.rejects(store.transact(created.id, () => ({ next: corrupt, result: undefined })), InvestigationSchemaError);
    assert.deepEqual(database.records.get(created.id), before);
  }
});

test("a grant recorded before Maigret was added never claims a Maigret action", async () => {
  const { database, store, service } = makeStoreHarness();
  const created = await service.createInvestigation();
  await service.addUsernameSeed(created.id, "anaexample", "Username supplied by the operator.");
  const granted = await service.authorize(created.id, true, "Authorize the listed tools");
  assert.deepEqual(granted.authorization?.catalogScopes, ["user-scanner.email.v1", "gravatar.email.v1", "maigret.username.v1"]);
  const row = database.records.get(created.id)!;
  row.document = { ...row.document, authorization: { ...row.document.authorization!, catalogScopes: ["user-scanner.email.v1", "gravatar.email.v1"] } };
  const before = structuredClone(row);
  const input: ClaimActionRequest = { investigationId: created.id, claimId: "claim", claimedAt: "2025-03-01T00:01:00Z", auditEvent: auditEvent("claim", "action_claimed") };
  assert.equal(await store.claimNextAction(input), undefined);
  assert.deepEqual(database.records.get(created.id), before);
  await service.authorize(created.id, true, "Renew the authorization for Maigret");
  assert.equal((await store.claimNextAction(input))?.action.spec.catalogId, "maigret.username.v1");
});

test("completion rejects malformed username evidence without a finding", async () => {
  const { database, store, service } = makeStoreHarness();
  const created = await service.createInvestigation();
  await service.addUsernameSeed(created.id, "ana", "Operator input");
  await service.authorize(created.id, true, "Authorize tools");
  const claim = await store.claimNextAction({
    investigationId: created.id, claimId: "claim",
    claimedAt: "2025-03-01T00:01:00Z",
    auditEvent: auditEvent("claim-audit", "action_claimed"),
  });
  assert.ok(claim);
  const before = structuredClone(database.records.get(created.id));
  for (const record of [{ seed: { kind: "username", value: "--help" } }, { seed: { kind: "username", value: "ana" } }, { seed: { kind: "phone", value: "1" } }]) {
    await assert.rejects(store.completeAction({
      investigationId: created.id, actionId: claim.action.id, claimId: "claim",
      completedAt: "2025-03-01T00:02:00Z",
      result: {
        kind: "success", unsupportedObservationCount: 0,
        evidence: [record] as unknown as Extract<CompleteActionInput["result"], { kind: "success" }>["evidence"],
      },
      auditEvent: auditEvent("completion-audit", "action_succeeded"),
    }), InvestigationSchemaError);
    assert.deepEqual(database.records.get(created.id), before);
  }
});

test("Gravatar findings for a mixed-case email seed are retained", async () => {
  const database = new FakePostgres();
  const store = new PostgresInvestigationStore(database);
  let sequence = 0;
  const service = createInvestigationService({
    store,
    executor: createCatalogExecutor({ "gravatar.email.v1": createGravatarBox({ fetch: (async () => Response.json({ display_name: "Ana" })) as typeof fetch }) }),
    clock: () => "2025-03-01T00:00:00.000Z",
    createId: (kind) => `${kind}-${++sequence}`,
    seedCatalog: ["gravatar.email.v1"],
  });
  const created = await service.createInvestigation();
  await service.addEmailSeed(created.id, "Ana.Example@Example.org");
  await service.authorize(created.id, true, "Authorize the listed tools");
  const completed = await service.executeNextAction(created.id);
  assert.equal(completed?.unsupportedObservationCount, 0);
  assert.deepEqual((await store.get(created.id))?.evidence.map((record) => [record.provider, record.seed.value]), [["Gravatar", "Ana.Example@Example.org"]]);
});

test("catalog executor evidence records the tool that produced it", async () => {
  const database = new FakePostgres();
  const store = new PostgresInvestigationStore(database);
  let sequence = 0;
  const service = createInvestigationService({
    store,
    executor: createCatalogExecutor({
      "user-scanner.email.v1": {
        id: "user-scanner:email", inputKind: "email",
        async execute(seed) {
          return [{ kind: "scanner_finding", seed, provider: "Example", status: "registered", finding: {
            target: { kind: "email", value: seed.value }, upstreamStatus: "Registered", url: "https://example.org",
            category: "Social", reason: "", extra: {}, media: {},
          } }];
        },
      },
      "gravatar.email.v1": {
        id: "gravatar:email", inputKind: "email",
        async execute(seed) {
          return [{ kind: "scanner_finding", seed, provider: "Gravatar", status: "registered", finding: {
            target: { kind: "email", value: seed.value }, upstreamStatus: "Found", url: "https://gravatar.com/seed",
            category: "Profile", reason: "", extra: { display_name: "Seed Person" }, media: {},
          } }];
        },
      },
    }),
    clock: () => "2025-03-01T00:00:00.000Z",
    createId: (kind) => `${kind}-${++sequence}`,
  });
  const created = await service.createInvestigation();
  await service.addEmailSeed(created.id, "seed@example.org");
  await service.authorize(created.id, true, "Authorize the listed tools");
  assert.equal((await service.executeNextAction(created.id))?.status, "succeeded");
  assert.equal((await service.executeNextAction(created.id))?.status, "succeeded");
  assert.equal(await service.executeNextAction(created.id), undefined);
  const evidence = (await store.get(created.id))?.evidence;
  assert.deepEqual(evidence?.map((record) => [record.provider, record.sourceId]), [
    ["Example", "user-scanner:email"],
    ["Gravatar", "gravatar:email"],
  ]);
});

test("creation metadata round-trips while legacy snapshots stay manual", async () => {
  const { database, store, service } = makeStoreHarness();
  const created = await service.createInvestigation("Caso", "Verificar registro", "manual");
  assert.deepEqual(await store.get(created.id), created);
  const row = database.records.get(created.id)!;
  const legacy: Record<string, unknown> = { ...row.document };
  delete legacy.intention;
  delete legacy.advancementMode;
  row.document = legacy as unknown as Investigation;
  const loaded = await store.get(created.id);
  assert.equal(loaded?.intention, "");
  assert.equal(loaded?.advancementMode, "manual");
  const changed = await service.addEmailSeed(created.id, "ana@example.test", "Semilla");
  assert.equal(changed.advancementMode, "manual");
  assert.equal(changed.intention, "");
  const persisted = database.records.get(created.id)!;
  for (const invalid of [null, "unknown", 1]) {
    persisted.document = { ...changed, advancementMode: invalid } as unknown as Investigation;
    await assert.rejects(store.get(created.id), InvestigationSchemaError);
  }
  persisted.document = { ...changed, intention: null } as unknown as Investigation;
  await assert.rejects(store.get(created.id), InvestigationSchemaError);
});

test("schema-v1 legacy snapshots get a deterministic name that survives mutations", async () => {
  const { database, store, service } = makeStoreHarness();
  const created = await service.createInvestigation();
  const row = database.records.get(created.id)!;
  const legacyDocument: Record<string, unknown> = { ...row.document };
  delete legacyDocument.name;
  row.document = legacyDocument as unknown as Investigation;

  const loaded = await store.get(created.id);
  assert.equal(loaded?.name, "Untitled investigation");
  assert.equal((await store.list())[0]?.name, "Untitled investigation");
  const updated = await service.addEmailSeed(created.id, "legacy@example.org", "Update a legacy snapshot.");
  assert.equal(updated.name, "Untitled investigation");
  assert.equal(database.records.get(created.id)?.document.name, "Untitled investigation");
  assert.equal(database.records.get(created.id)?.schema_version, 1, "adding a compatible field does not bump schema version");

  const updatedRow = database.records.get(created.id)!;
  updatedRow.document = { ...updatedRow.document, name: "   " } as Investigation;
  await assert.rejects(store.get(created.id), InvestigationSchemaError);
});

test("offline SQL fake exercises persisted gates, completion fencing, and retained claims", async () => {
  const { database, store, service } = makeStoreHarness();
  await store.migrate();
  const investigation = await service.createInvestigation();
  await service.addEmailSeed(investigation.id, "person@example.org", "Seed supplied by operator.");
  const action = await service.proposeGitHubAction(investigation.id, "person@example.org", "Propose one check.");
  const claimedAt = "2025-03-01T00:01:00.000Z";
  const claimInput = (claimId: string): ClaimActionRequest => ({
    investigationId: investigation.id,
    claimId,
    claimedAt,
    auditEvent: auditEvent(`audit-${claimId}`, "action_claimed"),
  });
  assert.equal(await store.claimNextAction(claimInput("unauthorized")), undefined);
  await service.authorize(investigation.id, true, "Authorized explicitly.");
  assert.equal(await store.claimNextAction(claimInput("unapproved")), undefined);
  await service.approveAction(investigation.id, action.id, "Approved explicitly.");
  await service.pause(investigation.id, "Pause before run.");
  assert.equal(await store.claimNextAction(claimInput("paused")), undefined);
  await service.resume(investigation.id, "Resume without granting approval.");

  const claim = await store.claimNextAction(claimInput("claim-current"));
  assert.equal(claim?.action.status, "claimed");
  const recoveredProcessStore = new PostgresInvestigationStore(database);
  assert.equal(await recoveredProcessStore.claimNextAction(claimInput("claim-retry")), undefined);
  assert.equal((await recoveredProcessStore.get(investigation.id))?.actions[0]?.status, "claimed");

  const wrongCompletion: CompleteActionInput = {
    investigationId: investigation.id,
    actionId: action.id,
    claimId: "stale-claim",
    completedAt: "2025-03-01T00:02:00.000Z",
    result: { kind: "success", evidence: [], unsupportedObservationCount: 0 },
    auditEvent: auditEvent("audit-stale", "action_succeeded"),
  };
  await assert.rejects(
    recoveredProcessStore.completeAction(wrongCompletion),
    (error: unknown) => error instanceof InvestigationClaimConflictError,
  );
  assert.equal((await recoveredProcessStore.get(investigation.id))?.actions[0]?.status, "claimed");

  await recoveredProcessStore.completeAction({
    ...wrongCompletion,
    claimId: claim!.action.claim.id,
    auditEvent: auditEvent("audit-success", "action_succeeded"),
  });
  const completed = await recoveredProcessStore.get(investigation.id);
  assert.equal(completed?.actions[0]?.status, "succeeded");
  assert.equal(completed?.revision, 8);
  assert.equal(await recoveredProcessStore.claimNextAction(claimInput("claim-again")), undefined);
});

test("offline SQL fake rolls back a failed mutation without advancing revision", async () => {
  const { database, store, service } = makeStoreHarness();
  await store.migrate();
  const investigation = await service.createInvestigation();
  await assert.rejects(store.transact(investigation.id, () => { throw new Error("operation failed"); }));
  assert.equal((await store.get(investigation.id))?.revision, 0);
  assert.ok(database.history.some((entry) => entry.sql.trim().toLowerCase() === "rollback"));
});

test("offline SQL fake evicts a client after rollback failure and preserves the mutation error", async () => {
  const { database, store, service } = makeStoreHarness();
  await store.migrate();
  const investigation = await service.createInvestigation();
  const mutationError = new Error("operation failed");
  const rollbackError = new Error("rollback failed");
  database.rollbackFailure = rollbackError;

  await assert.rejects(
    store.transact(investigation.id, () => { throw mutationError; }),
    (error: unknown) => error === mutationError,
  );
  assert.equal(database.releaseErrors.at(-1), rollbackError);
});

test("offline claim gate rejects malformed persisted authorization, approval, and action shapes", async () => {
  const { database, store, service } = makeStoreHarness();
  await store.migrate();
  const investigation = await service.createInvestigation();
  await service.addEmailSeed(investigation.id, "person@example.org", "Seed supplied by operator.");
  const action = await service.proposeGitHubAction(investigation.id, "person@example.org", "Propose one check.");
  await service.authorize(investigation.id, true, "Authorized explicitly.");
  await service.approveAction(investigation.id, action.id, "Approved explicitly.");
  const row = database.records.get(investigation.id)!;
  const validDocument = row.document;
  const claimRequest: ClaimActionRequest = {
    investigationId: investigation.id,
    claimId: "malformed-state-claim",
    claimedAt: "2025-03-01T00:01:00.000Z",
    auditEvent: auditEvent("audit-malformed-state", "action_claimed"),
  };

  row.document = {
    ...validDocument,
    authorization: { granted: true },
  } as unknown as Investigation;
  await assert.rejects(store.claimNextAction(claimRequest), InvestigationSchemaError);

  row.document = {
    ...validDocument,
    actions: validDocument.actions.map((candidate) => ({ ...candidate, approval: null })),
  } as unknown as Investigation;
  await assert.rejects(store.claimNextAction(claimRequest), InvestigationSchemaError);

  row.document = {
    ...validDocument,
    actions: [null],
  } as unknown as Investigation;
  await assert.rejects(store.claimNextAction(claimRequest), InvestigationSchemaError);
});
