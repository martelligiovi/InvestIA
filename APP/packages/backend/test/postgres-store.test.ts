import assert from "node:assert/strict";
import test from "node:test";
import {
  createCatalogExecutor,
  createInitialInvestigation,
  createInvestigationService,
  findingSeedNodeId,
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
function makeStoreHarness(seedCatalog: readonly ScopedCatalogId[] = ["user-scanner.email.v1"],
  executor: InvestigationExecutor = { id: "not-called", async execute() { return []; } }) {
  const database = new FakePostgres();
  const store = new PostgresInvestigationStore(database);
  let sequence = 0;
  let ticks = 0;
  const service = createInvestigationService({
    store,
    executor,
    clock: () => `2025-03-01T00:00:${String(ticks++).padStart(2, "0")}.000Z`,
    createId: (kind) => `${kind}-${++sequence}`,
    seedCatalog,
  });
  return { database, store, service };
}

function auditEvent(id: string, kind: "action_claimed" | "action_succeeded" | "action_failed"): CompleteActionInput["auditEvent"] {
  return { id, at: "2025-03-01T00:01:00.000Z", actor: "system", kind, reason: "offline test" };
}

async function rerunFixture(childStatus: "queued" | "claimed" = "queued", executor?: InvestigationExecutor) {
  const { store, service } = makeStoreHarness(["user-scanner.email.v1", "gravatar.email.v1"], executor);
  const at = "2025-03-01T00:00:00.000Z";
  const seed = { kind: "email", value: "owner@example.org" } as const;
  const run = {
    id: "root", status: "succeeded", spec: { catalogId: "user-scanner.email.v1", provider: "user-scanner", seed },
    proposedAt: at, completedAt: at, proposalReason: "Fixture scan", queuedByCatalog: true,
  } as const;
  const first = { id: "old", actionId: run.id, seed, status: "registered", sourceId: "user-scanner:email", provider: "Fixture", recordedAt: at } as const;
  const child = {
    ...run, id: "child", status: childStatus, sourceSeedId: findingSeedNodeId(first.id),
    spec: { catalogId: "gravatar.email.v1", provider: "gravatar", seed },
    ...(childStatus === "claimed" ? { claim: { id: "in-flight", claimedAt: at } } : {}),
  } as const;
  const created: Investigation = {
    ...createInitialInvestigation("rerun-case", at), advancementMode: "manual", emailSeeds: [seed],
    authorization: { granted: true, catalogScopes: ["user-scanner.email.v1", "gravatar.email.v1"], at, reason: "Fixture grant", operator: "local-operator" },
    actions: [child, run, { ...run, id: "sibling" }], evidence: [first, { ...first, id: "sibling-result", actionId: "sibling" }],
  };
  await store.create(created);
  const claimRequest: ClaimActionRequest = { investigationId: created.id, claimId: "new-claim", claimedAt: at, auditEvent: auditEvent("new-claim-audit", "action_claimed") };
  const evidence = { ...first, id: "replacement" };
  return { store, service, created, run, claimRequest, evidence };
}

test("a rerun keeps its previous results until successful completion commits the new branch", async () => {
  const { store, service, created, run, claimRequest, evidence } = await rerunFixture();
  const pending = await service.requestActionRerun(created.id, run.id, created.revision);
  assert.equal(pending.revision, created.revision + 1);
  assert.deepEqual(pending.evidence, created.evidence);
  assert.deepEqual(pending.actions.map(({ id, status }) => [id, status]), [["child", "queued"], ["root", "queued"], ["sibling", "succeeded"]]);
  assert.equal(await store.claimNextAction({ ...claimRequest, automaticOnly: true }), undefined);
  assert.equal((await store.claimNextAction(claimRequest))?.action.id, "root", "the old child cannot dispatch ahead of its replacement");
  assert.deepEqual((await store.get(created.id))?.evidence, created.evidence);
  const followUp = { ...created.actions[0]!, id: "new-child", sourceSeedId: findingSeedNodeId(evidence.id) };
  const result = await store.completeAction({ investigationId: created.id, actionId: run.id, claimId: claimRequest.claimId,
    completedAt: claimRequest.claimedAt, auditEvent: auditEvent("success", "action_succeeded"),
    result: { kind: "success", evidence: [evidence], unsupportedObservationCount: 0 },
    followUps: [{ action: followUp, auditEvent: { ...auditEvent("queue", "action_succeeded"), kind: "action_queued", actionId: followUp.id } }],
  });
  assert.equal(result.revision, pending.revision + 2);
  assert.deepEqual(result.actions.map(({ id, status }) => [id, status]), [["root", "succeeded"], ["sibling", "succeeded"], ["new-child", "queued"]]);
  assert.deepEqual(result.evidence.map(({ id }) => id), ["sibling-result", "replacement"]);
  assert.equal(result.audit.find(({ id }) => id === "success")?.kind, "action_rerun_succeeded");
  assert.deepEqual(await store.get(created.id), result);
});

test("a provider failure or a changed previous branch never discards prior results", async () => {
  for (const conflict of [false, true]) {
    const { store, service, created, run, claimRequest, evidence } = await rerunFixture();
    await service.requestActionRerun(created.id, run.id, created.revision);
    await store.claimNextAction(claimRequest);
    if (conflict) await service.validateEvidence(created.id, "old", "accepted", "Review during replacement");
    const before = (await store.get(created.id))!;
    const result = await store.completeAction({ investigationId: created.id, actionId: run.id, claimId: claimRequest.claimId,
      completedAt: claimRequest.claimedAt, auditEvent: auditEvent("terminal", conflict ? "action_succeeded" : "action_failed"),
      result: conflict ? { kind: "success", evidence: [evidence], unsupportedObservationCount: 0 } : { kind: "failure", error: "fixture failure" },
    });
    assert.deepEqual(result.evidence, before.evidence);
    assert.deepEqual(result.validations, before.validations);
    assert.deepEqual(result.actions.filter(({ id }) => id !== run.id), before.actions.filter(({ id }) => id !== run.id));
    assert.equal(result.actions.find(({ id }) => id === run.id)?.status, "succeeded");
    assert.equal(result.actions.find(({ id }) => id === run.id)?.lastRerunFailed, true);
    assert.equal(
      result.actions.find(({ id }) => id === run.id)?.lastRerunFailure,
      conflict ? "Prior results changed during execution; the replacement was not applied." : "fixture failure",
    );
    assert.equal(result.audit.at(-1)?.kind, "action_failed");
    assert.equal(result.revision, before.revision + 1);
  }
});

test("a legacy failed action survives a rerun error at the Unicode storage boundary", async () => {
  const { store, service, created, run, claimRequest } = await rerunFixture();
  const legacy = await store.transact(created.id, (current) => {
    const next: Investigation = {
      ...current,
      revision: current.revision + 1,
      actions: current.actions.map((action) => action.id === run.id
        ? { ...action, status: "failed", failure: "Prior failure", lastRerunFailed: true }
        : action),
    };
    return { next, result: next };
  });
  assert.deepEqual(await store.get(created.id), legacy);
  const queued = await service.requestActionRerun(created.id, run.id, legacy.revision);
  const queuedAction = queued.actions.find(({ id }) => id === run.id)!;
  assert.equal(queuedAction.lastRerunFailed, undefined);
  assert.equal(queuedAction.lastRerunFailure, undefined);
  assert.equal((await store.claimNextAction(claimRequest))?.action.id, run.id);

  const result = await store.completeAction({
    investigationId: created.id, actionId: run.id, claimId: claimRequest.claimId,
    completedAt: claimRequest.claimedAt, auditEvent: auditEvent("unicode", "action_failed"),
    result: { kind: "failure", error: "bad\u0000\uDC00\uD800" + "x".repeat(994) + "🚀" },
  });
  const restored = result.actions.find(({ id }) => id === run.id)!;
  assert.equal(restored.status, "failed");
  assert.equal(restored.failure, "Prior failure");
  assert.deepEqual(result.evidence, legacy.evidence);
  assert.ok(restored.lastRerunFailure);
  assert.doesNotMatch(restored.lastRerunFailure, /\u0000|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
});

test("prevents a rerun from overlapping an already-claimed child and leaves the snapshot unchanged", async () => {
  const { store, service, created, run } = await rerunFixture("claimed");
  const before = await store.get(created.id);
  await assert.rejects(service.requestActionRerun(created.id, run.id, created.revision), { name: "ActionRerunConflictError" });
  assert.deepEqual(await store.get(created.id), before);
});

test("ordinary scanner proposals cannot overwrite a pending rerun", async () => {
  const { store, service, created, run, claimRequest } = await rerunFixture();
  const pending = await service.requestActionRerun(created.id, run.id, created.revision);
  await assert.rejects(service.proposeUserScannerAction(created.id, run.spec.seed.value, "Other tab"),
    { message: "A scanner catalog action already exists for this email seed" });
  assert.deepEqual(await store.get(created.id), pending);
  assert.equal((await store.claimNextAction(claimRequest))?.action.id, run.id);
});

test("legacy Gravatar reconciliation cannot convert a pending rerun into a proposal", async () => {
  const { store, service, created, claimRequest } = await rerunFixture();
  const child = { ...created.actions[0]!, status: "succeeded" as const };
  delete child.sourceSeedId;
  await store.transact(created.id, (current) => {
    const next = { ...current, revision: current.revision + 1, actions: [child, ...current.actions.slice(1)] };
    return { next, result: next };
  });
  const pending = await service.requestActionRerun(created.id, child.id, created.revision + 1);
  const claim = await store.claimNextAction(claimRequest);
  assert.equal(claim?.action.id, child.id);
  assert.deepEqual(claim?.action.rerun, pending.actions[0]!.rerun);
  assert.deepEqual((await store.get(created.id))?.evidence, pending.evidence);
});

test("a result consisting entirely of scanner errors cannot replace the previous branch", async () => {
  for (const status of ["error", "not_registered"] as const) {
    const executor: InvestigationExecutor = { id: "fixture", async execute(action) {
      return [{ kind: "scanner_finding", provider: "Fixture", seed: action.spec.seed, status,
        finding: { target: action.spec.seed, upstreamStatus: status === "error" ? "Error" : "Not Registered",
          url: "", category: "", reason: "", extra: {}, media: {} } }];
    } };
    const { store, service, created, run } = await rerunFixture("queued", executor);
    const queued = await service.requestActionRerun(created.id, run.id, created.revision);
    const completed = await service.executeNextAction(created.id);
    const saved = (await store.get(created.id))!;
    assert.equal(completed?.id, run.id);
    assert.equal(completed?.status, "succeeded");
    assert.equal(saved.revision, queued.revision + 2);
    assert.equal(completed?.lastRerunFailed, status === "error" ? true : undefined);
    assert.deepEqual(saved.evidence.map(({ id }) => id), status === "error" ? ["old", "sibling-result"] : ["sibling-result"]);
    assert.equal(saved.actions.some(({ id }) => id === "child"), status === "error");
    assert.equal(saved.audit.some(({ kind }) => kind === "action_rerun_succeeded"), status === "not_registered");
  }
});

test("a queued rerun cannot claim work after its authorization is revoked", async () => {
  const { store, service, created, run, claimRequest } = await rerunFixture();
  await service.requestActionRerun(created.id, run.id, created.revision);
  const revoked = await service.authorize(created.id, false, "Revoked before dispatch");
  assert.equal(await store.claimNextAction(claimRequest), undefined);
  assert.deepEqual(await store.get(created.id), revoked);
});

test("GHunt persists, waits when deferred, and requires a scope that names it", async () => {
  const { database, store, service } = makeStoreHarness(["ghunt.email.v1", "user-scanner.email.v1"]);
  const created = await service.createInvestigation();
  const seeded = await service.addEmailSeed(created.id, "seed@gmail.com");
  assert.deepEqual(await store.get(created.id), seeded);
  assert.deepEqual(seeded.actions.map((action) => [action.spec.catalogId, action.spec.provider]), [["ghunt.email.v1", "ghunt"], ["user-scanner.email.v1", "user-scanner"]]);
  await service.authorize(created.id, true, "Authorize tools");
  const row = database.records.get(created.id)!;
  row.document = { ...row.document, authorization: { ...row.document.authorization!, catalogScopes: ["user-scanner.email.v1", "gravatar.email.v1", "maigret.username.v1"] } };
  const request: ClaimActionRequest = { investigationId: created.id, claimId: "scan", claimedAt: "2025-03-01T00:01:00Z", auditEvent: auditEvent("claim", "action_claimed"), deferredCatalogIds: ["ghunt.email.v1"] };
  assert.equal((await store.claimNextAction(request))?.action.spec.catalogId, "user-scanner.email.v1");
  const before = (await store.get(created.id))!;
  assert.equal(before.actions[0]?.status, "queued");
  assert.equal(await store.claimNextAction({ ...request, claimId: "old-grant", deferredCatalogIds: [] }), undefined);
  assert.deepEqual(await store.get(created.id), before);
  const renewed = await service.authorize(created.id, true, "Authorize GHunt");
  assert.equal(await store.claimNextAction({ ...request, claimId: "deferred" }), undefined);
  assert.deepEqual(await store.get(created.id), renewed);
  assert.equal((await store.claimNextAction({ ...request, claimId: "ghunt", deferredCatalogIds: [] }))?.action.spec.catalogId, "ghunt.email.v1");
  assert.deepEqual((await store.get(created.id))?.authorization, renewed.authorization);
});

test("FaceCheck photo actions and evidence round-trip and defer independently", async () => {
  const { database, store, service } = makeStoreHarness();
  const initial = await service.createInvestigation();
  await service.authorize(initial.id, true, "Authorize tools");
  const photo = { kind: "photo" as const, value: "https://lh3.googleusercontent.com/profile-photo" };
  const current = (await store.get(initial.id))!;
  const finding = { target: photo, upstreamStatus: "Found" as const, url: "https://example.org/profile", category: "Face match", reason: "", extra: { source: "facecheck", score: 92, testing_mode: true }, media: { thumbnail: "data:image/webp;base64,YWJj" } };
  const withPhoto: Investigation = { ...current, revision: current.revision + 1, actions: [{ id: "face", spec: { catalogId: "facecheck.photo.v1", provider: "facecheck", seed: photo }, status: "queued", queuedByCatalog: true, proposedAt: current.updatedAt, proposalReason: "Photo" }], evidence: [{ id: "ev", actionId: "face", seed: photo, provider: "FaceCheck", status: "registered", sourceId: "facecheck:photo", recordedAt: current.updatedAt, finding }] };
  await store.transact(initial.id, () => ({ next: withPhoto, result: undefined }));
  assert.deepEqual(await store.get(initial.id), withPhoto);
  const request: ClaimActionRequest = { investigationId: initial.id, claimId: "claim", claimedAt: "2025-03-01T00:01:00Z", auditEvent: auditEvent("claim", "action_claimed") };
  assert.equal(await store.claimNextAction({ ...request, deferredCatalogIds: ["facecheck.photo.v1"] }), undefined);
  assert.deepEqual(await store.get(initial.id), withPhoto);
  assert.equal((await store.claimNextAction(request))?.action.spec.catalogId, "facecheck.photo.v1");
  const before = structuredClone(database.records.get(initial.id));
  const now = (await store.get(initial.id))!;
  for (const seed of [{ kind: "photo", value: "https://evil.example/photo" }, { kind: "email", value: "x@example.org" }]) {
    const invalid = { ...now, revision: now.revision + 1, actions: [{ ...now.actions[0]!, spec: { ...now.actions[0]!.spec, seed } }] } as unknown as Investigation;
    await assert.rejects(store.transact(initial.id, () => ({ next: invalid, result: undefined })), InvestigationSchemaError);
    assert.deepEqual(database.records.get(initial.id), before);
  }
});

const scrapeSeed = { kind: "url" as const, value: "https://example.org/public-profile" };
const faceSeed = { kind: "photo" as const, value: "https://lh3.googleusercontent.com/profile-photo" };

async function makeScrapeCase() {
  const database = new FakePostgres();
  const store = new PostgresInvestigationStore(database);
  let sequence = 0;
  const service = createInvestigationService({
    store, executor: { id: "offline-decodo", async execute() { return []; } }, urlCatalog: ["decodo.url.v1"],
    clock: () => "2025-03-01T00:00:00.000Z", createId: (kind) => `${kind}-${++sequence}`,
  });
  const { id } = await service.createInvestigation();
  await service.authorize(id, true, "Authorize tools");
  await store.transact(id, (current) => ({ next: { ...current, revision: current.revision + 1, evidence: [{
    id: "candidate", actionId: "face", seed: faceSeed, provider: "FaceCheck", status: "registered", sourceId: "facecheck:photo", recordedAt: current.updatedAt,
    finding: { target: faceSeed, upstreamStatus: "Found", url: scrapeSeed.value, category: "Face match", reason: "Candidate", extra: {}, media: {} },
  }] }, result: undefined }));
  const decide = (status: "accepted" | "rejected" | "inconclusive") => service.validateEvidence(id, "candidate", status, "Reviewed match");
  const accepted = await decide("accepted");
  const request: ClaimActionRequest = { investigationId: id, claimId: "scrape-claim", claimedAt: accepted.updatedAt, auditEvent: auditEvent("claim", "action_claimed"), automaticOnly: true };
  return { database, store, id, decide, accepted, request };
}

test("Decodo snapshot validation round-trips URL actions and evidence and rejects unsafe URL seeds and targets", async () => {
  const { store, id, accepted, request } = await makeScrapeCase();
  assert.deepEqual(await store.get(id), accepted);
  const claim = await store.claimNextAction(request);
  assert.deepEqual(claim?.action.spec, { catalogId: "decodo.url.v1", provider: "decodo", seed: scrapeSeed });
  const completed = await store.completeAction({
    investigationId: id, actionId: claim!.action.id, claimId: request.claimId, completedAt: accepted.updatedAt, auditEvent: auditEvent("success", "action_succeeded"),
    result: { kind: "success", unsupportedObservationCount: 0, evidence: [{
      id: "page", actionId: claim!.action.id, seed: scrapeSeed, provider: "Decodo", status: "registered", sourceId: "decodo:url", recordedAt: accepted.updatedAt,
      finding: { target: scrapeSeed, upstreamStatus: "Found", url: scrapeSeed.value, category: "Web page", reason: "Profile", extra: { content: "Offline excerpt" }, media: {} },
    }] },
  });
  assert.deepEqual(await store.get(id), completed);
  assert.deepEqual(await store.list(), [completed]);
  assert.equal(completed.evidence.at(-1)?.sourceId, "decodo:url");
  assert.deepEqual(completed.evidence.at(-1)?.finding?.target, scrapeSeed);
  for (const value of ["https://user:password@example.org/", "http://127.0.0.1/", "http://10.0.0.1/", "http://169.254.1.2/", "ftp://example.org/"]) {
    const seed = { ...scrapeSeed, value };
    const action = completed.actions[0]!;
    const record = completed.evidence[1]!;
    for (const change of [
      { actions: [{ ...action, spec: { ...action.spec, seed } }] },
      { evidence: [completed.evidence[0]!, { ...record, seed }] },
      { evidence: [completed.evidence[0]!, { ...record, finding: { ...record.finding!, target: seed } }] },
    ]) {
      const next = { ...completed, ...change, revision: completed.revision + 1 } as Investigation;
      await assert.rejects(store.transact(id, () => ({ next, result: undefined })), { message: "Investigation snapshot is invalid." });
      assert.deepEqual(await store.get(id), completed);
    }
  }
});

test("Decodo claims under a FaceCheck-only grant but not without a covering scope", async () => {
  const { database, store, id, accepted, request } = await makeScrapeCase();
  const { catalogScope: _single, catalogScopes: _scopes, ...unscoped } = accepted.authorization!;
  const facecheckOnly = { ...unscoped, catalogScopes: ["facecheck.photo.v1"] } as const;
  const storeAuthorization = (authorization: Investigation["authorization"]) => store.transact(id, (current) => {
    const { authorization: _previous, ...snapshot } = current;
    const next = { ...snapshot, revision: current.revision + 1, ...(authorization === undefined ? {} : { authorization }) };
    return { next, result: next };
  });
  for (const [label, authorization] of [
    ["missing", undefined], ["revoked", { ...facecheckOnly, granted: false }],
    ["empty", { ...unscoped, catalogScopes: [] }], ["legacy unscoped", unscoped],
    ["scanner-only", { ...unscoped, catalogScopes: ["user-scanner.email.v1"] }],
    ["legacy scanner-only", { ...unscoped, catalogScope: "user-scanner.email.v1" }],
  ] as const) {
    const before = await storeAuthorization(authorization);
    const cursor = database.history.length;
    assert.equal(await store.claimNextAction(request), undefined, label);
    assert.deepEqual(await store.get(id), before, label);
    assert.ok(!database.history.slice(cursor).some(({ sql }) => /UPDATE investigations/.test(sql)), label);
  }

  const before = await storeAuthorization(facecheckOnly);
  const action = { ...before.actions[0]!, status: "claimed", claim: { id: request.claimId, claimedAt: request.claimedAt } };
  assert.deepEqual(await store.claimNextAction(request), {
    action, permit: { authorized: true, approved: true, paused: false },
  });
  assert.deepEqual(await store.get(id), {
    ...before, actions: [action], revision: before.revision + 1, updatedAt: request.claimedAt,
    audit: [...before.audit, { ...request.auditEvent, actionId: action.id }],
  });
});

test("PostgreSQL checks the current FaceCheck validation inside the Decodo claim transaction", async () => {
  const { database, store, id, decide, accepted, request } = await makeScrapeCase();
  assert.equal(accepted.actions.length, 1);
  for (const status of ["rejected", "inconclusive"] as const) {
    const before = await decide(status);
    const cursor = database.history.length;
    assert.equal(await store.claimNextAction(request), undefined);
    const queries = database.history.slice(cursor).map(({ sql }) => sql);
    assert.equal(queries[0], "BEGIN");
    assert.match(queries[1]!, /FOR UPDATE/);
    assert.ok(!queries.some((sql) => /UPDATE investigations/.test(sql)));
    assert.deepEqual(await store.get(id), before);
  }
  const reaccepted = await decide("accepted");
  assert.deepEqual(reaccepted.actions, accepted.actions);
  const claim = await store.claimNextAction(request);
  assert.equal(claim?.action.id, accepted.actions[0]?.id);
  assert.equal(claim?.action.status, "claimed");
  assert.equal((await store.get(id))?.revision, reaccepted.revision + 1);
});

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

const currentGrant = ["user-scanner.email.v1", "gravatar.email.v1", "maigret.username.v1", "ghunt.email.v1", "facecheck.photo.v1", "decodo.url.v1"];

test("recorded scopes round-trip, malformed scopes never write and empty scopes never claim", async () => {
  const { database, store, service } = makeStoreHarness();
  const created = await service.createInvestigation();
  await service.addEmailSeed(created.id, "seed@example.org");
  const granted = await service.authorize(created.id, true, "Authorize the listed tools");
  assert.deepEqual(granted.authorization?.catalogScopes, currentGrant);
  assert.deepEqual((await store.get(created.id))?.authorization?.catalogScopes, currentGrant);

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

test("a scanner-only grant never claims an approved Gravatar proposal", async () => {
  const { database, store, service } = makeStoreHarness(["user-scanner.email.v1", "gravatar.email.v1"]);
  const created = await service.createInvestigation();
  const seeded = await service.addEmailSeed(created.id, "seed@example.org");
  assert.deepEqual(seeded.actions.map((action) => [action.spec.catalogId, action.spec.provider, action.status, action.queuedByCatalog]), [
    ["user-scanner.email.v1", "user-scanner", "queued", true],
  ]);
  assert.deepEqual(await store.get(created.id), seeded);
  const granted = await service.authorize(created.id, true, "Authorize the listed tools");
  assert.deepEqual(granted.authorization?.catalogScopes, currentGrant);

  assert.equal((await service.executeNextAction(created.id))?.status, "succeeded");
  const proposal = (await store.get(created.id))!.actions.find((action) => action.spec.catalogId === "gravatar.email.v1")!;
  assert.equal(proposal.status, "proposed");
  await service.approveAction(created.id, proposal.id, "Operator approved the lookup");
  const row = database.records.get(created.id)!;
  row.document = { ...row.document, authorization: { ...row.document.authorization!, catalogScopes: ["user-scanner.email.v1"] } };
  const input: ClaimActionRequest = { investigationId: created.id, claimId: "claim-2", claimedAt: "2025-03-01T00:01:00Z", auditEvent: auditEvent("claim", "action_claimed") };
  const current = (await store.get(created.id))!;
  assert.equal(current.actions.find(({ id }) => id === proposal.id)?.status, "queued");
  assert.equal(await store.claimNextAction(input), undefined);
  assert.deepEqual(await store.get(created.id), current);

  const corrupt = { ...current, revision: current.revision + 1, actions: current.actions.map((action) =>
    action.spec.catalogId === "gravatar.email.v1" ? { ...action, spec: { ...action.spec, provider: "user-scanner" } } : action) } as unknown as Investigation;
  await assert.rejects(store.transact(created.id, () => ({ next: corrupt, result: undefined })), InvestigationSchemaError);
  assert.deepEqual(await store.get(created.id), current);
});

test("legacy unlinked Gravatar queues do not run before their scanner responds", async () => {
  const { store, service } = makeStoreHarness(["user-scanner.email.v1", "gravatar.email.v1"]);
  const created = await service.createInvestigation();
  const seeded = await service.addEmailSeed(created.id, "seed@example.org");
  await service.authorize(created.id, true, "Authorize the listed tools");
  await store.transact(created.id, (current) => ({
    next: { ...current, revision: current.revision + 1, actions: [...current.actions, {
      id: "legacy-gravatar", spec: { catalogId: "gravatar.email.v1", provider: "gravatar", seed: seeded.emailSeeds[0]! },
      status: "queued", queuedByCatalog: true, proposedAt: current.updatedAt, proposalReason: "Historical catalog queue",
    }] }, result: undefined,
  }));
  const request: ClaimActionRequest = { investigationId: created.id, claimId: "scan-claim", claimedAt: "2025-03-01T00:01:00Z", auditEvent: auditEvent("claim", "action_claimed") };
  assert.equal((await store.claimNextAction(request))?.action.spec.catalogId, "user-scanner.email.v1");
  const before = await store.get(created.id);
  assert.equal(await store.claimNextAction({ ...request, claimId: "other-claim" }), undefined);
  assert.deepEqual(await store.get(created.id), before);
});

test("scanner completion converts an unclaimed legacy Gravatar queue to a proposal", async () => {
  const { store, service } = makeStoreHarness(["user-scanner.email.v1", "gravatar.email.v1"]);
  const created = await service.createInvestigation();
  const seeded = await service.addEmailSeed(created.id, "seed@example.org");
  await store.transact(created.id, (current) => ({ next: { ...current, revision: current.revision + 1, actions: [...current.actions, {
    id: "legacy-gravatar", spec: { catalogId: "gravatar.email.v1", provider: "gravatar", seed: seeded.emailSeeds[0]! },
    status: "queued", queuedByCatalog: true, proposedAt: current.updatedAt, proposalReason: "Historical catalog queue",
  }] }, result: undefined }));
  await service.authorize(created.id, true, "Authorize the listed tools");
  assert.equal((await service.executeNextAction(created.id))?.status, "succeeded");
  const current = (await store.get(created.id))!;
  const gravatar = current.actions.filter((action) => action.spec.catalogId === "gravatar.email.v1");
  assert.equal(gravatar.length, 1);
  assert.equal(gravatar[0]!.id, "legacy-gravatar");
  assert.equal(gravatar[0]!.status, "proposed");
  assert.equal(gravatar[0]!.queuedByCatalog, undefined);
  assert.equal(current.audit.at(-1)?.kind, "action_proposed");
  assert.equal(current.audit.at(-1)?.actionId, "legacy-gravatar");
  assert.equal(await service.executeNextAction(created.id), undefined);
});

test("a legacy Gravatar queue is proposed, not linked, when the only finding reports another discovered email", async () => {
  const database = new FakePostgres();
  const store = new PostgresInvestigationStore(database);
  let sequence = 0;
  const service = createInvestigationService({ store, seedCatalog: ["user-scanner.email.v1"],
    executor: createCatalogExecutor({ "user-scanner.email.v1": { id: "user-scanner:email", inputKind: "email", async execute(seed) {
      return [{ kind: "scanner_finding", seed, provider: "Gravatar", status: "registered", finding: {
        target: { kind: "email", value: "other@example.org" }, upstreamStatus: "Registered", url: "", category: "", reason: "", extra: {}, media: {},
      } }];
    } } }),
    clock: () => "2025-03-01T00:00:00.000Z", createId: (kind) => `${kind}-${++sequence}`,
  });
  const created = await service.createInvestigation();
  const seeded = await service.addEmailSeed(created.id, "seed@example.org");
  await service.authorize(created.id, true, "Authorize the listed tools");
  await service.executeNextAction(created.id);
  await store.transact(created.id, (current) => ({ next: { ...current, revision: current.revision + 1, actions: [...current.actions, {
    id: "legacy-gravatar", spec: { catalogId: "gravatar.email.v1", provider: "gravatar", seed: seeded.emailSeeds[0]! },
    status: "queued", queuedByCatalog: true, proposedAt: current.updatedAt, proposalReason: "Historical catalog queue",
  }] }, result: undefined }));
  assert.equal(await store.claimNextAction({ investigationId: created.id, claimId: "claim", claimedAt: "2025-03-01T00:01:00Z", auditEvent: auditEvent("claim", "action_claimed") }), undefined);
  const legacy = (await store.get(created.id))!.actions.find((action) => action.id === "legacy-gravatar")!;
  assert.equal(legacy.status, "proposed");
  assert.equal(legacy.sourceSeedId, undefined);
});

test("a confirmed scanner finding links an unclaimed legacy Gravatar action", async () => {
  const database = new FakePostgres();
  const store = new PostgresInvestigationStore(database);
  let sequence = 0;
  const service = createInvestigationService({ store,
    executor: createCatalogExecutor({ "user-scanner.email.v1": { id: "user-scanner:email", inputKind: "email", async execute(seed) {
      return [{ kind: "scanner_finding", seed, provider: "Gravatar", status: "registered", finding: {
        target: { kind: "username", value: "ana" }, upstreamStatus: "Found", url: "", category: "", reason: "", extra: {}, media: {},
      } }];
    } } }),
    clock: () => "2025-03-01T00:00:00.000Z", createId: (kind) => `${kind}-${++sequence}`,
  });
  const created = await service.createInvestigation();
  const seeded = await service.addEmailSeed(created.id, "seed@example.org");
  await store.transact(created.id, (current) => ({ next: { ...current, revision: current.revision + 1, actions: [...current.actions, {
    id: "legacy-gravatar", spec: { catalogId: "gravatar.email.v1", provider: "gravatar", seed: seeded.emailSeeds[0]! },
    status: "queued", queuedByCatalog: true, proposedAt: current.updatedAt, proposalReason: "Historical catalog queue",
  }] }, result: undefined }));
  await service.authorize(created.id, true, "Authorize the listed tools");
  assert.equal((await service.executeNextAction(created.id))?.status, "succeeded");
  const current = (await store.get(created.id))!;
  const gravatar = current.actions.filter((action) => action.spec.catalogId === "gravatar.email.v1");
  assert.equal(gravatar.length, 1);
  assert.equal(gravatar[0]!.id, "legacy-gravatar");
  assert.equal(gravatar[0]!.status, "queued");
  assert.equal(gravatar[0]!.sourceSeedId, `seed:evidence:${encodeURIComponent(current.evidence[0]!.id)}`);
});

test("an already-completed scanner turns a legacy unlinked Gravatar queue into a proposal", async () => {
  const { store, service } = makeStoreHarness(["user-scanner.email.v1"]);
  const created = await service.createInvestigation();
  const seeded = await service.addEmailSeed(created.id, "seed@example.org");
  await service.authorize(created.id, true, "Authorize the listed tools");
  await service.executeNextAction(created.id);
  await store.transact(created.id, (current) => ({ next: { ...current, revision: current.revision + 1, actions: [...current.actions, {
    id: "legacy-gravatar", spec: { catalogId: "gravatar.email.v1", provider: "gravatar", seed: seeded.emailSeeds[0]! },
    status: "queued", queuedByCatalog: true, proposedAt: current.updatedAt, proposalReason: "Historical catalog queue",
  }] }, result: undefined }));
  assert.equal(await service.executeNextAction(created.id), undefined);
  const current = (await store.get(created.id))!;
  assert.equal(current.actions.find((action) => action.id === "legacy-gravatar")!.status, "proposed");
  assert.equal(current.audit.at(-1)?.kind, "action_proposed");
});

test("converting a legacy Gravatar queue does not stop the same claim from dispatching other work", async () => {
  const { store, service } = makeStoreHarness(["user-scanner.email.v1"]);
  const created = await service.createInvestigation();
  const seeded = await service.addEmailSeed(created.id, "seed@example.org");
  await service.authorize(created.id, true, "Authorize the listed tools");
  await service.executeNextAction(created.id);
  await store.transact(created.id, (current) => ({ next: { ...current, revision: current.revision + 1, actions: [...current.actions, {
    id: "legacy-gravatar", spec: { catalogId: "gravatar.email.v1", provider: "gravatar", seed: seeded.emailSeeds[0]! },
    status: "queued", queuedByCatalog: true, proposedAt: current.updatedAt, proposalReason: "Historical catalog queue",
  }] }, result: undefined }));
  await service.addUsernameSeed(created.id, "anaexample", "Operator supplied this username.");
  const claim = await store.claimNextAction({ investigationId: created.id, claimId: "claim", claimedAt: "2025-03-01T00:01:00Z", auditEvent: auditEvent("claim", "action_claimed") });
  assert.equal(claim?.action.spec.catalogId, "maigret.username.v1");
  const current = (await store.get(created.id))!;
  assert.equal(current.actions.find((action) => action.id === "legacy-gravatar")!.status, "proposed");
  assert.deepEqual(current.audit.slice(-2).map((event) => [event.kind, event.actionId]), [
    ["action_proposed", "legacy-gravatar"], ["action_claimed", claim!.action.id],
  ]);
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
    { usernameSeeds: [{ ...record, status: "proposed" }] },
    { usernameSeeds: [{ ...record, decision: { at: record.at, reason: "Operator seeds carry no decision", operator: "local-operator" } }] },
    { usernameSeeds: [{ ...record, origin: { kind: "evidence", evidenceId: "evidence" } }] },
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

test("accepted and rejected username proposals round-trip with their decisions", async () => {
  const database = new FakePostgres();
  const store = new PostgresInvestigationStore(database);
  let sequence = 0;
  const finding = (value: string) => ({ kind: "scanner_finding" as const, seed: { kind: "email" as const, value: "seed@example.org" }, provider: "GitHub", status: "registered" as const, finding: {
    target: { kind: "username" as const, value }, upstreamStatus: "Found" as const, url: "", category: "", reason: "", extra: {}, media: {},
  } });
  const service = createInvestigationService({
    store, seedCatalog: ["user-scanner.email.v1"],
    executor: createCatalogExecutor({ "user-scanner.email.v1": { id: "user-scanner:email", inputKind: "email", async execute() { return [finding("keep-me"), finding("drop-me")]; } } }),
    clock: () => "2025-03-01T00:00:00.000Z", createId: (kind) => `${kind}-${++sequence}`,
  });
  const created = await service.createInvestigation();
  await service.addEmailSeed(created.id, "seed@example.org");
  await service.authorize(created.id, true, "Authorize the listed tools");
  await service.executeNextAction(created.id);
  await service.decideUsernameProposal(created.id, "keep-me", "accepted", "Same person");
  const decided = await service.decideUsernameProposal(created.id, "drop-me", "rejected", "Different person");
  assert.deepEqual(await store.get(created.id), decided);
  assert.deepEqual(decided.usernameSeeds?.map((seed) => [seed.value, seed.status, seed.origin.kind, seed.decision?.reason]), [
    ["keep-me", "accepted", "evidence", "Same person"], ["drop-me", "rejected", "evidence", "Different person"],
  ]);
  const before = structuredClone(database.records.get(created.id));
  const undecided = { ...decided, revision: decided.revision + 1, usernameSeeds: decided.usernameSeeds!.map(({ decision: _decision, ...rest }) => rest) } as Investigation;
  await assert.rejects(store.transact(created.id, () => ({ next: undecided, result: undefined })), InvestigationSchemaError);
  assert.deepEqual(database.records.get(created.id), before);
});

test("a pre-Maigret grant does not claim a Maigret action without renewal", async () => {
  const { database, store, service } = makeStoreHarness();
  const created = await service.createInvestigation();
  await service.addUsernameSeed(created.id, "anaexample", "Username supplied by the operator.");
  const granted = await service.authorize(created.id, true, "Authorize the listed tools");
  assert.deepEqual(granted.authorization?.catalogScopes, currentGrant);
  const row = database.records.get(created.id)!;
  row.document = { ...row.document, authorization: { ...row.document.authorization!, catalogScopes: ["user-scanner.email.v1", "gravatar.email.v1"] } };
  const before = (await store.get(created.id))!;
  const input: ClaimActionRequest = { investigationId: created.id, claimId: "claim", claimedAt: "2025-03-01T00:01:00Z", auditEvent: auditEvent("claim", "action_claimed") };
  assert.equal(await store.claimNextAction(input), undefined);
  assert.deepEqual(await store.get(created.id), before);
  const renewed = await service.authorize(created.id, true, "Authorize Maigret");
  assert.equal((await store.claimNextAction(input))?.action.spec.catalogId, "maigret.username.v1");
  assert.deepEqual((await store.get(created.id))?.authorization, renewed.authorization);
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
    executor: createCatalogExecutor({
      "user-scanner.email.v1": { id: "user-scanner:email", inputKind: "email", async execute() { return []; } },
      "gravatar.email.v1": createGravatarBox({ fetch: (async () => Response.json({ display_name: "Ana" })) as typeof fetch }),
    }),
    clock: () => "2025-03-01T00:00:00.000Z",
    createId: (kind) => `${kind}-${++sequence}`,
    seedCatalog: ["user-scanner.email.v1", "gravatar.email.v1"],
  });
  const created = await service.createInvestigation();
  await service.addEmailSeed(created.id, "Ana.Example@Example.org");
  await service.authorize(created.id, true, "Authorize the listed tools");
  await service.executeNextAction(created.id);
  const proposal = (await store.get(created.id))!.actions.find((action) => action.spec.catalogId === "gravatar.email.v1")!;
  await service.approveAction(created.id, proposal.id, "Operator approved the lookup");
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
  const proposal = (await store.get(created.id))!.actions.find((action) => action.spec.catalogId === "gravatar.email.v1")!;
  await service.approveAction(created.id, proposal.id, "Operator approved the lookup");
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
