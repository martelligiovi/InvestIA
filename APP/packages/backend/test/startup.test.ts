import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MemorySaver } from "@langchain/langgraph";
import { Pool } from "pg";
import type { InvestigationExecutor } from "@investia/core";
import { startBackend } from "../src/main.ts";
import type { Neo4jDriverLike } from "../src/neo4j-investigation-projector.ts";

class FakePool {
  readonly queries: string[] = [];
  endCount = 0;

  on(): this {
    return this;
  }

  async query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string): Promise<{
    rows: T[];
    rowCount: number;
  }> {
    this.queries.push(sql);
    return { rows: [], rowCount: 0 };
  }

  async connect() {
    return {
      query: async <T extends Record<string, unknown> = Record<string, unknown>>(sql: string): Promise<{
        rows: T[];
        rowCount: number;
      }> => {
        this.queries.push(sql);
        return { rows: [], rowCount: 0 };
      },
      release() {},
    };
  }

  async end(): Promise<void> {
    this.endCount++;
  }
}

class FakeNeo4jDriver implements Neo4jDriverLike {
  closeCount = 0;

  session(): never {
    throw new Error("No projection is expected during startup.");
  }

  async close(): Promise<void> {
    this.closeCount++;
  }
}

test("container startup permits only an explicitly opted-in IPv4 wildcard", async () => {
  const config = {
    databaseUrl: "postgres://local/db",
    host: "0.0.0.0",
    port: 0,
    neo4jUri: "bolt://neo4j:7687",
    neo4jUsername: "neo4j",
    neo4jPassword: "development-only-password",
    neo4jDatabase: "neo4j",
    containerNetworking: true,
  };
  for (const host of ["::", "192.168.1.5", "localhost"]) {
    const pool = new FakePool();
    await assert.rejects(startBackend({ ...config, host }, { pool: pool as unknown as Pool }), /loopback/i);
    assert.equal(pool.queries.length, 0);
  }
  const pool = new FakePool();
  const driver = new FakeNeo4jDriver();
  const runtime = await startBackend(config, {
    pool: pool as unknown as Pool,
    neo4jDriver: driver,
    checkpointer: new MemorySaver(),
    executor: { id: "offline-container-executor", async execute() { throw new Error("No execution expected"); } },
    frontendDistPath: join(tmpdir(), `investia-missing-frontend-${randomUUID()}`),
  });
  try {
    const address = runtime.app.server.address();
    assert.ok(address !== null && typeof address !== "string");
    assert.equal(address.address, "0.0.0.0");
    const readiness = await runtime.app.inject({ method: "GET", url: "/investigations" });
    assert.equal(readiness.statusCode, 200);
    assert.deepEqual(readiness.json(), []);
    assert.ok(pool.queries.some((query) => query.includes("CREATE TABLE IF NOT EXISTS investigations")));
  } finally {
    await runtime.close();
  }
  assert.equal(pool.endCount, 1);
  assert.equal(driver.closeCount, 1);
});

test("starts on loopback with injected adapters and closes server/pool idempotently", async () => {
  const rejectedPool = new FakePool();
  await assert.rejects(startBackend({
    databaseUrl: "postgres://local/db",
    host: "0.0.0.0",
    port: 4317,
    neo4jUri: "neo4j://127.0.0.1:7687",
    neo4jUsername: "neo4j",
    neo4jPassword: "development-only-password",
    neo4jDatabase: "neo4j",
  }, { pool: rejectedPool as unknown as Pool }), /loopback/i);
  assert.equal(rejectedPool.queries.length, 0);

  const pool = new FakePool();
  let executions = 0;
  const executor: InvestigationExecutor = {
    id: "offline-startup-executor",
    async execute() {
      executions++;
      return [];
    },
  };
  const neo4jDriver = new FakeNeo4jDriver();
  const runtime = await startBackend({
    databaseUrl: "postgres://local/db",
    host: "127.0.0.1",
    port: 0,
    neo4jUri: "neo4j://127.0.0.1:7687",
    neo4jUsername: "neo4j",
    neo4jPassword: "development-only-password",
    neo4jDatabase: "neo4j",
  }, {
    pool: pool as unknown as Pool,
    executor,
    neo4jDriver,
    checkpointer: new MemorySaver(),
    frontendDistPath: join(tmpdir(), `investia-missing-frontend-${randomUUID()}`),
  });
  try {
    const missingFrontend = await runtime.app.inject({ method: "GET", url: "/" });
    assert.equal(missingFrontend.statusCode, 404);
    assert.match(missingFrontend.headers["content-type"] ?? "", /application\/json/);
    const apiOnly = await runtime.app.inject({ method: "GET", url: "/investigations" });
    assert.equal(apiOnly.statusCode, 200);
    assert.deepEqual(apiOnly.json(), []);

    const address = runtime.app.server.address();
    assert.notEqual(address, null);
    assert.ok(pool.queries.some((query) => query.includes("CREATE TABLE IF NOT EXISTS investigations")));
    await Promise.all([runtime.close(), runtime.close()]);
    assert.equal(pool.endCount, 1);
    assert.equal(neo4jDriver.closeCount, 1);
    assert.equal(executions, 0);
  } finally {
    await runtime.close();
  }
});
