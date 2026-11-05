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

test("filesystem failures are internal, keep only the errno code and do not disclose paths", async () => {
  await fake(async () => undefined, async (root, home) => {
    const runner = createGhuntProcessRunner({ sessionHome: home, outputDirectory: join(root, "secret-missing") });
    await assert.rejects(runner.run("ana@gmail.com"), (error: unknown) => {
      assert.ok(error instanceof GhuntProcessError);
      assert.equal(error.code, "internal_failure");
      assert.equal(error.message, "GHunt execution failed: internal_failure (ENOENT)");
      return true;
    });
  });
});

test("unclassified upstream failures record the exit code or signal but never the output", async () => {
  for (const [exit, signal, expected] of [[2, null, "(exit 2, no traceback)"], [null, "SIGTERM", "(signal SIGTERM, no traceback)"]] as const) {
    await fake(async (child) => { child.stderr.emit("data", Buffer.from("Traceback: secret\n")); child.emit("close", exit, signal); }, async (root, home) => {
      await assert.rejects(createGhuntProcessRunner({ sessionHome: home, outputDirectory: root }).run("ana@gmail.com"), (error: unknown) => {
        assert.ok(error instanceof GhuntProcessError);
        assert.equal(error.code, "process_failure");
        assert.equal(error.message, `GHunt execution failed: process_failure ${expected}`);
        return true;
      });
    });
  }
});

test("unclassified tracebacks record only the final exception name, never its message", async () => {
  const traceback = "Traceback (most recent call last):\n  File \"/opt/x.py\", line 3, in <module>\nKeyError: 'secret'\n\nDuring handling of the above exception, another exception occurred:\n\nTraceback (most recent call last):\n  File \"/opt/y.py\", line 9, in main\nhttpx.ReadTimeout: secret@gmail.com\n";
  for (const [output, expected] of [[traceback, "(exit 1, httpx.ReadTimeout)"], ["Traceback (most recent call last):\n  File \"/opt/x.py\"\nnot an identifier: secret\n", "(exit 1, unparsed traceback)"]] as const) {
    await fake(async (child) => { child.stderr.emit("data", Buffer.from(output)); child.emit("close", 1, null); }, async (root, home) => {
      await assert.rejects(createGhuntProcessRunner({ sessionHome: home, outputDirectory: root }).run("ana@gmail.com"), (error: unknown) => {
        assert.ok(error instanceof GhuntProcessError);
        assert.equal(error.code, "process_failure");
        assert.equal(error.message, `GHunt execution failed: process_failure ${expected}`);
        return true;
      });
    });
  }
});

test("structural diagnostics handle ANSI, split chunks and multiline exception messages", async () => {
  const output = "\u001b[31mTraceback (most recent call last):\u001b[0m\n  File \"/opt/venv-ghunt/lib/python3.11/site-packages/ghunt/ghunt.py\", line 42, in main\n    private_source(secret)\n\u001b[1mhttpx.ReadTimeout\u001b[0m: private_message\nKeyError: private_second_line\nprivate@gmail.com?token=private_token\n";
  await fake(async (child) => {
    for (let i = 0; i < output.length; i += 7) child.stderr.emit("data", Buffer.from(output.slice(i, i + 7)));
    child.emit("close", 1, null);
  }, async (root, home, child) => {
    await assert.rejects(createGhuntProcessRunner({ sessionHome: home, outputDirectory: root }).run("ana@gmail.com"), (error: unknown) => {
      assert.ok(error instanceof GhuntProcessError);
      assert.equal(error.code, "process_failure");
      assert.equal(error.detail, "exit 1, httpx.ReadTimeout, frames [ghunt/ghunt.py:42 in main]");
      assert.equal(error.message, `GHunt execution failed: process_failure (${error.detail})`);
      for (const secret of ["private_source", "private_message", "private_second_line", "private@gmail.com", "private_token"]) assert.ok(!error.message.includes(secret));
      return true;
    });
    assert.deepEqual(child.signals, []);
  });
});

test("a forged traceback header in an exception message can replace real diagnostic structure", async () => {
  const real = 'Traceback (most recent call last):\n  File "/opt/venv-ghunt/lib/python3.11/site-packages/ghunt/ghunt.py", line 7, in main\nKeyError: private_message\n';
  const cases = [
    ["Traceback (most recent call last):\nprivate_secret@gmail.com\n", "exit 1, unparsed traceback"],
    ['Traceback (most recent call last):\n  File "/opt/venv-ghunt/lib/python3.11/site-packages/ghunt/cli.py", line 123456, in main\nValueError: private_secret@gmail.com\n', "exit 1, ValueError, frames [ghunt/cli.py:123456 in main]"],
  ] as const;
  for (const [forged, expected] of cases) {
    await fake(async (child, _args, options) => {
      await writeFile(join(options.cwd, "report.json"), "private_report");
      child.stderr.emit("data", real + forged);
      child.emit("close", 1, null);
    }, async (root, home, child) => {
      await assert.rejects(createGhuntProcessRunner({ sessionHome: home, outputDirectory: root }).run("ana@gmail.com"), (error: unknown) => {
        assert.ok(error instanceof GhuntProcessError);
        assert.equal(error.code, "process_failure");
        assert.equal(error.detail, expected);
        assert.equal(error.message, `GHunt execution failed: process_failure (${expected})`);
        assert.ok(!error.message.includes("private"));
        return true;
      });
      assert.deepEqual(child.signals, []);
    });
  }
});

