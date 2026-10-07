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
import { createInvestigationRunGraph } from "../src/investigation-run-graph.ts";

class MemoryStore implements InvestigationStore {
  readonly #items = new Map<string, Investigation>();
  claimAttempts = 0;

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
    const mutation = operation(structuredClone(current));
    this.#items.set(id, structuredClone(mutation.next));
    return structuredClone(mutation.result);
  }

  async claimNextAction(input: ClaimActionRequest): Promise<ActionClaim | undefined> {
    this.claimAttempts++;
    const current = this.#items.get(input.investigationId);
    if (current === undefined || current.paused || current.authorization?.granted !== true) return undefined;
    const action = current.actions.find((candidate) => candidate.status === "queued" && candidate.approval !== undefined);
    if (action === undefined) return undefined;
    const claimed = {
      ...action,
      status: "claimed" as const,
      claim: { id: input.claimId, claimedAt: input.claimedAt },
    };
    const next = {
      ...current,
      revision: current.revision + 1,
      updatedAt: input.claimedAt,
      actions: current.actions.map((candidate) => candidate.id === action.id ? claimed : candidate),
      audit: [...current.audit, { ...input.auditEvent, actionId: action.id }],
    };
    this.#items.set(input.investigationId, structuredClone(next));
    return structuredClone({ action: claimed, permit: { authorized: true, approved: true, paused: false } });
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

test("StateGraph uses the investigation thread and the PostgreSQL claim gate prevents crash replay", async () => {
  const store = new MemoryStore();
  let ticks = 0;
  let sequence = 0;
  let toolExecutions = 0;
  const executor: InvestigationExecutor = {
    id: "offline-crash-recovery-executor",
    async execute() {
      toolExecutions++;
      return [];
    },
  };
  const service = createInvestigationService({
    store,
    executor,
    clock: () => new Date(Date.parse("2025-05-01T00:00:00.000Z") + ticks++ * 1_000).toISOString(),
    createId: (kind) => `${kind}-${++sequence}`,
  });
  const investigation = await service.createInvestigation();
  const email = "private-fact@example.org";
  await service.addEmailSeed(investigation.id, email, "Seed for a simulated process crash.");
  const action = await service.proposeGitHubAction(investigation.id, email, "Queue one explicitly approved action.");
  await service.authorize(investigation.id, true, "Explicit test authorization.");
  await service.approveAction(investigation.id, action.id, "Explicit test approval.");

  const claimedAt = "2025-05-01T00:01:00.000Z";
  const claim = await store.claimNextAction({
    investigationId: investigation.id,
    claimId: "claim-retained-after-crash",
    claimedAt,
    auditEvent: {
      id: "audit-crash-claim",
      at: claimedAt,
      actor: "system",
      kind: "action_claimed",
      reason: "Persisted authorization allowed a claim before the simulated crash.",
    },
  });
  assert.equal(claim?.action.status, "claimed");

  const checkpointer = new MemorySaver();
  const firstProcess = createInvestigationRunGraph(service, checkpointer);
  assert.equal(await firstProcess.run(investigation.id), undefined);
  const restartedProcess = createInvestigationRunGraph(service, checkpointer);
  assert.equal(await restartedProcess.run(investigation.id), undefined);

  assert.equal(store.claimAttempts, 3, "each graph invocation re-enters the authoritative claim gate");
  assert.equal(toolExecutions, 0, "a claimed action is never replayed after checkpoint restart");
  const checkpoint = await checkpointer.getTuple({ configurable: { thread_id: investigation.id } });
  assert.ok(checkpoint, "LangGraph saved state under the investigation thread id");
  const checkpointValues = JSON.stringify(checkpoint.checkpoint.channel_values);
  assert.match(checkpointValues, new RegExp(investigation.id));
  assert.match(checkpointValues, /revision/);
  assert.doesNotMatch(checkpointValues, /private-fact@example\.org|evidence|sourceId/);
});
