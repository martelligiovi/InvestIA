import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import neo4j from "neo4j-driver";
import { Pool } from "pg";
import { createInvestigationService, type Investigation, type InvestigationExecutor } from "@investia/core";
import { createBackendApp } from "../src/api.ts";
import { createInvestigationRunGraph } from "../src/investigation-run-graph.ts";
import { Neo4jInvestigationProjector } from "../src/neo4j-investigation-projector.ts";
import { PostgresInvestigationStore } from "../src/postgres-investigation-store.ts";

const testDatabaseUrl = process.env.INVESTIA_TEST_DATABASE_URL;
const testNeo4jUri = process.env.INVESTIA_TEST_NEO4J_URI;
const testNeo4jUsername = process.env.INVESTIA_TEST_NEO4J_USERNAME;
const testNeo4jPassword = process.env.INVESTIA_TEST_NEO4J_PASSWORD;
const testNeo4jDatabase = process.env.INVESTIA_TEST_NEO4J_DATABASE ?? "neo4j";
const missingConfiguration = [
  ["INVESTIA_TEST_DATABASE_URL", testDatabaseUrl],
  ["INVESTIA_TEST_NEO4J_URI", testNeo4jUri],
  ["INVESTIA_TEST_NEO4J_USERNAME", testNeo4jUsername],
  ["INVESTIA_TEST_NEO4J_PASSWORD", testNeo4jPassword],
].filter(([, value]) => value === undefined).map(([name]) => name);

interface TestConfig {
  readonly databaseUrl: string;
  readonly neo4jUri: string;
  readonly neo4jUsername: string;
  readonly neo4jPassword: string;
  readonly neo4jDatabase: string;
}

interface WorkflowRuntime {
  readonly pool: Pool;
  readonly driver: ReturnType<typeof neo4j.driver>;
  readonly store: PostgresInvestigationStore;
  readonly checkpointer: PostgresSaver;
  readonly app: ReturnType<typeof createBackendApp>;
}

interface ExecutionRecord {
  readonly actionId: string;
  readonly email: string;
}

function openRuntime(config: TestConfig, namespace: string, executions: ExecutionRecord[]): Promise<WorkflowRuntime> {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: 4,
    application_name: "investia-workflow-integration-test",
  });
  const driver = neo4j.driver(
    config.neo4jUri,
    neo4j.auth.basic(config.neo4jUsername, config.neo4jPassword),
    { maxConnectionPoolSize: 10 },
  );
  const store = new PostgresInvestigationStore(pool);
  const checkpointer = new PostgresSaver(pool);

  return (async () => {
    try {
      await store.migrate();
      await checkpointer.setup();
      let ticks = 0;
      const executor: InvestigationExecutor = {
        id: "fake-workflow-integration-executor",
        async execute(action, permit) {
          assert.deepEqual(permit, { authorized: true, approved: true, paused: false });
          executions.push({ actionId: action.id, email: action.spec.seed.value });
          return [{
            kind: "registration",
            seed: action.spec.seed,
            provider: "github",
            status: "unknown",
          }];
        },
      };
      const service = createInvestigationService({
        store,
        executor,
        clock: () => new Date(Date.now() + ticks++).toISOString(),
        createId: (kind) => `${kind}-${namespace}-${randomUUID()}`,
      });
      const app = createBackendApp(service, {
        actionRunner: createInvestigationRunGraph(service, checkpointer),
        projector: new Neo4jInvestigationProjector(driver, config.neo4jDatabase),
      });
      return { pool, driver, store, checkpointer, app };
    } catch (error) {
      await Promise.allSettled([pool.end(), driver.close()]);
      throw error;
    }
  })();
}

async function closeRuntime(runtime: WorkflowRuntime): Promise<void> {
  const results = await Promise.allSettled([
    runtime.app.close(),
    runtime.pool.end(),
    runtime.driver.close(),
  ]);
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}

function assertLocalTestTargets(config: TestConfig): void {
  const postgres = new URL(config.databaseUrl);
  assert.ok(["postgres:", "postgresql:"].includes(postgres.protocol), "test URL must use PostgreSQL");
  assert.ok(["localhost", "127.0.0.1", "::1", "[::1]"].includes(postgres.hostname),
    "workflow integration must use a local PostgreSQL test service");
  const databaseName = decodeURIComponent(postgres.pathname.slice(1));
  assert.ok(databaseName.toLowerCase().endsWith("_test"), "integration URL must name a dedicated *_test database");

  const graph = new URL(config.neo4jUri);
  assert.ok(["neo4j:", "bolt:"].includes(graph.protocol), "test URI must use Neo4j Bolt protocol");
  assert.ok(["localhost", "127.0.0.1", "::1", "[::1]"].includes(graph.hostname),
    "workflow integration must use a local Neo4j test service");
}

