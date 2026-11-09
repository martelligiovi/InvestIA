import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGhuntProcessRunner, createGhuntSession, createSessionBoundRunner, GhuntProcessError, GhuntSessionError, GHUNT_LOGIN_SCRIPT, validCompanionCode } from "../src/index.ts";

const require = createRequire(import.meta.url);
const processes = require("node:child_process") as typeof import("node:child_process");
const code = Buffer.from(JSON.stringify({ oauth_token: "oauth2_4/secret-token" })).toString("base64");

class Child extends EventEmitter {
  stdout = new EventEmitter(); stderr = new EventEmitter(); signals: string[] = []; input = "";
  stdin = Object.assign(new EventEmitter(), { end: (value: string) => { this.input = value; } });
  kill(signal: string) { this.signals.push(signal); queueMicrotask(() => this.emit("close", null)); return true; }
}
interface Spawned { args: string[]; options: { cwd: string; shell: boolean; env: NodeJS.ProcessEnv }; child: Child }
async function withSpawn(action: (spawned: Spawned) => Promise<void>, check: (home: string, calls: Spawned[]) => Promise<void>) {
  const home = join(await mkdtemp(join(tmpdir(), "ghunt-session-")), "home");
  const original = processes.spawn;
  const calls: Spawned[] = [];
  processes.spawn = ((_: string, args: string[], options: Spawned["options"]) => {
    const spawned = { args, options, child: new Child() };
    calls.push(spawned);
    setImmediate(() => { void action(spawned).catch((error) => spawned.child.emit("error", error)); });
    return spawned.child;
  }) as unknown as typeof processes.spawn;
  syncBuiltinESMExports();
  try { await check(home, calls); }
  finally { processes.spawn = original; syncBuiltinESMExports(); await rm(join(home, ".."), { recursive: true, force: true }); }
}
async function succeed({ options, child }: Spawned) {
  const folder = join(options.env.HOME!, ".malfrats", "ghunt");
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "creds.m"), "stored-secret");
  child.stdout.emit("data", "Generating cookies...\nINVESTIA_GHUNT_ACCOUNT=\"owner@gmail.com\"\n");
  child.emit("close", 0);
}
const failsWith = (expected: string) => (error: unknown) => error instanceof GhuntSessionError && error.code === expected && !error.message.includes("secret");

test("companion codes must be base64 JSON carrying an OAuth token", () => {
  assert.equal(validCompanionCode(code), true);
  assert.equal(validCompanionCode(` ${code}\n`), true);
  for (const value of ["", "not base64!", Buffer.from("[]").toString("base64"), Buffer.from(JSON.stringify({ oauth_token: "aas_et/x" })).toString("base64"),
    Buffer.from(JSON.stringify({ oauth_token: "oauth2_4/a b" })).toString("base64"), "A".repeat(20_000), 42]) {
    assert.equal(validCompanionCode(value), false);
  }
});

test("a new home requires connection and invalid codes never spawn", async () => {
  await withSpawn(async () => { throw new Error("must not spawn"); }, async (home, calls) => {
    const session = createGhuntSession({ sessionHome: home });
    assert.deepEqual(await session.status(), { state: "requires_connection", account: null });
    await assert.rejects(session.connect("nope"), failsWith("invalid_code"));
    assert.equal(calls.length, 0);
  });
});

test("connect passes the code on stdin only and stores a private session", async () => {
  await withSpawn(succeed, async (home, calls) => {
    const session = createGhuntSession({ sessionHome: home });
    assert.deepEqual(await session.connect(code), { state: "connected", account: "owner@gmail.com" });
    const [{ args, options, child }] = calls;
    assert.deepEqual(args, ["-B", "-c", GHUNT_LOGIN_SCRIPT]);
    assert.equal(args.some((arg) => arg.includes("secret-token") || arg.includes(code)), false);
    assert.equal(child.input, code);
    assert.equal(options.shell, false);
    assert.notEqual(options.env.HOME, home);
    assert.equal(await readFile(join(home, ".malfrats", "ghunt", "creds.m"), "utf8"), "stored-secret");
    assert.deepEqual((await readdir(home)).filter((name) => name.startsWith(".connect-")), []);
    if (process.platform !== "win32") assert.equal((await stat(home)).mode & 0o777, 0o700);
  });
});

