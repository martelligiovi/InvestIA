import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizationCovers,
  createCatalogExecutor,
  createInvestigationService,
  isActionEligibleByParentValidation,
  type ActionClaim,
  type ClaimActionRequest,
  type CompleteActionInput,
  type GitHubCatalogAction,
  type Investigation,
  type InvestigationExecutor,
  type InvestigationStore,
  type InvestigationTransaction,
} from "@investia/core";
import { MemorySaver } from "@langchain/langgraph";
import type { DecodoApiMode } from "../../adapter-decodo/src/index.ts";
import { createBackendApp } from "../src/api.ts";
import { AutomaticInvestigationRunner } from "../src/automatic-investigation-runner.ts";
import { createInvestigationRunGraph } from "../src/investigation-run-graph.ts";

class MemoryStore implements InvestigationStore {
  readonly #items = new Map<string, Investigation>();
  failList = false;

  async create(investigation: Investigation): Promise<void> {
    this.#items.set(investigation.id, structuredClone(investigation));
  }

  async get(id: string): Promise<Investigation | undefined> {
    const item = this.#items.get(id);
    return item === undefined ? undefined : structuredClone(item);
  }

  async list(): Promise<readonly Investigation[]> {
    if (this.failList) throw new Error("secret SQL host=private.example");
    return [...this.#items.values()].map((item) => structuredClone(item));
  }

  async transact<T>(
    id: string,
    operation: (current: Investigation) => InvestigationTransaction<T>,
  ): Promise<T> {
    const current = this.#items.get(id);
    if (current === undefined) throw new Error("Investigation not found");
    const { next, result } = operation(structuredClone(current));
    assert.equal(next.revision, current.revision + 1);
    this.#items.set(id, structuredClone(next));
    return structuredClone(result);
  }

  async claimNextAction(input: ClaimActionRequest): Promise<ActionClaim | undefined> {
    const current = this.#items.get(input.investigationId);
    if (current === undefined || current.paused || current.authorization?.granted !== true ||
      (input.automaticOnly === true && current.advancementMode !== "automatic")) return undefined;
    const action = current.actions.find((item) => item.status === "queued" && (item.approval !== undefined ||
      (item.spec.catalogId === "decodo.url.v1" && item.queuedByCatalog === true &&
        !(input.deferredCatalogIds ?? []).includes(item.spec.catalogId) && authorizationCovers(current.authorization, item.spec.catalogId) &&
        isActionEligibleByParentValidation(current, item))));
    if (action === undefined) return undefined;
    const claimed = {
      ...action,
      status: "claimed" as const,
      claim: { id: input.claimId, claimedAt: input.claimedAt },
    };
    const next: Investigation = {
      ...current,
      revision: current.revision + 1,
      updatedAt: input.claimedAt,
      actions: current.actions.map((item) => item.id === action.id ? claimed : item),
      audit: [...current.audit, { ...input.auditEvent, actionId: action.id }],
    };
    this.#items.set(input.investigationId, structuredClone(next));
    return structuredClone({
      action: claimed,
      permit: { authorized: true as const, approved: true as const, paused: false as const },
    });
  }

  async completeAction(input: CompleteActionInput): Promise<Investigation> {
    const current = this.#items.get(input.investigationId);
    if (current === undefined) throw new Error("Investigation not found");
    const action = current.actions.find((item) => item.id === input.actionId);
    if (action?.status !== "claimed" || action.claim?.id !== input.claimId) throw new Error("Stale claim");
    const completed = {
      ...action,
      status: input.result.kind === "success" ? "succeeded" as const : "failed" as const,
      completedAt: input.completedAt,
      ...(input.result.kind === "failure" ? { failure: input.result.error } : {
        unsupportedObservationCount: input.result.unsupportedObservationCount,
      }),
    };
    const next: Investigation = {
      ...current,
      revision: current.revision + 1,
      updatedAt: input.completedAt,
      actions: current.actions.map((item) => item.id === action.id ? completed : item),
      evidence: input.result.kind === "success" ? [...current.evidence, ...input.result.evidence] : current.evidence,
      audit: [...current.audit, input.auditEvent],
    };
    this.#items.set(input.investigationId, structuredClone(next));
    return structuredClone(next);
  }
}

function makeHarness(executorFailure?: string) {
  const store = new MemoryStore();
  let sequence = 0;
  let ticks = 0;
  let executions = 0;
  let projectionFails = false;
  const executor: InvestigationExecutor = {
    id: "offline-fake-executor",
    async execute(action) {
      executions++;
      if (executorFailure !== undefined) throw new Error(executorFailure);
      return [{ kind: "registration", seed: action.spec.seed, provider: "github", status: "registered" }];
    },
  };
  const service = createInvestigationService({
    store,
    executor,
    clock: () => `2025-02-01T00:00:${String(ticks++).padStart(2, "0")}.000Z`,
    createId: (kind) => `${kind}-${++sequence}`,
  });
  const projector = {
    async project(investigation: Investigation) {
      if (projectionFails) throw new Error("Neo4j unavailable");
      return { revision: investigation.revision, status: "applied" as const };
    },
  };
  return {
    app: createBackendApp(service, {
      actionRunner: createInvestigationRunGraph(service, new MemorySaver()),
      projector,
    }),
    store,
    set projectionFails(value: boolean) { projectionFails = value; },
    get executions() { return executions; },
  };
}

test("HTTP username seeds queue Maigret and reject invalid or duplicate input without changes", async (t) => {
  const harness = makeHarness();
  t.after(() => harness.app.close());
  const { app } = harness;
  const id = (await app.inject({ method: "POST", url: "/investigations" })).json<{ id: string }>().id;
  const added = await app.inject({ method: "POST", url: `/investigations/${id}/usernames`, payload: { username: "anaexample", reason: "Operator supplied this username." } });
  assert.equal(added.statusCode, 201);
  const body = added.json<Investigation>();
  assert.deepEqual(body.usernameSeeds?.map((seed) => [seed.value, seed.status, seed.origin.kind]), [["anaexample", "accepted", "operator"]]);
  assert.deepEqual(body.actions.map((action) => [action.spec.catalogId, action.status]), [["maigret.username.v1", "queued"]]);
  const before = await harness.store.get(id);
  for (const payload of [
    { username: "--help", reason: "Bad." }, { username: "two words", reason: "Bad." }, { username: "ok" },
    { username: "ok", reason: "Fine.", extra: true }, { username: 42, reason: "Bad." },
  ]) {
    const response = await app.inject({ method: "POST", url: `/investigations/${id}/usernames`, payload });
    assert.equal(response.statusCode, 400, JSON.stringify(payload));
    assert.equal(response.json<{ error: string }>().error, "INVALID_REQUEST");
  }
  const duplicate = await app.inject({ method: "POST", url: `/investigations/${id}/usernames`, payload: { username: "anaexample", reason: "Again." } });
  assert.equal(duplicate.statusCode, 409);
  assert.deepEqual(await harness.store.get(id), before);
  assert.equal(harness.executions, 0);
});

test("HTTP username proposal decisions accept or reject derived proposals and refuse anything else unchanged", async (t) => {
  const harness = makeHarness();
  t.after(() => harness.app.close());
  const { app, store } = harness;
  const id = (await app.inject({ method: "POST", url: "/investigations" })).json<{ id: string }>().id;
  await app.inject({ method: "POST", url: `/investigations/${id}/emails`, payload: { email: "person@example.org", reason: "Seed." } });
  const current = (await store.get(id))!;
  const finding = { target: { kind: "username" as const, value: "anaexample" }, upstreamStatus: "Found" as const, url: "", category: "", reason: "", extra: { discovered_usernames: "ana-alt" }, media: {} };
  await store.transact(id, () => ({ next: { ...current, revision: current.revision + 1, evidence: [{
    id: "evidence-x", actionId: current.actions[0]!.id, seed: current.emailSeeds[0]!, provider: "GitHub", status: "registered",
    sourceId: "user-scanner:email", recordedAt: current.updatedAt, finding,
  }] }, result: undefined }));

  const accepted = await app.inject({ method: "POST", url: `/investigations/${id}/usernames/decisions`, payload: { username: "anaexample", decision: "accepted", reason: "Same person." } });
  assert.equal(accepted.statusCode, 201);
  const body = accepted.json<Investigation>();
  assert.deepEqual(body.usernameSeeds?.map((seed) => [seed.value, seed.status]), [["anaexample", "accepted"]]);
  assert.equal(body.actions.at(-1)?.spec.catalogId, "maigret.username.v1");
  const rejected = await app.inject({ method: "POST", url: `/investigations/${id}/usernames/decisions`, payload: { username: "ana-alt", decision: "rejected", reason: "Not them." } });
  assert.equal(rejected.statusCode, 201);

  const before = await store.get(id);
  for (const [payload, status] of [
    [{ username: "anaexample", decision: "accepted", reason: "Again." }, 409],
    [{ username: "nobody", decision: "accepted", reason: "Unknown." }, 409],
    [{ username: "anaexample", decision: "maybe", reason: "Bad." }, 400],
    [{ username: "--help", decision: "accepted", reason: "Bad." }, 400],
    [{ username: "anaexample", decision: "accepted" }, 400],
  ] as const) {
    const response = await app.inject({ method: "POST", url: `/investigations/${id}/usernames/decisions`, payload });
    assert.equal(response.statusCode, status, JSON.stringify(payload));
  }
  assert.deepEqual(await store.get(id), before);
  assert.equal(harness.executions, 0);
});

test("HTTP creation accepts intention and mode without executing work", async (t) => {
  const harness = makeHarness();
  t.after(() => harness.app.close());
  for (const advancementMode of [undefined, "manual"]) {
    const response = await harness.app.inject({
      method: "POST", url: "/investigations",
      payload: { name: "Caso", intention: "  Verificar registro  ", ...(advancementMode ? { advancementMode } : {}) },
    });
    assert.equal(response.statusCode, 201);
    const created = response.json<Investigation>();
    assert.equal(created.intention, "Verificar registro");
    assert.equal(created.advancementMode, advancementMode ?? "automatic");
    assert.deepEqual((await harness.app.inject({ method: "GET", url: `/investigations/${created.id}` })).json(), created);
  }
  for (const payload of [{ intention: " " }, { intention: null }, { advancementMode: "other" }]) {
    assert.equal((await harness.app.inject({ method: "POST", url: "/investigations", payload })).statusCode, 400);
  }
  assert.equal(harness.executions, 0);
});

test("HTTP workflow persists operator decisions and only runs the approved action on request", async (t) => {
  const harness = makeHarness();
  t.after(() => harness.app.close());
  const { app } = harness;

  const created = await app.inject({ method: "POST", url: "/investigations" });
  assert.equal(created.statusCode, 201);
  const investigation = created.json<{ id: string; revision: number }>();
  assert.equal(investigation.revision, 0);
  const id = investigation.id;

  assert.equal((await app.inject({ method: "GET", url: "/investigations" })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: `/investigations/${id}` })).statusCode, 200);
  assert.equal((await app.inject({
    method: "POST", url: `/investigations/${id}/emails`, payload: {
      email: "person@example.org", reason: "Operator supplied this seed.",
    },
  })).statusCode, 201);

