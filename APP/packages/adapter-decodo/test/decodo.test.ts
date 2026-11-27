import assert from "node:assert/strict";
import test from "node:test";
import { isScannerFinding } from "../../core/src/index.ts";
import { createDecodoAdapter, DECODO_API_MODES, isDecodoApiMode, type DecodoAdapterOptions } from "../src/index.ts";

const seed = { kind: "url", value: "https://example.org/profile" } as const;
const TOKEN = "test-token-not-for-errors";
const PRIVATE_BODY = "private upstream response body";
const MARKDOWN = `# Public Profile\n\nA public biography.\n\n[Projects](https://example.org/projects)\n[Duplicate](https://example.org/projects#history)\n[Profile](${seed.value}#top)\n[Private](http://127.0.0.1/info)`;
const WEB_DATA = "https://data.decodo.com/v1/scrape";
const V2 = "https://scraper-api.decodo.com/v2/scrape";

function scraped(content: string, fields = {}) {
  return Response.json({ results: [{ status_code: 200, content, ...fields }] });
}

function fixture(replies: Array<() => Response>, overrides: Partial<DecodoAdapterOptions> = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher: typeof fetch = async (input, init = {}) => {
    const next = replies[calls.length];
    calls.push({ url: String(input), init });
    assert.ok(next, "unexpected fetch");
    return next();
  };
  const adapter = createDecodoAdapter({
    fetch: fetcher,
    settings: async () => ({ token: TOKEN, apiMode: "web_data" }),
    ...overrides,
  });
  return { adapter, calls };
}

function assertRequest(call: ReturnType<typeof fixture>["calls"][number], endpoint: string, authorization: string, headless = true) {
  assert.equal(call.url, endpoint);
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.redirect, "error");
  assert.ok(call.init.signal instanceof AbortSignal);
  const headers = new Headers(call.init.headers);
  assert.equal(headers.get("authorization"), authorization);
  assert.equal(headers.get("accept"), "application/json");
  assert.equal(headers.get("content-type"), "application/json");
  const body = JSON.parse(String(call.init.body)) as Record<string, unknown>;
  assert.equal("markdown" in body, false);
  assert.deepEqual(body, { url: seed.value, ...(headless ? { headless: "html" } : {}) });
}

async function assertFailure(work: Promise<unknown>, message: string) {
  await assert.rejects(work, (error: Error) => {
    assert.equal(error.message, message);
    assert.equal(error.cause, undefined);
    assert.doesNotMatch(String(error.stack), new RegExp(`${TOKEN}|${PRIVATE_BODY}`));
    return true;
  });
}

function syntheticHttpStatus(status: number) {
  // Fetch's Response constructor rejects Decodo's nonstandard HTTP status codes.
  return Object.defineProperty(new Response(`${PRIVATE_BODY}: Bearer ${TOKEN}`, { status: 500 }), "status", { value: status });
}

test("Web Data scrapes Markdown using a normalized Bearer token and returns one valid finding", async () => {
  assert.deepEqual(DECODO_API_MODES, ["web_data", "scraping_v2"]);
  for (const mode of DECODO_API_MODES) assert.equal(isDecodoApiMode(mode), true);
  for (const invalid of [null, undefined, "WEB_DATA", "other", {}]) assert.equal(isDecodoApiMode(invalid), false);
  const { adapter, calls } = fixture([() => scraped(MARKDOWN, { task_id: "task-1" })], {
    settings: async () => ({ apiMode: "web_data", token: `  bEaReR ${TOKEN}  ` }),
  });
  assert.equal(adapter.id, "decodo:url");
  assert.equal(adapter.inputKind, "url");
  const observations = await adapter.execute(seed);
  assert.equal(calls.length, 1);
  assertRequest(calls[0]!, WEB_DATA, `Bearer ${TOKEN}`);
  assert.deepEqual(observations, [{
    kind: "scanner_finding", provider: "Decodo", seed, status: "registered",
    finding: {
      target: seed, upstreamStatus: "Found", url: seed.value, category: "Web page", reason: "Public Profile",
      media: {}, extra: {
        source: "decodo", api_mode: "web_data", status_code: 200, task_id: "task-1", content_format: "markdown",
        title: "Public Profile", description: "A public biography.", preview: "A public biography.",
        content: MARKDOWN, content_length: MARKDOWN.length, content_truncated: false,
        links: "https://example.org/projects", extracted_links_count: 1,
      },
    },
  }]);
  assert.equal(isScannerFinding(observations[0]?.finding), true);
});

test("Scraping API v2 scrapes HTML using normalized Basic auth and retains only safe text and URLs", async () => {
  const html = `<!doctype html><html><head>
    <title>Browser Title</title><meta content="Profile &amp; Work" property="og:title">
    <meta name="description" content="Developer&nbsp;and designer &#x2014; based in Oslo.">
    <link rel="canonical" href="https://example.org/canonical?one=1&amp;two=2">
    </head><body><main><h1>Public Profile</h1><p>Hello &amp; welcome &#33;</p>
    <script>discard-script</script><style>discard-style</style><noscript>discard-noscript</noscript>
    <svg><a href="/discard-link">discard-svg</a></svg><template><template>discard-template</template>discard-outer</template>
    <a title="value > value" href="/projects">Projects</a> <a href="/projects#other">Duplicate</a>
    <a href="javascript:alert(1)">Script link</a> <a href="https://user:pass@example.org/private">Credentials</a>
    <a href="http://169.254.169.254/">Local</a></main></body></html>`;
  const { adapter, calls } = fixture([() => scraped(html, { url: "https://example.org/redirected" })], {
    settings: async () => ({ apiMode: "scraping_v2", token: ` bAsIc ${TOKEN} ` }),
  });
  const [observation] = await adapter.execute(seed);
  assert.equal(calls.length, 1);
  assertRequest(calls[0]!, V2, `Basic ${TOKEN}`);
  assert.equal(isScannerFinding(observation?.finding), true);
  const { url, reason, extra } = observation!.finding;
  assert.equal(url, "https://example.org/canonical?one=1&two=2");
  assert.equal(reason, "Profile & Work");
  assert.equal(extra.api_mode, "scraping_v2");
  assert.equal(extra.title, reason);
  assert.equal(extra.description, "Developer and designer — based in Oslo.");
  assert.equal(extra.content_format, "html");
  assert.equal(extra.content, "# Public Profile\nHello & welcome !\nProjects Duplicate Script link Credentials Local");
  assert.equal(extra.content_length, String(extra.content).length);
  assert.equal(extra.content_truncated, false);
  assert.equal(extra.links, "https://example.org/projects");
  assert.equal(extra.extracted_links_count, 1);
});

