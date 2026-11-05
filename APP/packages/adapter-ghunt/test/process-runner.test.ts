import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { chmod, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGhuntProcessRunner, GhuntProcessError, ghuntArguments } from "../src/index.ts";

const require = createRequire(import.meta.url);
const processes = require("node:child_process") as typeof import("node:child_process");
const filesystem = require("node:fs/promises") as typeof import("node:fs/promises");
class Child extends EventEmitter {
  stdout = new EventEmitter(); stderr = new EventEmitter(); signals: string[] = [];
  kill(signal: string) { this.signals.push(signal); queueMicrotask(() => this.emit("close", null)); return true; }
}
interface SpawnOptions { cwd: string; shell: boolean; env: NodeJS.ProcessEnv }
async function fake(action: (child: Child, args: string[], options: SpawnOptions) => Promise<void>, check: (root: string, home: string, child: Child) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "ghunt-test-"));
  const home = await mkdtemp(join(tmpdir(), "ghunt-home-"));
  const original = processes.spawn;
  const child = new Child();
  processes.spawn = ((_: string, args: string[], options: SpawnOptions) => {
    queueMicrotask(() => { void action(child, args, options).catch((error) => child.emit("error", error)); });
    return child;
  }) as unknown as typeof processes.spawn;
  syncBuiltinESMExports();
  try { await check(root, home, child); assert.deepEqual(await readdir(root), []); }
  finally { processes.spawn = original; syncBuiltinESMExports(); await rm(root, { recursive: true, force: true }); await rm(home, { recursive: true, force: true }); }
}
const code = (expected: string) => (error: unknown) => error instanceof GhuntProcessError && error.code === expected && !error.message.includes("secret");

test("CLI uses main(), a positional email and explicit JSON path without a shell", async () => {
  await fake(async (child, args, options) => {
    assert.deepEqual(args, ghuntArguments("ana@gmail.com", join(options.cwd, "report.json")));
    assert.deepEqual(args.slice(0, 3), ["-B", "-c", "from ghunt.ghunt import main; main()"]);
    assert.deepEqual(args.slice(3), ["email", "--json", join(options.cwd, "report.json"), "--", "ana@gmail.com"]);
    assert.equal(options.shell, false);
    assert.notEqual(options.env.HOME, options.cwd);
    await writeFile(join(options.cwd, "report.json"), "{}");
    child.emit("close", 0);
  }, async (root, home) => {
    assert.equal(await createGhuntProcessRunner({ sessionHome: home, outputDirectory: root }).run("ana@gmail.com"), "{}");
  });
});

test("explicit persistent session home is supplied and never placed in a run directory", async () => {
  await fake(async (child, _args, options) => {
    assert.equal(options.env.HOME, expectedHome);
    assert.equal(options.env.USERPROFILE, expectedHome);
    child.emit("close", 0);
  }, async (root, home) => {
    expectedHome = home;
    await assert.rejects(createGhuntProcessRunner({ sessionHome: home, outputDirectory: root }).run("ana@gmail.com"), code("missing_report"));
  });
});
let expectedHome = "";

test("zero exit with no report is an explicit error, nonzero and spawn errors are generic", async () => {
  for (const [event, expected] of [["missing", "missing_report"], ["nonzero", "process_failure"], ["spawn", "spawn_failure"]]) {
    await fake(async (child) => {
      if (event === "spawn") child.emit("error", new Error("secret"));
      else child.emit("close", event === "missing" ? 0 : 1);
    }, async (root, home) => {
      await assert.rejects(createGhuntProcessRunner({ sessionHome: home, outputDirectory: root }).run("ana@gmail.com"), code(expected!));
    });
  }
});

test("unsafe targets do not spawn and limits kill without retaining output", async () => {
  let spawned = false;
  await fake(async (child) => { spawned = true; child.stderr.emit("data", Buffer.from("secret".repeat(20))); }, async (root, home, child) => {
    const runner = createGhuntProcessRunner({ sessionHome: home, outputDirectory: root, maxOutputBytes: 16 });
    await assert.rejects(runner.run("a@evil.com"));
    assert.equal(spawned, false);
    await assert.rejects(runner.run("ana@gmail.com"), code("output_limit"));
    assert.deepEqual(child.signals, ["SIGKILL"]);
  });
});

