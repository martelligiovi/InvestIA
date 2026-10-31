import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { createMaigretProcessRunner, MaigretProcessError, maigretArguments } from "../src/index.ts";

const require = createRequire(import.meta.url);
const processes = require("node:child_process") as typeof import("node:child_process");
class Child extends EventEmitter {
  stdout = new EventEmitter(); stderr = new EventEmitter(); signals: unknown[] = [];
  kill(signal: unknown) { this.signals.push(signal); queueMicrotask(() => this.emit("close", null)); return true; }
}
interface SpawnOptions { readonly shell: boolean; readonly cwd: string }

async function fake(run: (child: Child, args: string[], options: SpawnOptions) => Promise<void>, check: (root: string, child: Child) => Promise<void>) {
  const root = await mkdtemp(resolve(".maigret-test-"));
  const original = processes.spawn;
  const child = new Child();
  processes.spawn = ((_: string, args: string[], options: SpawnOptions) => {
    queueMicrotask(() => { void run(child, args, options).catch((error) => child.emit("error", error)); });
    return child;
  }) as unknown as typeof processes.spawn;
  syncBuiltinESMExports();
  try { await check(root, child); assert.deepEqual(await readdir(root), [], "private per-run files are removed"); }
  finally { processes.spawn = original; syncBuiltinESMExports(); await rm(root, { recursive: true, force: true }); }
}
function code(expected: string) { return (error: unknown) => error instanceof MaigretProcessError && error.code === expected; }
function folderOf(args: string[]): string { return args[args.indexOf("--folderoutput") + 1]!; }

test("arguments pin a bounded, non-recursive, non-updating scan with a JSON report", () => {
  assert.deepEqual(maigretArguments("anaexample", "/tmp/run"), [
    "-B", "-m", "maigret", "anaexample", "--json", "simple", "--folderoutput", "/tmp/run",
    "--top-sites", "500", "--timeout", "30", "--retries", "1",
    "--no-recursion", "--no-autoupdate", "--no-color", "--no-progressbar",
  ]);
});

test("successful runner uses exact arguments, no shell, a private working directory and reads the report", async () => {
  const folders: string[] = [];
  await fake(async (child, args, options) => {
    const folder = folderOf(args);
    assert.deepEqual(args, maigretArguments("anaexample", folder));
    assert.equal(options.shell, false);
    assert.equal(options.cwd, folder, "stray files stay inside the private run directory");
    folders.push(folder);
    await writeFile(join(folder, "report_anaexample_simple.json"), "{}");
    child.emit("close", 0);
  }, async (root) => {
    const runner = createMaigretProcessRunner({ outputDirectory: root });
    assert.equal(await runner.run("anaexample"), "{}");
    assert.equal(await runner.run("anaexample"), "{}");
    assert.notEqual(folders[0], folders[1]);
  });
});

test("process failures, missing or linked reports and oversized output fail closed", async () => {
  await fake(async (child) => { child.emit("close", 2); }, async (root) => {
    await assert.rejects(createMaigretProcessRunner({ outputDirectory: root }).run("anaexample"), code("process_failure"));
  });
  await fake(async (child) => { child.emit("close", 0); }, async (root) => {
    await assert.rejects(createMaigretProcessRunner({ outputDirectory: root }).run("anaexample"), code("missing_report"));
  });
  await fake(async (child, args) => {
    const outside = join(folderOf(args), "..", "outside.json");
    await writeFile(outside, "{}");
    await symlink(outside, join(folderOf(args), "report_anaexample_simple.json")).catch(() => writeFile(join(folderOf(args), "report_anaexample_simple.json"), "x".repeat(64)));
    await rm(outside, { force: true });
    child.emit("close", 0);
  }, async (root) => {
    await assert.rejects(createMaigretProcessRunner({ outputDirectory: root, maxOutputBytes: 32 }).run("anaexample"), (error) =>
      code("missing_report")(error) || code("output_limit")(error));
  });
  await fake(async (child) => { child.stdout.emit("data", Buffer.alloc(64)); }, async (root, child) => {
    await assert.rejects(createMaigretProcessRunner({ outputDirectory: root, maxOutputBytes: 32 }).run("anaexample"), code("output_limit"));
    assert.deepEqual(child.signals, ["SIGKILL"]);
  });
});

test("a stalled scan is killed at the timeout", async () => {
  await fake(async () => undefined, async (root, child) => {
    await assert.rejects(createMaigretProcessRunner({ outputDirectory: root, timeoutMs: 10 }).run("anaexample"), code("timeout"));
    assert.deepEqual(child.signals, ["SIGKILL"]);
  });
});

test("an unsafe username never spawns a process", async () => {
  let spawned = false;
  await fake(async () => { spawned = true; }, async (root) => {
    await assert.rejects(createMaigretProcessRunner({ outputDirectory: root }).run("--help"));
  });
  assert.equal(spawned, false);
});
