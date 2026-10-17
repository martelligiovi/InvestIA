import assert from "node:assert/strict";
import test from "node:test";
import {
  createInitialInvestigation,
  investigationSeedGraph,
  seedHasActions,
  type EvidenceRecord,
  type GitHubCatalogAction,
  type Investigation,
  type ScannerFinding,
} from "../src/index.ts";

const at = "2025-03-01T00:00:00.000Z";

function emailAction(id: string, email: string, sourceSeedId?: string): GitHubCatalogAction {
  return {
    id,
    spec: { catalogId: "user-scanner.email.v1", provider: "user-scanner", seed: { kind: "email", value: email } },
    status: "succeeded",
    proposedAt: at,
    proposalReason: "Scan the operator email.",
    queuedByCatalog: true,
    ...(sourceSeedId === undefined ? {} : { sourceSeedId }),
  };
}

function finding(target: string, provider: string): ScannerFinding {
  return {
    target: { kind: "email", value: target },
    upstreamStatus: "Registered",
    url: `https://${provider.toLowerCase()}.example`,
    category: "Design",
    reason: "",
    extra: {},
    media: {},
  };
}

function evidence(id: string, actionId: string, seedEmail: string, withFinding?: ScannerFinding): EvidenceRecord {
  return {
    id,
    actionId,
    seed: { kind: "email", value: seedEmail },
    provider: "Canva",
    status: "registered",
    sourceId: "user-scanner:email",
    recordedAt: at,
    ...(withFinding === undefined ? {} : { finding: withFinding }),
  };
}

function investigation(overrides: Partial<Investigation>): Investigation {
  return { ...createInitialInvestigation("case", at), ...overrides };
}

test("operator email seeds get stable ids in input order with operator origin", () => {
  const graph = investigationSeedGraph(investigation({
    emailSeeds: [{ kind: "email", value: "b+x@example.org" }, { kind: "email", value: "a@example.org" }],
  }));
  assert.deepEqual(graph.seeds, [
    { kind: "email", id: "seed:email:b%2Bx%40example.org", value: "b+x@example.org", origin: { kind: "operator" } },
    { kind: "email", id: "seed:email:a%40example.org", value: "a@example.org", origin: { kind: "operator" } },
  ]);
  assert.equal(graph.actionInputs.size, 0);
});

test("each evidence record yields one finding seed with action provenance, including historical records", () => {
  const withFinding = evidence("ev/1", "action-1", "seed@example.org", finding("seed@example.org", "Canva"));
  const historical = evidence("ev-2", "action-1", "seed@example.org");
  const graph = investigationSeedGraph(investigation({
    emailSeeds: [{ kind: "email", value: "seed@example.org" }],
    actions: [emailAction("action-1", "seed@example.org")],
    evidence: [withFinding, historical],
  }));
  assert.deepEqual(graph.seeds.slice(1), [
    {
      kind: "finding", id: "seed:evidence:ev%2F1", evidence: withFinding,
      origin: { kind: "action", actionId: "action-1", evidenceId: "ev/1" },
    },
    {
      kind: "finding", id: "seed:evidence:ev-2", evidence: historical,
      origin: { kind: "action", actionId: "action-1", evidenceId: "ev-2" },
    },
  ]);
});

test("an action embedding an operator email resolves to that email seed; finding seeds stay leaves", () => {
  const graph = investigationSeedGraph(investigation({
    emailSeeds: [{ kind: "email", value: "seed@example.org" }],
    actions: [emailAction("action-1", "seed@example.org"), emailAction("orphan", "other@example.org")],
    evidence: [evidence("ev-1", "action-1", "seed@example.org", finding("seed@example.org", "Canva"))],
  }));
  assert.equal(graph.actionInputs.get("action-1"), "seed:email:seed%40example.org");
  assert.ok(graph.actionInputs.has("orphan"));
  assert.equal(graph.actionInputs.get("orphan"), undefined);
  assert.equal(seedHasActions(graph, "seed:email:seed%40example.org"), true);
  assert.equal(seedHasActions(graph, "seed:evidence:ev-1"), false);
});

test("explicit sourceSeedId to a finding seed makes it a branch; dangling references stay unlinked", () => {
  const graph = investigationSeedGraph(investigation({
    emailSeeds: [{ kind: "email", value: "seed@example.org" }],
    actions: [
      emailAction("action-1", "seed@example.org"),
      emailAction("follow-up", "seed@example.org", "seed:evidence:ev-1"),
      emailAction("dangling", "seed@example.org", "seed:evidence:missing"),
    ],
    evidence: [evidence("ev-1", "action-1", "seed@example.org", finding("seed@example.org", "Canva"))],
  }));
  assert.equal(graph.actionInputs.get("follow-up"), "seed:evidence:ev-1");
  assert.equal(seedHasActions(graph, "seed:evidence:ev-1"), true);
  assert.ok(graph.actionInputs.has("dangling"));
  assert.equal(graph.actionInputs.get("dangling"), undefined);
});

test("equal finding targets never merge seeds or link to actions by value", () => {
  const graph = investigationSeedGraph(investigation({
    emailSeeds: [{ kind: "email", value: "seed@example.org" }],
    actions: [emailAction("action-1", "seed@example.org"), emailAction("other", "found@example.org")],
    evidence: [
      evidence("ev-1", "action-1", "seed@example.org", finding("found@example.org", "Canva")),
      evidence("ev-2", "action-1", "seed@example.org", finding("found@example.org", "Figma")),
    ],
  }));
  const findings = graph.seeds.filter((seed) => seed.kind === "finding");
  assert.deepEqual(findings.map((seed) => seed.id), ["seed:evidence:ev-1", "seed:evidence:ev-2"]);
  assert.equal(graph.actionInputs.get("other"), undefined);
  assert.equal(seedHasActions(graph, "seed:evidence:ev-1"), false);
  assert.equal(seedHasActions(graph, "seed:evidence:ev-2"), false);
});

test("building the graph does not mutate the investigation", () => {
  const input = investigation({
    emailSeeds: [{ kind: "email", value: "seed@example.org" }],
    actions: [emailAction("action-1", "seed@example.org"), emailAction("follow-up", "seed@example.org", "seed:evidence:ev-1")],
    evidence: [evidence("ev-1", "action-1", "seed@example.org", finding("seed@example.org", "Canva"))],
  });
  const before = structuredClone(input);
  investigationSeedGraph(input);
  assert.deepEqual(input, before);
});