test("HTML falls back to title and safe response URL; Markdown never stores embedded raw HTML", async () => {
  const { adapter } = fixture([
    () => scraped('<title>Page &copy;</title><link rel="canonical" href="http://192.168.1.2/private"><p>Readable body</p>', { url: "https://example.org/final" }),
    () => scraped('# Notes\n\nSome <b>public text</b>. <script>discard-me</script>\n\nSee <https://example.org/more>.'),
  ]);
  const [html] = await adapter.execute(seed);
  assert.equal(html?.finding.url, "https://example.org/final");
  assert.equal(html?.finding.extra.title, "Page ©");
  assert.equal(html?.finding.extra.content, "Readable body");
  const [markdown] = await adapter.execute(seed);
  assert.equal(markdown?.finding.extra.content_format, "markdown");
  assert.equal(markdown?.finding.extra.content, "# Notes\n\nSome public text.\n\nSee https://example.org/more.");
  assert.equal(markdown?.finding.extra.links, "https://example.org/more");
});

test("rejects unsafe URLs before reading settings or sending anything", async () => {
  let settingsReads = 0;
  const { adapter, calls } = fixture([], { settings: async () => { settingsReads++; return { apiMode: "web_data", token: TOKEN }; } });
  for (const value of ["not a URL", "ftp://example.org/file", "http://localhost/", "http://127.1/", "https://[::1]/", "http://10.20.30.40/", "http://169.254.169.254/", "https://user:pass@example.org/"]) {
    await assertFailure(adapter.execute({ kind: "url", value }), "A valid public HTTP URL seed is required");
  }
  assert.equal(settingsReads, 0);
  assert.deepEqual(calls, []);
});

test("does not expose a settings failure or send any request", async () => {
  for (const settings of [() => { throw new Error(TOKEN); }, async () => { throw new Error(TOKEN); }]) {
    const { adapter, calls } = fixture([], { settings });
    await assertFailure(adapter.execute(seed), "Decodo settings could not be loaded");
    assert.deepEqual(calls, []);
  }
});

test("rejects missing or invalid tokens without a fetch", async () => {
  for (const [token, message] of [
    [undefined, "Decodo API token is not configured"], ["  ", "Decodo API token is not configured"],
    [" Bearer  ", "Decodo API token is not configured"], [`Bearer ${TOKEN}\n`, "Decodo API token contains control characters"],
    [`${TOKEN}\x00`, "Decodo API token contains control characters"], [`${TOKEN}\u0085`, "Decodo API token contains control characters"],
  ] as const) {
    const { adapter, calls } = fixture([], { settings: async () => ({ apiMode: "web_data", token }) });
    await assertFailure(adapter.execute(seed), message);
    assert.deepEqual(calls, []);
  }
});

for (const [apiMode, token] of [
  ["web_data", "Bearer"], ["scraping_v2", "Basic"],
  ["web_data", "  bEaReR  "], ["scraping_v2", " bAsIc "],
  ["web_data", "Basic"], ["scraping_v2", "Bearer"],
] as const) {
  test(`rejects scheme-only credentials for ${apiMode}: ${JSON.stringify(token)}`, async () => {
    const { adapter, calls } = fixture([], { settings: async () => ({ apiMode, token }) });
    await assertFailure(adapter.execute(seed), "Decodo API token is not configured");
    assert.deepEqual(calls, []);
  });
}

for (const [apiMode, token, message] of [
  ["web_data", "two words", "Decodo API token contains whitespace"],
  ["scraping_v2", "Basic two\u00a0words", "Decodo API token contains whitespace"],
  ["web_data", "Bearer two\twords", "Decodo API token contains control characters"],
] as const) {
  test(`rejects malformed credentials for ${apiMode}: ${JSON.stringify(token)}`, async () => {
    const { adapter, calls } = fixture([], { settings: async () => ({ apiMode, token }) });
    await assertFailure(adapter.execute(seed), message);
    assert.deepEqual(calls, []);
  });
}

for (const [name, blocked] of [
  ["target status", () => scraped(PRIVATE_BODY, { status_code: 999 })],
  ["Decodo HTTP status", () => syntheticHttpStatus(999)],
] as const) {
  test(`retries once without headless on 999 ${name} and returns the fallback finding`, async () => {
    const { adapter, calls } = fixture([blocked, () => scraped(MARKDOWN)]);
    const observations = await adapter.execute(seed);
    assert.equal(observations.length, 1);
    assert.equal(observations[0]?.finding.extra.status_code, 200);
    assert.equal(calls.length, 2);
    assertRequest(calls[0]!, WEB_DATA, `Bearer ${TOKEN}`);
    assertRequest(calls[1]!, WEB_DATA, `Bearer ${TOKEN}`, false);
  });
}

test("a second 999 is terminal and never sends a third request", async () => {
  const { adapter, calls } = fixture([() => syntheticHttpStatus(999), () => scraped(TOKEN, { status_code: 999 })]);
  await assertFailure(adapter.execute(seed), "Decodo scrape blocked by anti-bot protection (999)");
  assert.equal(calls.length, 2);
  assertRequest(calls[1]!, WEB_DATA, `Bearer ${TOKEN}`, false);
});

