import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { Pool } from "pg";
import { createInvestigationService, type InvestigationExecutor } from "@investia/core";
import { createInvestigationRunGraph } from "../src/investigation-run-graph.ts";
import { PostgresInvestigationStore } from "../src/postgres-investigation-store.ts";

const testDatabaseUrl = process.env.INVESTIA_TEST_DATABASE_URL;

test("PostgresSaver resumes the investigation thread without replaying a completed action", {
  skip: testDatabaseUrl === undefined ? "Set INVESTIA_TEST_DATABASE_URL to a dedicated *_test database" : false,
}, async () => {
  if (testDatabaseUrl === undefined) return;
  const databaseName = decodeURIComponent(new URL(testDatabaseUrl).pathname.slice(1));
  assert.ok(databaseName.toLowerCase().endsWith("_test"), "integration URL must name a dedicated *_test database");

  const pool = new Pool({ connectionString: testDatabaseUrl, max: 4, application_name: "investia-checkpoint-test" });
  try {
    const store = new PostgresInvestigationStore(pool);
    await store.migrate();
    const firstCheckpointer = new PostgresSaver(pool);
    await firstCheckpointer.setup();
    let ticks = 0;
    let executions = 0;
    const executor: InvestigationExecutor = {
      id: "offline-postgres-checkpoint-test",
      async execute() {
        executions++;
        return [];
      },
    };
    const service = createInvestigationService({
      store,
      executor,
      clock: () => new Date(Date.now() + ticks++).toISOString(),
      createId: (kind) => `${kind}-${randomUUID()}`,
    });
    const investigation = await service.createInvestigation();
    const email = `${randomUUID()}@example.org`;
    await service.addEmailSeed(investigation.id, email, "Dedicated checkpoint integration test.");
    const action = await service.proposeGitHubAction(investigation.id, email, "Test durable graph execution.");
    await service.authorize(investigation.id, true, "Integration authorization.");
    await service.approveAction(investigation.id, action.id, "Integration approval.");

    const firstProcess = createInvestigationRunGraph(service, firstCheckpointer);
    assert.equal((await firstProcess.run(investigation.id))?.status, "succeeded");
    const reopenedCheckpointer = new PostgresSaver(pool);
    const restartedProcess = createInvestigationRunGraph(service, reopenedCheckpointer);
    assert.equal(await restartedProcess.run(investigation.id), undefined);
    assert.equal(executions, 1);

    const checkpoint = await reopenedCheckpointer.getTuple({ configurable: { thread_id: investigation.id } });
    assert.ok(checkpoint, "checkpoint is durable across graph/checkpointer reconstruction");
    assert.doesNotMatch(JSON.stringify(checkpoint.checkpoint.channel_values), new RegExp(email));
  } finally {
    await pool.end();
  }
});
