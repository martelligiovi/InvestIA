import assert from "node:assert/strict";
import test from "node:test";
import { createFacecheckBox, FACECHECK_SITE, type FacecheckBoxOptions } from "../src/index.ts";

const PHOTO = "https://lh3.googleusercontent.com/a-/ALV-photo=s400";
const seed = { kind: "photo", value: PHOTO } as const;
const TOKEN = "secret-token";
const PHOTO_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const THUMB = "data:image/webp;base64,UklGRhYAAABXRUJQ";

interface Call { readonly url: string; readonly method: string; readonly headers: Headers; readonly body: RequestInit["body"] }

function item(score: number, url: string = `https://example.org/page-${score}`, base64: string = THUMB) {
  return { guid: `g${score}`, score, group: 1, base64, url: { value: url }, index: 0, indexDB: 0, seen: null };
}

function photoResponse(): Response {
  return new Response(PHOTO_BYTES, { status: 200, headers: { "content-type": "image/jpeg" } });
}

/** Serves the photo, then upload_pic and one search reply per poll, recording every call. */
function fakeFetch(upload: unknown, searches: unknown[], calls: Call[] = [], photo: () => Response = photoResponse): typeof fetch {
  const pending = [...searches];
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", headers: new Headers(init?.headers), body: init?.body });
    if (url === PHOTO) return photo();
    if (url === `${FACECHECK_SITE}/api/upload_pic`) return Response.json(upload);
    if (url === `${FACECHECK_SITE}/api/search`) {
      const next = pending.shift();
      if (next === undefined) throw new Error("unexpected poll");
      return Response.json(next);
    }
    throw new Error(`unexpected request ${url}`);
  }) as typeof fetch;
}

function box(fetcher: typeof fetch, overrides: Partial<FacecheckBoxOptions> = {}, testingMode = true) {
  return createFacecheckBox({
    fetch: fetcher,
    settings: async () => ({ token: TOKEN, testingMode }),
    sleep: async () => undefined,
    ...overrides,
  });
}

const uploaded = { id_search: "search-1", message: "Uploaded" };

test("uploads the profile photo, polls until results and keeps the 20 best candidates", async () => {
  const calls: Call[] = [];
  const items = Array.from({ length: 25 }, (_, index) => item(index + 50));
  const facecheck = box(fakeFetch(uploaded, [{ message: "Searching", progress: 40 }, { output: { items } }], calls));
  assert.equal(facecheck.id, "facecheck:photo");
  assert.equal(facecheck.inputKind, "photo");
  const observations = await facecheck.execute(seed);

  assert.deepEqual(calls.map((call) => [call.method, call.url]), [
    ["GET", PHOTO],
    ["POST", `${FACECHECK_SITE}/api/upload_pic`],
    ["POST", `${FACECHECK_SITE}/api/search`],
    ["POST", `${FACECHECK_SITE}/api/search`],
  ]);
  assert.equal(calls[0]!.headers.get("authorization"), null);
  assert.equal(calls[1]!.headers.get("authorization"), TOKEN);
  const form = calls[1]!.body as FormData;
  const image = form.get("images") as File;
  assert.deepEqual(new Uint8Array(await image.arrayBuffer()), PHOTO_BYTES);
  assert.equal(image.type, "image/jpeg");
  for (const poll of calls.slice(2)) {
    assert.equal(poll.headers.get("authorization"), TOKEN);
    assert.equal(poll.headers.get("content-type"), "application/json");
    assert.deepEqual(JSON.parse(String(poll.body)), { id_search: "search-1", with_progress: true, status_only: false, demo: true });
  }

  assert.equal(observations.length, 20);
  assert.deepEqual(observations.map((observation) => observation.finding.extra.score), Array.from({ length: 20 }, (_, index) => 74 - index));
  assert.deepEqual(observations[0], {
    kind: "scanner_finding", seed, provider: "FaceCheck", status: "registered",
    finding: {
      target: seed, upstreamStatus: "Found", url: "https://example.org/page-74", category: "Face match", reason: "",
      extra: { source: "facecheck", score: 74, group: 1, testing_mode: true },
      media: { thumbnail: THUMB },
    },
  });
});

