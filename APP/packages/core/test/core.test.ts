import assert from "node:assert/strict";
import test from "node:test";
import {
  ExecutionDeniedError,
  executeSeedBox,
  type EmailSeed,
  type RegistrationObservation,
  type SeedBox,
  type ExecutionState,
} from "../src/index.ts";

const seed: EmailSeed = { kind: "email", value: "person@example.org" };
const observation: RegistrationObservation = {
  kind: "registration",
  seed,
  provider: "github",
  status: "registered",
};

function makeBox(onExecute: () => void): SeedBox<EmailSeed, RegistrationObservation> {
  return {
    id: "test-box",
    inputKind: "email",
    async execute() {
      onExecute();
      return [observation];
    },
  };
}

test("requires explicit authorization before invoking a box", async () => {
  let invoked = false;
  await assert.rejects(
    executeSeedBox(makeBox(() => { invoked = true; }), seed, {
      authorized: false,
      approved: true,
      paused: false,
    }),
    (error: unknown) => error instanceof ExecutionDeniedError && error.code === "unauthorized",
  );
  assert.equal(invoked, false);
});

test("requires approval before invoking a box", async () => {
  let invoked = false;
  await assert.rejects(
    executeSeedBox(makeBox(() => { invoked = true; }), seed, {
      authorized: true,
      approved: false,
      paused: false,
    }),
    (error: unknown) => error instanceof ExecutionDeniedError && error.code === "unapproved",
  );
  assert.equal(invoked, false);
});

test("a paused execution cannot invoke a box", async () => {
  let invoked = false;
  await assert.rejects(
    executeSeedBox(makeBox(() => { invoked = true; }), seed, {
      authorized: true,
      approved: true,
      paused: true,
    }),
    (error: unknown) => error instanceof ExecutionDeniedError && error.code === "paused",
  );
  assert.equal(invoked, false);
});

test("fails closed when authorization, approval, or unpaused state is not explicit", async () => {
  const invalidStates = [
    [{ authorized: true, approved: true, paused: undefined }, "paused"],
    [{ authorized: "yes", approved: true, paused: false }, "unauthorized"],
    [{ authorized: true, approved: 1, paused: false }, "unapproved"],
  ] as const;

  for (const [state, code] of invalidStates) {
    let invoked = false;
    await assert.rejects(
      executeSeedBox(makeBox(() => { invoked = true; }), seed, state as unknown as ExecutionState),
      (error: unknown) => error instanceof ExecutionDeniedError && error.code === code,
    );
    assert.equal(invoked, false);
  }
});

test("executes and returns observations only when all gates are clear", async () => {
  let invoked = false;
  const result = await executeSeedBox(makeBox(() => { invoked = true; }), seed, {
    authorized: true,
    approved: true,
    paused: false,
  });
  assert.equal(invoked, true);
  assert.deepEqual(result, [observation]);
});
