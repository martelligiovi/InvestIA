import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
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
import { AutomaticInvestigationRunner } from "../src/automatic-investigation-runner.ts";
import { createInvestigationRunGraph } from "../src/investigation-run-graph.ts";
import { resolveFrontendDistPath } from "../src/serve-frontend.ts";

const HOST = "127.0.0.1";
const PORT = 4327;
const serverScope = randomUUID();

class InMemoryStore implements InvestigationStore {
  enumerationCount = 0;
  readonly #investigations = new Map<string, Investigation>();

  async create(investigation: Investigation): Promise<void> {
    this.#investigations.set(investigation.id, structuredClone(investigation));
  }

  async get(id: string): Promise<Investigation | undefined> {
    const investigation = this.#investigations.get(id);
    return investigation === undefined ? undefined : structuredClone(investigation);
  }

  async list(): Promise<readonly Investigation[]> {
    this.enumerationCount++;
    return [...this.#investigations.values()].map((investigation) => structuredClone(investigation));
  }

  async transact<T>(
    id: string,
    operation: (current: Investigation) => InvestigationTransaction<T>,
  ): Promise<T> {
    const current = this.#investigations.get(id);
    if (current === undefined) throw new Error("Investigation not found");
    const { next, result } = operation(structuredClone(current));
    assert.equal(next.revision, current.revision + 1);
    this.#investigations.set(id, structuredClone(next));
    return structuredClone(result);
  }

  async claimNextAction(input: ClaimActionRequest): Promise<ActionClaim | undefined> {
    const current = this.#investigations.get(input.investigationId);
    if (current === undefined || current.paused || current.authorization?.granted !== true ||
      (input.automaticOnly === true && current.advancementMode !== "automatic")) return undefined;
    // No await between gate, selection and persisted claim: atomic in this isolated store.
    const action = current.actions.find((candidate) => candidate.status === "queued" &&
      (candidate.queuedByCatalog === true || candidate.approval !== undefined));
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
    this.#investigations.set(input.investigationId, structuredClone(next));
    return structuredClone({
      action: claimed,
      permit: { authorized: true, approved: true, paused: false },
    });
  }

  async completeAction(input: CompleteActionInput): Promise<Investigation> {
    const current = this.#investigations.get(input.investigationId);
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
    this.#investigations.set(input.investigationId, structuredClone(next));
    return structuredClone(next);
  }
}

const store = new InMemoryStore();
const requestCounts = new Map<string, number>();
const executionCalls: { readonly actionId: string; readonly email: string }[] = [];
let idSequence = 0;
let ticks = 0;
const executor: InvestigationExecutor = {
  id: "test-only-fake-github-observer",
  async execute(action, permit) {
    assert.deepEqual(permit, { authorized: true, approved: true, paused: false });
    executionCalls.push({ actionId: action.id, email: action.spec.seed.value });
    return [{
      kind: "registration",
      seed: action.spec.seed,
      provider: "github",
      status: "unknown",
    }];
  },
};
const service = createInvestigationService({
  store,
  executor,
  clock: () => new Date(Date.now() + ticks++).toISOString(),
  createId: (kind) => `browser-${serverScope}-${kind}-${++idSequence}-${randomUUID()}`,
});
const app = createBackendApp(service, {
  actionRunner: createInvestigationRunGraph(service, new MemorySaver()),
  projector: {
    async project(investigation) {
      return { revision: investigation.revision, status: "applied" };
    },
  },
}, { frontendDistPath: resolveFrontendDistPath() });

const workerErrors: string[] = [];
const automaticRunner = new AutomaticInvestigationRunner(service, {
  intervalMs: 50,
  onError: () => { workerErrors.push("Automatic worker error"); },
});
app.addHook("onClose", async () => { await automaticRunner.stop(); });

// Request counting and this state-inspection route exist only in this test process.
app.addHook("onRequest", (request, _reply, done) => {
  if (request.url.startsWith("/investigations")) {
    const route = request.routeOptions.url ?? request.url.split("?", 1)[0] ?? request.url;
    const key = `${request.method} ${route}`;
    requestCounts.set(key, (requestCounts.get(key) ?? 0) + 1);
  }
  done();
});
app.get<{ Params: { id: string } }>("/__test/state/:id", async (request, reply) => {
  const investigation = await store.get(request.params.id);
  if (investigation === undefined) return reply.code(404).send({ error: "NOT_FOUND" });
  return {
    investigation,
    enumerationCount: store.enumerationCount,
    workerErrors: [...workerErrors],
    executionCount: executionCalls.length,
    executionCalls: structuredClone(executionCalls),
    requestCounts: Object.fromEntries(requestCounts),
  };
});

async function close(): Promise<void> {
  if (!app.server.listening) return;
  await app.close();
}

try {
  await app.listen({ host: HOST, port: PORT });
  automaticRunner.start();
  const address = app.server.address() as AddressInfo;
  console.info(`Test-only browser API and built frontend listening on http://${HOST}:${address.port}`);
} catch (error) {
  console.error("Could not start the isolated Playwright browser server.", error);
  process.exitCode = 1;
}

process.once("SIGINT", () => { void close(); });
process.once("SIGTERM", () => { void close(); });
