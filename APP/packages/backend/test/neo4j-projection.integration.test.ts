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