function neo4jNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "object" && value !== null && "toNumber" in value && typeof value.toNumber === "function") {
    return value.toNumber();
  }
  return Number.NaN;
}

async function assertProjectedWorkflow(runtime: WorkflowRuntime, id: string, expected: Investigation): Promise<void> {
  const session = runtime.driver.session({ database: testNeo4jDatabase });
  try {
    const result = await session.run(`
      MATCH (i:Investigation {id: $id})
      OPTIONAL MATCH (i)-[:HAS_ACTION]->(action:CatalogAction)
      WITH i, count(DISTINCT action) AS actionCount
      OPTIONAL MATCH (i)-[:HAS_EVIDENCE]->(evidence:Evidence)
      WITH i, actionCount, count(DISTINCT evidence) AS evidenceCount
      OPTIONAL MATCH (i)-[:HAS_VALIDATION]->(validation:EvidenceValidation)
      WITH i, actionCount, evidenceCount, count(DISTINCT validation) AS validationCount
      OPTIONAL MATCH (i)-[:HAS_EVIDENCE]->(projectedEvidence:Evidence)-[:HAS_VALIDATION]->(linkedValidation:EvidenceValidation)
      RETURN i.revision AS revision, i.paused AS paused,
        i.authorizationGranted AS authorizationGranted, actionCount, evidenceCount, validationCount,
        count(DISTINCT linkedValidation) AS linkedValidationCount`,
    { id });
    assert.equal(result.records.length, 1, "Neo4j contains the uniquely identified investigation");
    const record = result.records[0]!;
    assert.equal(neo4jNumber(record.get("revision")), expected.revision);
    assert.equal(record.get("paused"), expected.paused);
    assert.equal(record.get("authorizationGranted"), expected.authorization?.granted ?? null);
    assert.equal(neo4jNumber(record.get("actionCount")), expected.actions.length);
    assert.equal(neo4jNumber(record.get("evidenceCount")), expected.evidence.length);
    assert.equal(neo4jNumber(record.get("validationCount")), expected.validations.length);
    assert.equal(neo4jNumber(record.get("linkedValidationCount")), expected.validations.length);
  } finally {
    await session.close();
  }
}

async function cleanupWorkflowData(config: TestConfig, id: string, checkpointTablesReady: boolean): Promise<void> {
  const pool = new Pool({ connectionString: config.databaseUrl, max: 2, application_name: "investia-workflow-cleanup" });
  const driver = neo4j.driver(
    config.neo4jUri,
    neo4j.auth.basic(config.neo4jUsername, config.neo4jPassword),
  );
  const failures: unknown[] = [];
  try {
    if (checkpointTablesReady) {
      for (const table of ["checkpoint_writes", "checkpoints", "checkpoint_blobs"]) {
        try {
          await pool.query(`DELETE FROM ${table} WHERE thread_id = $1`, [id]);
        } catch (error) {
          failures.push(error);
        }
      }
    }
    try {
      await pool.query("DELETE FROM investigations WHERE id = $1", [id]);
    } catch (error) {
      failures.push(error);
    }
    try {
      const session = driver.session({ database: config.neo4jDatabase });
      try {
        await session.run(
          "MATCH (node) WHERE (node:Investigation AND node.id = $id) OR node.investigationId = $id DETACH DELETE node",
          { id },
        );
      } finally {
        await session.close();
      }
    } catch (error) {
      failures.push(error);
    }
  } finally {
    await Promise.allSettled([pool.end(), driver.close()]);
  }
  if (failures.length > 0) throw new AggregateError(failures, "Could not clean all generated workflow integration data");
}