for (const [status, message] of [
  [401, "Decodo API credentials were rejected"], [403, "Decodo API credentials were rejected"],
  [429, "Decodo API rate limit or quota exceeded"], [400, "Decodo API rejected the scrape request"],
  [422, "Decodo API rejected the scrape request"], [500, "Decodo service failure (HTTP 500)"],
  [524, "Decodo request timed out"], [612, "Decodo service failure (HTTP 612)"], [613, "Decodo service failure (HTTP 613)"],
] as const) {
  test(`maps HTTP ${status} without exposing secrets or retrying`, async () => {
    const { adapter, calls } = fixture([() => syntheticHttpStatus(status)]);
    await assertFailure(adapter.execute(seed), message);
    assert.equal(calls.length, 1);
  });
}

for (const [name, reply, message] of [
  ["malformed JSON", () => new Response(`${PRIVATE_BODY}: ${TOKEN}`), "Unexpected Decodo response"],
  ["missing results", () => Response.json({ private: TOKEN }), "Unexpected Decodo response"],
  ["missing status", () => Response.json({ results: [{ content: TOKEN }] }), "Unexpected Decodo response"],
  ["target 404", () => scraped(TOKEN, { status_code: 404 }), "Decodo target returned HTTP 404"],
  ["network failure", () => { throw new Error(TOKEN); }, "Decodo request failed"],
  ["aborted fetch", () => { throw new DOMException(TOKEN, "AbortError"); }, "Decodo request timed out"],
  ["timed-out fetch", () => { throw new DOMException(TOKEN, "TimeoutError"); }, "Decodo request timed out"],
  ["aborted body", () => new Response(new ReadableStream({ start(controller) { controller.error(new DOMException(TOKEN, "AbortError")); } })), "Decodo request timed out"],
] as const) {
  test(`fails on ${name} without exposing secrets or retrying`, async () => {
    const { adapter, calls } = fixture([reply]);
    await assertFailure(adapter.execute(seed), message);
    assert.equal(calls.length, 1);
  });
}

test("rejects authwalls and login/sign-up pages, but not a LinkedIn profile with a sign-in link", async () => {
  const profile = { kind: "url", value: "https://www.linkedin.com/in/public-profile/" } as const;
  const gated = [
    () => scraped("# Welcome\n\nA generic page", { url: "https://www.linkedin.com/authwall?trk=profile" }),
    () => scraped(`[LinkedIn](https://www.linkedin.com/)\n\n# Sign in to LinkedIn\n\nStay updated on your professional world\n\nEmail or phone\n\nPassword\n\nShow\n\n[Forgot password?](https://www.linkedin.com/reset)\n\nNew to LinkedIn? Join now\n\nLinkedIn © 2026`),
    () => scraped('<title>Sign Up | LinkedIn</title><nav>Home</nav><main><h1>Join LinkedIn</h1><p>Make the most of your professional life</p><form><label>Email or phone</label><label>Password</label><button>Join now</button></form></main>'),
  ];
  const { adapter, calls } = fixture([
    ...gated.flatMap((reply) => [reply, reply]),
    () => scraped('<title>Public Profile | LinkedIn</title><nav><a href="/login">Sign in</a></nav><main><h1>Jamie Example</h1><p>Software engineer building research tools.</p><h2>Experience</h2><p>Research Engineer at Example Studio</p></main>'),
    () => scraped('[Sign in](https://www.linkedin.com/login)\n\n# Jamie Example\n\nSoftware engineer\n\n## Experience\n\nResearch Engineer at Example Studio'),
  ]);
  for (let i = 0; i < 3; i++) await assertFailure(adapter.execute(profile), "Decodo target requires login");
  for (let i = 0; i < 2; i++) {
    const [observation] = await adapter.execute(profile);
    assert.equal(observation?.finding.url, profile.value);
    assert.match(String(observation?.finding.extra.content), /Research Engineer at Example Studio/);
  }
  assert.equal(calls.length, 8);
  assert.deepEqual(calls.map((call) => JSON.parse(String(call.init.body)).headless),
    ["html", undefined, "html", undefined, "html", undefined, "html", "html"]);
});

test("a standalone sign-in link does not make a sparse Markdown profile a login gate", async () => {
  const content = "# Jane Doe\n\n[Sign in](https://example.org/login)";
  const { adapter, calls } = fixture([() => scraped(content, { url: seed.value })]);
  const findings = await adapter.execute(seed);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.finding.url, seed.value);
  assert.equal(findings[0]?.finding.extra.title, "Jane Doe");
  assert.equal(findings[0]?.finding.extra.content, content);
  assert.equal(calls.length, 1);
});

test("an HTML login form stays terminal after fallback even with marketing copy and JSON-LD", async () => {
  const reply = () => scraped('<html><head><script type="application/ld+json">'
    + JSON.stringify({ description: "Public stories about local communities and engineering projects. ".repeat(6) })
    + '</script></head><main><p>Explore local news and discover new communities.</p>'
    + '<form><h1>Sign in</h1><label>Password <input type="password"></label></form></main></html>', { url: seed.value });
  const { adapter, calls } = fixture([reply, reply]);
  await assertFailure(adapter.execute(seed), "Decodo target requires login");
  assert.equal(calls.length, 2);
});

test("Decodo rejects a members-only password gate on the original profile URL", async () => {
  const content = '<main><h1>Members only</h1><p>Enter your credentials to continue reading.</p>'
    + '<form><label>Password <input type="password"></label><button>Sign in</button></form></main>';
  const reply = () => scraped(content, { url: seed.value });
  const { adapter, calls } = fixture([reply, reply]);
  await assertFailure(adapter.execute(seed), "Decodo target requires login");
  assert.equal(calls.length, 2);
});