test("option-like service seeds are passed after the option terminator", async () => {
  await fake(async (child, args, options) => {
    assert.deepEqual(args.slice(-2), ["--", "--help@gmail.com"]);
    await writeFile(join(options.cwd, "report.json"), "{}");
    child.emit("close", 0);
  }, async (root, home) => {
    assert.equal(await createGhuntProcessRunner({ sessionHome: home, outputDirectory: root }).run("--help@gmail.com"), "{}");
  });
});

test("oversized report fails closed and is cleaned without disclosing contents", async () => {
  await fake(async (child, _args, options) => {
    await writeFile(join(options.cwd, "report.json"), "secret".repeat(20));
    child.emit("close", 0);
  }, async (root, home) => {
    await assert.rejects(createGhuntProcessRunner({ sessionHome: home, outputDirectory: root, maxOutputBytes: 16 }).run("ana@gmail.com"), code("output_limit"));
  });
});

test("linked report fails closed without accessing its target", async (t) => {
  let unavailable = false;
  await fake(async (child, _args, options) => {
    try { await symlink(join(options.env.HOME!, "secret-target"), join(options.cwd, "report.json")); }
    catch (error) {
      if (["EPERM", "EACCES", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) { unavailable = true; t.skip("symlink creation unavailable"); child.emit("close", 0); return; }
      throw error;
    }
    child.emit("close", 0);
  }, async (root, home) => {
    await writeFile(join(home, "secret-target"), "secret");
    await assert.rejects(createGhuntProcessRunner({ sessionHome: home, outputDirectory: root }).run("ana@gmail.com"), code("missing_report"));
    if (unavailable) return;
  });
});

test("a reported symbolic link is rejected even where real symlinks cannot be created", async () => {
  const original = filesystem.lstat;
  filesystem.lstat = (async (path: Parameters<typeof original>[0], ...args: unknown[]) => {
    if (String(path).endsWith("report.json")) return { isFile: () => false, isSymbolicLink: () => true };
    return original(path, ...args as []);
  }) as typeof original;
  syncBuiltinESMExports();
  try {
    await fake(async (child) => { child.emit("close", 0); }, async (root, home) => {
      await assert.rejects(createGhuntProcessRunner({ sessionHome: home, outputDirectory: root }).run("ana@gmail.com"), code("missing_report"));
    });
  } finally { filesystem.lstat = original; syncBuiltinESMExports(); }
});

test("POSIX credential home must be owner-only", { skip: process.platform === "win32" ? "Windows mode bits do not establish ACL privacy" : false }, async () => {
  await fake(async () => { throw new Error("must not spawn"); }, async (root, home) => {
    await chmod(home, 0o755);
    await assert.rejects(createGhuntProcessRunner({ sessionHome: home, outputDirectory: root }).run("ana@gmail.com"), code("invalid_session_home"));
  });
});

test("filesystem failures do not disclose paths or sensitive details", async () => {
  await fake(async () => undefined, async (root, home) => {
    const runner = createGhuntProcessRunner({ sessionHome: home, outputDirectory: join(root, "secret-missing") });
    await assert.rejects(runner.run("ana@gmail.com"), code("process_failure"));
  });
});

test("timeout terminates a stalled child", async () => {
  await fake(async () => undefined, async (root, home, child) => {
    await assert.rejects(createGhuntProcessRunner({ sessionHome: home, outputDirectory: root, timeoutMs: 5 }).run("ana@gmail.com"), code("timeout"));
    assert.deepEqual(child.signals, ["SIGKILL"]);
  });
});

test("upstream not-found exits are classified without disclosing output", async () => {
  for (const message of ["[-] The target wasn't found.\n", "[-] Given information does not match a public Google Account.\n"]) {
    await fake(async (child) => { child.stderr.emit("data", Buffer.from(message)); child.emit("close", 1); }, async (root, home) => {
      await assert.rejects(createGhuntProcessRunner({ sessionHome: home, outputDirectory: root }).run("ana@gmail.com"), code("not_found"));
    });
  }
});

test("upstream session failures are classified as an invalid session", async () => {
  for (const message of ["ghunt.errors.GHuntInvalidSession: Please generate a new session by doing => ghunt login\n", "ghunt.errors.GHuntLoginError: [-] Can't generate cookies after multiple retries. Exiting...\n"]) {
    await fake(async (child) => { child.stdout.emit("data", "Traceback (most recent call last):\n"); child.stderr.emit("data", message); child.emit("close", 1); }, async (root, home) => {
      await assert.rejects(createGhuntProcessRunner({ sessionHome: home, outputDirectory: root }).run("ana@gmail.com"), code("invalid_session"));
    });
  }
});
