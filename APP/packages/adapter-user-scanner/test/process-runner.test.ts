import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import test from "node:test";
import { createUserScannerProcessRunner, ScannerProcessError, scannerArguments } from "../src/index.ts";

const require = createRequire(import.meta.url);
const processes = require("node:child_process") as typeof import("node:child_process");
class Child extends EventEmitter {
  stdout = new EventEmitter(); stderr = new EventEmitter(); signals: unknown[] = [];
  kill(signal: unknown) { this.signals.push(signal); queueMicrotask(() => this.emit("close", null)); return true; }
}
async function fake(run: (child: Child, args: string[], options: unknown) => Promise<void>, check: (root: string, child: Child) => Promise<void>) {
  const root = await mkdtemp(resolve(".scanner-test-"));
  const original = processes.spawn;
  const child = new Child();
  processes.spawn = ((_: string, args: string[], options: unknown) => {
    queueMicrotask(() => { void run(child, args, options).catch((error) => child.emit("error", error)); });
    return child;
  }) as unknown as typeof processes.spawn;
  syncBuiltinESMExports();
  try { await check(root, child); assert.deepEqual(await readdir(root), [], "private per-run files are removed"); }
  finally { processes.spawn = original; syncBuiltinESMExports(); await rm(root, { recursive: true, force: true }); }
}
function code(expected: string) { return (error: unknown) => error instanceof ScannerProcessError && error.code === expected; }

test("successful runner uses exact arguments, no shell, and a unique report file", async () => {
  const paths: string[] = [];
  await fake(async (child, args, options) => {
    const path = args.at(-1)!;
    assert.deepEqual(args, scannerArguments("person@example.org", path));
    assert.equal((options as { shell: boolean }).shell, false);
    paths.push(path); await writeFile(path, "[]"); child.emit("close", 0);
  }, async (root) => {
    const runner = createUserScannerProcessRunner({ outputDirectory: root });
    assert.equal(await runner.run("person@example.org"), "[]");
    assert.equal(await runner.run("person@example.org"), "[]");
    assert.notEqual(paths[0], paths[1]);
  });
});

test("success exit without JSON report is not a successful scan", async () => {
  await fake(async (child) => { child.stdout.emit("data", "verbose successful-looking output"); child.emit("close", 0); }, async (root) => {
    await assert.rejects(createUserScannerProcessRunner({ outputDirectory: root }).run("person@example.org"), code("missing_report"));
  });
});

for (const [label, event, expected] of [["spawn error", "error", "spawn_failure"], ["nonzero exit", "close", "process_failure"]] as const) {
  test(label + " is sanitized", async () => {
    await fake(async (child) => { child.emit(event, event === "error" ? new Error("person@example.org secret") : 7); }, async (root) => {
      await assert.rejects(createUserScannerProcessRunner({ outputDirectory: root }).run("person@example.org"), (error: unknown) => code(expected)(error) && !String(error).includes("person@example.org"));
    });
  });
}

test("timeout kills, rejects and removes files without retry", async () => {
  await fake(async () => {}, async (root, child) => {
    await assert.rejects(createUserScannerProcessRunner({ outputDirectory: root, timeoutMs: 5 }).run("person@example.org"), code("timeout"));
    assert.deepEqual(child.signals, ["SIGKILL"]);
  });
});

test("UTF-8 report byte limit accepts the exact boundary and rejects excess", async () => {
  await fake(async (child, args) => { await writeFile(args.at(-1)!, "€"); child.emit("close", 0); }, async (root) => {
    assert.equal(await createUserScannerProcessRunner({ outputDirectory: root, maxOutputBytes: 3 }).run("person@example.org"), "€");
    await assert.rejects(createUserScannerProcessRunner({ outputDirectory: root, maxOutputBytes: 2 }).run("person@example.org"), code("output_limit"));
  });
});

test("diagnostic limit counts stdout and stderr together without retaining either", async () => {
  await fake(async (child) => { child.stdout.emit("data", "12"); child.stderr.emit("data", "34"); }, async (root, child) => {
    await assert.rejects(createUserScannerProcessRunner({ outputDirectory: root, maxOutputBytes: 3 }).run("person@example.org"), code("output_limit"));
    assert.deepEqual(child.signals, ["SIGKILL"]);
  });
});

test("invalid email and nonpositive limits are rejected before spawn", async () => {
  assert.throws(() => createUserScannerProcessRunner({ timeoutMs: 0 }), RangeError);
  assert.throws(() => createUserScannerProcessRunner({ maxOutputBytes: 0 }), RangeError);
  await assert.rejects(createUserScannerProcessRunner().run("not an email"), /valid email/);
});