  const proposed = await app.inject({
    method: "POST", url: `/investigations/${id}/actions/proposals`, payload: {
      email: "person@example.org", reason: "Propose one catalog action.",
    },
  });
  assert.equal(proposed.statusCode, 201);
  const action = proposed.json<{ id: string; status: string }>();
  assert.equal(action.status, "proposed");

  const beforeApproval = await app.inject({ method: "POST", url: `/investigations/${id}/actions/run` });
  assert.equal(beforeApproval.statusCode, 200);
  assert.equal(beforeApproval.json<{ action: unknown }>().action, null);
  assert.equal(harness.executions, 0);
  assert.equal((await app.inject({
    method: "POST", url: `/investigations/${id}/authorization`,
    payload: { granted: false, reason: "Operator denied execution for now." },
  })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: `/investigations/${id}/actions/run` }))
    .json<{ action: unknown }>().action, null);
  assert.equal(harness.executions, 0);

  assert.equal((await app.inject({
    method: "POST", url: `/investigations/${id}/authorization`,
    payload: { granted: true, reason: "Operator authorized the catalog check." },
  })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: `/investigations/${id}/actions/run` }))
    .json<{ action: unknown }>().action, null);
  assert.equal(harness.executions, 0);
  assert.equal((await app.inject({
    method: "POST", url: `/investigations/${id}/actions/${action.id}/approval`,
    payload: { reason: "Operator approved this action." },
  })).statusCode, 200);
  assert.equal((await app.inject({
    method: "POST", url: `/investigations/${id}/pause`, payload: { reason: "Review pause." },
  })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: `/investigations/${id}/actions/run` }))
    .json<{ action: unknown }>().action, null);
  assert.equal(harness.executions, 0);
  assert.equal((await app.inject({
    method: "POST", url: `/investigations/${id}/resume`, payload: { reason: "Resume deliberately." },
  })).statusCode, 200);

  const run = await app.inject({ method: "POST", url: `/investigations/${id}/actions/run` });
  assert.equal(run.statusCode, 200);
  assert.equal(run.json<{ action: { status: string } }>().action.status, "succeeded");
  assert.equal(harness.executions, 1);

  const loaded = await app.inject({ method: "GET", url: `/investigations/${id}` });
  const evidenceId = loaded.json<Investigation>().evidence[0]!.id;
  assert.equal((await app.inject({
    method: "POST", url: `/investigations/${id}/evidence/${evidenceId}/validation`,
    payload: { status: "accepted", reason: "Evidence reviewed." },
  })).statusCode, 201);
  assert.equal((await app.inject({
    method: "POST", url: `/investigations/${id}/evidence/${evidenceId}/rejection`,
    payload: { reason: "Reject this evidence as insufficient." },
  })).statusCode, 201);

  const report = await app.inject({ method: "GET", url: `/investigations/${id}/report` });
  assert.equal(report.statusCode, 200);
  assert.match(report.headers["content-type"] ?? "", /text\/markdown/);
  assert.match(report.body, /Identity attribution is unsupported/);
  assert.match(report.body, /rejected/);
});