test("real API workflow persists PostgreSQL state and PostgresSaver checkpoints across runtime reconstruction", {
  skip: missingConfiguration.length > 0
    ? `Set ${missingConfiguration.join(", ")} to enable the PostgreSQL + Neo4j workflow integration`
    : false,
}, async () => {
  if (testDatabaseUrl === undefined || testNeo4jUri === undefined ||
      testNeo4jUsername === undefined || testNeo4jPassword === undefined) return;

  const config: TestConfig = {
    databaseUrl: testDatabaseUrl,
    neo4jUri: testNeo4jUri,
    neo4jUsername: testNeo4jUsername,
    neo4jPassword: testNeo4jPassword,
    neo4jDatabase: testNeo4jDatabase,
  };
  assertLocalTestTargets(config);

  const namespace = `workflow-${randomUUID()}`;
  const executions: ExecutionRecord[] = [];
  let runtime: WorkflowRuntime | undefined;
  let investigationId: string | undefined;
  let checkpointTablesReady = false;
  try {
    runtime = await openRuntime(config, namespace, executions);
    checkpointTablesReady = true;

    const created = await runtime.app.inject({
      method: "POST", url: "/investigations", payload: { name: "Local workflow T1" },
    });
    assert.equal(created.statusCode, 201);
    const createdInvestigation = created.json<{ id: string; name: string }>();
    investigationId = createdInvestigation.id;
    assert.equal(createdInvestigation.name, "Local workflow T1");
    assert.ok(investigationId.startsWith(`investigation-${namespace}-`));
    assert.equal((await runtime.app.inject({ method: "GET", url: "/investigations" })).statusCode, 200);
    assert.ok((await runtime.app.inject({ method: "GET", url: "/investigations" }))
      .json<{ id: string }[]>().some((item) => item.id === investigationId));
    assert.equal((await runtime.app.inject({ method: "GET", url: `/investigations/${investigationId}` })).statusCode, 200);

    const emails = [`first-${namespace}@example.org`, `second-${namespace}@example.org`];
    for (const email of emails) {
      assert.equal((await runtime.app.inject({ method: "POST", url: `/investigations/${investigationId}/emails`, payload: {
        email, reason: "Add a unique operator-supplied integration test seed.",
      } })).statusCode, 201);
    }
    const actions: { id: string; status: string }[] = [];
    for (const email of emails) {
      const proposal: { readonly statusCode: number; json<T>(): T } = await runtime.app.inject({
        method: "POST", url: `/investigations/${investigationId}/actions/proposals`,
        payload: { email, reason: "Propose a fake-executor integration action." },
      });
      assert.equal(proposal.statusCode, 201);
      actions.push(proposal.json<{ id: string; status: string }>());
    }

    const run = (app: ReturnType<typeof createBackendApp>) => app.inject({
      method: "POST", url: `/investigations/${investigationId}/actions/run`,
    });
    assert.equal((await run(runtime.app)).json<{ action: unknown }>().action, null, "an unauthorized unapproved workflow does not dispatch");
    assert.equal(executions.length, 0);
    assert.equal((await runtime.app.inject({
      method: "POST", url: `/investigations/${investigationId}/authorization`,
      payload: { granted: true, reason: "Explicit dedicated integration-test authorization." },
    })).statusCode, 200);
    assert.equal((await run(runtime.app)).json<{ action: unknown }>().action, null, "authorization alone does not approve a proposal");
    assert.equal(executions.length, 0);

    const firstApproval = await runtime.app.inject({
      method: "POST", url: `/investigations/${investigationId}/actions/${actions[0]!.id}/approval`,
      payload: { reason: "Explicitly approve only the first integration-test action." },
    });
    assert.equal(firstApproval.statusCode, 200);
    assert.equal(firstApproval.json<{ status: string }>().status, "queued");
    const firstRun = await run(runtime.app);
    assert.equal(firstRun.statusCode, 200);
    const firstRunAction = firstRun.json<{ action: { id: string; status: string } | null }>().action;
    assert.ok(firstRunAction);
    assert.equal(firstRunAction.id, actions[0]!.id);
    assert.equal(firstRunAction.status, "succeeded");
    assert.deepEqual(executions.map((execution) => execution.actionId), [actions[0]!.id]);

    const afterFirstRun = (await runtime.app.inject({
      method: "GET", url: `/investigations/${investigationId}`,
    })).json<Investigation>();
    const evidenceId = afterFirstRun.evidence[0]!.id;
    const validation = await runtime.app.inject({
      method: "POST", url: `/investigations/${investigationId}/evidence/${evidenceId}/validation`,
      payload: { status: "accepted", reason: "Accept the fake unknown registration observation as recorded evidence." },
    });
    assert.equal(validation.statusCode, 201);

    const secondApproval = await runtime.app.inject({
      method: "POST", url: `/investigations/${investigationId}/actions/${actions[1]!.id}/approval`,
      payload: { reason: "Explicitly approve the second integration-test action." },
    });
    assert.equal(secondApproval.statusCode, 200);
    assert.equal(secondApproval.json<{ status: string }>().status, "queued");
    const paused = await runtime.app.inject({
      method: "POST", url: `/investigations/${investigationId}/pause`,
      payload: { reason: "Pause before dispatching the second queued action." },
    });
    assert.equal(paused.statusCode, 200);
    assert.equal(paused.json<Investigation>().paused, true);
    assert.equal((await run(runtime.app)).json<{ action: unknown }>().action, null);
    assert.equal(executions.length, 1, "pause gates the second already-approved queued action");

    const resumed = await runtime.app.inject({
      method: "POST", url: `/investigations/${investigationId}/resume`,
      payload: { reason: "Resume without changing authorization or action approval." },
    });
    assert.equal(resumed.statusCode, 200);
    assert.equal(resumed.json<Investigation>().authorization?.granted, true);
    const secondRun = await run(runtime.app);
    assert.equal(secondRun.statusCode, 200);
    const secondRunAction = secondRun.json<{ action: { id: string; status: string } | null }>().action;
    assert.ok(secondRunAction);
    assert.equal(secondRunAction.id, actions[1]!.id);
    assert.equal(secondRunAction.status, "succeeded");
    assert.deepEqual(executions.map((execution) => execution.actionId), actions.map((action) => action.id));

    const report = await runtime.app.inject({ method: "GET", url: `/investigations/${investigationId}/report` });
    assert.equal(report.statusCode, 200);
    assert.match(report.headers["content-type"] ?? "", /text\/markdown/);
    assert.match(report.body, /# Local workflow T1/);
    assert.match(report.body, /Identity attribution is unsupported/);
    assert.match(report.body, /accepted/);
    assert.match(report.body, /unknown/);

    const persistedBeforeReconnect = (await runtime.store.get(investigationId))!;
    assert.equal(persistedBeforeReconnect.name, "Local workflow T1");
    assert.equal(persistedBeforeReconnect.actions.filter((action) => action.status === "succeeded").length, 2);
    assert.equal(persistedBeforeReconnect.validations.length, 1);
    await assertProjectedWorkflow(runtime, investigationId, persistedBeforeReconnect);

    const previousRuntime = runtime;
    runtime = undefined;
    await closeRuntime(previousRuntime);

    // This reconstructs clients/checkpointers; it is not a process-crash simulation.
    runtime = await openRuntime(config, namespace, executions);
    const reloadedCheckpoint = await runtime.checkpointer.getTuple({
      configurable: { thread_id: investigationId },
    });
    assert.ok(reloadedCheckpoint, "PostgresSaver reloads the investigation thread checkpoint on a new pool");
    const checkpointValues = JSON.stringify(reloadedCheckpoint.checkpoint.channel_values);
    assert.match(checkpointValues, new RegExp(investigationId));
    assert.doesNotMatch(checkpointValues, new RegExp(emails.map((email) => email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")));

    const reloaded = await runtime.app.inject({ method: "GET", url: `/investigations/${investigationId}` });
    assert.equal(reloaded.statusCode, 200);
    const persistedAfterReconnect = reloaded.json<Investigation>();
    assert.equal(persistedAfterReconnect.name, "Local workflow T1");
    assert.deepEqual(persistedAfterReconnect.actions.map((action) => action.status), ["succeeded", "succeeded"]);
    assert.equal(persistedAfterReconnect.evidence.length, 2);
    assert.equal(persistedAfterReconnect.validations[0]?.status, "accepted");

    const refreshProjection = await runtime.app.inject({
      method: "POST", url: `/investigations/${investigationId}/resume`,
      payload: { reason: "Refresh the projection through the reconstructed runtime." },
    });
    assert.equal(refreshProjection.statusCode, 200);
    const afterProjectionRefresh = await runtime.store.get(investigationId);
    assert.ok(afterProjectionRefresh);
    await assertProjectedWorkflow(runtime, investigationId, afterProjectionRefresh);

    assert.equal((await run(runtime.app)).json<{ action: unknown }>().action, null);
    assert.equal(executions.length, 2, "reloaded graph checkpoint and persisted terminal actions do not repeat executor calls");
  } finally {
    const cleanupErrors: unknown[] = [];
    try {
      if (runtime !== undefined) await closeRuntime(runtime);
    } catch (error) {
      cleanupErrors.push(error);
    } finally {
      try {
        if (investigationId !== undefined) await cleanupWorkflowData(config, investigationId, checkpointTablesReady);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length === 1) throw cleanupErrors[0];
    if (cleanupErrors.length > 1) {
      throw new AggregateError(cleanupErrors, "Could not close runtime and clean workflow integration data");
    }
  }
});
