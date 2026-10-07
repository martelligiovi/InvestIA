import assert from "node:assert/strict";
import test from "node:test";
import { loadBackendConfig } from "../src/config.ts";

test("backend configuration defaults to loopback and a validated port", () => {
  assert.deepEqual(loadBackendConfig({
    DATABASE_URL: "postgres://local/db",
    NEO4J_URI: "neo4j://127.0.0.1:7687",
    NEO4J_USERNAME: "neo4j",
    NEO4J_PASSWORD: "development-only-password",
  }), {
    databaseUrl: "postgres://local/db",
    host: "127.0.0.1",
    port: 4317,
    neo4jUri: "neo4j://127.0.0.1:7687",
    neo4jUsername: "neo4j",
    neo4jPassword: "development-only-password",
    neo4jDatabase: "neo4j",
  });
});

test("container networking accepts only the Compose bind and Neo4j hostname", () => {
  const env = {
    DATABASE_URL: "postgres://postgres/db",
    INVESTIA_CONTAINER_NETWORKING: "true",
    HOST: "0.0.0.0",
    NEO4J_URI: "bolt://neo4j:7687",
    NEO4J_USERNAME: "neo4j",
    NEO4J_PASSWORD: "development-only-password",
  };
  const config = loadBackendConfig(env);
  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.neo4jUri, "bolt://neo4j:7687");
  assert.equal(config.containerNetworking, true);
  for (const flag of [undefined, "false", "1", "TRUE"]) {
    assert.throws(() => loadBackendConfig({ ...env, INVESTIA_CONTAINER_NETWORKING: flag }), /loopback/i);
  }
  for (const host of ["::", "192.168.1.5", "localhost", "example.org"]) {
    assert.throws(() => loadBackendConfig({ ...env, HOST: host }), /loopback/i);
  }
  for (const uri of ["bolt://other:7687", "bolt://neo4j.example:7687", "http://neo4j:7687", "bolt://user:pass@neo4j:7687"]) {
    assert.throws(() => loadBackendConfig({ ...env, NEO4J_URI: uri }), /NEO4J_URI/i);
  }
  assert.throws(() => loadBackendConfig({ ...env, HOST: "127.0.0.1", INVESTIA_CONTAINER_NETWORKING: undefined }), /loopback/i);
  assert.equal(loadBackendConfig({ ...env, HOST: "::1", NEO4J_URI: "neo4j://[::1]:7687" }).host, "::1");
});

test("backend configuration rejects wildcard and non-loopback binds", () => {
  for (const host of ["0.0.0.0", "::", "192.168.1.5", "localhost", "example.org"]) {
    assert.throws(
      () => loadBackendConfig({ DATABASE_URL: "postgres://local/db", HOST: host }),
      /loopback/i,
    );
  }
  assert.throws(() => loadBackendConfig({ DATABASE_URL: "postgres://local/db", PORT: "0" }), /port/i);
  assert.throws(() => loadBackendConfig({ HOST: "127.0.0.1" }), /DATABASE_URL/i);
  const validNeo4j = {
    DATABASE_URL: "postgres://local/db",
    NEO4J_URI: "neo4j://127.0.0.1:7687",
    NEO4J_USERNAME: "neo4j",
    NEO4J_PASSWORD: "development-only-password",
  };
  assert.throws(() => loadBackendConfig({ ...validNeo4j, NEO4J_URI: "neo4j://database.internal:7687" }), /loopback/i);
  assert.throws(() => loadBackendConfig({ ...validNeo4j, NEO4J_URI: "neo4j://user:pass@127.0.0.1:7687" }), /credentials/i);
  assert.throws(() => loadBackendConfig({ ...validNeo4j, NEO4J_PASSWORD: "" }), /NEO4J_PASSWORD/i);
});