test("FaceCheck acceptance and Decodo token updates wake eligible scrapes without claiming rejected matches", async (t) => {
  const store = new MemoryStore();
  const seen: unknown[] = [];
  let settings = { token: undefined as string | undefined, apiMode: "web_data" as DecodoApiMode };
  const decodo = {
    async load() { return { ...settings }; },
    async update(update: { token?: string; apiMode?: DecodoApiMode }) { settings = { ...settings, ...update }; },
    async clearToken() { settings = { ...settings, token: undefined }; },
  };
  let sequence = 0;
  const service = createInvestigationService({
    store, urlCatalog: ["decodo.url.v1"],
    deferredCatalogIds: async () => settings.token === undefined ? ["decodo.url.v1"] : [],
    executor: createCatalogExecutor({ "decodo.url.v1": {
      id: "decodo:url", inputKind: "url", async execute(seed) {
        seen.push(seed);
        return [{ kind: "scanner_finding", seed, provider: "Decodo", status: "registered", finding: {
          target: seed, upstreamStatus: "Found", url: seed.value, category: "Web page", reason: "Public profile",
          extra: { source: "decodo", content: "Offline excerpt" }, media: {},
        } }];
      },
    } }),
    clock: () => "2025-02-01T00:00:00.000Z", createId: (kind) => `${kind}-${++sequence}`,
  });
  const runner = new AutomaticInvestigationRunner(service);
  let sweep = Promise.resolve();
  let wakes = 0;
  const server = createBackendApp(service, {
    actionRunner: createInvestigationRunGraph(service, new MemorySaver()),
    projector: { project: async ({ revision }) => ({ revision, status: "applied" }) },
    decodo,
    wakeAutomaticRunner: () => { wakes++; sweep = runner.drain(); },
  });
  t.after(async () => { await runner.stop(); await server.close(); });
  const photo = { kind: "photo" as const, value: "https://lh3.googleusercontent.com/profile-photo" };
  const seedCase = async (url: string) => {
    const created = await server.inject({ method: "POST", url: "/investigations" });
    assert.equal(created.statusCode, 201);
    const investigation = created.json<Investigation>();
    const path = `/investigations/${investigation.id}`;
    assert.equal((await server.inject({ method: "POST", url: `${path}/authorization`, payload: { granted: true, reason: "Authorize the enabled tools" } })).statusCode, 200);
    await store.transact(investigation.id, (current) => ({ next: { ...current, revision: current.revision + 1, evidence: [{
      id: "match", actionId: "facecheck", seed: photo, provider: "FaceCheck", status: "registered", sourceId: "facecheck:photo", recordedAt: current.createdAt,
      finding: { target: photo, upstreamStatus: "Found", url, category: "Face match", reason: "Candidate", extra: {}, media: { thumbnail: "data:image/webp;base64,YWJj" } },
    }] }, result: undefined }));
    return {
      decide: (status: string) => server.inject({ method: "POST", url: `${path}/evidence/match/validation`, payload: { status, reason: "Reviewed this match" } }),
      run: () => server.inject({ method: "POST", url: `${path}/actions/run` }),
      load: async () => (await server.inject({ method: "GET", url: path })).json<Investigation>(),
    };
  };
  const approvedUrl = "https://www.linkedin.com/in/example-profile";
  const disputedUrl = "https://example.org/profile";
  const approved = await seedCase(approvedUrl);
  const disputed = await seedCase(disputedUrl);
  for (const [entry, url] of [[approved, approvedUrl], [disputed, disputedUrl]] as const) {
    const decision = await entry.decide("accepted");
    assert.equal(decision.statusCode, 201);
    assert.deepEqual(decision.json<Investigation>().actions.map(({ spec, status }) => [spec.catalogId, status, spec.seed]),
      [["decodo.url.v1", "queued", { kind: "url", value: url }]]);
    await sweep;
    const before = await entry.load();
    const deferred = await entry.run();
    assert.equal(deferred.statusCode, 200);
    assert.deepEqual(deferred.json(), { action: null });
    assert.deepEqual(await entry.load(), before);
  }
  assert.deepEqual(seen, []);
  assert.equal((await disputed.decide("rejected")).statusCode, 201);
  assert.equal(wakes, 2);
  const rejected = await disputed.load();
  const configured = await server.inject({ method: "PUT", url: "/settings/decodo", headers: { host: "127.0.0.1:4317" }, payload: { token: "offline-token" } });
  assert.equal(configured.statusCode, 200);
  assert.equal(wakes, 3);
  await sweep;
  assert.deepEqual(seen, [{ kind: "url", value: approvedUrl }]);
  assert.deepEqual(await disputed.load(), rejected);
  const blocked = await disputed.run();
  assert.equal(blocked.statusCode, 200);
  assert.deepEqual(blocked.json(), { action: null });
  assert.deepEqual(await disputed.load(), rejected);
  const completed = await approved.load();
  assert.equal(completed.actions[0]?.status, "succeeded");
  assert.deepEqual(completed.evidence.slice(1).map(({ sourceId, seed, finding }) => [sourceId, seed, finding?.target, finding?.extra.content]),
    [["decodo:url", { kind: "url", value: approvedUrl }, { kind: "url", value: approvedUrl }, "Offline excerpt"]]);
  assert.equal((await disputed.decide("accepted")).statusCode, 201);
  assert.equal(wakes, 4);
  await sweep;
  assert.deepEqual(seen, [{ kind: "url", value: approvedUrl }, { kind: "url", value: disputedUrl }]);
  const reaccepted = await disputed.load();
  assert.deepEqual(reaccepted.actions.map(({ id, status }) => [id, status]), [[rejected.actions[0]!.id, "succeeded"]]);
  assert.deepEqual(reaccepted.evidence.map(({ sourceId }) => sourceId), ["facecheck:photo", "decodo:url"]);
});

