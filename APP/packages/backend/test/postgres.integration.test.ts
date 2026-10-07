import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import {
  createInvestigationService,
  type ClaimActionRequest,
  type CompleteActionInput,
  type InvestigationExecutor,
} from "@investia/core";
import { PostgresInvestigationStore } from "../src/postgres-investigation-store.ts";

const testDatabaseUrl = process.env.INVESTIA_TEST_DATABASE_URL;

test("real PostgreSQL rejects JSON null investigation identity and revision values", {
  skip: testDatabaseUrl === undefined ? "Set INVESTIA_TEST_DATABASE_URL to a dedicated *_test database" : false,
}, async () => {
  if (testDatabaseUrl === undefined) return;
  const database = new URL(testDatabaseUrl);
  const databaseName = decodeURIComponent(database.pathname.slice(1));
  assert.ok(databaseName.toLowerCase().endsWith("_test"), "integration URL must name a dedicated *_test database");

  const pool = new Pool({ connectionString: testDatabaseUrl, max: 1, application_name: "investia-schema-constraint-test" });
  try {
    await new PostgresInvestigationStore(pool).migrate();
    const at = "2025-03-01T00:00:00.000Z";
    const nullRevisionId = randomUUID();
    const invalidDocuments = [
      { id: randomUUID(), document: { id: null, revision: 0 } },
      { id: nullRevisionId, document: { id: nullRevisionId, revision: null } },
    ];
    for (const { id, document } of invalidDocuments) {
      await assert.rejects(
        pool.query(
          "INSERT INTO investigations (id, schema_version, revision, created_at, updated_at, document) VALUES ($1, 1, 0, $2, $2, $3::jsonb)",
          [id, at, JSON.stringify(document)],
        ),
        (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "23514",
      );
    }
  } finally {
    await pool.end();
  }
});

test("real PostgreSQL serializes claims and retains claim fencing across reconnect", {
  skip: testDatabaseUrl === undefined ? "Set INVESTIA_TEST_DATABASE_URL to a dedicated *_test database" : false,
}, async () => {
  if (testDatabaseUrl === undefined) return;
  const database = new URL(testDatabaseUrl);
  const databaseName = decodeURIComponent(database.pathname.slice(1));
  assert.ok(databaseName.toLowerCase().endsWith("_test"), "integration URL must name a dedicated *_test database");

  const firstPool = new Pool({ connectionString: testDatabaseUrl, max: 4, application_name: "investia-backend-test" });
  let reopenedPool: Pool | undefined;
  try {
    const store = new PostgresInvestigationStore(firstPool);
    await store.migrate();
    let ticks = 0;
    const executor: InvestigationExecutor = { id: "unused-integration-executor", async execute() { return []; } };
    const service = createInvestigationService({
      store,
      executor,
      clock: () => new Date(Date.now() + ticks++).toISOString(),
      createId: (kind) => `${kind}-${randomUUID()}`,
    });
    const investigation = await service.createInvestigation();
    await service.addEmailSeed(investigation.id, `${randomUUID()}@example.org`, "Dedicated PostgreSQL integration test.");
    const current = await store.get(investigation.id);
    const email = current!.emailSeeds[0]!.value;
    const action = await service.proposeGitHubAction(investigation.id, email, "Test a persisted action claim.");
    await service.authorize(investigation.id, true, "Integration test authorization.");
    await service.approveAction(investigation.id, action.id, "Integration test approval.");

    const claimRequest = (claimId: string): ClaimActionRequest => ({
      investigationId: investigation.id,
      claimId,
      claimedAt: new Date().toISOString(),
      auditEvent: {
        id: `audit-${claimId}`,
        at: new Date().toISOString(),
        actor: "system",
        kind: "action_claimed",
        reason: "Integration test claim.",
      },
    });
    const claims = await Promise.all([
      store.claimNextAction(claimRequest(`claim-${randomUUID()}`)),
      store.claimNextAction(claimRequest(`claim-${randomUUID()}`)),
    ]);
    assert.equal(claims.filter((claim) => claim !== undefined).length, 1);
    const claim = claims.find((candidate) => candidate !== undefined)!;
    assert.equal(claim.action.status, "claimed");
    assert.equal(claim.permit.authorized && claim.permit.approved && !claim.permit.paused, true);

    await firstPool.end();
    reopenedPool = new Pool({ connectionString: testDatabaseUrl, max: 2, application_name: "investia-backend-reconnect-test" });
    const reopenedStore = new PostgresInvestigationStore(reopenedPool);
    assert.equal((await reopenedStore.get(investigation.id))?.actions[0]?.status, "claimed");
    assert.equal(await reopenedStore.claimNextAction(claimRequest(`claim-${randomUUID()}`)), undefined);

    const completedAt = new Date().toISOString();
    const completion: CompleteActionInput = {
      investigationId: investigation.id,
      actionId: action.id,
      claimId: claim.action.claim.id,
      completedAt,
      result: { kind: "success", evidence: [], unsupportedObservationCount: 0 },
      auditEvent: {
        id: `audit-${randomUUID()}`,
        at: completedAt,
        actor: "system",
        kind: "action_succeeded",
        reason: "Integration test completion.",
      },
    };
    await assert.rejects(reopenedStore.completeAction({ ...completion, claimId: "stale-claim" }));
    assert.equal((await reopenedStore.get(investigation.id))?.actions[0]?.status, "claimed");
    const completed = await reopenedStore.completeAction(completion);
    assert.equal(completed.actions[0]?.status, "succeeded");
    assert.equal((await reopenedStore.get(investigation.id))?.actions[0]?.status, "succeeded");
  } finally {
    if (reopenedPool !== undefined && !reopenedPool.ended) await reopenedPool.end();
    if (!firstPool.ended) await firstPool.end();
  }
});
