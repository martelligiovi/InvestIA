import assert from "node:assert/strict";
import test from "node:test";
import { createInitialInvestigation, type Investigation } from "@investia/core";
import { AutomaticInvestigationRunner } from "../src/automatic-investigation-runner.ts";

function harness() {
  const cases = new Map<string, Investigation>();
  const calls: string[] = [];
  const remaining = new Map<string, number>();
  let release: (() => void) | undefined;
  let fail = false;
  const service = {
    async listInvestigations() { return [...cases.values()].map((item) => ({ ...item, name: item.name!, emailSeedCount: 0, actionCount: 0 })); },
    async loadInvestigation(id: string) { return cases.get(id); },
    async executeNextAction(id: string, automaticOnly?: boolean) {
      assert.equal(automaticOnly, true, "worker must request an atomic automatic-mode claim");
      const current = cases.get(id)!;
      if (current.advancementMode !== "automatic" || current.paused || !current.authorization?.granted) return undefined;
      if (!remaining.get(id)) return undefined;
      remaining.set(id, remaining.get(id)! - 1);
      calls.push(id);
      if (fail) throw new Error("retained claim/completion error");
      if (release !== undefined) await new Promise<void>((resolve) => { release = resolve; });
      return { id: `action-${calls.length}`, spec: { catalogId: "github.email-registration.v1" as const, provider: "github" as const, seed: { kind: "email" as const, value: "a@example.test" } }, status: "succeeded" as const, proposedAt: "2025-01-01T00:00:00Z", proposalReason: "catalog" };
    },
  };
  function add(id: string, mode: "automatic" | "manual" | undefined = "automatic", authorized = true, paused = false) {
    cases.set(id, { ...createInitialInvestigation(id, "2025-01-01T00:00:00Z"), advancementMode: mode, paused, authorization: { granted: authorized, at: "2025-01-01T00:00:00Z", operator: "local-operator", reason: "case authorization" } });
    remaining.set(id, 3);
  }
  return { service, calls, remaining, cases, add, block() { release = () => {}; }, unblock() { release?.(); release = undefined; }, fail() { fail = true; } };
}

test("worker enumerates persisted automatic cases, bounds draining and excludes manual/legacy/gated cases", async () => {
  const h = harness();
  h.add("auto"); h.add("manual", "manual"); h.add("legacy");
  h.cases.set("legacy", { ...h.cases.get("legacy")!, advancementMode: undefined });
  h.add("paused", "automatic", true, true); h.add("denied", "automatic", false);
  const worker = new AutomaticInvestigationRunner(h.service, { maxActionsPerSweep: 2 });
  await worker.drain();
  assert.deepEqual(h.calls, ["auto", "auto"]);
  await worker.stop();
  const restarted = new AutomaticInvestigationRunner(h.service);
  await restarted.drain();
  assert.deepEqual(h.calls, ["auto", "auto", "auto"], "restart drains only remaining persisted work");
  h.cases.set("paused", { ...h.cases.get("paused")!, paused: false });
  await restarted.drain();
  assert.equal(h.remaining.get("paused"), 0);
  await restarted.stop();
});

test("overlapping sweeps share one dispatch and shutdown waits without claiming more work", async () => {
  const h = harness(); h.add("auto"); h.block();
  const worker = new AutomaticInvestigationRunner(h.service);
  const first = worker.drain();
  const second = worker.drain();
  while (h.calls.length === 0) await new Promise<void>((resolve) => setImmediate(resolve));
  let stopped = false;
  const stopping = worker.stop().then(() => { stopped = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  assert.equal(h.calls.length, 1);
  h.unblock();
  await Promise.all([first, second, stopping]);
  assert.equal(h.calls.length, 1);
  await worker.drain();
  assert.equal(h.calls.length, 1, "a stopped worker cannot claim again");
});

test("dispatch errors end that case's sweep without retry spin and are observable", async () => {
  const h = harness(); h.add("auto"); h.fail();
  const errors: unknown[] = [];
  const worker = new AutomaticInvestigationRunner(h.service, { onError: (error) => errors.push(error) });
  await worker.drain();
  assert.equal(h.calls.length, 1);
  assert.equal(errors.length, 1);
  await worker.stop();
});
