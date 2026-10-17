import assert from "node:assert/strict";
import test from "node:test";
import { createInitialInvestigation, createSeedBoxExecutor, type ActionClaim, type GitHubCatalogAction } from "../src/index.ts";

test("a scanner executor refuses historical GitHub-only actions without dispatch", async () => {
  let calls = 0;
  const executor = createSeedBoxExecutor({
    id: "user-scanner:email", inputKind: "email",
    async execute() { calls++; return []; },
  });
  const action: GitHubCatalogAction = {
    id: "legacy", spec: { catalogId: "github.email-registration.v1", provider: "github", seed: { kind: "email", value: "person@example.org" } },
    status: "claimed", proposedAt: "2025-01-01T00:00:00Z", proposalReason: "Historical approval",
    claim: { id: "claim", claimedAt: "2025-01-01T00:00:00Z" },
  };
  await assert.rejects(executor.execute(action as ActionClaim["action"], { authorized: true, approved: true, paused: false }), /retired/i);
  assert.equal(calls, 0);
});

test("historical evidence remains valid without scanner fields", () => {
  const investigation = createInitialInvestigation("old", "2025-01-01T00:00:00Z");
  assert.deepEqual(investigation.evidence, []);
});
