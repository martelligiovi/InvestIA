import assert from "node:assert/strict";
import test from "node:test";
import {
  compileInvestigationReport,
  createInvestigationService,
  createSeedBoxExecutor,
  type ActionClaim,
  type ClaimActionRequest,
  type CompleteActionInput,
  type EmailSeed,
  type Investigation,
  type InvestigationExecutor,
  type InvestigationStore,
  type InvestigationTransaction,
  type Observation,
} from "../src/index.ts";

class MemoryInvestigationStore implements InvestigationStore {
  readonly #items = new Map<string, Investigation>();

  async create(investigation: Investigation): Promise<void> {
    if (this.#items.has(investigation.id)) throw new Error("Investigation already exists");
    this.#items.set(investigation.id, structuredClone(investigation));
  }

  async get(id: string): Promise<Investigation | undefined> {
    const item = this.#items.get(id);
    return item === undefined ? undefined : structuredClone(item);
  }

  async list(): Promise<readonly Investigation[]> {
    return [...this.#items.values()].map((item) => structuredClone(item));
  }

  async transact<T>(
    id: string,
    operation: (current: Investigation) => InvestigationTransaction<T>,
  ): Promise<T> {
    const current = this.#items.get(id);
    if (current === undefined) throw new Error(`Investigation not found: ${id}`);
    const { next, result } = operation(structuredClone(current));
    assert.equal(next.id, current.id);
    assert.equal(next.revision, current.revision + 1, "each mutation advances exactly one revision");
    this.#items.set(id, structuredClone(next));
    return structuredClone(result);
  }

  async claimNextAction(input: ClaimActionRequest): Promise<ActionClaim | undefined> {
    const current = this.#items.get(input.investigationId);
    if (
      current === undefined || current.paused || current.authorization?.granted !== true
    ) return undefined;
    const action = current.actions.find((candidate) => candidate.status === "queued" && candidate.approval);
    if (action === undefined) return undefined;

    const claimedAction = {
      ...action,
      status: "claimed" as const,
      claim: { id: input.claimId, claimedAt: input.claimedAt },
    };
    const audit = {
      ...input.auditEvent,
      actionId: action.id,
    };
    this.#items.set(input.investigationId, structuredClone({
      ...current,
      revision: current.revision + 1,
      updatedAt: input.claimedAt,
      actions: current.actions.map((candidate) => candidate.id === action.id ? claimedAction : candidate),
      audit: [...current.audit, audit],
    }));
    return structuredClone({
      action: claimedAction,
      permit: { authorized: true as const, approved: true as const, paused: false as const },
    });
  }

  async completeAction(input: CompleteActionInput): Promise<Investigation> {
    const current = this.#items.get(input.investigationId);
    if (current === undefined) throw new Error(`Investigation not found: ${input.investigationId}`);
    const action = current.actions.find((candidate) => candidate.id === input.actionId);
    if (action?.status !== "claimed" || action.claim?.id !== input.claimId) {
      throw new Error("Action claim is no longer active");
    }
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
      actions: current.actions.map((candidate) => candidate.id === action.id ? completed : candidate),
      evidence: input.result.kind === "success" ? [...current.evidence, ...input.result.evidence] : current.evidence,
      audit: [...current.audit, input.auditEvent],
    };
    this.#items.set(input.investigationId, structuredClone(next));
    return structuredClone(next);
  }
}

function makeHarness(executor?: InvestigationExecutor) {
  const store = new MemoryInvestigationStore();
  let id = 0;
  let tick = 0;
  const defaultExecutor: InvestigationExecutor = executor ?? {
    id: "fake-github-box",
    async execute(action) {
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
    executor: defaultExecutor,
    clock: () => `2025-01-01T00:00:${String(tick++).padStart(2, "0")}.000Z`,
    createId: (kind) => `${kind}-${++id}`,
  });
  return { store, service };
}

async function approvedAction(
  service: ReturnType<typeof createInvestigationService>,
  email = "person@example.org",
): Promise<{ investigationId: string; actionId: string }> {
  const investigation = await service.createInvestigation();
  await service.addEmailSeed(investigation.id, email, "Operator supplied this email seed.");
  const action = await service.proposeGitHubAction(
    investigation.id,
    email,
    "Check this email against the approved GitHub catalog action.",
  );
  await service.approveAction(investigation.id, action.id, "Operator approved this single action.");
  await service.authorize(investigation.id, true, "Operator authorized this action.");
  return { investigationId: investigation.id, actionId: action.id };
}