test("a real search sends demo false and marks candidates outside testing mode", async () => {
  const calls: Call[] = [];
  const observations = await box(fakeFetch(uploaded, [{ output: { items: [item(90)] } }], calls), {}, false).execute(seed);
  assert.deepEqual(JSON.parse(String(calls[2]!.body)).demo, false);
  assert.equal(observations[0]!.finding.extra.testing_mode, false);
});

test("no candidates is a successful empty result", async () => {
  assert.deepEqual(await box(fakeFetch(uploaded, [{ output: { items: [] } }])).execute(seed), []);
  assert.deepEqual(await box(fakeFetch(uploaded, [{ output: { items: null } }])).execute(seed), []);
});

test("drops candidates whose source link or thumbnail is unsafe and accepts bare base64 thumbnails", async () => {
  const items = [
    item(99, "javascript:alert(1)"),
    item(98, "https://user:pass@example.org/x"),
    item(97, "https://example.org/bad-thumb", "data:text/html;base64,PHNjcmlwdD4="),
    item(96, "https://example.org/bare", "UklGRhYAAABXRUJQ"),
    { ...item(95), score: "high" },
  ];
  const observations = await box(fakeFetch(uploaded, [{ output: { items } }])).execute(seed);
  assert.deepEqual(observations.map((observation) => [observation.finding.url, observation.finding.media.thumbnail]), [
    ["https://example.org/bare", "data:image/webp;base64,UklGRhYAAABXRUJQ"],
  ]);
});

test("keeps candidates in the live response shape: url as a plain string and a space after base64,", async () => {
  const live = (score: number, url: string, base64: string) => ({ guid: `live${score}`, score, group: 0, base64, url, index: 0, indexDB: 1456707678, seen: null });
  const items = [
    live(92, "https://example.org/profile-a", "data:image/webp;base64, UklGRs4HAABXRUJQ"),
    live(83, "https://example.org/profile-b", "data:image/webp;base64,UklGRsAPAABXRUJQ"),
    item(81, "https://example.org/swagger-shape"),
    live(80, "javascript:alert(1)", "data:image/webp;base64, UklGRsAPAABXRUJQ"),
    live(79, "https://example.org/bad-thumb", "data:image/webp;base64, <script>"),
  ];
  const observations = await box(fakeFetch(uploaded, [{ output: { items } }]), {}, false).execute(seed);
  assert.deepEqual(observations.map((observation) => [observation.finding.url, observation.finding.media.thumbnail, observation.finding.extra]), [
    ["https://example.org/profile-a", "data:image/webp;base64,UklGRs4HAABXRUJQ", { source: "facecheck", score: 92, group: 0, testing_mode: false }],
    ["https://example.org/profile-b", "data:image/webp;base64,UklGRsAPAABXRUJQ", { source: "facecheck", score: 83, group: 0, testing_mode: false }],
    ["https://example.org/swagger-shape", THUMB, { source: "facecheck", score: 81, group: 1, testing_mode: false }],
  ]);
});

test("upload and search errors fail with the FaceCheck error and code, without the token", async () => {
  const calls: Call[] = [];
  await assert.rejects(box(fakeFetch({ error: "Not enough credits", code: "NO_CREDITS" }, [], calls)).execute(seed),
    { message: "FaceCheck: Not enough credits (NO_CREDITS)" });
  assert.equal(calls.length, 2);
  await assert.rejects(box(fakeFetch(uploaded, [{ error: "No face\nfound", code: "NO_FACE" }])).execute(seed),
    (error: Error) => error.message === "FaceCheck: No face found (NO_FACE)" && !error.message.includes(TOKEN));
});

test("a non-JSON or failed FaceCheck response is a clear failure", async () => {
  const fetcher = (async (input: string | URL | Request) => String(input) === PHOTO ? photoResponse()
    : new Response("<html>", { status: 503 })) as typeof fetch;
  await assert.rejects(box(fetcher).execute(seed), { message: "FaceCheck request failed with HTTP 503" });
});

