import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createRequire, syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { createHoleheProcessRunner, HoleheProcessError } from "../src/index.ts";

const require = createRequire(import.meta.url);
const childProcess = require("node:child_process") as typeof import("node:child_process");

class FakeStream extends EventEmitter {
  resume(): this {
    return this;
  }
}

class FakeChild extends EventEmitter {
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();
  readonly killSignals: Array<NodeJS.Signals | number | undefined> = [];

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killSignals.push(signal);
    return true;
  }
}

async function withFakeSpawn<T>(child: FakeChild, run: () => Promise<T>): Promise<T> {
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = (() => child as unknown as ChildProcess) as typeof childProcess.spawn;
  syncBuiltinESMExports();
  try {
    return await run();
  } finally {
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
  }
}

function hasProcessError(code: HoleheProcessError["code"]) {
  return (error: unknown): boolean => error instanceof HoleheProcessError && error.code === code;
}

test("returns stdout after a successful process close", async () => {
  const child = new FakeChild();
  await withFakeSpawn(child, async () => {
    const result = createHoleheProcessRunner().run("github", "person@example.org");
    child.stdout.emit("data", Buffer.from("bridge response"));
    child.emit("close", 0, null);
    assert.equal(await result, "bridge response");
  });
});

test("accepts output whose UTF-8 byte length is exactly the configured limit", async () => {
  const child = new FakeChild();
  await withFakeSpawn(child, async () => {
    const result = createHoleheProcessRunner({ maxOutputBytes: 3 }).run("github", "person@example.org");
    child.stdout.emit("data", Buffer.from([0xe2, 0x82]));
    child.stdout.emit("data", Buffer.from([0xac]));
    child.emit("close", 0, null);
    assert.equal(await result, "€");
  });
});

test("kills and rejects output exceeding the configured byte limit", async () => {
  const child = new FakeChild();
  await withFakeSpawn(child, async () => {
    const result = createHoleheProcessRunner({ maxOutputBytes: 3 }).run("github", "person@example.org");
    child.stdout.emit("data", Buffer.from("1234"));
    await assert.rejects(result, hasProcessError("output_limit"));
    assert.deepEqual(child.killSignals, ["SIGKILL"]);
    child.emit("close", null, "SIGKILL");
  });
});

test("kills and rejects a process that exceeds its timeout", async () => {
  const child = new FakeChild();
  await withFakeSpawn(child, async () => {
    const result = createHoleheProcessRunner({ timeoutMs: 5 }).run("github", "person@example.org");
    await assert.rejects(result, hasProcessError("timeout"));
    assert.deepEqual(child.killSignals, ["SIGKILL"]);
  });
});

test("preserves timeout settlement when late child events arrive", async () => {
  const child = new FakeChild();
  await withFakeSpawn(child, async () => {
    const result = createHoleheProcessRunner({ timeoutMs: 5 }).run("github", "person@example.org");
    const settled = result.then(
      () => assert.fail("expected timeout rejection"),
      (error: unknown) => error,
    );
    const timeoutError = await settled;
    assert(timeoutError instanceof HoleheProcessError);
    assert.equal(timeoutError.code, "timeout");

    child.emit("close", 0, null);
    child.emit("error", new Error("late child error"));
    child.stdout.emit("data", Buffer.from("late output"));
    assert.equal(await settled, timeoutError);
  });
});

test("maps a child spawn error to spawn_failure", async () => {
  const child = new FakeChild();
  await withFakeSpawn(child, async () => {
    const result = createHoleheProcessRunner().run("github", "person@example.org");
    child.emit("error", new Error("python unavailable"));
    await assert.rejects(result, hasProcessError("spawn_failure"));
    child.emit("close", -2, null);
  });
});

test("maps a nonzero process exit to process_failure", async () => {
  const child = new FakeChild();
  await withFakeSpawn(child, async () => {
    const result = createHoleheProcessRunner().run("github", "person@example.org");
    child.emit("close", 7, null);
    await assert.rejects(result, hasProcessError("process_failure"));
  });
});