test("bounds title, description, preview, content and links without storing partial URLs", async () => {
  const article = `<title>${"T".repeat(300)}</title><meta name="description" content="${"D".repeat(500)}"><p>${"x".repeat(6500)}</p>`;
  const urls = Array.from({ length: 14 }, (_, i) => `https://example.org/${i}/${"z".repeat(140)}`);
  const { adapter } = fixture([
    () => scraped(article + urls.map((url) => `<a href="${url}">Link</a>`).join(" ")),
    () => scraped(`<p>${"y".repeat(6500)}</p>`),
    () => scraped(urls.map((_, i) => `[Link ${i}](https://example.org/${i})`).join("\n")),
  ]);
  const [observation] = await adapter.execute(seed);
  const extra = observation!.finding.extra;
  assert.equal(extra.title, "T".repeat(240));
  assert.equal(extra.description, "D".repeat(400));
  assert.equal(extra.preview, "D".repeat(400));
  assert.equal(extra.content, "x".repeat(6000));
  assert.equal(extra.content_truncated, true);
  assert.equal(extra.content_length, 6570);
  assert.ok(String(extra.links).length <= 1200);
  const links = String(extra.links).split("\n");
  assert.deepEqual(links, urls.slice(0, 7));
  assert.equal(extra.extracted_links_count, links.length);
  const [noMeta] = await adapter.execute(seed);
  assert.equal(noMeta?.finding.extra.description, undefined);
  assert.equal(noMeta?.finding.extra.preview, "y".repeat(400));
  const [short] = await adapter.execute(seed);
  assert.equal(short?.finding.extra.extracted_links_count, 10);
  assert.deepEqual(String(short?.finding.extra.links).split("\n"), Array.from({ length: 10 }, (_, i) => `https://example.org/${i}`));
});

test("strips large navigation chrome, skip-links, ARIA chrome, and asset URLs while prioritizing main profile content and links", async () => {
  const navNoise = Array.from({ length: 60 }, (_, i) => `<a href="https://example.org/nav-${i}">Navigation menu item ${i}</a>`).join(" ");
  const assetLinks = [
    "https://cdn.example.org/avatar.webp?size=256",
    "https://cdn.example.org/photo.png",
    "https://cdn.example.org/cover.jpg",
    "https://cdn.example.org/banner.jpeg",
    "https://cdn.example.org/badge.gif",
    "https://cdn.example.org/icon.svg",
    "https://cdn.example.org/favicon.ico",
    "https://cdn.example.org/app.css?v=2",
    "https://cdn.example.org/bundle.js",
    "https://cdn.example.org/module.mjs",
    "https://cdn.example.org/legacy.cjs",
    "https://cdn.example.org/font.woff",
    "https://cdn.example.org/font.woff2",
    "https://cdn.example.org/font.ttf",
    "https://cdn.example.org/font.eot",
  ].map((href) => `<a href="${href}">Asset</a>`).join(" ");
  const mainRepoLinks = Array.from({ length: 9 }, (_, i) =>
    `<article><h2>repo-${i}</h2><p>Deterministic generic parser utility module ${i}.</p><a href="https://example.org/u/ada/repo-${i}">repo-${i}</a></article>`,
  ).join("");
  const html = `<!doctype html><html><head><title>Ada Lovelace (@ada)</title></head><body>
    <a href="#main-content">Skip to main content</a>
    <header>${navNoise}<div role="search"><a href="https://example.org/search">Search</a></div></header>
    <div role="navigation"><a href="https://example.org/explore">Explore</a></div>
    <div class="outer-banner">Outside wrapper note before main<a href="https://example.org/outer-link-1">Outer 1</a><a href="https://example.org/outer-link-2">Outer 2</a></div>
    <aside><a href="https://example.org/sponsors">Sidebar sponsor promo</a></aside>
    <main id="main-content">
      <h1>Ada Lovelace</h1>
      <p>Mathematician and computing pioneer building open analytical algorithms and numerical engines in London.</p>
      <a href="https://adalovelace.example.com/publications">Publications</a>
      ${assetLinks}
      ${mainRepoLinks}
    </main>
  </body></html>`;
  const { adapter } = fixture([() => scraped(html)]);
  const [observation] = await adapter.execute(seed);
  const extra = observation!.finding.extra;
  const content = String(extra.content);
  assert.equal(extra.content_format, "html");
  assert.equal(extra.content_truncated, false);
  assert.equal(extra.preview, "Ada Lovelace");
  assert.match(content, /Ada Lovelace/);
  assert.match(content, /Mathematician and computing pioneer/);
  assert.match(content, /repo-8/);
  assert.doesNotMatch(content, /Skip to main content|Navigation menu item|Sidebar sponsor promo|Outside wrapper note|Explore|Search/);
  const links = String(extra.links).split("\n");
  assert.equal(links.length, 10);
  assert.equal(links[0], "https://adalovelace.example.com/publications");
  assert.deepEqual(links.slice(1), Array.from({ length: 9 }, (_, i) => `https://example.org/u/ada/repo-${i}`));
});