test("projection outages do not fail a committed run and can be reconciled from PostgreSQL state", async (t) => {
  const harness = makeHarness();
  t.after(() => harness.app.close());
  harness.projectionFails = true;

  const created = await harness.app.inject({ method: "POST", url: "/investigations" });
  const id = created.json<{ id: string }>().id;
  await harness.app.inject({ method: "POST", url: `/investigations/${id}/emails`, payload: {
    email: "projection@example.org", reason: "Persist the source seed before projection.",
  } });
  const proposal = await harness.app.inject({
    method: "POST", url: `/investigations/${id}/actions/proposals`, payload: {
      email: "projection@example.org", reason: "Propose a factual catalog check.",
    },
  });
  const actionId = proposal.json<{ id: string }>().id;
  await harness.app.inject({ method: "POST", url: `/investigations/${id}/authorization`, payload: {
    granted: true, reason: "Explicitly authorized for this test.",
  } });
  await harness.app.inject({ method: "POST", url: `/investigations/${id}/actions/${actionId}/approval`, payload: {
    reason: "Explicitly approved for this test.",
  } });

  const run = await harness.app.inject({ method: "POST", url: `/investigations/${id}/actions/run` });
  assert.equal(run.statusCode, 200);
  assert.equal(run.json<{ action: { status: string } }>().action.status, "succeeded");
  assert.equal(harness.executions, 1);

  harness.projectionFails = false;
  const reconciled = await harness.app.inject({ method: "POST", url: "/investigations/projections/reconcile" });
  assert.equal(reconciled.statusCode, 200);
  assert.deepEqual(reconciled.json(), {
    outcomes: [{ id, revision: (await harness.store.get(id))?.revision, status: "applied" }],
  });
  assert.equal(harness.executions, 1, "reconciliation projects persisted facts without rerunning the action");
});

