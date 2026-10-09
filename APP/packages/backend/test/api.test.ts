import assert from "node:assert/strict";
import test from "node:test";
import {
  createInvestigationService,
  type ActionClaim,
  type ClaimActionRequest,
  type CompleteActionInput,
  type Investigation,
  type InvestigationExecutor,
  type InvestigationStore,
  type InvestigationTransaction,
} from "@investia/core";
import { MemorySaver } from "@langchain/langgraph";
import { createBackendApp } from "../src/api.ts";
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
    if (current === undefined || current.paused || current.authorization?.granted !== true) return undefined;
    const action = current.actions.find((item) => item.status === "queued" && item.approval !== undefined);
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
      return [{ kind: "registration", seed: action.spec.seed, provider: "github", status: "unknown" }];
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
