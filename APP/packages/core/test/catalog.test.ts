import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizationCovers,
  CATALOG_INPUT_KINDS,
  createCatalogExecutor,
  SCOPED_CATALOG_IDS,
  type ActionClaim,
  type AuthorizationRecord,
  type GitHubCatalogAction,
} from "../src/index.ts";

const permit = { authorized: true, approved: true, paused: false } as const;
const base = { at: "2025-01-01T00:00:00Z", reason: "Operator consent", operator: "local-operator" } as const;

function claimed(spec: GitHubCatalogAction["spec"]): ActionClaim["action"] {
  return {
    id: "action", spec, status: "claimed", proposedAt: base.at, proposalReason: "Catalog queue",
    queuedByCatalog: true, claim: { id: "claim", claimedAt: base.at },
  };
}

const scannerSpec = { catalogId: "user-scanner.email.v1", provider: "user-scanner", seed: { kind: "email", value: "person@example.org" } } as const;

test("authorization covers a tool only through an explicit scope", () => {
  const current: AuthorizationRecord = { ...base, granted: true, catalogScopes: ["user-scanner.email.v1"] };
  const singleScope: AuthorizationRecord = { ...base, granted: true, catalogScope: "user-scanner.email.v1" };
  const unscoped: AuthorizationRecord = { ...base, granted: true };
  const emptyScopes: AuthorizationRecord = { ...base, granted: true, catalogScopes: [] };
  const revoked: AuthorizationRecord = { ...base, granted: false, catalogScopes: ["user-scanner.email.v1"] };
  assert.equal(authorizationCovers(current, "user-scanner.email.v1"), true);
  assert.equal(authorizationCovers(singleScope, "user-scanner.email.v1"), true, "single-scope grants stay valid");
  assert.equal(authorizationCovers(unscoped, "user-scanner.email.v1"), false, "legacy grants never broaden");
  assert.equal(authorizationCovers(emptyScopes, "user-scanner.email.v1"), false);
  assert.equal(authorizationCovers(revoked, "user-scanner.email.v1"), false);
  assert.equal(authorizationCovers(undefined, "user-scanner.email.v1"), false);
  assert.equal(authorizationCovers(unscoped, "github.email-registration.v1"), true, "historical actions keep their gate");
  assert.equal(authorizationCovers(current, "unknown.tool.v1"), false);
  assert.equal(authorizationCovers(current, "gravatar.email.v1"), false, "a user-scanner grant never covers Gravatar");
  assert.equal(authorizationCovers(singleScope, "gravatar.email.v1"), false);
  assert.equal(authorizationCovers({ ...current, catalogScopes: ["user-scanner.email.v1", "gravatar.email.v1"] }, "gravatar.email.v1"), true);
});

test("the scoped catalog lists every consentable tool and its input kind", () => {
  assert.deepEqual(SCOPED_CATALOG_IDS, ["user-scanner.email.v1", "gravatar.email.v1", "maigret.username.v1"]);
  assert.deepEqual(CATALOG_INPUT_KINDS, {
    "user-scanner.email.v1": "email", "gravatar.email.v1": "email", "maigret.username.v1": "username",
  });
  const scannerAndGravatar: AuthorizationRecord = { ...base, granted: true, catalogScopes: ["user-scanner.email.v1", "gravatar.email.v1"] };
  assert.equal(authorizationCovers(scannerAndGravatar, "maigret.username.v1"), false, "earlier grants never cover Maigret");
});

test("catalog executor routes username actions to a username box", async () => {
  const seen: string[] = [];
  const executor = createCatalogExecutor({
    "maigret.username.v1": { id: "maigret:username", inputKind: "username", async execute(seed) { seen.push(`${seed.kind}:${seed.value}`); return []; } },
  });
  const action = claimed({ catalogId: "maigret.username.v1", provider: "maigret", seed: { kind: "username", value: "anaexample" } });
  await executor.execute(action, permit);
  assert.deepEqual(seen, ["username:anaexample"]);
  assert.equal(executor.sourceIdFor?.(action), "maigret:username");
  assert.throws(() => createCatalogExecutor({
    "maigret.username.v1": { id: "wrong", inputKind: "email", async execute() { return []; } },
  } as unknown as Parameters<typeof createCatalogExecutor>[0]), /requires a username SeedBox/);
});

test("catalog executor dispatches each action to the box registered for its catalog id", async () => {
  const seen: string[] = [];
  const executor = createCatalogExecutor({
    "user-scanner.email.v1": { id: "user-scanner:email", inputKind: "email", async execute(seed) { seen.push(seed.value); return []; } },
  });
  const action = claimed(scannerSpec);
  assert.deepEqual(await executor.execute(action, permit), []);
  assert.deepEqual(seen, ["person@example.org"]);
  assert.equal(executor.sourceIdFor?.(action), "user-scanner:email");
});

test("catalog executor refuses unregistered and historical catalogs without dispatch", async () => {
  let calls = 0;
  const executor = createCatalogExecutor({
    "user-scanner.email.v1": { id: "user-scanner:email", inputKind: "email", async execute() { calls++; return []; } },
  });
  const unknown = claimed({ ...scannerSpec, catalogId: "unknown.tool.v1" } as unknown as GitHubCatalogAction["spec"]);
  await assert.rejects(executor.execute(unknown, permit), /No tool is registered for catalog unknown\.tool\.v1/);
  const legacy = claimed({ catalogId: "github.email-registration.v1", provider: "github", seed: scannerSpec.seed });
  await assert.rejects(executor.execute(legacy, permit), /retired/i);
  const unclaimed = { ...claimed(scannerSpec), status: "queued" } as unknown as ActionClaim["action"];
  await assert.rejects(executor.execute(unclaimed, permit), /claimed action/i);
  await assert.rejects(executor.execute(claimed(scannerSpec), { ...permit, paused: true } as unknown as typeof permit), /paused/);
  assert.equal(calls, 0);
});

test("catalog executor rejects a box registered under an input kind it cannot accept", () => {
  assert.throws(() => createCatalogExecutor({
    "user-scanner.email.v1": { id: "wrong", inputKind: "username", async execute() { return []; } },
  } as unknown as Parameters<typeof createCatalogExecutor>[0]), /requires an email SeedBox/);
});