test("extracts rich public profile HTML cleanly without false login-gate rejection when sign-in dialogs and forms are present", async () => {
  const html = `<!doctype html><html><head>
    <title>Elena Rostova — Principal Systems Engineer</title>
    <meta property="og:description" content="Principal Systems Engineer working on distributed storage, consensus protocols, and fault-tolerant runtimes.">
  </head><body>
    <div>Jump to content</div>
    <header><nav><a href="https://example.org/login">Sign in</a> <a href="https://example.org/join">Sign up</a></nav></header>
    <main>
      <h1>Elena Rostova</h1>
      <p>Principal Systems Engineer with twelve years of experience designing distributed storage engines, consensus protocols, and deterministic simulation frameworks.</p>
      <section>
        <h2>Experience</h2>
        <p>Lead Architect at Horizon Storage Lab — built multi-region replication and automated recovery pipelines for petabyte-scale clusters.</p>
        <p>Senior Engineer at Aurora Systems — authored open-source diagnostics and observability libraries used across production infrastructure.</p>
      </section>
      <p>Website: <a href="https://rostova.dev/research">rostova.dev/research</a></p>
      <div role="dialog" aria-modal="true">
        <div class="modal-shell">
          <div class="modal-header"><h2>Sign in to view full profile</h2><p>Unclosed paragraph inside nested dialog</div>
          <form action="/session">
            <label>Email <input type="email" name="email"></label>
            <label>Password <input type="password" name="password"></label>
            <a href="https://example.org/password-reset">Forgot password?</a>
            <button type="submit">Sign in</button>
          </form>
        </div>
      </div>
      <dialog>
        <h2>Create your account</h2>
        <form><input type="password"><input type="submit" value="Sign up"></form>
      </dialog>
      <div hidden><p>Hidden draft biography and <a href="https://example.org/hidden">hidden link</a></p></div>
      <div aria-hidden="true"><p>Decorative clone text and <a href="https://example.org/decorative">decorative link</a></p></div>
      <p>Selected talk: Deterministic Testing for Consensus Engines at SystemsConf.</p>
    </main>
  </body></html>`;
  const { adapter } = fixture([() => scraped(html)]);
  const [observation] = await adapter.execute(seed);
  const extra = observation!.finding.extra;
  const content = String(extra.content);
  assert.equal(extra.title, "Elena Rostova — Principal Systems Engineer");
  assert.equal(extra.description, "Principal Systems Engineer working on distributed storage, consensus protocols, and fault-tolerant runtimes.");
  assert.equal(extra.preview, extra.description);
  assert.match(content, /Principal Systems Engineer with twelve years of experience/);
  assert.match(content, /Selected talk: Deterministic Testing for Consensus Engines/);
  assert.doesNotMatch(content, /Jump to content|Sign in to view full profile|Forgot password|Create your account|Hidden draft|Decorative clone/);
  assert.equal(extra.links, "https://rostova.dev/research");
  assert.equal(extra.extracted_links_count, 1);
});

test("strips large footer language chrome and prefers meta or twitter description for preview", async () => {
  const languages = Array.from({ length: 120 }, (_, i) => `<li><a href="https://example.org/?lang=lang-${i}">Language option ${i}</a></li>`).join("");
  const htmlWithMeta = `<!doctype html><html><head>
    <title>Marco Silva</title>
    <meta name="description" content="Open-source maintainer focused on compilers and static analysis.">
  </head><body>
    <div>Ir al contenido principal</div>
    <div role="main">
      <h1>Marco Silva</h1>
      <p>Maintainer of portable compiler toolchains, incremental typecheckers, and intermediate representations for modern languages.</p>
    </div>
    <footer><ul>${languages}</ul></footer>
    <div role="contentinfo"><p>Copyright 2026 Example Platform — Terms — Privacy — Cookies</p></div>
  </body></html>`;
  const htmlWithTwitter = `<!doctype html><html><head>
    <title>Marco Silva</title>
    <meta name="twitter:description" content="Compiler engineer and static analysis researcher.">
  </head><body><article><p>First article paragraph with enough detail.</p></article></body></html>`;
  const { adapter } = fixture([() => scraped(htmlWithMeta), () => scraped(htmlWithTwitter)]);
  const [first] = await adapter.execute(seed);
  assert.equal(first?.finding.extra.description, "Open-source maintainer focused on compilers and static analysis.");
  assert.equal(first?.finding.extra.preview, "Open-source maintainer focused on compilers and static analysis.");
  assert.equal(first?.finding.extra.content_truncated, false);
  assert.doesNotMatch(String(first?.finding.extra.content), /Ir al contenido|Language option|Copyright 2026/);
  assert.equal(first?.finding.extra.links, undefined);
  const [second] = await adapter.execute(seed);
  assert.equal(second?.finding.extra.description, "Compiler engineer and static analysis researcher.");
  assert.equal(second?.finding.extra.preview, "Compiler engineer and static analysis researcher.");
});

test("still rejects modal or dialog password login walls when substantive non-chrome body is sparse", async () => {
  const modalPages = [
    () => scraped('<body><main><p>View this profile.</p></main><div role="dialog" aria-modal="true"><h1>Sign in</h1><form><input type="password"><button>Sign in</button></form></div></body>'),
    () => scraped('<body><dialog open><h1>Log in</h1><form><input type="password"><button>Log in</button></form></dialog></body>'),
  ];
  const { adapter, calls } = fixture(modalPages.flatMap((reply) => [reply, reply]));
  await assertFailure(adapter.execute(seed), "Decodo target requires login");
  await assertFailure(adapter.execute(seed), "Decodo target requires login");
  assert.equal(calls.length, 4);
});

