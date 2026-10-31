export type { EmailSeed, Seed } from "./domain/seed.ts";
export { isScannerFinding } from "./domain/observation.ts";
export type {
  ScannerFinding,
  ScannerObservation,
  IdentityObservation,
  Observation,
  RegistrationObservation,
  RegistrationStatus,
} from "./domain/observation.ts";
export type { SeedBox } from "./domain/seed-box.ts";
export {
  ExecutionDeniedError,
  executeSeedBox,
  type ExecutionDenialCode,
  type ExecutionState,
} from "./application/execute-seed-box.ts";
export {
  authorizationCovers,
  createInitialInvestigation,
  DEFAULT_INVESTIGATION_NAME,
  isScopedCatalogId,
  SCOPED_CATALOG_IDS,
  type ScopedCatalogId,
  INVESTIGATION_NAME_MAX_LENGTH,
  normalizeInvestigationName,
  type ActionApproval,
  type AuditActor,
  type AuditEvent,
  type AuditKind,
  type AuthorizationRecord,
  type EvidenceId,
  type EvidenceRecord,
  type GitHubActionSpec,
  type GravatarActionSpec,
  type UserScannerActionSpec,
  type GitHubCatalogAction,
  type Investigation,
  type InvestigationActionId,
  type InvestigationActionStatus,
  type InvestigationId,
  type InvestigationSummary,
  type RegistrationStatus as InvestigationRegistrationStatus,
  type ValidationDecision,
  type ValidationStatus,
} from "./domain/investigation.ts";
export {
  emailSeedNodeId,
  findingSeedNodeId,
  investigationSeedGraph,
  seedHasActions,
  type EmailSeedNode,
  type FindingSeedNode,
  type InvestigationSeedGraph,
  type InvestigationSeedId,
  type InvestigationSeedNode,
} from "./domain/seed-graph.ts";
export {
  createCatalogExecutor,
  createInvestigationService,
  createSeedBoxExecutor,
  type CatalogBoxes,
  InvestigationService,
  type InvestigationIdKind,
  type InvestigationServiceDependencies,
} from "./application/investigation-service.ts";
export { compileInvestigationReport } from "./application/compile-report.ts";
export {
  AI_MAX_TOKENS_RANGE,
  AI_REASONING_EFFORTS,
  AI_REPORT_SYSTEM_PROMPT,
  buildAiReportMessages,
  composeAiReport,
  countOmittedAiReportFindings,
  DEFAULT_AI_REPORT_SETTINGS,
  normalizeAiReportSettings,
  stripModelReasoning,
  type AiChatMessage,
  type AiReasoningEffort,
  type AiReportSettings,
  type ComposeAiReportInput,
} from "./application/ai-report.ts";
export type {
  ActionClaim,
  ActionCompletion,
  ClaimActionRequest,
  CompleteActionInput,
  ExecutionPermit,
  InvestigationExecutor,
  InvestigationStore,
  InvestigationTransaction,
} from "./ports/investigation-store.ts";
