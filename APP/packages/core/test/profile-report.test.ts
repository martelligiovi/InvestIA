import assert from "node:assert/strict";
import test from "node:test";
import { buildAiReportMessages, compileInvestigationReport, createInitialInvestigation, type Investigation } from "../src/index.ts";

const at = "2026-10-01T10:00:00.000Z";
const emailSeed = { kind: "email" as const, value: "ana@example.com" };
const usernameSeed = { kind: "username" as const, value: "anaexample" };

function profileCase(): Investigation {
  return {
    ...createInitialInvestigation("case-profile", at, "Perfil"),
    emailSeeds: [emailSeed],
    usernameSeeds: [
      { kind: "username", value: "anaexample", origin: { kind: "evidence", evidenceId: "e-scanner" }, status: "accepted", at, reason: "Proposed from a GitHub finding.", decision: { at, reason: "Misma persona", operator: "local-operator" } },
      { kind: "username", value: "other-ana", origin: { kind: "evidence", evidenceId: "e-scanner" }, status: "rejected", at, reason: "Proposed from a GitHub finding.", decision: { at, reason: "Otra persona", operator: "local-operator" } },
      { kind: "username", value: "manual-ana", origin: { kind: "operator" }, status: "accepted", at, reason: "Aportado" },
    ],
    actions: [{
      id: "a-maigret", spec: { catalogId: "maigret.username.v1", provider: "maigret", seed: usernameSeed },
      status: "succeeded", queuedByCatalog: true, proposedAt: at, proposalReason: "Catalog queue",
    }],
    evidence: [
      {
        id: "e-scanner", actionId: "a-scanner", seed: emailSeed, provider: "GitHub", status: "registered", sourceId: "user-scanner:email", recordedAt: at,
        finding: { target: { kind: "username", value: "anaexample" }, upstreamStatus: "Found", url: "", category: "", reason: "", extra: { discovered_usernames: "ana-pending" }, media: {} },
      },
      {
        id: "e-maigret", actionId: "a-maigret", seed: usernameSeed, provider: "Reddit", status: "registered", sourceId: "maigret:username", recordedAt: at,
        finding: { target: { kind: "username", value: "anaexample" }, upstreamStatus: "Found", url: "https://reddit.com/user/anaexample", category: "", reason: "", extra: { fullname: "Ana Example" }, media: {} },
      },
    ],
  };
}

function section(report: string, heading: string): string {
  const start = report.indexOf(`## ${heading}\n`);
  assert.ok(start >= 0, heading);
  const rest = report.slice(start + heading.length + 4);
  const end = rest.indexOf("\n## ");
  return end < 0 ? rest : rest.slice(0, end);
}

test("the factual report lists username seeds, their decisions and pending proposals", () => {
  const report = compileInvestigationReport(profileCase());
  const seeds = section(report, "Username seeds");
  assert.match(seeds, /\| Username \| Origin \| Status \| Reason \| Decision \|/);
  assert.match(seeds, /\| anaexample \| evidence e\\-scanner \| accepted \| Proposed from a GitHub finding\\\. \| .*Misma persona \|/);
  assert.match(seeds, /\| other\\-ana \| evidence e\\-scanner \| rejected \| .*Otra persona \|/);
  assert.match(seeds, /\| manual\\-ana \| operator \| accepted \| Aportado \| not recorded \|/);
  const pending = section(report, "Pending username proposals");
  assert.match(pending, /\| ana\\-pending \| e\\-scanner \| GitHub \|/);
  assert.doesNotMatch(pending, /anaexample/);
  assert.match(section(report, "Tool action queue"), /\| a\\-maigret \| maigret\\.username\\.v1 \| username: anaexample \|/);
  assert.match(section(report, "Evidence"), /\| e\\-maigret \| a\\-maigret \| username: anaexample \| Reddit \|/);
  assert.match(section(report, "Evidence"), /\| e\\-scanner \| a\\-scanner \| email: ana@example\\.com \|/);
});

test("a case without username data reports empty username sections", () => {
  const report = compileInvestigationReport(createInitialInvestigation("legacy", at));
  assert.equal(section(report, "Username seeds").trim(), "None recorded.");
  assert.equal(section(report, "Pending username proposals").trim(), "None recorded.");
});

test("the AI report request names username seeds and the seed of each finding by kind", () => {
  const user = buildAiReportMessages(profileCase())[1]!.content;
  const data = JSON.parse(user.slice(user.indexOf("```json") + 7, user.lastIndexOf("```")));
  assert.deepEqual(data.emailSeeds, ["ana@example.com"]);
  assert.deepEqual(data.usernameSeeds, ["anaexample", "manual-ana"]);
  assert.equal(data.findings[0].emailSeed, "ana@example.com");
  assert.equal(data.findings[1].usernameSeed, "anaexample");
  assert.ok(!("emailSeed" in data.findings[1]));
});
