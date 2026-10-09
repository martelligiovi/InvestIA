import assert from "node:assert/strict";
import test from "node:test";
import {
  createInitialInvestigation,
  createInvestigationService,
  type ClaimActionRequest,
  type CompleteActionInput,
  type Investigation,
  type InvestigationExecutor,
} from "@investia/core";
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

function makeStoreHarness() {
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
