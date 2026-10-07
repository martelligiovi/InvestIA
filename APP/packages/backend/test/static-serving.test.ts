import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import type { InvestigationService } from "@investia/core";
import { createBackendApp } from "../src/api.ts";
import type { BackendAppAdapters } from "../src/api.ts";
import { resolveFrontendDistPath } from "../src/serve-frontend.ts";

function makeFixtureRoot(t: TestContext, beforeRemove: () => void | Promise<void> = () => undefined): string {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "investia-frontend-test-"));
  t.after(async () => {
    try {
      await beforeRemove();
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
      assert.equal(existsSync(fixtureRoot), false, "the test-owned fixture root is removed after its lifecycle");
    }
  });
  return fixtureRoot;
}

function createApp(frontendDistPath?: string, onFrontendUnavailable?: () => void) {
  const service = { async listInvestigations() { return []; } } as unknown as InvestigationService;
  const adapters = {
    actionRunner: {},
    projector: {},
  } as unknown as BackendAppAdapters;
  const options = {
    ...(frontendDistPath === undefined ? {} : { frontendDistPath }),
    ...(onFrontendUnavailable === undefined ? {} : { onFrontendUnavailable }),
  };
  return createBackendApp(service, adapters, options);
}

test("serves the built frontend safely while keeping unknown API and asset requests as JSON 404s", async (t) => {
  let app: ReturnType<typeof createApp> | undefined;
  const fixtureRoot = makeFixtureRoot(t, async () => {
    if (app !== undefined) await app.close();
  });
  const dist = join(fixtureRoot, "dist");
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(join(dist, "index.html"), "<!doctype html><main>built frontend</main>");
  writeFileSync(join(dist, "assets", "app.js"), "console.log('built asset');");
  mkdirSync(join(dist, "investigations", "unknown"), { recursive: true });
  writeFileSync(join(dist, "investigations", "unknown", "extra"), "static files never replace API 404s");
  writeFileSync(join(fixtureRoot, "secret.txt"), "outside dist must never be served");
  let symlinkCreated = false;
  try {
    symlinkSync(join(fixtureRoot, "secret.txt"), join(dist, "assets", "escape.txt"), "file");
    symlinkCreated = true;
  } catch (error) {
    if (typeof error !== "object" || error === null || !("code" in error) ||
      !["EPERM", "EACCES", "ENOSYS"].includes(String(error.code))) throw error;
  }

  app = createApp(dist);

  const home = await app.inject({ method: "GET", url: "/" });
  assert.equal(home.statusCode, 200);
  assert.match(home.headers["content-type"] ?? "", /text\/html/);
  assert.equal(home.body, "<!doctype html><main>built frontend</main>");
  assert.match(home.headers["cache-control"] ?? "", /no-cache|no-store|max-age=0/);

  const explicitIndex = await app.inject({ method: "GET", url: "/index.html" });
  assert.equal(explicitIndex.statusCode, 200);
  assert.match(explicitIndex.headers["cache-control"] ?? "", /no-cache|no-store|max-age=0/);

  const asset = await app.inject({ method: "GET", url: "/assets/app.js" });
  assert.equal(asset.statusCode, 200);
  assert.match(asset.headers["content-type"] ?? "", /javascript/);
  assert.match(asset.headers["cache-control"] ?? "", /max-age=/);
  assert.ok(asset.headers.etag);
  assert.equal(asset.body, "console.log('built asset');");

  const unknownAsset = await app.inject({ method: "GET", url: "/assets/missing.js" });
  assert.equal(unknownAsset.statusCode, 404);
  assert.doesNotMatch(unknownAsset.body, /built frontend/);

  for (const url of ["/invented-route", "/assets/%2e%2e/secret.txt", "/%2e%2e/secret.txt"]) {
    const response = await app.inject({ method: "GET", url });
    assert.notEqual(response.statusCode, 200, `${url} must not be served`);
    assert.doesNotMatch(response.body, /outside dist must never be served/);
  }

  if (symlinkCreated) {
    const symlinkEscape = await app.inject({ method: "GET", url: "/assets/escape.txt" });
    assert.equal(symlinkEscape.statusCode, 404);
    assert.doesNotMatch(symlinkEscape.body, /outside dist must never be served/);
  }

  const unknownApiPath = await app.inject({ method: "GET", url: "/investigations/unknown/extra" });
  assert.equal(unknownApiPath.statusCode, 404);
  assert.match(unknownApiPath.headers["content-type"] ?? "", /application\/json/);
  assert.deepEqual(unknownApiPath.json(), { error: "NOT_FOUND", message: "Not found" });

  const unknownApiMethod = await app.inject({ method: "PATCH", url: "/investigations" });
  assert.equal(unknownApiMethod.statusCode, 404);
  assert.match(unknownApiMethod.headers["content-type"] ?? "", /application\/json/);
  assert.deepEqual(unknownApiMethod.json(), { error: "NOT_FOUND", message: "Not found" });
});

test("serves the real Vite build from its module-relative path when the build exists", async (t) => {
  const dist = resolveFrontendDistPath();
  if (!existsSync(join(dist, "index.html"))) {
    t.skip("Build the frontend to exercise the production static root.");
    return;
  }
  const originalCwd = process.cwd();
  let app: ReturnType<typeof createApp> | undefined;
  const unrelatedCwd = makeFixtureRoot(t, async () => {
    try {
      if (app !== undefined) await app.close();
    } finally {
      process.chdir(originalCwd);
    }
  });
  try {
    process.chdir(unrelatedCwd);
    app = createApp();
  } finally {
    process.chdir(originalCwd);
  }

  const indexHtml = readFileSync(join(dist, "index.html"), "utf8");
  const home = await app.inject({ method: "GET", url: "/" });
  assert.equal(home.statusCode, 200);
  assert.equal(home.body, indexHtml);
  const assetPath = indexHtml.match(/src="(\/assets\/[^\"]+\.js)"/)?.[1];
  assert.ok(assetPath);
  const asset = await app.inject({ method: "GET", url: assetPath });
  assert.equal(asset.statusCode, 200);
  assert.match(asset.headers["content-type"] ?? "", /javascript/);
});

test("resolves the frontend build beside the server module regardless of the working directory", (t) => {
  const expected = resolve(
    dirname(fileURLToPath(new URL("../src/serve-frontend.ts", import.meta.url))),
    "../../frontend/dist",
  );
  const originalCwd = process.cwd();
  const unrelatedCwd = makeFixtureRoot(t, () => process.chdir(originalCwd));
  try {
    process.chdir(unrelatedCwd);
    assert.equal(resolve(resolveFrontendDistPath()), expected);
  } finally {
    process.chdir(originalCwd);
  }
});

test("a missing frontend build leaves the API available without an SPA fallback", async (t) => {
  let app: ReturnType<typeof createApp> | undefined;
  const missingDist = join(makeFixtureRoot(t, async () => {
    if (app !== undefined) await app.close();
  }), "not-built");
  let startupNoticeCount = 0;
  app = createApp(missingDist, () => startupNoticeCount++);
  assert.equal(startupNoticeCount, 1);

  const api = await app.inject({ method: "GET", url: "/investigations" });
  assert.equal(api.statusCode, 200);
  assert.deepEqual(api.json(), []);

  const home = await app.inject({ method: "GET", url: "/" });
  assert.equal(home.statusCode, 404);
  assert.match(home.headers["content-type"] ?? "", /application\/json/);
});
