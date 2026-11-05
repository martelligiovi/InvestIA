import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createGhuntBox, GhuntProcessError } from "../src/index.ts";

const email = { kind: "email", value: "Ana@GMAIL.COM" } as const;
const profile = { PROFILE_CONTAINER: { profile: {
  personId: "123", names: { PROFILE: { fullname: "Ana Example", token: "secret" } },
  profilePhotos: { PROFILE: { url: "https://images.example/photo", isDefault: false } },
  access_token: "secret", private: { value: "secret" },
}, maps: { secret: "secret" }, calendar: { secret: "secret" } } };

test("found profile becomes an allowlisted email finding", async () => {
  const seen: string[] = [];
  const box = createGhuntBox({ async run(value: string) { seen.push(value); return JSON.stringify(profile); } });
  assert.equal(box.id, "ghunt:email");
  assert.equal(box.inputKind, "email");
  assert.deepEqual(await box.execute(email), [{
    kind: "scanner_finding", seed: email, provider: "GHunt", status: "registered",
    finding: { target: email, upstreamStatus: "Found", url: "", category: "Profile", reason: "",
      extra: { source: "ghunt public profile", person_id: "123", fullname: "Ana Example" },
      media: { avatar: "https://images.example/photo" } },
  }]);
  assert.deepEqual(seen, [email.value]);
});

test("only exact case-insensitive Gmail domains and safe local parts reach the runner", async () => {
  const seen: string[] = [];
  const box = createGhuntBox({ async run(value: string) { seen.push(value); return JSON.stringify(profile); } });
  await box.execute({ kind: "email", value: "  ana@GoogleMail.Com  " });
  for (const value of ["a@xgmail.com", "a@gmail.com.evil", "a@example.com", "a b@gmail.com", "a@@gmail.com", "a/b@gmail.com", "a;id@gmail.com", "@gmail.com"]) {
    await assert.rejects(box.execute({ kind: "email", value }));
  }
  await assert.rejects(box.execute({ kind: "username", value: "ana@gmail.com" } as never));
  assert.deepEqual(seen, ["ana@GoogleMail.Com"]);
});

test("service-compatible Gmail local parts remain valid", async () => {
  const seen: string[] = [];
  const box = createGhuntBox({ async run(value: string) { seen.push(value); return JSON.stringify(profile); } });
  const values = ["'ana@gmail.com", "_ana@googlemail.com", "+ana@gmail.com", "--help@gmail.com", `${"a".repeat(260)}@gmail.com`];
  for (const value of values) await box.execute({ kind: "email", value });
  assert.deepEqual(seen, values);
});

test("malformed and unproven reports never create positive findings or leak report contents", async () => {
  for (const raw of ["secret not json", "{}", "[]", JSON.stringify({ PROFILE_CONTAINER: { profile: null } }), JSON.stringify({ PROFILE_CONTAINER: { profile: {} } })]) {
    const box = createGhuntBox({ async run() { return raw; } });
    await assert.rejects(box.execute(email), (error: unknown) => error instanceof Error && error.message === "Invalid GHunt report");
  }
});

test("unsafe avatar URLs and default avatars are omitted", async () => {
  for (const photo of [{ url: "https://example.test/x?token=secret", isDefault: false }, { url: "javascript:secret", isDefault: false }, { url: "https://example.test/a", isDefault: true }]) {
    const report = { PROFILE_CONTAINER: { profile: { personId: "1", profilePhotos: { PROFILE: photo } } } };
    const box = createGhuntBox({ async run() { return JSON.stringify(report); } });
    const [result] = await box.execute(email);
    assert.deepEqual(result.finding.media, {});
  }
});

test("a report produced by the authentic GHunt 2.3.4 encoder is parsed", async () => {
  const raw = await readFile(new URL("./fixtures/ghunt-2.3.4-email-report.json", import.meta.url), "utf8");
  const box = createGhuntBox({ async run() { return raw; } });
  const [result] = await box.execute(email);
  assert.deepEqual(result.finding.extra, { source: "ghunt public profile", person_id: "100000000000000000001" });
  assert.deepEqual(result.finding.media, { avatar: "https://lh3.googleusercontent.com/a-/fixture" });
});

test("a target GHunt cannot find yields no finding", async () => {
  const box = createGhuntBox({ async run() { throw new GhuntProcessError("not_found"); } });
  assert.deepEqual(await box.execute(email), []);
});
