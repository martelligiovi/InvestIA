import { DEFAULT_INVESTIGATION_NAME, type Investigation } from "../domain/investigation.ts";
import type { EmailSeed, UsernameSeed } from "../domain/seed.ts";
import { usernameProposals } from "../domain/username-proposals.ts";

function markdownText(value: string): string {
  return value
    .replace(/\r\n?|\n/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\\`*_{}\[\]()#+.!|~>-]/g, (character) => `\\${character}`);
}

function seedText(seed: EmailSeed | UsernameSeed): string {
  return markdownText(`${seed.kind}: ${seed.value}`);
}

function table(rows: readonly (readonly string[])[]): string {
  if (rows.length === 0) return "None recorded.";
  return [
    `| ${rows[0]!.join(" | ")} |`,
    `| ${rows[0]!.map(() => "---").join(" | ")} |`,
    ...rows.slice(1).map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

/** Compiles only persisted facts; output is stable for an unchanged snapshot and contains no inference. */
export function compileInvestigationReport(investigation: Investigation): string {
  const authorization = investigation.authorization === undefined
    ? "unknown or unrecorded"
    : investigation.authorization.granted ? "granted" : "denied";
  const actionRows: string[][] = [
    ["Action", "Catalog", "Seed", "Status", "Approval", "Unsupported observations", "Failure"],
    ...investigation.actions.map((action) => [
      markdownText(action.id),
      markdownText(action.spec.catalogId),
      seedText(action.spec.seed),
      markdownText(action.status),
      action.approval === undefined ? "not recorded" : markdownText(`${action.approval.at}: ${action.approval.reason}`),
      action.unsupportedObservationCount === undefined ? "not recorded" : String(action.unsupportedObservationCount),
      action.failure === undefined ? "none" : markdownText(action.failure),
    ]),
  ];
  const evidenceRows: string[][] = [
    ["Evidence", "Action", "Seed", "Provider", "Registration status", "Source", "Recorded at", "Target kind", "Observed target", "Upstream status", "URL", "Category", "Reason", "Metadata", "Media"],
    ...investigation.evidence.map((evidence) => [
      markdownText(evidence.id),
      markdownText(evidence.actionId),
      seedText(evidence.seed),
      markdownText(evidence.provider),
      markdownText(evidence.status),
      markdownText(evidence.sourceId),
      markdownText(evidence.recordedAt),
      markdownText(evidence.finding?.target.kind ?? "email"),
      markdownText(evidence.finding?.target.value ?? evidence.seed.value),
      markdownText(evidence.finding?.upstreamStatus ?? evidence.status),
      markdownText(evidence.finding?.url ?? ""),
      markdownText(evidence.finding?.category ?? ""),
      markdownText(evidence.finding?.reason ?? ""),
      markdownText(JSON.stringify(evidence.finding?.extra ?? {})),
      markdownText(JSON.stringify(evidence.finding?.media ?? {})),
    ]),
  ];
  const usernameRows: string[][] = [
    ["Username", "Origin", "Status", "Reason", "Decision"],
    ...(investigation.usernameSeeds ?? []).map((record) => [
      markdownText(record.value),
      markdownText(record.origin.kind === "operator" ? "operator" : `evidence ${record.origin.evidenceId}`),
      markdownText(record.status),
      markdownText(record.reason),
      record.decision === undefined ? "not recorded" : markdownText(`${record.decision.at}: ${record.decision.reason}`),
    ]),
  ];
  const proposalRows: string[][] = [
    ["Username", "Evidence", "Provider"],
    ...usernameProposals(investigation).map((proposal) => [
      markdownText(proposal.value), markdownText(proposal.evidenceId), markdownText(proposal.provider),
    ]),
  ];
  const validationRows: string[][] = [
    ["Decision", "Evidence", "Status", "Reason", "Recorded at"],
    ...investigation.validations.map((decision) => [
      markdownText(decision.id),
      markdownText(decision.evidenceId),
      markdownText(decision.status),
      markdownText(decision.reason),
      markdownText(decision.at),
    ]),
  ];
  const auditRows: string[][] = [
    ["At", "Actor", "Kind", "Reason", "Action ID", "Evidence ID", "Granted", "Decision", "Unsupported observations"],
    ...investigation.audit.map((event) => [
      markdownText(event.at),
      markdownText(event.actor),
      markdownText(event.kind),
      markdownText(event.reason),
      event.actionId === undefined ? "not recorded" : markdownText(event.actionId),
      event.evidenceId === undefined ? "not recorded" : markdownText(event.evidenceId),
      event.granted === undefined ? "not recorded" : String(event.granted),
      event.decision === undefined ? "not recorded" : markdownText(event.decision),
      event.unsupportedObservationCount === undefined ? "not recorded" : String(event.unsupportedObservationCount),
    ]),
  ];

  return [
    `# ${markdownText(investigation.name ?? DEFAULT_INVESTIGATION_NAME)}`,
    "",
    `- ID: ${markdownText(investigation.id)}`,
    `- Revision: ${investigation.revision}`,
    `- Created: ${markdownText(investigation.createdAt)}`,
    `- Updated: ${markdownText(investigation.updatedAt)}`,
    `- State: ${investigation.paused ? "paused" : "active"}`,
    `- Authorization: ${authorization}`,
    "",
    "## Email seeds",
    investigation.emailSeeds.length === 0
      ? "- None recorded."
      : investigation.emailSeeds.map((seed) => `- ${markdownText(seed.value)}`).join("\n"),
    "",
    "## Username seeds",
    usernameRows.length > 1 ? table(usernameRows) : "None recorded.",
    "",
    "## Pending username proposals",
    proposalRows.length > 1 ? table(proposalRows) : "None recorded.",
    "",
    "## Tool action queue",
    table(actionRows),
    "",
    "## Evidence",
    table(evidenceRows),
    "",
    "## Validation decisions",
    table(validationRows),
    "",
    "## Identity attribution",
    "Identity attribution is unsupported and is not asserted. Scanner findings retain observed targets, links, metadata, media and upstream provenance/confidence alongside historical registration observations. Confidence is the tool's assessment, not a human identity verdict.",
    "",
    "## Audit decisions",
    table(auditRows),
    "",
    "Only positive tool-reported results (`Registered` / `Found`, normalized as `registered`) are retained as findings. Negative, uncertain and provider-error results are not stored as evidence. A finding records what the tool reported about its observed target; it does not independently confirm account ownership or identity and may contain tool errors.",
    "A claimed action may remain in flight after a process crash; its external outcome is unknown and it is not automatically retried.",
    "Application claims prevent duplicate dispatch, but cannot guarantee exactly-once remote effects.",
    "",
  ].join("\n");
}