test("sanitizes executor failure details in load, run, and report responses", async (t) => {
  const harness = makeHarness("runner failed at C:\\\\private\\\\credentials.txt");
  t.after(() => harness.app.close());
  const created = await harness.app.inject({ method: "POST", url: "/investigations" });
  const id = created.json<{ id: string }>().id;
  await harness.app.inject({ method: "POST", url: `/investigations/${id}/emails`, payload: {
    email: "person@example.org", reason: "Operator supplied this seed.",
  } });
  const proposal = await harness.app.inject({
    method: "POST", url: `/investigations/${id}/actions/proposals`, payload: {
      email: "person@example.org", reason: "Propose a failure-sanitization test.",
    },
  });
  const action = proposal.json<{ id: string }>();
  await harness.app.inject({ method: "POST", url: `/investigations/${id}/authorization`, payload: {
    granted: true, reason: "Explicitly authorized for offline testing.",
  } });
  await harness.app.inject({ method: "POST", url: `/investigations/${id}/actions/${action.id}/approval`, payload: {
    reason: "Explicitly approved for offline testing.",
  } });

  const run = await harness.app.inject({ method: "POST", url: `/investigations/${id}/actions/run` });
  assert.equal(run.json<{ action: { status: string; failure: string } }>().action.status, "failed");
  assert.equal(run.json<{ action: { failure: string } }>().action.failure, "Execution failed.");
  const loaded = await harness.app.inject({ method: "GET", url: `/investigations/${id}` });
  assert.equal(loaded.json<Investigation>().actions[0]?.failure, "Execution failed.");
  const report = await harness.app.inject({ method: "GET", url: `/investigations/${id}/report` });
  assert.match(report.body, /Execution failed/);
  for (const response of [run, loaded, report]) assert.doesNotMatch(response.body, /credentials|private/i);
});