test("creates, lists, loads, and adds validated email seeds with revisions", async () => {
  const { service } = makeHarness();
  const created = await service.createInvestigation();
  assert.equal(created.revision, 0);
  const updated = await service.addEmailSeed(created.id, " person@example.org ", "Seed supplied by operator.");
  assert.equal(updated.revision, 1);
  assert.deepEqual(updated.emailSeeds, [{ kind: "email", value: "person@example.org" }]);
  assert.equal((await service.loadInvestigation(created.id))?.revision, 1);
  assert.equal((await service.listInvestigations()).length, 1);
  await assert.rejects(service.addEmailSeed(created.id, "not-an-email", "Bad seed."), /email/i);
  await assert.rejects(service.addEmailSeed(created.id, "person@-.org", "Invalid domain label."), /email/i);
});

test("investigation names are trimmed and preserved through listing, loading, mutation, and reports", async () => {
  const { service } = makeHarness();
  const created = await service.createInvestigation("  Triage | **<Night>**  ");
  assert.equal(created.name, "Triage | **<Night>**");
  assert.equal((await service.listInvestigations())[0]?.name, created.name);
  await service.addEmailSeed(created.id, "person@example.org", "Seed supplied by operator.");
  const loaded = await service.loadInvestigation(created.id);
  assert.equal(loaded?.name, created.name);
  const report = compileInvestigationReport(loaded!);
  assert.ok(report.includes("# Triage \\| \\*\\*&lt;Night&gt;\\*\\*"));
  assert.ok(!report.includes("# Triage | **<Night>**"));

  const bodyless = await service.createInvestigation();
  assert.equal(bodyless.name, "Untitled investigation");
  const maximum = await service.createInvestigation("😀".repeat(120));
  assert.equal([...maximum.name!].length, 120, "the limit counts Unicode characters, not UTF-16 code units");
});

test("domain rejects blank, malformed, and overlong investigation names without creating records", async () => {
  const { service } = makeHarness();
  await assert.rejects(service.createInvestigation("  "), /name/i);
  await assert.rejects(service.createInvestigation(42 as unknown as string), /name/i);
  await assert.rejects(service.createInvestigation("n".repeat(121)), /name/i);
  assert.deepEqual(await service.listInvestigations(), []);
});

test("requires persisted authorization and explicit action approval before dispatch", async () => {
  let calls = 0;
  const executor: InvestigationExecutor = {
    id: "test-box",
    async execute(action) {
      calls++;
      return [{ kind: "registration", seed: action.spec.seed, provider: "github", status: "registered" }];
    },
  };
  const { service } = makeHarness(executor);
  const created = await service.createInvestigation();
  await service.addEmailSeed(created.id, "person@example.org", "Seed supplied.");
  const action = await service.proposeGitHubAction(created.id, "person@example.org", "Proposal reason.");
  assert.equal(await service.executeNextAction(created.id), undefined);
  await service.approveAction(created.id, action.id, "Approved explicitly.");
  assert.equal(await service.executeNextAction(created.id), undefined, "approval alone is not authorization");
  await service.authorize(created.id, true, "Operator authorized GitHub checks.");
  const result = await service.executeNextAction(created.id);
  assert.equal(result?.status, "succeeded");
  assert.equal(calls, 1);
});

test("pause prevents new claims and resume does not approve proposed actions", async () => {
  const { service } = makeHarness();
  const investigation = await service.createInvestigation();
  await service.addEmailSeed(investigation.id, "person@example.org", "Seed supplied.");
  const action = await service.proposeGitHubAction(investigation.id, "person@example.org", "Proposal reason.");
  await service.authorize(investigation.id, true, "Authorized.");
  await service.pause(investigation.id, "Pause while reviewing.");
  assert.equal(await service.executeNextAction(investigation.id), undefined);
  await service.resume(investigation.id, "Resume without approving anything.");
  assert.equal(await service.executeNextAction(investigation.id), undefined);
  assert.equal((await service.loadInvestigation(investigation.id))?.actions[0]?.status, "proposed");
  await service.approveAction(investigation.id, action.id, "Approved after resume.");
  assert.equal((await service.executeNextAction(investigation.id))?.status, "succeeded");
});

