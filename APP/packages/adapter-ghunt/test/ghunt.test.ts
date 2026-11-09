import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createGhuntBox, GhuntProcessError } from "../src/index.ts";

const email = { kind: "email", value: "Ana@GMAIL.COM" } as const;
const profile = { PROFILE_CONTAINER: { profile: {
  personId: "123", names: { PROFILE: { fullname: "Ana Example", firstName: "Ana", lastName: "Example", token: "secret" } },
  profilePhotos: { PROFILE: { url: "https://images.example/photo", isDefault: false, flathash: "secret" } },
  coverPhotos: { PROFILE: { url: "https://images.example/cover", isDefault: false } },
  sourceIds: { PROFILE: { lastUpdated: "2024/01/02 03:04:05 (UTC)", secret: "secret" } },
  emails: { PROFILE: { value: "secret@example.test" } },
  profileInfos: { PROFILE: { userTypes: ["GOOGLE_USER", "GOOGLE_ONE_USER"] } },
  inAppReachability: { PROFILE: { apps: ["Maps", "YouTube"] } },
  extendedData: { dynamiteData: { entityType: "PERSON", customerId: "C123", presence: "secret" }, gplusData: { isEntrepriseUser: false, contentRestriction: "secret" } },
  access_token: "secret", private: { value: "secret" },
}, play_games: {
  profile: { display_name: "AnaPlays", id: "", avatar_url: "https://images.example/player", gamertag: "ana_g", title: "Rookie", banner_url_portrait: "secret" },
  played_games: [{ secret: "secret" }, { secret: "secret" }], achievements: [{ secret: "secret" }],
}, maps: { photos: null, reviews: null, stats: { Reviews: 12, Ratings: 3, Photos: 30, Secret: "secret" } },
calendar: { details: { id: "secret@example.test", summary: "Ana's calendar", time_zone: "Europe/Madrid" },
  events: { items: [{ summary: "secret" }, { summary: "secret" }, { summary: "secret" }] } } } };

function leaf(category: string, extra: Record<string, string | number | boolean>, media: Record<string, string> = {}, url = "") {
  return { kind: "scanner_finding", seed: email, provider: "GHunt", status: "registered",
    finding: { target: email, upstreamStatus: "Found", url, category, reason: "", extra: { source: "ghunt", ...extra }, media } };
}

test("each data type of a found profile becomes its own allowlisted finding", async () => {
  const seen: string[] = [];
  const box = createGhuntBox({ async run(value: string) { seen.push(value); return JSON.stringify(profile); } });
  assert.equal(box.id, "ghunt:email");
  assert.equal(box.inputKind, "email");
  assert.deepEqual(await box.execute(email), [
    leaf("Google account", { person_id: "123", user_types: "GOOGLE_USER, GOOGLE_ONE_USER", entity_type: "PERSON", customer_id: "C123", enterprise_user: false }),
    leaf("Name", { fullname: "Ana Example", first_name: "Ana", last_name: "Example" }),
    leaf("Profile photo", {}, { avatar: "https://images.example/photo" }, "https://images.example/photo"),
    leaf("Cover photo", {}, { cover: "https://images.example/cover" }, "https://images.example/cover"),
    leaf("Last profile edit", { last_updated: "2024/01/02 03:04:05 (UTC)" }),
    leaf("Google services", { services: "Maps, YouTube" }),
    leaf("Maps", { reviews: 12, ratings: 3, photos: 30 }, {}, "https://www.google.com/maps/contrib/123"),
    leaf("Calendar", { summary: "Ana's calendar", time_zone: "Europe/Madrid", events: 3 }),
    leaf("Play Games", { display_name: "AnaPlays", gamertag: "ana_g", title: "Rookie", played_games: 2, achievements: 1 }, { avatar: "https://images.example/player" }),
  ]);
  assert.deepEqual(seen, [email.value]);
});

test("absent, default and empty sections add no findings", async () => {
  const report = { PROFILE_CONTAINER: { profile: { personId: "7",
    names: { PROFILE: { fullname: "" } }, profilePhotos: { PROFILE: { url: "https://images.example/a", isDefault: true } },
    coverPhotos: {}, sourceIds: { PROFILE: { lastUpdated: "" } }, profileInfos: {}, inAppReachability: { PROFILE: { apps: [] } },
  }, play_games: null, maps: { photos: null, reviews: null, stats: { Reviews: 0, Ratings: 0, Photos: 0 } }, calendar: null } };
  const box = createGhuntBox({ async run() { return JSON.stringify(report); } });
  assert.deepEqual(await box.execute(email), [leaf("Google account", { person_id: "7" })]);
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

test("unsafe or default photos and malformed edit dates are omitted", async () => {
  for (const photo of [{ url: "https://example.test/x?token=secret", isDefault: false }, { url: "javascript:secret", isDefault: false }, { url: "https://example.test/a", isDefault: true }]) {
    const report = { PROFILE_CONTAINER: { profile: { personId: "1", profilePhotos: { PROFILE: photo } } } };
    const box = createGhuntBox({ async run() { return JSON.stringify(report); } });
    assert.deepEqual((await box.execute(email)).map((result) => result.finding.category), ["Google account"]);
  }
  const unsafe = { PROFILE_CONTAINER: { profile: { personId: "1", coverPhotos: { PROFILE: { url: "http://example.test/c", isDefault: false } }, sourceIds: { PROFILE: { lastUpdated: "secret text" } } },
    play_games: { profile: { display_name: "P", avatar_url: "https://example.test/p#secret" } } } };
  const box = createGhuntBox({ async run() { return JSON.stringify(unsafe); } });
  const results = await box.execute(email);
  assert.deepEqual(results.map((result) => result.finding.category), ["Google account", "Play Games"]);
  assert.deepEqual(results[1]?.finding.media, {});
});

test("a report produced by the authentic GHunt 2.3.4 encoder is parsed", async () => {
  const raw = await readFile(new URL("./fixtures/ghunt-2.3.4-email-report.json", import.meta.url), "utf8");
  const box = createGhuntBox({ async run() { return raw; } });
  assert.deepEqual(await box.execute(email), [
    leaf("Google account", { person_id: "100000000000000000001", enterprise_user: false }),
    leaf("Profile photo", {}, { avatar: "https://lh3.googleusercontent.com/a-/fixture" }, "https://lh3.googleusercontent.com/a-/fixture"),
  ]);
});

test("a target GHunt cannot find yields no finding", async () => {
  const box = createGhuntBox({ async run() { throw new GhuntProcessError("not_found"); } });
  assert.deepEqual(await box.execute(email), []);
});

test("impossible edit dates and email-like calendar summaries do not reach findings", async () => {
  const report = { PROFILE_CONTAINER: {
    profile: { personId: "123", sourceIds: { PROFILE: { lastUpdated: "2024/99/99 99:99:99 (UTC)" } } },
    calendar: { details: { summary: "other@example.test", time_zone: "UTC" }, events: { items: [] } },
  } };
  const box = createGhuntBox({ async run() { return JSON.stringify(report); } });
  const results = await box.execute(email);
  assert.deepEqual(results, [leaf("Google account", { person_id: "123" }), leaf("Calendar", { time_zone: "UTC" })]);
});