test("stops polling when the search does not finish in time", async () => {
  const progress = { message: "Searching", progress: 10 };
  const calls: Call[] = [];
  await assert.rejects(box(fakeFetch(uploaded, [progress, progress, progress], calls), { maxPolls: 3 }).execute(seed),
    { message: "FaceCheck search did not finish in time" });
  assert.equal(calls.length, 5);
});

test("rejects photos it cannot use before uploading anything, naming the reason, without retrying", async () => {
  for (const [response, reason] of [
    [() => new Response("nope", { status: 404 }), "HTTP 404"],
    [() => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }), "unsupported type"],
    [() => new Response(new Uint8Array(11), { status: 200, headers: { "content-type": "image/png" } }), "too large"],
    [() => new Response(new Uint8Array(0), { status: 200, headers: { "content-type": "image/png" } }), "empty"],
  ] as const) {
    const calls: Call[] = [];
    const sleeps: number[] = [];
    await assert.rejects(box(fakeFetch(uploaded, [], calls, response), { maxPhotoBytes: 10, sleep: async (ms) => { sleeps.push(ms); } }).execute(seed),
      { message: `FaceCheck could not download the profile photo (${reason})` });
    assert.deepEqual(calls.map((call) => call.url), [PHOTO]);
    assert.deepEqual(sleeps, []);
  }
});

test("retries the free photo download after a network error, then searches once", async () => {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  let attempts = 0;
  const flaky = () => { if (++attempts === 1) throw new TypeError("fetch failed"); return photoResponse(); };
  const observations = await box(fakeFetch(uploaded, [{ output: { items: [item(90)] } }], calls, flaky), { sleep: async (ms) => { sleeps.push(ms); } }).execute(seed);
  assert.equal(observations.length, 1);
  assert.deepEqual(calls.map((call) => [call.method, call.url]), [
    ["GET", PHOTO], ["GET", PHOTO], ["POST", `${FACECHECK_SITE}/api/upload_pic`], ["POST", `${FACECHECK_SITE}/api/search`],
  ]);
  assert.deepEqual(sleeps, [1_000]);
});

test("gives up after three download attempts on network errors, HTTP 429 or 5xx, keeping the last reason, without uploading", async () => {
  for (const [responses, reason] of [
    [[() => { throw new TypeError("fetch failed"); }], "network error"],
    [[() => new Response("", { status: 503 }), () => new Response("", { status: 502 }), () => new Response("", { status: 429 })], "HTTP 429"],
    [[() => new Response("", { status: 500 }), () => { throw new TypeError("fetch failed"); }], "network error"],
  ] as const) {
    const calls: Call[] = [];
    const sleeps: number[] = [];
    let attempt = 0;
    const photo = () => { const next = responses[Math.min(attempt++, responses.length - 1)]!; return next(); };
    await assert.rejects(box(fakeFetch(uploaded, [], calls, photo), { sleep: async (ms) => { sleeps.push(ms); } }).execute(seed),
      { message: `FaceCheck could not download the profile photo (${reason})` });
    assert.deepEqual(calls.map((call) => call.url), [PHOTO, PHOTO, PHOTO]);
    assert.deepEqual(sleeps, [1_000, 2_000]);
  }
});

test("a photo download that times out is retried and named", async () => {
  const calls: Call[] = [];
  const hanging = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? "GET", headers: new Headers(init?.headers), body: init?.body });
    return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
  }) as typeof fetch;
  await assert.rejects(box(hanging, { requestTimeoutMs: 5 }).execute(seed),
    { message: "FaceCheck could not download the profile photo (timed out)" });
  assert.deepEqual(calls.map((call) => call.url), [PHOTO, PHOTO, PHOTO]);
});