test("atomic claims prevent duplicate dispatch, and pause blocks subsequent claims", async () => {
  let releaseExecution!: () => void;
  let calls = 0;
  const executor: InvestigationExecutor = {
    id: "slow-box",
    async execute() {
      calls++;
      await new Promise<void>((resolve) => { releaseExecution = resolve; });
      return [];
    },
  };
  const { service } = makeHarness(executor);
  const { investigationId } = await approvedAction(service);
  const first = service.executeNextAction(investigationId);
  const second = service.executeNextAction(investigationId);
  await service.pause(investigationId, "Pause further dispatches.");
  assert.equal(await second, undefined);
  assert.equal(calls, 1);
  releaseExecution();
  assert.equal((await first)?.status, "succeeded");
  assert.equal(await service.executeNextAction(investigationId), undefined);
  await service.resume(investigationId, "Resume without retrying claimed work.");
  assert.equal(await service.executeNextAction(investigationId), undefined, "terminal action is not retried");
});

test("records GitHub evidence provenance and ignores unsupported identities/providers", async () => {
  const executor: InvestigationExecutor = {
    id: "mixed-box",
    async execute(action) {
      return [
        { kind: "registration", seed: action.spec.seed, provider: "github", status: "unknown" },
        { kind: "registration", seed: action.spec.seed, provider: "github", status: "error" },
        { kind: "registration", seed: action.spec.seed, provider: "other", status: "registered" },
        { kind: "identity", subject: "person@example.org", basis: "unverified match" },
      ];
    },
  };
  const { service } = makeHarness(executor);
  const { investigationId, actionId } = await approvedAction(service);
  const action = await service.executeNextAction(investigationId);
  const investigation = await service.loadInvestigation(investigationId);
  assert.equal(action?.id, actionId);
  assert.equal(investigation?.evidence.length, 2);
  assert.deepEqual(investigation?.evidence.map((evidence) => evidence.status), ["unknown", "error"]);
  assert.ok(investigation?.evidence.every((evidence) => evidence.provider === "github"));
  assert.ok(investigation?.evidence.every((evidence) => evidence.sourceId === "mixed-box"));
  assert.equal(action?.unsupportedObservationCount, 2);
  assert.equal(investigation?.audit.some((event) => event.kind === "action_succeeded"), true);
  const report = compileInvestigationReport(investigation!);
  assert.ok(report.includes("unknown"));
  assert.ok(report.includes("error"));
  assert.ok(report.includes("| 2 |"), "unsupported observation count is visible in the action row");
  assert.ok(!report.includes("unverified match"), "identity observation content is never asserted or published");
});

test("validation decisions preserve accepted, rejected, and inconclusive outcomes", async () => {
  const { service } = makeHarness();
  const { investigationId } = await approvedAction(service);
  await service.executeNextAction(investigationId);
  const snapshot = await service.loadInvestigation(investigationId);
  const evidence = snapshot?.evidence[0];
  assert.ok(evidence);
  for (const status of ["accepted", "rejected", "inconclusive"] as const) {
    await service.validateEvidence(investigationId, evidence.id, status, `Decision: ${status}.`);
  }
  const final = await service.loadInvestigation(investigationId);
  assert.deepEqual(final?.validations.map((decision) => decision.status), ["accepted", "rejected", "inconclusive"]);
  assert.equal(final?.audit.filter((event) => event.kind === "evidence_validated").length, 3);
  const report = compileInvestigationReport(final!);
  assert.ok(report.includes("accepted"));
  assert.ok(report.includes("rejected"));
  assert.ok(report.includes("inconclusive"));
  const auditReport = report.split("## Audit decisions\n")[1]?.split("\n\n")[0] ?? "";
  assert.ok(auditReport.includes("Action ID"));
  assert.ok(auditReport.includes("Evidence ID"));
  for (const event of final!.audit.filter((candidate) => candidate.kind === "authorization_changed")) {
    assert.ok(auditReport.includes(
      `| ${event.actionId?.replaceAll("-", "\\-") ?? "not recorded"} | ${event.evidenceId?.replaceAll("-", "\\-") ?? "not recorded"} | ${event.granted ?? "not recorded"} | ${event.decision ?? "not recorded"} |`,
    ));
  }
  for (const event of final!.audit.filter((candidate) => candidate.kind === "evidence_validated")) {
    assert.ok(auditReport.includes(
      `| ${event.actionId?.replaceAll("-", "\\-") ?? "not recorded"} | ${event.evidenceId?.replaceAll("-", "\\-") ?? "not recorded"} | ${event.granted ?? "not recorded"} | ${event.decision ?? "not recorded"} |`,
    ));
  }
});

