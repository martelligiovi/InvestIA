import assert from "node:assert/strict";
import test from "node:test";
import { MemorySaver } from "@langchain/langgraph";
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
import { createBackendApp } from "../src/api.ts";
import { createInvestigationRunGraph } from "../src/investigation-run-graph.ts";

class MemoryStore implements InvestigationStore {
  readonly #items = new Map<string, Investigation>();

  async create(investigation: Investigation): Promise<void> {
    this.#items.set(investigation.id, structuredClone(investigation));
  }

  async get(id: string): Promise<Investigation | undefined> {
    const investigation = this.#items.get(id);
    return investigation === undefined ? undefined : structuredClone(investigation);
  }

  async list(): Promise<readonly Investigation[]> {
    return [...this.#items.values()].map((investigation) => structuredClone(investigation));
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
    const action = current.actions.find((candidate) => candidate.status === "queued" && candidate.approval !== undefined);
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
      actions: current.actions.map((candidate) => candidate.id === action.id ? claimed : candidate),
      audit: [...current.audit, { ...input.auditEvent, actionId: action.id }],
    };
    this.#items.set(input.investigationId, structuredClone(next));
    return structuredClone({
      action: claimed,
      permit: { authorized: true, approved: true, paused: false },
    });
  }

  async completeAction(input: CompleteActionInput): Promise<Investigation> {
    const current = this.#items.get(input.investigationId);
    if (current === undefined) throw new Error("Investigation not found");
    const action = current.actions.find((candidate) => candidate.id === input.actionId);
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
      actions: current.actions.map((candidate) => candidate.id === input.actionId ? completed : candidate),
      evidence: input.result.kind === "success" ? [...current.evidence, ...input.result.evidence] : current.evidence,
      audit: [...current.audit, input.auditEvent],
    };
    this.#items.set(input.investigationId, structuredClone(next));
    return structuredClone(next);
  }
}

test("offline API and graph complete a gated two-action workflow", async (t) => {
  const store = new MemoryStore();
  let sequence = 0;
  let executions = 0;
  const executor: InvestigationExecutor = {
    id: "offline-workflow-fake-executor",
    async execute(action, permit) {
      executions++;
      assert.equal(action.status, "claimed");
      assert.deepEqual(permit, { authorized: true, approved: true, paused: false });
      return [{ kind: "registration", seed: action.spec.seed, provider: "github", status: "unknown" }];
    },
  };
  const service = createInvestigationService({
    store,
    executor,
    clock: () => new Date("2025-06-01T00:00:00.000Z").toISOString(),
    createId: (kind) => `${kind}-${++sequence}`,
  });
  const app = createBackendApp(service, {
    actionRunner: createInvestigationRunGraph(service, new MemorySaver()),
    projector: { async project(investigation) { return { revision: investigation.revision, status: "applied" }; } },
  });
  t.after(() => app.close());

  const created = await app.inject({ method: "POST", url: "/investigations" });
  assert.equal(created.statusCode, 201);
  const id = created.json<{ id: string }>().id;
  assert.ok((await app.inject({ method: "GET", url: "/investigations" })).json<{ id: string }[]>().some((item) => item.id === id));
  assert.equal((await app.inject({ method: "GET", url: `/investigations/${id}` })).statusCode, 200);

  const emails = ["first-offline@example.org", "second-offline@example.org"];
  for (const email of emails) {
    assert.equal((await app.inject({ method: "POST", url: `/investigations/${id}/emails`, payload: {
      email, reason: "Add an operator-supplied offline test seed.",
    } })).statusCode, 201);
  }
  const actions = [] as { id: string; status: string }[];
  for (const email of emails) {
    const response = await app.inject({ method: "POST", url: `/investigations/${id}/actions/proposals`, payload: {
      email, reason: "Propose a fake-backed workflow action.",
    } });
    assert.equal(response.statusCode, 201);
    actions.push(response.json<{ id: string; status: string }>());
  }

  const run = async () => app.inject({ method: "POST", url: `/investigations/${id}/actions/run` });
  assert.equal((await run()).json<{ action: unknown }>().action, null, "missing authorization and approval gate execution");
  assert.equal(executions, 0);
  assert.equal((await app.inject({ method: "POST", url: `/investigations/${id}/authorization`, payload: {
    granted: true, reason: "Explicit offline test authorization.",
  } })).statusCode, 200);
  assert.equal((await run()).json<{ action: unknown }>().action, null, "authorization alone does not approve an action");
  assert.equal(executions, 0);

  for (const action of actions) {
    assert.equal((await app.inject({ method: "POST", url: `/investigations/${id}/actions/${action.id}/approval`, payload: {
      reason: "Explicit offline test approval.",
    } })).statusCode, 200);
  }
  assert.equal((await run()).json<{ action: { id: string; status: string } }>().action.id, actions[0]!.id);
  assert.equal(executions, 1);

  const afterFirstRun = (await app.inject({ method: "GET", url: `/investigations/${id}` })).json<Investigation>();
  const evidenceId = afterFirstRun.evidence[0]!.id;
  assert.equal((await app.inject({ method: "POST", url: `/investigations/${id}/evidence/${evidenceId}/validation`, payload: {
    status: "accepted", reason: "Accept the fake unknown registration observation as recorded evidence.",
  } })).statusCode, 201);
  assert.equal((await app.inject({ method: "POST", url: `/investigations/${id}/pause`, payload: {
    reason: "Pause before dispatching the second queued action.",
  } })).statusCode, 200);
  assert.equal((await run()).json<{ action: unknown }>().action, null);
  assert.equal(executions, 1, "pause gates the second approved queued action");
  assert.equal((await app.inject({ method: "POST", url: `/investigations/${id}/resume`, payload: {
    reason: "Resume the investigation without changing its approval.",
  } })).statusCode, 200);
  assert.equal((await run()).json<{ action: { id: string; status: string } }>().action.id, actions[1]!.id);
  assert.equal(executions, 2);

  const report = await app.inject({ method: "GET", url: `/investigations/${id}/report` });
  assert.equal(report.statusCode, 200);
  assert.match(report.headers["content-type"] ?? "", /text\/markdown/);
  assert.match(report.body, /Identity attribution is unsupported/);
  assert.match(report.body, /accepted/);
  assert.match(report.body, /unknown/);
});
