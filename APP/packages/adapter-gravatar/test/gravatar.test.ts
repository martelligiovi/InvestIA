import assert from "node:assert/strict";
import test from "node:test";
import { createGravatarBox, gravatarHash } from "../src/index.ts";

const seed = { kind: "email", value: "  Test@Example.com " } as const;
const HASH = "973dfe463ec85785f5f95af5ba3906eedb2d931c24e69824a89ea65dba4e813b";

interface Call { readonly url: string; readonly headers: Headers }

function fakeFetch(response: () => Response | Promise<Response>, calls: Call[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers) });
    return response();
  }) as typeof fetch;
}

const profile = {
  hash: HASH,
  display_name: "Ana Example",
  profile_url: "https://gravatar.com/anaexample",
  avatar_url: "https://0.gravatar.com/avatar/abc",
  avatar_alt_text: "",
  location: "Córdoba, Argentina",
  description: "Backend developer",
  job_title: "Engineer",
  company: "Example Co",
  pronouns: "",
  verified_accounts: [
    { service_type: "github", service_label: "GitHub", url: "https://github.com/anaexample", is_hidden: false },
    { service_type: "x", service_label: "X", url: "https://x.com/hidden", is_hidden: true },
    { service_type: "evil", service_label: "Evil", url: "javascript:alert(1)", is_hidden: false },
  ],
};

test("hashes the trimmed lowercase email with SHA-256", () => {
  assert.equal(gravatarHash(" Test@Example.com\n"), HASH);
});

test("a public profile becomes one profile finding and one finding per visible verified account", async () => {
  const calls: Call[] = [];
  const box = createGravatarBox({ fetch: fakeFetch(() => Response.json(profile), calls) });
  assert.equal(box.id, "gravatar:email");
  assert.equal(box.inputKind, "email");
  const observations = await box.execute(seed);
  assert.deepEqual(calls.map((call) => call.url), [`https://api.gravatar.com/v3/profiles/${HASH}`]);
  assert.equal(calls[0]!.headers.get("authorization"), null);
  assert.deepEqual(observations, [
    {
      kind: "scanner_finding", seed: { kind: "email", value: "test@example.com" }, provider: "Gravatar", status: "registered",
      finding: {
        target: { kind: "email", value: "test@example.com" }, upstreamStatus: "Found", url: "https://gravatar.com/anaexample",
        category: "Profile", reason: "",
        extra: {
          source: "gravatar public profile", display_name: "Ana Example", location: "Córdoba, Argentina",
          description: "Backend developer", job_title: "Engineer", company: "Example Co",
        },
        media: { avatar: "https://0.gravatar.com/avatar/abc" },
      },
    },
    {
      kind: "scanner_finding", seed: { kind: "email", value: "test@example.com" }, provider: "GitHub", status: "registered",
      finding: {
        target: { kind: "email", value: "test@example.com" }, upstreamStatus: "Found", url: "https://github.com/anaexample",
        category: "Linked account", reason: "",
        extra: { source: "gravatar verified account", service_type: "github" },
        media: {},
      },
    },
  ]);
});

test("an optional API key is sent as a bearer token", async () => {
  const calls: Call[] = [];
  const box = createGravatarBox({ apiKey: "secret-key", fetch: fakeFetch(() => Response.json(profile), calls) });
  await box.execute(seed);
  assert.equal(calls[0]!.headers.get("authorization"), "Bearer secret-key");
});

test("a missing profile is a valid negative result", async () => {
  const box = createGravatarBox({ fetch: fakeFetch(() => new Response("Not found", { status: 404 })) });
  const observations = await box.execute(seed);
  assert.equal(observations.length, 1);
  assert.equal(observations[0]!.status, "not_registered");
  assert.equal(observations[0]!.finding.upstreamStatus, "Not Found");
});

test("rate limits and provider failures reject without exposing the response body", async () => {
  const limited = createGravatarBox({ fetch: fakeFetch(() => new Response("token=leak", { status: 429 })) });
  await assert.rejects(limited.execute(seed), (error: Error) =>
    /rate limit/i.test(error.message) && !error.message.includes("leak"));
  const failed = createGravatarBox({ fetch: fakeFetch(() => new Response("token=leak", { status: 500 })) });
  await assert.rejects(failed.execute(seed), (error: Error) =>
    error.message === "Gravatar request failed with HTTP 500" && !error.message.includes("leak"));
  const offline = createGravatarBox({ fetch: fakeFetch(() => { throw new TypeError("getaddrinfo ENOTFOUND"); }) });
  await assert.rejects(offline.execute(seed), /Gravatar request failed/);
});

test("a stalled request times out", async () => {
  const stalled = ((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  })) as typeof fetch;
  const box = createGravatarBox({ fetch: stalled, timeoutMs: 10 });
  await assert.rejects(box.execute(seed), /Gravatar request timed out/);
});

test("a malformed profile body is rejected", async () => {
  for (const body of [[], { display_name: 42 }, "not json"]) {
    const box = createGravatarBox({ fetch: fakeFetch(() => new Response(JSON.stringify(body), { status: 200 })) });
    await assert.rejects(box.execute(seed), /Invalid Gravatar profile/);
  }
});

test("an invalid seed is rejected before any request", async () => {
  const calls: Call[] = [];
  const box = createGravatarBox({ fetch: fakeFetch(() => Response.json(profile), calls) });
  await assert.rejects(box.execute({ kind: "email", value: "not-an-email" }));
  assert.equal(calls.length, 0);
});