test("terminal executor failures are retained and report escaping is deterministic and factual", async () => {
  let calls = 0;
  const executor: InvestigationExecutor = {
    id: "failure-box",
    async execute() {
      calls++;
      throw new Error("<script>alert(1)</script> | failed\n- injected claim");
    },
  };
  const { service } = makeHarness(executor);
  const investigation = await service.createInvestigation();
  const email = "a.b@example.org";
  await service.addEmailSeed(investigation.id, email, "Seed from operator.");
  const action = await service.proposeGitHubAction(investigation.id, email, "Reason with **markup**.");
  await service.authorize(investigation.id, true, "Explicit authorization.");
  await service.approveAction(investigation.id, action.id, "Explicit approval.");
  assert.equal((await service.executeNextAction(investigation.id))?.status, "failed");
  assert.equal(await service.executeNextAction(investigation.id), undefined);
  assert.equal(calls, 1);
  const snapshot = await service.loadInvestigation(investigation.id);
  assert.equal(snapshot?.actions[0]?.failure, "<script>alert(1)</script> | failed\n- injected claim");
  assert.equal(snapshot?.actions[0]?.spec.seed.value, email, "action seed remains unchanged");
  const report = compileInvestigationReport(snapshot!);
  assert.ok(report.includes("Identity attribution is unsupported and is not asserted."));
  assert.ok(report.includes("&lt;script&gt;"));
  assert.ok(report.includes("a\\.b@example\\.org"));
  assert.ok(!report.includes("<script>"));
  assert.ok(!report.includes("injected claim\n-"));
  assert.equal(report, compileInvestigationReport(snapshot!), "same snapshot compiles byte-for-byte identically");
});

test("pause leaves a second approved action queued until resume", async () => {
  let releaseFirst!: () => void;
  let signalFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => { signalFirstStarted = resolve; });
  let calls = 0;
  const executor: InvestigationExecutor = {
    id: "queued-box",
    async execute() {
      calls++;
      if (calls === 1) {
        signalFirstStarted();
        await new Promise<void>((resolve) => { releaseFirst = resolve; });
      }
      return [];
    },
  };
  const { service } = makeHarness(executor);
  const investigation = await service.createInvestigation();
  const actionIds: string[] = [];
  for (const email of ["first@example.org", "second@example.org"]) {
    await service.addEmailSeed(investigation.id, email, "Operator supplied this email seed.");
    const action = await service.proposeGitHubAction(investigation.id, email, "Proposal reason.");
    actionIds.push(action.id);
    await service.approveAction(investigation.id, action.id, "Approved explicitly.");
  }
  await service.authorize(investigation.id, true, "Operator authorized both actions.");

  const firstExecution = service.executeNextAction(investigation.id);
  await firstStarted;
  await service.pause(investigation.id, "Pause before dispatching the queued action.");
  assert.equal(await service.executeNextAction(investigation.id), undefined);
  releaseFirst();
  assert.equal((await firstExecution)?.id, actionIds[0]);
  assert.equal(calls, 1);
  assert.equal((await service.loadInvestigation(investigation.id))?.actions[1]?.status, "queued");

  await service.resume(investigation.id, "Resume the approved queue.");
  assert.equal((await service.executeNextAction(investigation.id))?.id, actionIds[1]);
  assert.equal(calls, 2);
});

