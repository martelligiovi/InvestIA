import assert from "node:assert/strict";
import test from "node:test";
import { createUserScannerBox, scannerArguments } from "../src/index.ts";

const seed = { kind: "email" as const, value: "person@example.org" };
const result = { status: "Registered", email: seed.value, site_name: "Github", category: "Dev", url: "https://github.com/user", reason: "", extra: {}, media: {} };

test("CLI uses every requested flag plus isolated JSON export, not a shell command", () => {
  assert.deepEqual(scannerArguments(seed.value, "report.json"), [
    "-B", "-m", "user_scanner", "-e", seed.value, "--allow-loud", "--cross-scan", "--cross-links", "all", "--cross-emails", "all", "--cross-depth", "2", "--cross-sweep", "25", "--verbose", "-f", "json", "-o", "report.json",
  ]);
});

test("SeedBox keeps all platforms, crossed emails, handles, URLs and metadata", async () => {
  const rows = [result, { ...result, email: "second@example.org", site_name: "Spotify", extra: { pivot_source: "address from Github", confidence: "candidate", public_email: "third@example.org" } },
    { ...result, email: undefined, username: "derived", status: "Found", site_name: "Other", media: { avatar: "https://example.org/avatar" } }];
  const calls: string[] = [];
  const box = createUserScannerBox({ async run(email) { calls.push(email); return JSON.stringify(rows); } });
  assert.equal(box.id, "user-scanner:email");
  assert.equal(box.inputKind, "email");
  const observations = await box.execute(seed);
  assert.deepEqual(calls, [seed.value]);
  assert.equal(observations.length, 3);
  assert.deepEqual(observations[1]?.finding.target, { kind: "email", value: "second@example.org" });
  assert.equal(observations[1]?.finding.extra.confidence, "candidate");
  assert.equal(observations[1]?.finding.extra.public_email, "third@example.org");
  assert.deepEqual(observations[2]?.finding.target, { kind: "username", value: "derived" });
  assert.equal(observations[2]?.finding.media.avatar, "https://example.org/avatar");
  assert.ok(observations.every((row) => row.seed.value === seed.value));
});

test("all upstream states remain factual, never inferred positives", async () => {
  const statuses = ["Registered", "Not Registered", "Found", "Not Found", "Error", "Skipped"];
  const box = createUserScannerBox({ async run() { return JSON.stringify(statuses.map((status) => ({ ...result, status }))); } });
  assert.deepEqual((await box.execute(seed)).map((row) => row.status), ["registered", "not_registered", "registered", "not_registered", "error", "unknown"]);
});

test("invalid inputs never spawn, invalid/missing reports and process failures reject", async () => {
  let calls = 0;
  const box = createUserScannerBox({ async run() { calls++; return "[]"; } });
  await assert.rejects(box.execute({ kind: "email", value: "bad; command" }));
  assert.equal(calls, 0);
  assert.deepEqual(await box.execute(seed), []);
  for (const payload of ["invalid", "{}", JSON.stringify([{ ...result, status: "maybe" }]), JSON.stringify([{ ...result, email: "bad" }]), JSON.stringify([result, {}])]) {
    await assert.rejects(createUserScannerBox({ async run() { return payload; } }).execute(seed), /report/i);
  }
  await assert.rejects(createUserScannerBox({ async run() { throw new Error("Process failed"); } }).execute(seed), /failed/i);
});