test("deduplicates repeated boilerplate blocks in both HTML and Markdown before clipping to 6000 chars", async () => {
  const repeatedNotice = "You cannot perform that action right now. Please reload the page to refresh your session state.";
  const repeatedHtml = Array.from({ length: 80 }, (_, i) =>
    `<div class="toast">${i % 2 === 0 ? repeatedNotice : `  ${repeatedNotice.toUpperCase()}  `}</div>`,
  ).join("");
  const html = `<!doctype html><html><head><title>Deduplicated Page</title></head><body><main>
    <h1>Project Overview</h1>
    <p>Clean technical documentation describing the architecture and verification invariants of the project.</p>
    ${repeatedHtml}
    <p>Final section confirming deterministic output after duplicate banner removal.</p>
  </main></body></html>`;
  const repeatedMdBlock = "> We value your privacy and use cookies to personalize content and analyze traffic across sessions.";
  const markdown = [
    "[Skip to main content](#main)",
    "* [Home](https://example.org/)\n* [Sign in](https://example.org/login)",
    "# Field Notes",
    repeatedMdBlock,
    "Detailed field notes covering distributed systems, storage layout, and verification methodology.",
    repeatedMdBlock.toUpperCase(),
    `  ${repeatedMdBlock}  `,
    "Closing remarks on reproducible builds.",
  ].join("\n\n");
  const { adapter } = fixture([() => scraped(html), () => scraped(markdown)]);

  const [htmlObs] = await adapter.execute(seed);
  const htmlContent = String(htmlObs?.finding.extra.content);
  assert.equal(htmlObs?.finding.extra.content_truncated, false);
  assert.equal(htmlContent.split(/cannot perform that action/i).length - 1, 1);
  assert.match(htmlContent, /Final section confirming deterministic output/);

  const [mdObs] = await adapter.execute(seed);
  const mdContent = String(mdObs?.finding.extra.content);
  assert.equal(mdObs?.finding.extra.content_format, "markdown");
  assert.equal(mdObs?.finding.extra.title, "Field Notes");
  assert.equal(mdObs?.finding.extra.preview, "Detailed field notes covering distributed systems, storage layout, and verification methodology.");
  assert.equal(mdObs?.finding.extra.description, mdObs?.finding.extra.preview);
  assert.doesNotMatch(mdContent, /Skip to main content/i);
  assert.equal(mdContent.split(/value your privacy and use cookies/i).length - 1, 1);
  assert.match(mdContent, /Closing remarks on reproducible builds/);
});

test("keeps local header and footer content while excluding global and explicit chrome", async () => {
  const sections = ["main", "article", "section", "div role=\"main\""];
  for (const region of sections) {
    const tag = region.split(" ")[0];
    const html = `<header><a href="/menu">Global menu</a></header>
      <${region}><header><h1>Jamie Example</h1><a href="/work">Selected work</a></header>
      <nav>Local navigation</nav><header role="banner">Explicit banner</header>
      <footer hidden>Hidden footer</footer><footer aria-hidden="true">Hidden clone</footer>
      <footer>Published recently</footer></${tag}><footer><a href="/languages">Languages</a></footer>`;
    const { adapter, calls } = fixture([() => scraped(html)]);
    const [result] = await adapter.execute(seed);
    assert.equal(result?.finding.extra.content, "# Jamie Example\nSelected work\nPublished recently", region);
    assert.equal(result?.finding.extra.links, "https://example.org/work");
    assert.equal(calls.length, 1);
  }
});

test("adds only bounded, deduplicated factual JSON-LD and validated non-asset links", async () => {
  const rawSchema = (value: string) => `<script type="application/ld+json">${value}</script>`;
  const schema = (value: unknown) => rawSchema(JSON.stringify(value));
  const html = `<html><head>${rawSchema("{invalid")}
    ${schema({ name: "Oversized UTF-8 block", description: "é".repeat(33000) })}
    ${schema({ "@graph": [{ mainEntity: {
      name: "JAMIE EXAMPLE", alternateName: "Jamie E.", jobTitle: "Research engineer",
      description: "Builds &lt;svg onload=alert(1)&gt; research tools.",
      worksFor: { name: "Example Lab" }, alumniOf: [{ name: "Example College" }],
      address: { streetAddress: "Unlisted street", addressLocality: "Córdoba" },
      knowsAbout: ["Software testing", "software testing"], telephone: "Not public evidence",
      url: "https://example.org/work#about",
      sameAs: ["https://example.net/bio", "https://example.net/vol%2E3", "http://127.0.0.1/", "https://x.test/photo.png", "https://x.test/portrait.avif",
        "https://x.test/portrait%2Epng", "https://name:pass@example.net/", "javascript:alert(1)"],
    } }] })}
    ${rawSchema('{"__proto__":{"name":"Inherited text"},"mainEntity":{"constructor":{"name":"Inherited field"}}}')}
    ${Array.from({ length: 4 }, () => schema([])).join("")}${schema({ name: "Ignored ninth block" })}
    <script>{"name":"Not JSON-LD"}</script></head><body><main><h1>Jamie Example</h1>
    <a href="/work">Selected work</a></main></body></html>`;
  const { adapter, calls } = fixture([() => scraped(html)]);
  const [result] = await adapter.execute(seed);
  const extra = result!.finding.extra;
  assert.equal(extra.content, ["# Jamie Example", "Selected work", "Jamie E.", "Builds &lt;svg onload=alert(1)> research tools.",
    "Research engineer", "Software testing", "Example Lab", "Example College", "Córdoba"].join("\n"));
  assert.equal(extra.links, "https://example.org/work\nhttps://example.net/bio\nhttps://example.net/vol%2E3");
  assert.equal(extra.content_truncated, false);
  assert.equal(calls.length, 1);
  assert.equal(Object.hasOwn(Object.prototype, "name"), false);
});

test("ignores hidden, chrome, oversized raw, and invalid JSON-LD blocks", async () => {
  const html = `<html><body><main><h1>Public profile</h1>
    ${["hidden", 'aria-hidden="true"', 'aria-modal="true"', 'role="banner"'].map((attribute, i) =>
      `<script type="application/ld+json" ${attribute}>{"name":"Hidden claim ${i}","url":"https://example.org/hidden-${i}"}</script>`).join("")}
    <script type="application/ld+json">${"\r\n".repeat(33000)}{"name":"Above raw limit"}</script>
    <script type="application/ld+json">{"name":"Invalid\u0001metadata"}</script>
    <script type="application/ld+json">{"headline":"Visible claim"}</script></main></body></html>`;
  const { adapter, calls } = fixture([() => scraped(html)]);
  const [result] = await adapter.execute(seed);
  assert.equal(result?.finding.extra.content, "# Public profile\nVisible claim");
  assert.equal(result?.finding.extra.links, undefined);
  assert.equal(calls.length, 1);
});