test("authorization revocation blocks new claims but leaves an in-flight completion valid", async () => {
  let releaseFirst!: () => void;
  let signalFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => { signalFirstStarted = resolve; });
  let calls = 0;
  const executor: InvestigationExecutor = {
    id: "revocation-box",
    async execute() {
      calls++;
      if (calls === 1) {
        signalFirstStarted();
        await new Promise<void>((resolve) => { releaseFirst = resolve; });
      }
      return [];
    },
  };
  const { service } = makeHarness(executor);
  const investigation = await service.createInvestigation();
  const actionIds: string[] = [];
  for (const email of ["first@example.org", "second@example.org"]) {
    await service.addEmailSeed(investigation.id, email, "Operator supplied this email seed.");
    const action = await service.proposeGitHubAction(investigation.id, email, "Proposal reason.");
    actionIds.push(action.id);
    await service.approveAction(investigation.id, action.id, "Approved explicitly.");
  }
  await service.authorize(investigation.id, true, "Operator authorized both actions.");

  const firstExecution = service.executeNextAction(investigation.id);
  await firstStarted;
  await service.authorize(investigation.id, false, "Revoke authorization before the next claim.");
  assert.equal(await service.executeNextAction(investigation.id), undefined);
  releaseFirst();
  assert.equal((await firstExecution)?.id, actionIds[0]);
  assert.equal(calls, 1);
  const revoked = await service.loadInvestigation(investigation.id);
  assert.equal(revoked?.actions[1]?.status, "queued");
  assert.equal(await service.executeNextAction(investigation.id), undefined);
  const auditReport = compileInvestigationReport(revoked!).split("## Audit decisions\n")[1] ?? "";
  assert.ok(auditReport.includes("| not recorded | not recorded | false | not recorded |"));

  await service.authorize(investigation.id, true, "Reauthorize the remaining approved action.");
  assert.equal((await service.executeNextAction(investigation.id))?.id, actionIds[1]);
  assert.equal(calls, 2);
});

test("completion fencing rejects a stale claim and a duplicate terminal completion", async () => {
  const { store, service } = makeHarness();
  const { investigationId, actionId } = await approvedAction(service);
  const claimedAt = "2025-01-02T00:00:00.000Z";
  const claim: ClaimActionRequest = {
    investigationId,
    claimId: "active-claim",
    claimedAt,
    auditEvent: {
      id: "claim-audit",
      at: claimedAt,
      actor: "system",
      kind: "action_claimed",
      reason: "Claim for fencing regression test.",
      actionId,
    },
  };
  assert.ok(await store.claimNextAction(claim));
  const completedAt = "2025-01-02T00:00:01.000Z";
  const completion: CompleteActionInput = {
    investigationId,
    actionId,
    claimId: "active-claim",
    completedAt,
    result: { kind: "success", evidence: [], unsupportedObservationCount: 0 },
    auditEvent: {
      id: "completion-audit",
      at: completedAt,
      actor: "system",
      kind: "action_succeeded",
      reason: "Completion for fencing regression test.",
      actionId,
    },
  };
  await assert.rejects(store.completeAction({ ...completion, claimId: "stale-claim" }), /claim is no longer active/i);
  assert.equal((await store.get(investigationId))?.actions[0]?.status, "claimed");
  await store.completeAction(completion);
  await assert.rejects(store.completeAction(completion), /claim is no longer active/i);
});

test("SeedBox executor rejects unclaimed actions even with all permit flags", async () => {
  let calls = 0;
  const executor = createSeedBoxExecutor({
    id: "claimed-only-box",
    inputKind: "email",
    async execute(seed: EmailSeed): Promise<readonly Observation[]> {
      calls++;
      return [{ kind: "registration", seed, provider: "github", status: "registered" }];
    },
  });
  const { service } = makeHarness();
  const investigation = await service.createInvestigation();
  await service.addEmailSeed(investigation.id, "person@example.org", "Seed supplied.");
  const action = await service.proposeGitHubAction(investigation.id, "person@example.org", "Proposal reason.");
  await assert.rejects(executor.execute(
    action as unknown as ActionClaim["action"],
    { authorized: true, approved: true, paused: false },
  ), /claimed action/i);
  assert.equal(calls, 0);
});

test("SeedBox executor delegates through the existing explicit execution gate", async () => {
  let calls = 0;
  const executor = createSeedBoxExecutor({
    id: "github-seed-box",
    inputKind: "email",
    async execute(seed: EmailSeed): Promise<readonly Observation[]> {
      calls++;
      return [{ kind: "registration", seed, provider: "github", status: "not_registered" }];
    },
  });
  const { service } = makeHarness(executor);
  const { investigationId } = await approvedAction(service);
  await service.executeNextAction(investigationId);
  assert.equal(calls, 1);
  assert.equal((await service.loadInvestigation(investigationId))?.evidence[0]?.status, "not_registered");
});