test("a rejected connection keeps the previous session and discloses nothing", async () => {
  let attempt = 0;
  await withSpawn(async (spawned) => {
    attempt += 1;
    if (attempt === 1) return succeed(spawned);
    spawned.child.stderr.emit("data", "GHuntAndroidMasterAuthError secret-token");
    spawned.child.emit("close", 1);
  }, async (home) => {
    const session = createGhuntSession({ sessionHome: home });
    await session.connect(code);
    await assert.rejects(session.connect(code), failsWith("rejected"));
    assert.deepEqual(await session.status(), { state: "connected", account: "owner@gmail.com" });
  });
});

test("a stalled login is killed", async () => {
  await withSpawn(async () => undefined, async (home, calls) => {
    await assert.rejects(createGhuntSession({ sessionHome: home, timeoutMs: 5 }).connect(code), failsWith("timeout"));
    assert.deepEqual(calls[0]!.child.signals, ["SIGKILL"]);
  });
});

test("an upstream session rejection marks the session invalid until reconnection or disconnect", async () => {
  await withSpawn(succeed, async (home) => {
    const session = createGhuntSession({ sessionHome: home });
    await session.connect(code);
    const runner = createSessionBoundRunner(session, { async run() { throw new GhuntProcessError("invalid_session"); } });
    await assert.rejects(runner.run("ana@gmail.com"), (error: unknown) => error instanceof GhuntProcessError && error.code === "invalid_session");
    assert.deepEqual(await session.status(), { state: "invalid_session", account: "owner@gmail.com" });
    assert.deepEqual(await session.connect(code), { state: "connected", account: "owner@gmail.com" });
    await createSessionBoundRunner(session, { async run() { throw new GhuntProcessError("invalid_session"); } }).run("ana@gmail.com").catch(() => undefined);
    assert.deepEqual(await session.disconnect(), { state: "requires_connection", account: null });
    assert.deepEqual((await readdir(home)).filter((name) => name !== ".malfrats"), []);
    await assert.rejects(stat(join(home, ".malfrats", "ghunt", "creds.m")));
  });
});

test("network timeout after a retry leaves the connected session unchanged", async () => {
  let scans = 0;
  await withSpawn(async (spawned) => {
    if (spawned.args[2] === GHUNT_LOGIN_SCRIPT) return succeed(spawned);
    scans++;
    spawned.child.stderr.emit("data", "Traceback (most recent call last):\nhttpx.ConnectTimeout: secret\n");
    spawned.child.emit("close", 1);
  }, async (home) => {
    const session = createGhuntSession({ sessionHome: home });
    await session.connect(code);
    const runner = createSessionBoundRunner(session, createGhuntProcessRunner({ sessionHome: home, outputDirectory: tmpdir(), retryDelayMs: 0 }));
    await assert.rejects(runner.run("ana@gmail.com"), (error: unknown) => error instanceof GhuntProcessError && error.code === "network_timeout");
    assert.equal(scans, 2);
    assert.deepEqual(await session.status(), { state: "connected", account: "owner@gmail.com" });
  });
});

test("scans and session changes never overlap", async () => {
  await withSpawn(succeed, async (home) => {
    const session = createGhuntSession({ sessionHome: home });
    await session.connect(code);
    const order: string[] = [];
    let release!: () => void;
    const runner = createSessionBoundRunner(session, { async run() { order.push("scan-start"); await new Promise<void>((done) => { release = done; }); order.push("scan-end"); return "{}"; } });
    const scan = runner.run("ana@gmail.com");
    await new Promise((done) => setImmediate(done));
    const disconnect = session.disconnect().then(() => order.push("disconnect"));
    await new Promise((done) => setImmediate(done));
    release();
    await Promise.all([scan, disconnect]);
    assert.deepEqual(order, ["scan-start", "scan-end", "disconnect"]);
  });
});

test("a failure while promoting the new session keeps the previous one", async () => {
  const filesystem = require("node:fs/promises") as typeof import("node:fs/promises");
  await withSpawn(succeed, async (home) => {
    const session = createGhuntSession({ sessionHome: home });
    await session.connect(code);
    const original = filesystem.rename;
    filesystem.rename = (async () => { throw Object.assign(new Error("secret EIO"), { code: "EIO" }); }) as typeof original;
    syncBuiltinESMExports();
    try { await assert.rejects(session.connect(code)); }
    finally { filesystem.rename = original; syncBuiltinESMExports(); }
    assert.deepEqual(await session.status(), { state: "connected", account: "owner@gmail.com" });
    assert.equal(await readFile(join(home, ".malfrats", "ghunt", "creds.m"), "utf8"), "stored-secret");
  });
});