test("retains descriptive alt text in visible primary regions without image URLs or icon text", async () => {
  const html = `<body><img alt="A descriptive caption outside the primary region">
    <main><h1>A workshop</h1><article>
      <img src="https://example.org/private.png" alt="An open course on testing &amp; software">
      <img alt="An open course on testing &amp; software">
      <img alt="abcdefghijklmnopqrstuvwx"><img alt="Too few verylongwordsindeed">
      <img alt="Profile picture of the workshop presenter">
      <img hidden alt="Another caption that is not displayed">
      <div aria-hidden="true"><img alt="A repeated caption from hidden content"></div>
      <nav><img alt="A caption placed inside site navigation"></nav>
      <img alt="Students &lt;img onerror=alert(1)&gt; reviewing an example">
    </article></main></body>`;
  const { adapter, calls } = fixture([() => scraped(html)]);
  const [result] = await adapter.execute(seed);
  assert.equal(result?.finding.extra.content,
    "# A workshop\nAn open course on testing & software\nStudents &lt;img onerror=alert(1)> reviewing an example");
  assert.equal(result?.finding.extra.links, undefined);
  assert.equal(calls.length, 1);
});

const loginWall = () => scraped("<h1>Sign in</h1>", { url: "https://example.org/authwall" });
const empty = () => scraped("<body><script>discard</script> &nbsp; </body>");

test("retries a headless login or empty page once and keeps only the public fallback finding", async () => {
  for (const first of [loginWall, empty]) {
    const { adapter, calls } = fixture([first, () => scraped("<main><h1>Public page</h1><p>Public biography for visitors.</p></main>", { task_id: "fallback" })]);
    const [result, ...rest] = await adapter.execute(seed);
    assert.deepEqual(rest, []);
    assert.equal(result?.finding.extra.content, "# Public page\nPublic biography for visitors.");
    assert.equal(result?.finding.extra.task_id, "fallback");
    assert.equal(result?.finding.url, seed.value);
    assert.equal(calls.length, 2);
    assertRequest(calls[0]!, WEB_DATA, `Bearer ${TOKEN}`);
    assertRequest(calls[1]!, WEB_DATA, `Bearer ${TOKEN}`, false);
  }
});

test("unrelated structured site metadata does not turn a sign-in shell into a finding", async () => {
  const shell = `<html><head><title>Sign in</title><script type="application/ld+json">${JSON.stringify({
    "@type": "WebSite", name: "Welcome", description: "Public stories about local communities and engineering projects. ".repeat(6),
  })}</script></head><body><main><h1>Sign in</h1><p>Welcome</p></main></body></html>`;
  const { adapter, calls } = fixture([() => scraped(shell), () => scraped("<main><h1>Public fallback profile</h1></main>")]);
  const [result] = await adapter.execute(seed);
  assert.equal(result?.finding.extra.content, "# Public fallback profile");
  assert.equal(calls.length, 2);
  assertRequest(calls[1]!, WEB_DATA, `Bearer ${TOKEN}`, false);

  const body = "Builds software for scientific experiments and maintains public research tools. ".repeat(4).trim();
  for (const type of ["WebSite", "Person"]) {
    const branded = `<html><head><title>Sign in | Civic Library</title><script type="application/ld+json">${JSON.stringify({
      "@type": type, name: "Civic Library", description: body,
    })}</script></head><main><h1>Civic Library</h1><form><button>Sign in</button></form></main></html>`;
    const brandedFixture = fixture([() => scraped(branded), () => scraped(branded)]);
    await assertFailure(brandedFixture.adapter.execute(seed), "Decodo target requires login");
    assert.equal(brandedFixture.calls.length, 2);
    assertRequest(brandedFixture.calls[1]!, WEB_DATA, `Bearer ${TOKEN}`, false);
  }
  const profile = `<html><head><title>Sign in | Community</title><script type="application/ld+json">${JSON.stringify({
    "@type": "Person", name: "Jamie Example", description: body,
  })}</script></head><main><h1>Jamie Example</h1></main></html>`;
  const publicFixture = fixture([() => scraped(profile)]);
  const [publicResult] = await publicFixture.adapter.execute(seed);
  assert.equal(publicResult?.finding.extra.content, `# Jamie Example\n${body}`);
  assert.equal(publicFixture.calls.length, 1);
});

test("stops after the second request and retains the relevant public error", async () => {
  const blocked = () => scraped(PRIVATE_BODY, { status_code: 999 });
  for (const [first, second, message] of [
    [loginWall, loginWall, "Decodo target requires login"],
    [loginWall, blocked, "Decodo target requires login"],
    [empty, empty, "Decodo returned empty page content"],
    [empty, loginWall, "Decodo target requires login"],
    [blocked, empty, "Decodo returned empty page content"],
  ] as const) {
    const { adapter, calls } = fixture([first, second]);
    await assertFailure(adapter.execute(seed), message);
    assert.equal(calls.length, 2);
    assertRequest(calls[0]!, WEB_DATA, `Bearer ${TOKEN}`);
    assertRequest(calls[1]!, WEB_DATA, `Bearer ${TOKEN}`, false);
  }
});