test("exposes only allowlisted Decodo failures in run, load, and report responses", async (t) => {
  const store = new MemoryStore();
  const service = createInvestigationService({
    store, executor: { id: "offline", async execute() { return []; } },
    clock: () => "2025-02-01T00:00:00.000Z", createId: () => "failure-case",
  });
  const investigation = await service.createInvestigation();
  const path = `/investigations/${investigation.id}`;
  const loginFailure = "Decodo target requires login";
  const decodoSpec = { catalogId: "decodo.url.v1", provider: "decodo", seed: { kind: "url", value: "https://example.org/profile" } } as const;
  const scannerSpec = { catalogId: "user-scanner.email.v1", provider: "user-scanner", seed: { kind: "email", value: "person@example.org" } } as const;
  const failures = [
    [decodoSpec, loginFailure, loginFailure],
    [decodoSpec, "Decodo scrape blocked by anti-bot protection (999)", "Decodo scrape blocked by anti-bot protection (999)"],
    [decodoSpec, "Decodo API credentials were rejected", "Decodo API credentials were rejected"],
    [decodoSpec, "Decodo API rate limit or quota exceeded", "Decodo API rate limit or quota exceeded"],
    [decodoSpec, "Decodo request timed out", "Decodo request timed out"],
    [decodoSpec, "Decodo returned empty page content", "Decodo returned empty page content"],
    [decodoSpec, "Decodo target returned HTTP 404", "Decodo target returned HTTP 404"],
    [decodoSpec, "Decodo service failure (HTTP 612)", "Decodo service failure (HTTP 612)"],
    [decodoSpec, "Decodo request failed (HTTP 407)", "Decodo request failed (HTTP 407)"],
    [decodoSpec, `${loginFailure}: offline-secret`, "Execution failed."],
    [decodoSpec, "Decodo target returned HTTP 404\noffline-secret", "Execution failed."],
    [decodoSpec, "Decodo target returned HTTP 40412345678", "Execution failed."],
    [scannerSpec, loginFailure, "Execution failed."],
  ] as const;
  const actions: GitHubCatalogAction[] = failures.map(([spec, failure], index) => ({
    id: `action-${index}`, spec, status: "failed", failure,
    proposedAt: investigation.createdAt, proposalReason: "Offline fixture", completedAt: investigation.updatedAt,
  }));
  await store.transact(investigation.id, (current) => ({ next: { ...current, actions, revision: current.revision + 1 }, result: undefined }));
  const before = await store.get(investigation.id);
  let runIndex = 0;
  const app = createBackendApp(service, {
    actionRunner: { async run() { return actions[runIndex++]; } },
    projector: { project: async ({ revision }) => ({ revision, status: "applied" }) },
  });
  t.after(() => app.close());

  for (const [index, [,, failure]] of failures.entries()) {
    const run = await app.inject({ method: "POST", url: `${path}/actions/run` });
    assert.equal(run.statusCode, 200);
    assert.deepEqual(run.json(), { action: { ...actions[index], failure } });
  }
  const loaded = await app.inject({ method: "GET", url: path });
  assert.equal(loaded.statusCode, 200);
  assert.deepEqual(loaded.json<Investigation>().actions, actions.map((action, index) => ({ ...action, failure: failures[index]![2] })));
  const report = await app.inject({ method: "GET", url: `${path}/report` });
  assert.equal(report.statusCode, 200);
  assert.match(report.body, /Decodo target requires login/);
  assert.match(report.body, /Execution failed/);
  assert.doesNotMatch(report.body, /offline-secret|40412345678/);
  assert.deepEqual(await store.get(investigation.id), before);
});