test("Python 3.11 ExceptionGroup falls back to an unparsed traceback without leaking output", async () => {
  const output = '  + Exception Group Traceback (most recent call last):\n  |   File "/opt/venv-ghunt/lib/python3.11/site-packages/ghunt/ghunt.py", line 7, in main\n  | ExceptionGroup: private_message (1 sub-exception)\n  +-+---------------- 1 ----------------\n    | ValueError: private_secret@gmail.com\n    +------------------------------------\n';
  await fake(async (child, _args, options) => {
    await writeFile(join(options.cwd, "report.json"), "private_report");
    child.stderr.emit("data", output);
    child.emit("close", 1, null);
  }, async (root, home, child) => {
    await assert.rejects(createGhuntProcessRunner({ sessionHome: home, outputDirectory: root }).run("ana@gmail.com"), (error: unknown) => {
      assert.ok(error instanceof GhuntProcessError);
      assert.equal(error.code, "process_failure");
      assert.equal(error.detail, "exit 1, unparsed traceback");
      assert.equal(error.message, "GHunt execution failed: process_failure (exit 1, unparsed traceback)");
      assert.ok(!error.message.includes("private"));
      return true;
    });
    assert.deepEqual(child.signals, []);
  });
});

test("stderr traceback survives interleaved trailing stdout beyond classification tail", async () => {
  await fake(async (child) => {
    child.stderr.emit("data", 'Traceback (most recent call last):\n  File "/opt/venv-ghunt/lib/python3.11/site-packages/ghunt/ghunt.py", line 7, in main\nValueError: private_value\n');
    child.stdout.emit("data", "private_stdout".repeat(1000));
    child.emit("close", 3, null);
  }, async (root, home) => {
    await assert.rejects(createGhuntProcessRunner({ sessionHome: home, outputDirectory: root }).run("ana@gmail.com"), (error: unknown) => {
      assert.ok(error instanceof GhuntProcessError);
      assert.equal(error.code, "process_failure");
      assert.equal(error.detail, "exit 3, ValueError, frames [ghunt/ghunt.py:7 in main]");
      assert.ok(!error.message.includes("private"));
      return true;
    });
  });
});

test("last chained exception and bounded frames omit unknown and spoofed private data", async () => {
  const frame = '  File "/opt/venv-ghunt/lib/python3.11/site-packages/ghunt/ghunt.py", line 42, in main\n    private_source\n';
  const output = 'Traceback (most recent call last):\n' + frame + 'KeyError: old_secret\n\nDuring handling of the above exception, another exception occurred:\n\nTraceback (most recent call last):\n' + frame.repeat(20)
    + '  File "/opt/venv-ghunt/lib/python3.11/site-packages/ghunt/private_secret.py", line 2, in main\n'
    + '  File "/tmp/private_secret/ghunt/ghunt.py", line 3, in main\n'
    + '  File "/opt/venv-ghunt/lib/python3.11/site-packages/ghunt/ghunt.py", line 4, in private_function\n'
    + 'PrivateException: private_value\n';
  await fake(async (child) => { child.stderr.emit("data", output); child.emit("close", 1, null); }, async (root, home) => {
    await assert.rejects(createGhuntProcessRunner({ sessionHome: home, outputDirectory: root }).run("ana@gmail.com"), (error: unknown) => {
      assert.ok(error instanceof GhuntProcessError);
      assert.equal(error.code, "process_failure");
      assert.equal(error.detail, `exit 1, unparsed traceback, frames [${Array(8).fill("ghunt/ghunt.py:42 in main").join("; ")}]`);
      assert.ok(error.detail.length < 512);
      assert.ok(!error.message.includes("private"));
      assert.ok(!error.message.includes("PrivateException"));
      assert.ok(!error.message.includes("KeyError"));
      return true;
    });
  });
});

test("a chained traceback records only the final exception's frames", async () => {
  const output = 'Traceback (most recent call last):\n  File "/opt/venv-ghunt/lib/python3.11/site-packages/ghunt/ghunt.py", line 1, in main\nKeyError: private_first\n\nThe above exception was the direct cause of the following exception:\n\nTraceback (most recent call last):\n  File "/opt/venv-ghunt/lib/python3.11/site-packages/httpx/_client.py", line 22, in send\nhttpx.ReadTimeout: private_final\n';
  await fake(async (child) => { child.stderr.emit("data", output); child.emit("close", 1, null); }, async (root, home) => {
    await assert.rejects(createGhuntProcessRunner({ sessionHome: home, outputDirectory: root }).run("ana@gmail.com"), (error: unknown) => {
      assert.ok(error instanceof GhuntProcessError);
      assert.equal(error.code, "process_failure");
      assert.equal(error.detail, "exit 1, httpx.ReadTimeout, frames [httpx/_client.py:22 in send]");
      assert.ok(!error.message.includes("private"));
      assert.ok(!error.message.includes("KeyError"));
      return true;
    });
  });
});