test("preserves XSS entity escaping across title, description, preview, and cleaned content", async () => {
  const html = `<!doctype html><html><head>
    <title>Alert &lt;script&gt;alert(1)&lt;/script&gt;</title>
    <meta name="description" content="Bio &lt;img src=x onerror=alert(1)&gt; safe">
  </head><body><main>
    <p>Inline &#60;svg onload=alert(1)&#62; and &lt;/main&gt;&lt;script&gt;evil()&lt;/script&gt; text.</p>
  </main></body></html>`;
  const { adapter } = fixture([() => scraped(html)]);
  const [observation] = await adapter.execute(seed);
  const extra = observation!.finding.extra;
  assert.equal(extra.title, "Alert &lt;script>alert(1)&lt;/script>");
  assert.equal(extra.description, "Bio &lt;img src=x onerror=alert(1)> safe");
  assert.equal(extra.preview, "Bio &lt;img src=x onerror=alert(1)> safe");
  assert.equal(extra.content, "Inline &lt;svg onload=alert(1)> and &lt;/main>&lt;script>evil()&lt;/script> text.");
  for (const field of [extra.title, extra.description, extra.preview, extra.content]) {
    assert.doesNotMatch(String(field), /<[a-z!/]/i);
  }
});

test("preserves generic HTML heading levels for section context without polluting preview", async () => {
  const html = `<!doctype html><html><head><title>Ada Lovelace</title></head><body><main>
    <h1>Ada Lovelace</h1>
    <p>Analytical engine researcher in London.</p>
    <section><h2>About</h2><p>Designs algorithms and mathematical notation.</p></section>
    <section><h3>Activity</h3><p>Liked a post by Charles Babbage about mechanical gears.</p></section>
  </main></body></html>`;
  const { adapter } = fixture([() => scraped(html)]);
  const [observation] = await adapter.execute(seed);
  const extra = observation!.finding.extra;
  assert.equal(extra.preview, "Ada Lovelace");
  assert.equal(extra.content, [
    "# Ada Lovelace",
    "Analytical engine researcher in London.",
    "## About",
    "Designs algorithms and mathematical notation.",
    "### Activity",
    "Liked a post by Charles Babbage about mechanical gears.",
  ].join("\n"));
});

test("accepts a concise public guest profile under 250 chars when sign-in modals exist in the DOM", async () => {
  const html = `<!doctype html><html><head>
    <title>Ada Lovelace | Network</title>
    <script type="application/ld+json">${JSON.stringify({
      "@type": "Person", name: "Ada Lovelace", jobTitle: "Systems Student",
      worksFor: { "@type": "Organization", name: "Analytical Group" },
      alumniOf: { "@type": "CollegeOrUniversity", name: "University of London" },
    })}</script>
  </head><body>
    <main>
      <h1>Ada Lovelace</h1>
      <h3>London, United Kingdom</h3>
      <p>Analytical Group · University of London</p>
      <h2>About</h2>
      <p>Final-year computer science student focusing on distributed systems.</p>
      <div role="dialog" aria-modal="true">
        <h2>Sign in to view Ada's full profile</h2>
        <form><input type="email"><input type="password"><button type="submit">Sign in</button></form>
      </div>
      <section>
        <form><h2>Welcome back</h2><input type="password"><button type="submit">Sign in</button></form>
      </section>
    </main>
  </body></html>`;
  const { adapter, calls } = fixture([() => scraped(html)]);
  const [observation] = await adapter.execute(seed);
  const content = String(observation!.finding.extra.content);
  assert.equal(calls.length, 1);
  assert.match(content, /^# Ada Lovelace/m);
  assert.match(content, /^## About$/m);
  assert.match(content, /Final-year computer science student/);
  assert.doesNotMatch(content, /Sign in to view|Welcome back/);
});

test("still rejects a page-level sign-in wall with non-modal gate heading and marketing lines under 250 chars", async () => {
  const wall = `<!doctype html><html><head><title>Portal</title></head><body><main>
    <h1>Sign in to your account</h1>
    <p>Discover opportunities and connect with professionals across industries worldwide.</p>
    <p>Build your network every day with curated updates.</p>
    <p>Already have credentials ready?</p>
    <form><input type="email"><input type="password"><button type="submit">Sign in</button></form>
  </main></body></html>`;
  const { adapter, calls } = fixture([() => scraped(wall), () => scraped(wall)]);
  await assertFailure(adapter.execute(seed), "Decodo target requires login");
  assert.equal(calls.length, 2);
});

test("heading markers do not change which visible subject corroborates JSON-LD", async () => {
  const heading = "A detailed guide to restoring historic instruments, maintaining public archives, and documenting workshop practice";
  assert.ok(heading.length < 120 && heading.length + 7 >= 120);
  const html = `<html><head><script type="application/ld+json">
    {"@type":"Person","name":"Ada Lovelace"}
    </script></head><body><p>Ada Lovelace</p><main><h6>${heading}</h6></main></body></html>`;
  const { adapter } = fixture([() => scraped(html)]);
  const [result] = await adapter.execute(seed);
  assert.equal(result?.finding.extra.preview, "Ada Lovelace");
  assert.equal(result?.finding.extra.content, `Ada Lovelace\n###### ${heading}`);
});

test("a page-level form heading is still a login signal when marketing surrounds it", async () => {
  const html = `<main>
    <p>Discover opportunities and connect with professionals across industries worldwide.</p>
    <p>Build your network every day with curated updates.</p>
    <p>Membership benefits and resources</p>
    <form><h1>Sign in to your account</h1><input type="password"><button>Sign in</button></form>
    </main>`;
  const { adapter, calls } = fixture([() => scraped(html), () => scraped(html)]);
  await assertFailure(adapter.execute(seed), "Decodo target requires login");
  assert.equal(calls.length, 2);
});

test("a two-line public profile remains readable beside a contextual sign-in dialog", async () => {
  const html = `<main><h1>Ada Lovelace</h1><p>Studies public archives.</p>
    <dialog><h2>Sign in to follow Ada</h2><form><input type="password">
    <button>Sign in</button></form></dialog></main>`;
  const { adapter, calls } = fixture([() => scraped(html)]);
  const [result] = await adapter.execute(seed);
  assert.equal(result?.finding.extra.content, "# Ada Lovelace\nStudies public archives.");
  assert.equal(calls.length, 1);
});