test("requires a Google profile photo seed and a configured token before any request", async () => {
  const calls: Call[] = [];
  const fetcher = fakeFetch(uploaded, [], calls);
  for (const input of [
    { kind: "photo", value: "https://example.org/face.jpg" },
    { kind: "photo", value: "http://lh3.googleusercontent.com/a" },
    { kind: "photo", value: `${PHOTO}?sz=50` },
    { kind: "email", value: "a@example.com" },
  ]) {
    await assert.rejects(box(fetcher).execute(input as never), { message: "A Google profile photo seed is required" });
  }
  await assert.rejects(box(fetcher, { settings: async () => undefined }).execute(seed), { message: "FaceCheck API token is not configured" });
  await assert.rejects(box(fetcher, { settings: async () => ({ token: "  ", testingMode: true }) }).execute(seed),
    { message: "FaceCheck API token is not configured" });
  assert.equal(calls.length, 0);
});

test("refuses an oversized photo from its declared length or while streaming, without reading it all", async () => {
  let pulled = 0;
  const streamed = () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) { pulled++; controller.enqueue(new Uint8Array(8)); if (pulled > 100) controller.close(); },
  }), { status: 200, headers: { "content-type": "image/jpeg" } });
  const declared = () => new Response(new Uint8Array(4), { status: 200, headers: { "content-type": "image/jpeg", "content-length": "999" } });
  for (const response of [streamed, declared]) {
    const calls: Call[] = [];
    await assert.rejects(box(fakeFetch(uploaded, [], calls, response), { maxPhotoBytes: 20 }).execute(seed),
      { message: "FaceCheck could not download the profile photo (too large)" });
    assert.deepEqual(calls.map((call) => call.url), [PHOTO]);
  }
  assert.ok(pulled <= 4, `read ${pulled} chunks`);
});

test("never persists the token when FaceCheck echoes it in an error", async () => {
  await assert.rejects(box(fakeFetch({ error: `Invalid token ${TOKEN}`, code: "AUTH" }, [])).execute(seed),
    { message: "FaceCheck: Invalid token [token] (AUTH)" });
});

test("validates both URL shapes and normalizes live thumbnails", async () => {
  const liveThumb = "data:image/webp;base64, UklGRhYAAABXRUJQ";
  const urls = [
    "https://example.org/ok",
    "javascript:alert(1)",
    "data:text/html,x",
    "https://user:pass@example.org/",
    `https://example.org/${"a".repeat(2049)}`,
  ];
  for (const wrapped of [false, true]) {
    for (const [index, url] of urls.entries()) {
      const candidate = { ...item(90), url: wrapped ? { value: url } : url, base64: liveThumb };
      const result = await box(fakeFetch(uploaded, [{ output: { items: [candidate] } }])).execute(seed);
      assert.equal(result.length, index === 0 ? 1 : 0, `${wrapped ? "object" : "string"} url ${url.slice(0, 40)}`);
      if (index === 0) assert.equal(result[0]!.finding.media.thumbnail, THUMB);
    }
  }

  for (const base64 of [
    "data:text/html;base64, PHNjcmlwdD4=",
    "data:image/webp;base64, <script>",
    "data:image/webp;base64, \nUkl GR",
    `data:image/webp;base64, ${"A".repeat(256 * 1024)}`,
  ]) {
    const result = await box(fakeFetch(uploaded, [{ output: { items: [{ ...item(90), url: "https://example.org/", base64 }] } }])).execute(seed);
    assert.deepEqual(result, []);
  }
});

test("ranks live-shape candidates separately", async () => {
  const items = Array.from({ length: 25 }, (_, score) => ({
    ...item(score),
    url: `https://example.org/${score}`,
    base64: "data:image/webp;base64, UklGRhYAAABXRUJQ",
  }));
  const result = await box(fakeFetch(uploaded, [{ output: { items } }])).execute(seed);
  assert.deepEqual(result.map((observation) => observation.finding.extra.score), Array.from({ length: 20 }, (_, index) => 24 - index));
  assert.equal(new Set(result.map((observation) => observation.finding.url)).size, 20);
  assert.ok(result.every((observation) => observation.finding.media.thumbnail === THUMB));
});

test("never persists the token from a photo content type", async () => {
  const response = () => new Response("bad", { headers: { "content-type": `application/${TOKEN}` } });
  await assert.rejects(box(fakeFetch(uploaded, [], [], response)).execute(seed), (error: Error) =>
    error.message === "FaceCheck could not download the profile photo (unsupported type)" && !error.message.includes(TOKEN));
});
