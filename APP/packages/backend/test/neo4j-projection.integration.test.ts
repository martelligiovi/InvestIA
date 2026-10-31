import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import neo4j from "neo4j-driver";
import { createInitialInvestigation } from "@investia/core";
import { Neo4jInvestigationProjector } from "../src/neo4j-investigation-projector.ts";

const uri = process.env.INVESTIA_TEST_NEO4J_URI;
const username = process.env.INVESTIA_TEST_NEO4J_USERNAME;
const password = process.env.INVESTIA_TEST_NEO4J_PASSWORD;
const database = process.env.INVESTIA_TEST_NEO4J_DATABASE ?? "neo4j";

test("real Neo4j transaction fences an older investigation revision", {
  skip: uri === undefined || username === undefined || password === undefined
    ? "Set dedicated INVESTIA_TEST_NEO4J_* connection variables to enable Neo4j integration"
    : false,
}, async () => {
  if (uri === undefined || username === undefined || password === undefined) return;
  const driver = neo4j.driver(uri, neo4j.auth.basic(username, password));
  try {
    const projector = new Neo4jInvestigationProjector(driver, database);
    const id = `investia-neo4j-test-${randomUUID()}`;
    const initial = createInitialInvestigation(id, new Date().toISOString());
    const newer = { ...initial, revision: 2, paused: true };
    const stale = { ...initial, revision: 1, paused: false };

    assert.deepEqual(await projector.project(newer), { revision: 2, status: "applied" });
    assert.deepEqual(await projector.project(stale), { revision: 1, status: "stale" });

    const session = driver.session({ database });
    try {
      const result = await session.run(
        "MATCH (i:Investigation {id: $id}) RETURN i.revision AS revision, i.paused AS paused",
        { id },
      );
      assert.equal(result.records.length, 1);
      const storedRevision = result.records[0]!.get("revision");
      const observedRevision = typeof storedRevision === "number"
        ? storedRevision
        : typeof storedRevision === "object" && storedRevision !== null &&
          "toNumber" in storedRevision && typeof storedRevision.toNumber === "function"
          ? storedRevision.toNumber()
          : Number.NaN;
      assert.equal(observedRevision, 2);
      assert.equal(result.records[0]!.get("paused"), true);
    } finally {
      await session.close();
    }
  } finally {
    await driver.close();
  }
});

test("real Neo4j projects username seeds and Maigret work as UsernameSeed nodes, never EmailSeed", {
  skip: uri === undefined || username === undefined || password === undefined
    ? "Set dedicated INVESTIA_TEST_NEO4J_* connection variables to enable Neo4j integration"
    : false,
}, async () => {
  if (uri === undefined || username === undefined || password === undefined) return;
  const driver = neo4j.driver(uri, neo4j.auth.basic(username, password));
  try {
    const projector = new Neo4jInvestigationProjector(driver, database);
    const id = `investia-neo4j-test-${randomUUID()}`;
    const at = new Date().toISOString();
    const usernameSeed = { kind: "username" as const, value: "anaexample" };
    const emailSeed = { kind: "email" as const, value: "ana@example.org" };
    const finding = { target: usernameSeed, upstreamStatus: "Found" as const, url: "", category: "", reason: "", extra: {}, media: {} };
    const investigation = {
      ...createInitialInvestigation(id, at), revision: 1, emailSeeds: [emailSeed],
      usernameSeeds: [{ kind: "username" as const, value: "anaexample", origin: { kind: "operator" as const }, status: "accepted" as const, at, reason: "Operator" }],
      actions: [
        { id: "scanner", spec: { catalogId: "user-scanner.email.v1" as const, provider: "user-scanner" as const, seed: emailSeed }, status: "succeeded" as const, queuedByCatalog: true as const, proposedAt: at, proposalReason: "Queue" },
        { id: "maigret", spec: { catalogId: "maigret.username.v1" as const, provider: "maigret" as const, seed: usernameSeed }, status: "succeeded" as const, queuedByCatalog: true as const, proposedAt: at, proposalReason: "Queue" },
      ],
      evidence: [{ id: "evidence-1", actionId: "maigret", seed: usernameSeed, provider: "Reddit", status: "registered" as const, sourceId: "maigret:username", recordedAt: at, finding }],
    };
    assert.deepEqual(await projector.project(investigation), { revision: 1, status: "applied" });

    const session = driver.session({ database });
    try {
      const count = async (query: string) => {
        const value = (await session.run(query, { id })).records[0]!.get("n");
        return typeof value === "number" ? value : value.toNumber();
      };
      assert.equal(await count("MATCH (s:EmailSeed {investigationId: $id, value: 'anaexample'}) RETURN count(s) AS n"), 0);
      assert.equal(await count("MATCH (:Investigation {id: $id})-[:HAS_SEED]->(s:UsernameSeed {value: 'anaexample', status: 'accepted', originKind: 'operator'}) RETURN count(s) AS n"), 1);
      assert.equal(await count("MATCH (:CatalogAction {investigationId: $id, id: 'maigret'})-[:USES_SEED]->(s:UsernameSeed {value: 'anaexample'}) RETURN count(s) AS n"), 1);
      assert.equal(await count("MATCH (:CatalogAction {investigationId: $id, id: 'scanner'})-[:USES_SEED]->(s:EmailSeed {value: 'ana@example.org'}) RETURN count(s) AS n"), 1);
      assert.equal(await count("MATCH (:UsernameSeed {investigationId: $id, value: 'anaexample'})-[:HAS_EVIDENCE]->(e:Evidence {id: 'evidence-1'})<-[:PRODUCED]-(:CatalogAction {id: 'maigret'}) RETURN count(e) AS n"), 1);
      await session.run("MATCH (n) WHERE n.investigationId = $id OR n.id = $id DETACH DELETE n", { id });
    } finally {
      await session.close();
    }
  } finally {
    await driver.close();
  }
});
