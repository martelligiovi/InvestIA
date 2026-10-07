import assert from "node:assert/strict";
import test from "node:test";
import type { Investigation } from "@investia/core";
import {
  Neo4jInvestigationProjector,
  type Neo4jDriverLike,
  type Neo4jTransactionLike,
} from "../src/neo4j-investigation-projector.ts";

class FakeNeo4jDriver implements Neo4jDriverLike {
  readonly calls: { query: string; parameters: Record<string, unknown> }[] = [];
  revision = -1;

  session(): {
    run(query: string, parameters?: Record<string, unknown>): Promise<{ records: readonly { get(key: string): unknown }[] }>;
    executeWrite<T>(operation: (transaction: Neo4jTransactionLike) => Promise<T>): Promise<T>;
    close(): Promise<void>;
  } {
    const run = async (query: string, parameters: Record<string, unknown> = {}) => {
      this.calls.push({ query, parameters: structuredClone(parameters) });
      if (query.includes("RETURN i.revision AS revision")) {
        const incoming = Number(parameters.revision);
        if (incoming > this.revision) this.revision = incoming;
        return {
          records: this.revision === incoming
            ? [{ get: () => this.revision }]
            : [],
        };
      }
      return { records: [] };
    };
    return {
      run,
      executeWrite: async <T>(operation: (transaction: Neo4jTransactionLike) => Promise<T>) =>
        operation({ run }),
      close: async () => undefined,
    };
  }

  async close(): Promise<void> {}
}

function snapshot(revision: number, paused: boolean): Investigation {
  const at = "2025-04-01T00:00:00.000Z";
  return {
    id: "investigation ' WITH 1 AS x //",
    revision,
    createdAt: at,
    updatedAt: at,
    paused,
    authorization: { granted: true, at, reason: "operator decision", operator: "local-operator" },
    emailSeeds: [{ kind: "email", value: "factual@example.org" }],
    actions: [{
      id: "action ' MATCH (n) DETACH DELETE n //",
      spec: {
        catalogId: "github.email-registration.v1",
        provider: "github",
        seed: { kind: "email", value: "factual@example.org" },
      },
      status: "succeeded",
      proposedAt: at,
      proposalReason: "approved factual check",
      approval: { at, reason: "approved", operator: "local-operator" },
      claim: { id: "claim-1", claimedAt: at },
      completedAt: at,
      unsupportedObservationCount: 0,
    }],
    evidence: [{
      id: "evidence-1",
      actionId: "action ' MATCH (n) DETACH DELETE n //",
      seed: { kind: "email", value: "factual@example.org" },
      provider: "github",
      status: "unknown",
      sourceId: "offline-source",
      recordedAt: at,
    }],
    validations: [{
      id: "validation-1",
      evidenceId: "evidence-1",
      status: "inconclusive",
      reason: "insufficient evidence",
      at,
      operator: "local-operator",
    }],
    audit: [{ id: "audit-1", at, actor: "operator", kind: "evidence_validated", reason: "reviewed", evidenceId: "evidence-1", decision: "inconclusive" }],
  };
}

test("projects factual records through parameterized Cypher and ignores stale revisions", async () => {
  const driver = new FakeNeo4jDriver();
  const projector = new Neo4jInvestigationProjector(driver, "neo4j");
  const latest = snapshot(8, true);

  assert.deepEqual(await projector.project(latest), { revision: 8, status: "applied" });
  const queryCountAfterLatest = driver.calls.length;
  assert.ok(queryCountAfterLatest >= 5, "investigation, seed, action and evidence facts are projected");

  const stale = snapshot(7, false);
  assert.deepEqual(await projector.project(stale), { revision: 7, status: "stale" });
  assert.equal(driver.calls.length, queryCountAfterLatest + 1, "stale snapshots stop after the revision fence");
  assert.equal(driver.revision, 8);

  const everyQuery = driver.calls.map(({ query }) => query).join("\n");
  assert.doesNotMatch(everyQuery, /investigation ' WITH|DETACH DELETE/);
  const fenceCall = driver.calls.find(({ query }) => query.includes("RETURN i.revision AS revision"));
  assert.equal(fenceCall?.parameters.investigationId, latest.id);
  const actionWrite = driver.calls.find(({ parameters }) => Array.isArray(parameters.actions));
  assert.equal(
    (actionWrite?.parameters.actions as { id: string }[] | undefined)?.[0]?.id,
    latest.actions[0]?.id,
  );
  const evidenceWrite = driver.calls.find(({ parameters }) => Array.isArray(parameters.evidence));
  assert.equal(
    (evidenceWrite?.parameters.evidence as { id: string }[] | undefined)?.[0]?.id,
    latest.evidence[0]?.id,
  );
});
