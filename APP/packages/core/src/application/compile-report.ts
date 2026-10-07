import { DEFAULT_INVESTIGATION_NAME, type Investigation } from "../domain/investigation.ts";

function markdownText(value: string): string {
  return value
    .replace(/\r\n?|\n/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\\`*_{}\[\]()#+.!|~>-]/g, (character) => `\\${character}`);
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
    ["Action", "Catalog", "Email seed", "Status", "Approval", "Unsupported observations", "Failure"],
    ...investigation.actions.map((action) => [
      markdownText(action.id),
      markdownText(action.spec.catalogId),
      markdownText(action.spec.seed.value),
      markdownText(action.status),
      action.approval === undefined ? "not recorded" : markdownText(`${action.approval.at}: ${action.approval.reason}`),
      action.unsupportedObservationCount === undefined ? "not recorded" : String(action.unsupportedObservationCount),
      action.failure === undefined ? "none" : markdownText(action.failure),
    ]),
  ];
  const evidenceRows: string[][] = [
    ["Evidence", "Action", "Email seed", "Provider", "Registration status", "Source", "Recorded at"],
    ...investigation.evidence.map((evidence) => [
      markdownText(evidence.id),
      markdownText(evidence.actionId),
      markdownText(evidence.seed.value),
      markdownText(evidence.provider),
      markdownText(evidence.status),
      markdownText(evidence.sourceId),
      markdownText(evidence.recordedAt),
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
    "## GitHub action queue",
    table(actionRows),
    "",
    "## Evidence",
    table(evidenceRows),
    "",
    "## Validation decisions",
    table(validationRows),
    "",
    "## Identity attribution",
    "Identity attribution is unsupported and is not asserted. Only GitHub registration observations are retained as evidence.",
    "",
    "## Audit decisions",
    table(auditRows),
    "",
    "Registration statuses are recorded as returned; `unknown` and `error` are not converted into positive or negative findings.",
    "A claimed action may remain in flight after a process crash; its external outcome is unknown and it is not automatically retried.",
    "Application claims prevent duplicate dispatch, but cannot guarantee exactly-once remote effects.",
    "",
  ].join("\n");
}
