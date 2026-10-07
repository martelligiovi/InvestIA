import assert from "node:assert/strict";
import test from "node:test";
import { createHoleheBox, type HoleheRunner } from "../src/index.ts";

const response = (status: string) => JSON.stringify({ contract_version: 1, status });

function fakeRunner(payload: string, calls: string[][] = []): HoleheRunner {
  return {
    async run(moduleName, email) {
      calls.push([moduleName, email]);
      return payload;
    },
  };
}

test("maps bridge outcomes to registration observations without identity data", async () => {
  const cases = [
    ["registered", "registered"],
    ["not_registered", "not_registered"],
    ["rate_limited", "rate_limited"],
    ["error", "error"],
    ["unknown", "unknown"],
  ] as const;

  for (const [bridgeStatus, expected] of cases) {
    const box = createHoleheBox(fakeRunner(response(bridgeStatus)));
    const [observation] = await box.execute({ kind: "email", value: "person@example.org" });
    assert.deepEqual(observation, {
      kind: "registration",
      seed: { kind: "email", value: "person@example.org" },
      provider: "github",
      status: expected,
    });
    assert.equal("profileUrl" in observation, false);
  }
});

test("uses the explicit github module and passes the email as data", async () => {
  const calls: string[][] = [];
  const box = createHoleheBox(fakeRunner(response("unknown"), calls));
  await box.execute({ kind: "email", value: "person@example.org" });
  assert.deepEqual(calls, [["github", "person@example.org"]]);
});

test("turns malformed bridge JSON into an error observation", async () => {
  const box = createHoleheBox(fakeRunner("not-json"));
  const [observation] = await box.execute({ kind: "email", value: "person@example.org" });
  assert.equal(observation.status, "error");
});

test("turns an unsupported bridge contract version into an error observation", async () => {
  const box = createHoleheBox(fakeRunner(JSON.stringify({ contract_version: 2, status: "registered" })));
  const [observation] = await box.execute({ kind: "email", value: "person@example.org" });
  assert.equal(observation.status, "error");
});

test("turns a rejected runner into an error observation", async () => {
  const box = createHoleheBox({
    async run() {
      throw new Error("runner failed");
    },
  });
  const [observation] = await box.execute({ kind: "email", value: "person@example.org" });
  assert.equal(observation.status, "error");
});

test("validates email at the adapter boundary before running Holehe", async () => {
  let called = false;
  const runner: HoleheRunner = {
    async run() {
      called = true;
      return response("registered");
    },
  };
  const box = createHoleheBox(runner);
  await assert.rejects(box.execute({ kind: "email", value: "not-an-email" }));
  assert.equal(called, false);
});