test("creates named investigations with strict bounded input while keeping bodyless creation", async (t) => {
  const harness = makeHarness();
  t.after(() => harness.app.close());
  const { app } = harness;

  const bodyless = await app.inject({ method: "POST", url: "/investigations" });
  assert.equal(bodyless.statusCode, 201);
  assert.equal(bodyless.json<{ name: string }>().name, "Untitled investigation");

  const named = await app.inject({
    method: "POST", url: "/investigations", payload: { name: "  Report | <Night>  " },
  });
  assert.equal(named.statusCode, 201);
  const created = named.json<{ id: string; name: string }>();
  assert.equal(created.name, "Report | <Night>");
  const maximumName = "😀".repeat(120);
  const maximum = await app.inject({ method: "POST", url: "/investigations", payload: { name: maximumName } });
  assert.equal(maximum.statusCode, 201);
  assert.equal([...maximum.json<{ name: string }>().name].length, 120);
  assert.equal((await app.inject({ method: "GET", url: `/investigations/${created.id}` }))
    .json<{ name: string }>().name, created.name);
  assert.match((await app.inject({ method: "GET", url: `/investigations/${created.id}/report` })).body,
    /# Report \\| &lt;Night&gt;/);
  assert.deepEqual((await app.inject({ method: "GET", url: "/investigations" }))
    .json<{ id: string; name: string }[]>().map(({ id, name }) => ({ id, name })), [
    { id: bodyless.json<{ id: string }>().id, name: "Untitled investigation" },
    { id: created.id, name: "Report | <Night>" },
    { id: maximum.json<{ id: string }>().id, name: maximumName },
  ]);

  for (const payload of [
    { name: "   " },
    { name: "😀".repeat(121) },
    { name: 42 },
    { name: "Valid name", extra: true },
  ]) {
    assert.equal((await app.inject({ method: "POST", url: "/investigations", payload })).statusCode, 400);
  }
  assert.equal((await app.inject({ method: "GET", url: "/investigations" })).json<unknown[]>().length, 3,
    "invalid names do not create investigation records");
});

test("validates HTTP input and sanitizes missing-record and internal errors", async (t) => {
  const harness = makeHarness();
  t.after(() => harness.app.close());
  const { app, store } = harness;

  const invalid = await app.inject({
    method: "POST", url: "/investigations/not-real/emails",
    payload: { email: "not-email", reason: "   " },
  });
  assert.equal(invalid.statusCode, 400);
  assert.doesNotMatch(invalid.body, /stack|zod|not-email/i);

  const missing = await app.inject({ method: "GET", url: "/investigations/missing" });
  assert.equal(missing.statusCode, 404);
  assert.deepEqual(missing.json(), { error: "NOT_FOUND", message: "Investigation not found" });
  const unknownRoute = await app.inject({ method: "GET", url: "/private/internal" });
  assert.equal(unknownRoute.statusCode, 404);
  assert.deepEqual(unknownRoute.json(), { error: "NOT_FOUND", message: "Not found" });

  store.failList = true;
  const internal = await app.inject({ method: "GET", url: "/investigations" });
  assert.equal(internal.statusCode, 500);
  assert.deepEqual(internal.json(), { error: "INTERNAL_ERROR", message: "Internal server error" });
  assert.doesNotMatch(internal.body, /secret SQL|private\.example/i);
});