test("stdout fallback and unknown structural fields remain private", async () => {
  const output = 'Traceback (most recent call last):\n'
    + '  File "/opt/venv-ghunt/lib/python3.11/site-packages/ghunt/private_secret.py", line 2, in main\n'
    + '  File "/tmp/private_secret/ghunt/ghunt.py", line 3, in main\n'
    + '  File "/opt/venv-ghunt/lib/python3.11/site-packages/ghunt/ghunt.py", line 4, in private_function\n'
    + '  File "/opt/venv-ghunt/lib/python3.11/site-packages/ghunt/ghunt.py", line 5, in main\n'
    + 'PrivateException: private_value\n';
  await fake(async (child) => { child.stdout.emit("data", output); child.emit("close", 1, null); }, async (root, home) => {
    await assert.rejects(createGhuntProcessRunner({ sessionHome: home, outputDirectory: root }).run("ana@gmail.com"), (error: unknown) => {
      assert.ok(error instanceof GhuntProcessError);
      assert.equal(error.code, "process_failure");
      assert.equal(error.detail, "exit 1, unparsed traceback, frames [ghunt/ghunt.py:5 in main]");
      assert.ok(!error.message.includes("private"));
      assert.ok(!error.message.includes("PrivateException"));
      return true;
    });
  });
});

test("bounded traceback tail finds a long traceback and fails closed if its header is truncated", async () => {
  const header = "Traceback (most recent call last):\n";
  for (const [length, expected] of [[8000, "exit 1, KeyError"], [70000, "exit 1, no traceback"]] as const) {
    await fake(async (child) => { child.stderr.emit("data", header + "  private_source\n".repeat(length / 16) + "KeyError: private_value\n"); child.emit("close", 1, null); }, async (root, home) => {
      await assert.rejects(createGhuntProcessRunner({ sessionHome: home, outputDirectory: root }).run("ana@gmail.com"), (error: unknown) => {
        assert.ok(error instanceof GhuntProcessError);
        assert.equal(error.code, "process_failure");
        assert.equal(error.detail, expected);
        assert.ok(!error.message.includes("private"));
        return true;
      });
    });
  }
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

test("zero-exit upstream not-found messages without a report are classified as not_found", async () => {
  for (const message of ["[-] The target wasn't found.\n", "[-] Given information does not match a public Google Account.\n"]) {
    await fake(async (child) => { child.stdout.emit("data", Buffer.from(message)); child.emit("close", 0); }, async (root, home) => {
      await assert.rejects(createGhuntProcessRunner({ sessionHome: home, outputDirectory: root }).run("ana@gmail.com"), code("not_found"));
    });
  }
});

test("zero-exit not-found text does not override an existing report", async () => {
  await fake(async (child, _args, options) => {
    child.stdout.emit("data", "[-] The target wasn't found.\n");
    await writeFile(join(options.cwd, "report.json"), "{}");
    child.emit("close", 0);
  }, async (root, home) => {
    assert.equal(await createGhuntProcessRunner({ sessionHome: home, outputDirectory: root }).run("ana@gmail.com"), "{}");
  });
});

test("zero-exit not-found text does not turn an unsafe report into not_found", async () => {
  const original = filesystem.lstat;
  filesystem.lstat = (async (path: Parameters<typeof original>[0], ...args: unknown[]) => {
    if (String(path).endsWith("report.json")) return { isFile: () => false, isSymbolicLink: () => true };
    return original(path, ...args as []);
  }) as typeof original;
  syncBuiltinESMExports();
  try {
    await fake(async (child) => { child.stdout.emit("data", "[-] The target wasn't found.\n"); child.emit("close", 0); }, async (root, home) => {
      await assert.rejects(createGhuntProcessRunner({ sessionHome: home, outputDirectory: root }).run("ana@gmail.com"), code("missing_report"));
    });
  } finally { filesystem.lstat = original; syncBuiltinESMExports(); }
});

test("upstream session failures are classified as an invalid session", async () => {
  for (const message of ["ghunt.errors.GHuntInvalidSession: Please generate a new session by doing => ghunt login\n", "ghunt.errors.GHuntLoginError: [-] Can't generate cookies after multiple retries. Exiting...\n"]) {
    await fake(async (child) => { child.stdout.emit("data", "Traceback (most recent call last):\n"); child.stderr.emit("data", message); child.emit("close", 1); }, async (root, home) => {
      await assert.rejects(createGhuntProcessRunner({ sessionHome: home, outputDirectory: root }).run("ana@gmail.com"), code("invalid_session"));
    });
  }
});
