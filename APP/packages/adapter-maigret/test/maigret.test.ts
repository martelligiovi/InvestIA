import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createMaigretBox, type MaigretRunner } from "../src/index.ts";

function runner(report: unknown, seen: string[] = []): MaigretRunner {
  return { async run(username) { seen.push(username); return typeof report === "string" ? report : JSON.stringify(report); } };
}

/** Shape written by maigret 0.6.6 `--json simple` (report.generate_json_report): claimed sites only. */
const report = {
  GitHub: {
    username: "anaexample", parsing_enabled: true, url_main: "https://github.com/", url_user: "https://github.com/anaexample",
    status: {
      username: "anaexample", site_name: "GitHub", url: "https://github.com/anaexample", status: "Claimed",
      ids: { fullname: "Ana Example", location: "Córdoba", image: "https://avatars.example/ana.png", follower_count: "12", created_at: "2019-01-01" },
      tags: ["coding"], keywords: [], keyword_match_status: "None",
    },
    http_status: 200, is_similar: false, rank: 25, site: { name: "GitHub", alexaRank: 25 },
    ids_usernames: { "ana-alt": "username", "ana_dev": "username" }, ids_links: ["https://ana.example.dev"],
  },
  Reddit: {
    username: "anaexample", parsing_enabled: true, url_main: "https://www.reddit.com/", url_user: "https://www.reddit.com/user/anaexample",
    status: { username: "anaexample", site_name: "Reddit", url: "https://www.reddit.com/user/anaexample", status: "Claimed", ids: {}, tags: [] },
    http_status: 200, is_similar: false, rank: 10, site: { name: "Reddit" },
  },
  SimilarForum: {
    username: "anaexample", parsing_enabled: true, url_main: "https://forum.example/", url_user: "https://forum.example/search?q=anaexample",
    status: { username: "anaexample", site_name: "SimilarForum", url: "https://forum.example/search?q=anaexample", status: "Claimed", ids: {}, tags: [] },
    http_status: 200, is_similar: true, rank: 900, site: {},
  },
};

test("claimed sites become username findings with extracted profile data", async () => {
  const seen: string[] = [];
  const box = createMaigretBox(runner(report, seen));
  assert.equal(box.id, "maigret:username");
  assert.equal(box.inputKind, "username");
  const observations = await box.execute({ kind: "username", value: " anaexample " });
  assert.deepEqual(seen, ["anaexample"]);
  assert.deepEqual(observations, [
    {
      kind: "scanner_finding", seed: { kind: "username", value: "anaexample" }, provider: "GitHub", status: "registered",
      finding: {
        target: { kind: "username", value: "anaexample" }, upstreamStatus: "Found", url: "https://github.com/anaexample",
        category: "coding", reason: "",
        extra: {
          source: "maigret", rank: 25,
          fullname: "Ana Example", location: "Córdoba", follower_count: "12", created_at: "2019-01-01",
          discovered_usernames: "ana-alt, ana_dev", links: "https://ana.example.dev",
        },
        media: { avatar: "https://avatars.example/ana.png" },
      },
    },
    {
      kind: "scanner_finding", seed: { kind: "username", value: "anaexample" }, provider: "Reddit", status: "registered",
      finding: {
        target: { kind: "username", value: "anaexample" }, upstreamStatus: "Found", url: "https://www.reddit.com/user/anaexample",
        category: "", reason: "", extra: { source: "maigret", rank: 10 }, media: {},
      },
    },
  ], "similar-search sites are dropped as likely false positives");
});

test("an empty report is a valid result without findings", async () => {
  assert.deepEqual(await createMaigretBox(runner({})).execute({ kind: "username", value: "nobody" }), []);
});

test("unsafe URLs and non-primitive extracted values are not retained", async () => {
  const hostile = { Evil: { ...report.Reddit, url_user: "javascript:alert(1)", status: {
    ...report.Reddit.status, ids: { image: "file:///etc/passwd", nested: { a: 1 }, list: ["x"], bio: "Plain text" },
  } } };
  const [observation] = await createMaigretBox(runner(hostile)).execute({ kind: "username", value: "anaexample" });
  assert.equal(observation!.finding.url, "");
  assert.deepEqual(observation!.finding.media, {});
  assert.deepEqual(observation!.finding.extra, { source: "maigret", rank: 10, bio: "Plain text" });
});

test("a malformed report is rejected", async () => {
  for (const body of ["not json", "[]", JSON.stringify({ GitHub: { status: "Claimed" } })]) {
    await assert.rejects(createMaigretBox(runner(body)).execute({ kind: "username", value: "anaexample" }), /Invalid Maigret report/);
  }
});

test("usernames that could be read as CLI options or several targets are rejected before running", async () => {
  const seen: string[] = [];
  const box = createMaigretBox(runner(report, seen));
  for (const value of ["--help", "-a", "two words", "", "a".repeat(65), "semi;colon", "slash/name"]) {
    await assert.rejects(box.execute({ kind: "username", value }));
  }
  await assert.rejects(box.execute({ kind: "email", value: "ana@example.test" } as never));
  assert.deepEqual(seen, []);
});

test("a report written by the real maigret 0.6.6 CLI (loopback-only smoke) parses", async () => {
  const raw = await readFile(new URL("./fixtures/maigret-0.6.6-simple-loopback.json", import.meta.url), "utf8");
  const observations = await createMaigretBox({ async run() { return raw; } }).execute({ kind: "username", value: "smoketestuser" });
  assert.deepEqual(observations.map((observation) => [observation.provider, observation.finding.url, observation.finding.category]), [
    ["LocalSmoke", "http://127.0.0.1:18765/user/smoketestuser/", "coding"],
  ]);
});

test("credential fields are never retained in Maigret findings", async () => {
  const body = { Site: {
    ...report.Reddit,
    status: { ...report.Reddit.status, ids: {
      fullname: "Ana", password: "secret", access_token: "token", api_key: "k", session_id: "s", password_hash: "h", uid: "42",
    } },
  } };
  const [observation] = await createMaigretBox(runner(body)).execute({ kind: "username", value: "anaexample" });
  assert.deepEqual(observation!.finding.extra, { source: "maigret", rank: 10, fullname: "Ana", uid: "42" });
});
