import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { z } from "zod";
import {
  ActionRerunConflictError,
  AI_MAX_TOKENS_RANGE,
  AI_REASONING_EFFORTS,
  buildAiReportMessages,
  buildEvidenceNormalizationMessages,
  compileInvestigationReport,
  composeAiReport,
  countOmittedAiReportFindings,
  decodoSourceContentHash,
  DEFAULT_AI_REPORT_SETTINGS,
  findingSeedNodeId,
  INVESTIGATION_NAME_MAX_LENGTH,
  USERNAME_SEED_PATTERN,
  normalizeAiReportSettings,
  parseEvidenceNormalization,
  type EvidenceAiNormalization,
  type EvidenceRecord,
  type GitHubCatalogAction,
  type Investigation,
  type InvestigationService,
} from "@investia/core";
import {
  InvestigationClaimConflictError,
  InvestigationNotFoundError,
} from "./postgres-investigation-store.ts";
import type { AiSettingsRecord, AiSettingsStore } from "./ai-settings-store.ts";
import type { EvidenceNormalizationJobStore } from "./evidence-normalization-job-store.ts";
import { isDecodoNormalizationEvidence, NVIDIA_PROVIDER_ERROR_CODES } from "./evidence-normalization-runner.ts";
import type { EvidenceNormalizationStore } from "./evidence-normalization-store.ts";
import type { InvestigationActionRunner } from "./investigation-run-graph.ts";
import { NvidiaProviderError, type NvidiaBuildGateway } from "./nvidia-build.ts";
import type { InvestigationProjector } from "./neo4j-investigation-projector.ts";
import type { GhuntSession } from "../../adapter-ghunt/src/index.ts";
import { isLocalSameOriginRequest, registerGhuntRoutes } from "./ghunt-routes.ts";
import { DECODO_API_MODES, isPublicDecodoFailure, normalizeDecodoToken } from "../../adapter-decodo/src/index.ts";
import { isValidDecodoToken, type DecodoSettingsRecord, type DecodoSettingsStore } from "./decodo-settings-store.ts";
import type { FacecheckSettingsRecord, FacecheckSettingsStore } from "./facecheck-settings-store.ts";
import { registerFrontend } from "./serve-frontend.ts";

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly publicMessage: string;

  constructor(status: number, code: string, publicMessage: string) {
    super(publicMessage);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.publicMessage = publicMessage;
  }
}

const ReasonBody = z.object({ reason: z.string().trim().min(1).max(2_000) }).strict();
const InvestigationName = z.string().trim().min(1).refine(
  (name) => [...name].length <= INVESTIGATION_NAME_MAX_LENGTH,
);
const CreateInvestigationBody = z.object({
  name: InvestigationName.optional(),
  intention: z.string().trim().min(1).optional(),
  advancementMode: z.enum(["automatic", "manual"]).optional(),
}).strict().optional();
const EmailBody = ReasonBody.extend({ email: z.string().email().max(320) }).strict();
const UsernameBody = ReasonBody.extend({ username: z.string().trim().regex(USERNAME_SEED_PATTERN) }).strict();
const UsernameDecisionBody = UsernameBody.extend({ decision: z.enum(["accepted", "rejected"]) }).strict();
const AuthorizationBody = ReasonBody.extend({ granted: z.boolean() }).strict();
const ValidationBody = ReasonBody.extend({ status: z.enum(["accepted", "rejected", "inconclusive"]) }).strict();
const QueueDecodoBody = ReasonBody.partial().optional();
const EmptyBody = z.object({}).strict().optional();
const ActionRerunBody = z.object({ expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict();
const InvestigationParams = z.object({ id: z.string().min(1).max(200) }).strict();
const ActionParams = InvestigationParams.extend({ actionId: z.string().min(1).max(200) }).strict();
const EvidenceParams = InvestigationParams.extend({ evidenceId: z.string().min(1).max(200) }).strict();
const AiSettingsBody = z.object({
  apiKey: z.string().trim().min(1).max(512).regex(/^\S+$/).optional(),
  settings: z.object({
    model: z.string(),
    reasoningEffort: z.enum(AI_REASONING_EFFORTS),
    temperature: z.number(),
    topP: z.number(),
    maxTokens: z.number().int().min(AI_MAX_TOKENS_RANGE.min).max(AI_MAX_TOKENS_RANGE.max),
  }).partial().strict().optional(),
}).strict().refine((body) => body.apiKey !== undefined || body.settings !== undefined);

const FacecheckSettingsBody = z.object({
  token: z.string().trim().min(1).max(512).regex(/^\S+$/).optional(),
  testingMode: z.boolean().optional(),
}).strict().refine((body) => body.token !== undefined || body.testingMode !== undefined);

const DecodoSettingsBody = z.object({
  token: z.string().optional(),
  apiMode: z.enum(DECODO_API_MODES).optional(),
}).strict().refine(({ token, apiMode }) => token === undefined ? apiMode !== undefined : isValidDecodoToken(token, apiMode));

const PROVIDER_ERRORS = {
  unauthorized: new HttpError(502, NVIDIA_PROVIDER_ERROR_CODES.unauthorized, "NVIDIA Build rejected the API key"),
  rate_limited: new HttpError(502, NVIDIA_PROVIDER_ERROR_CODES.rate_limited, "NVIDIA Build rate limit reached; try again later"),
  rejected: new HttpError(502, NVIDIA_PROVIDER_ERROR_CODES.rejected, "NVIDIA Build rejected the model or parameters"),
  unavailable: new HttpError(502, NVIDIA_PROVIDER_ERROR_CODES.unavailable, "NVIDIA Build is unavailable or returned no report"),
  invalid_response: new HttpError(502, NVIDIA_PROVIDER_ERROR_CODES.invalid_response, "NVIDIA Build is unavailable or returned no report"),
  timeout: new HttpError(502, NVIDIA_PROVIDER_ERROR_CODES.timeout, "The NVIDIA Build model did not answer in time; its free endpoint may be saturated"),
  truncated: new HttpError(502, NVIDIA_PROVIDER_ERROR_CODES.truncated, "The model used its whole token budget before writing the report"),
} as const;

/** Shows enough to recognize the stored key without disclosing it. */
function apiKeyHint(apiKey: string): string {
  return apiKey.length >= 16 ? `${apiKey.slice(0, 6)}…${apiKey.slice(-4)}` : "…";
}

function aiSettingsView(record: AiSettingsRecord | undefined) {
  const apiKey = record?.apiKey ?? null;
  return {
    apiKeyConfigured: apiKey !== null,
    apiKeyHint: apiKey === null ? null : apiKeyHint(apiKey),
    settings: record?.settings ?? DEFAULT_AI_REPORT_SETTINGS,
    defaults: DEFAULT_AI_REPORT_SETTINGS,
  };
}

function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HttpError(400, "INVALID_REQUEST", "Invalid request");
  return parsed.data;
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function publicError(error: unknown): unknown {
  if (error instanceof HttpError) return error;
  if (error instanceof NvidiaProviderError) return PROVIDER_ERRORS[error.kind];
  if (error instanceof InvestigationNotFoundError) return new HttpError(404, "NOT_FOUND", "Investigation not found");
  if (error instanceof InvestigationClaimConflictError) return new HttpError(409, "CONFLICT", "Action state changed; reload before retrying");
  if (error instanceof ActionRerunConflictError) return new HttpError(409, "CONFLICT", "The action cannot be rerun in the current state");
  if (isErrorCode(error, "23505")) return new HttpError(409, "CONFLICT", "The requested record already exists");
  if (error instanceof Error) {
    if (error.message === "A valid email seed is required" || error.message === "A valid username seed is required") {
      return new HttpError(400, "INVALID_REQUEST", "Invalid request");
    }
    if (error.message.startsWith("Action not found:") || error.message.startsWith("Evidence not found:")) {
      return new HttpError(404, "NOT_FOUND", "Record not found");
    }
    if ([
      "Email seed already exists in this investigation",
      "Username seed already exists in this investigation",
      "Username proposal not found",
      "GitHub actions require an email seed already recorded in this investigation",
      "A GitHub catalog action already exists for this email seed",
      "Scanner actions require an email seed already recorded in this investigation",
      "A scanner catalog action already exists for this email seed",
      "Only a proposed action can be approved",
      "A Decodo scrape action already exists for this FaceCheck match",
      "Only an accepted FaceCheck match can queue a Decodo scrape",
      "FaceCheck match does not have a valid public HTTP URL",
      "Decodo scraping is not enabled",
    ].includes(error.message)) return new HttpError(409, "CONFLICT", "Operation conflicts with the current investigation state");
  }
  return error;
}

async function serviceCall<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw publicError(error);
  }
}

const PUBLIC_RERUN_FAILURES = new Set([
  "Prior results changed during execution; the replacement was not applied.",
  "The replacement returned no confirmed results.",
]);

function publicFailureDetail(message: string, catalogId: GitHubCatalogAction["spec"]["catalogId"] | undefined, allowRerunReason = false): string {
  if (typeof message === "string") {
    if (catalogId === "decodo.url.v1" && isPublicDecodoFailure(message)) return message;
    if (allowRerunReason && PUBLIC_RERUN_FAILURES.has(message)) return message;
  }
  return "Execution failed.";
}

async function readOperationalReadiness(readLocal: () => Promise<boolean | null>): Promise<boolean | null> {
  try {
    return await readLocal();
  } catch {
    // A failed local readiness read must not hide the persisted investigation history.
    return null;
  }
}

function publicAction(action: GitHubCatalogAction): GitHubCatalogAction {
  const failure = action.failure === undefined ? undefined : publicFailureDetail(action.failure, action.spec.catalogId);
  const lastRerunFailure = action.lastRerunFailure === undefined ? undefined : publicFailureDetail(action.lastRerunFailure, action.spec.catalogId, true);
  if (failure === action.failure && lastRerunFailure === action.lastRerunFailure) return action;
  return {
    ...action,
    ...(failure === undefined ? {} : { failure }),
    ...(lastRerunFailure === undefined ? {} : { lastRerunFailure }),
  };
}

function publicInvestigation(investigation: Investigation): Investigation {
  const actionById = new Map(investigation.actions.map((action) => [action.id, action]));
  return {
    ...investigation,
    actions: investigation.actions.map(publicAction),
    audit: investigation.audit.map((event) => {
      if (event.failure === undefined) return event;
      const catalogId = event.actionId === undefined ? undefined : actionById.get(event.actionId)?.spec.catalogId;
      return { ...event, failure: publicFailureDetail(event.failure, catalogId, true) };
    }),
  };
}

function filterValidNormalizations(
  investigation: Investigation,
  stored: readonly EvidenceAiNormalization[],
): readonly EvidenceAiNormalization[] {
  if (stored.length === 0) return [];
  const decodoById = new Map<string, EvidenceRecord>();
  for (const item of investigation.evidence) {
    if (item.sourceId === "decodo:url" && item.finding !== undefined) {
      decodoById.set(item.id, item);
    }
  }
  return stored.filter((record) => {
    const evidence = decodoById.get(record.evidenceId);
    return evidence !== undefined && record.sourceContentHash === decodoSourceContentHash(evidence);
  });
}

function statusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) return undefined;
  const value = error.statusCode;
  return typeof value === "number" ? value : undefined;
}

export interface AiReportAdapters {
  readonly settings: AiSettingsStore;
  readonly gateway: NvidiaBuildGateway;
  readonly clock: () => string;
  readonly normalizations?: EvidenceNormalizationStore;
  readonly normalizationJobs?: EvidenceNormalizationJobStore;
  readonly wakeNormalizations?: () => void;
}

export interface BackendAppAdapters {
  readonly actionRunner: InvestigationActionRunner;
  readonly projector: InvestigationProjector;
  /** NVIDIA Build settings and AI reports; their routes are absent when omitted. */
  readonly ai?: AiReportAdapters;
  /** GHunt Google session routes; `session` is absent when GHunt is not installed. */
  readonly ghunt?: { readonly session?: GhuntSession };
  readonly facecheck?: FacecheckSettingsStore;
  readonly decodo?: DecodoSettingsStore;
  /** Request an automatic sweep without waiting for provider work in the HTTP response. */
  readonly wakeAutomaticRunner?: () => void;
}

export interface BackendAppOptions {
  /** Filesystem override for isolated serving tests; production resolves the frontend beside this module. */
  readonly frontendDistPath?: string;
  /** Optional startup notice hook used by the production entry point when the build is absent. */
  readonly onFrontendUnavailable?: () => void;
}

export function createBackendApp(
  service: InvestigationService,
  adapters: BackendAppAdapters,
  options: BackendAppOptions = {},
): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });

  async function projectPersistedState(id: string): Promise<void> {
    try {
      const persisted = await service.loadInvestigation(id);
      if (persisted !== undefined) await adapters.projector.project(persisted);
    } catch {
      // PostgreSQL already committed. Neo4j is downstream and is repaired by reconciliation.
    }
  }

  app.setErrorHandler((error, _request, reply) => {
    const safe = publicError(error);
    if (safe instanceof HttpError) {
      return reply.code(safe.status).send({ error: safe.code, message: safe.publicMessage });
    }
    const parserStatus = statusCode(error);
    if (parserStatus === 400 || parserStatus === 413 || parserStatus === 415) {
      const message = parserStatus === 413 ? "Request payload is too large" : "Invalid request";
      return reply.code(parserStatus).send({ error: parserStatus === 413 ? "PAYLOAD_TOO_LARGE" : "INVALID_REQUEST", message });
    }
    return reply.code(500).send({ error: "INTERNAL_ERROR", message: "Internal server error" });
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: "NOT_FOUND", message: "Not found" }));
  if (!registerFrontend(app, options.frontendDistPath)) options.onFrontendUnavailable?.();

  app.post("/investigations", async (request, reply) => {
    const body = input(CreateInvestigationBody, request.body);
    const investigation = await serviceCall(() => service.createInvestigation(body?.name, body?.intention, body?.advancementMode));
    await projectPersistedState(investigation.id);
    return reply.code(201).send(investigation);
  });

  app.post("/investigations/projections/reconcile", async () => {
    const summaries = await serviceCall(() => service.listInvestigations());
    const outcomes: { id: string; revision: number | null; status: "applied" | "stale" | "failed" }[] = [];
    for (const summary of summaries) {
      const persisted = await serviceCall(() => service.loadInvestigation(summary.id));
      if (persisted === undefined) {
        outcomes.push({ id: summary.id, revision: null, status: "failed" });
        continue;
      }
      try {
        const result = await adapters.projector.project(persisted);
        outcomes.push({ id: summary.id, revision: persisted.revision, status: result.status });
      } catch {
        outcomes.push({ id: summary.id, revision: persisted.revision, status: "failed" });
      }
    }
    return { outcomes };
  });

  app.get("/investigations", async () => {
    const [ghuntConnected, decodoConfigured] = await Promise.all([
      readOperationalReadiness(async () => {
        const status = await adapters.ghunt?.session?.status();
        return status === undefined ? null : status.state === "connected";
      }),
      readOperationalReadiness(async () => {
        const settings = await adapters.decodo?.load();
        return settings === undefined ? null : settings.token !== undefined;
      }),
    ]);
    return serviceCall(() => service.listInvestigations({ ghuntConnected, decodoConfigured }));
  });

  app.get<{ Params: { id: string } }>("/investigations/:id", async (request) => {
    const { id } = input(InvestigationParams, request.params);
    const investigation = await serviceCall(() => service.loadInvestigation(id));
    if (investigation === undefined) throw new HttpError(404, "NOT_FOUND", "Investigation not found");
    return publicInvestigation(investigation);
  });

  app.post<{ Params: { id: string } }>("/investigations/:id/emails", async (request, reply) => {
    const { id } = input(InvestigationParams, request.params);
    const body = input(EmailBody, request.body);
    const investigation = await serviceCall(() => service.addEmailSeed(id, body.email, body.reason));
    await projectPersistedState(id);
    return reply.code(201).send(publicInvestigation(investigation));
  });

  app.post<{ Params: { id: string } }>("/investigations/:id/usernames", async (request, reply) => {
    const { id } = input(InvestigationParams, request.params);
    const body = input(UsernameBody, request.body);
    const investigation = await serviceCall(() => service.addUsernameSeed(id, body.username, body.reason));
    await projectPersistedState(id);
    return reply.code(201).send(publicInvestigation(investigation));
  });

  app.post<{ Params: { id: string } }>("/investigations/:id/usernames/decisions", async (request, reply) => {
    const { id } = input(InvestigationParams, request.params);
    const body = input(UsernameDecisionBody, request.body);
    const investigation = await serviceCall(() => service.decideUsernameProposal(id, body.username, body.decision, body.reason));
    await projectPersistedState(id);
    return reply.code(201).send(publicInvestigation(investigation));
  });

  app.post<{ Params: { id: string } }>("/investigations/:id/actions/proposals", async (request, reply) => {
    const { id } = input(InvestigationParams, request.params);
    const body = input(EmailBody, request.body);
    const action = await serviceCall(() => service.proposeUserScannerAction(id, body.email, body.reason));
    await projectPersistedState(id);
    return reply.code(201).send(action);
  });

  app.post<{ Params: { id: string } }>("/investigations/:id/authorization", async (request) => {
    const { id } = input(InvestigationParams, request.params);
    const body = input(AuthorizationBody, request.body);
    const investigation = await serviceCall(() => service.authorize(id, body.granted, body.reason));
    await projectPersistedState(id);
    return publicInvestigation(investigation);
  });

  app.post<{ Params: { id: string; actionId: string } }>(
    "/investigations/:id/actions/:actionId/approval",
    async (request) => {
      const { id, actionId } = input(ActionParams, request.params);
      const body = input(ReasonBody, request.body);
      const action = await serviceCall(() => service.approveAction(id, actionId, body.reason));
      await projectPersistedState(id);
      return publicAction(action);
    },
  );

  app.post<{ Params: { id: string; actionId: string } }>("/investigations/:id/actions/:actionId/rerun", async (request, reply) => {
    if (!isLocalSameOriginRequest(request.headers)) throw new HttpError(403, "FORBIDDEN", "Reruns require a local same-origin request");
    const { id, actionId } = input(ActionParams, request.params);
    const { expectedRevision } = input(ActionRerunBody, request.body);
    const investigation = await serviceCall(() => service.requestActionRerun(id, actionId, expectedRevision));
    await projectPersistedState(id);
    if (investigation.advancementMode === "automatic") adapters.wakeAutomaticRunner?.();
    return reply.code(202).send(publicInvestigation(investigation));
  });

  app.post<{ Params: { id: string } }>("/investigations/:id/actions/run", async (request) => {
    const { id } = input(InvestigationParams, request.params);
    input(EmptyBody, request.body);
    const action = await serviceCall(() => adapters.actionRunner.run(id));
    await projectPersistedState(id);
    return { action: action === undefined ? null : publicAction(action) };
  });

  app.post<{ Params: { id: string; evidenceId: string } }>(
    "/investigations/:id/evidence/:evidenceId/validation",
    async (request, reply) => {
      const { id, evidenceId } = input(EvidenceParams, request.params);
      const body = input(ValidationBody, request.body);
      const investigation = await serviceCall(() => service.validateEvidence(id, evidenceId, body.status, body.reason));
      if (body.status === "accepted" && investigation.actions.some((action) => action.status === "queued" &&
        action.spec.catalogId === "decodo.url.v1" && action.sourceSeedId === findingSeedNodeId(evidenceId))) {
        adapters.wakeAutomaticRunner?.();
      }
      await projectPersistedState(id);
      return reply.code(201).send(publicInvestigation(investigation));
    },
  );

  app.post<{ Params: { id: string; evidenceId: string } }>(
    "/investigations/:id/evidence/:evidenceId/decodo",
    async (request, reply) => {
      const { id, evidenceId } = input(EvidenceParams, request.params);
      const reason = input(QueueDecodoBody, request.body)?.reason;
      const investigation = await serviceCall(() => service.queueDecodoAction(id, evidenceId, reason));
      adapters.wakeAutomaticRunner?.();
      await projectPersistedState(id);
      return reply.code(201).send(publicInvestigation(investigation));
    },
  );

  app.post<{ Params: { id: string; evidenceId: string } }>(
    "/investigations/:id/evidence/:evidenceId/rejection",
    async (request, reply) => {
      const { id, evidenceId } = input(EvidenceParams, request.params);
      const body = input(ReasonBody, request.body);
      const investigation = await serviceCall(() => service.validateEvidence(id, evidenceId, "rejected", body.reason));
      await projectPersistedState(id);
      return reply.code(201).send(publicInvestigation(investigation));
    },
  );

  app.post<{ Params: { id: string } }>("/investigations/:id/pause", async (request) => {
    const { id } = input(InvestigationParams, request.params);
    const body = input(ReasonBody, request.body);
    const investigation = await serviceCall(() => service.pause(id, body.reason));
    await projectPersistedState(id);
    return publicInvestigation(investigation);
  });

  app.post<{ Params: { id: string } }>("/investigations/:id/resume", async (request) => {
    const { id } = input(InvestigationParams, request.params);
    const body = input(ReasonBody, request.body);
    const investigation = await serviceCall(() => service.resume(id, body.reason));
    await projectPersistedState(id);
    return publicInvestigation(investigation);
  });

  app.get<{ Params: { id: string } }>("/investigations/:id/report", async (request, reply) => {
    const { id } = input(InvestigationParams, request.params);
    const investigation = await serviceCall(() => service.loadInvestigation(id));
    if (investigation === undefined) throw new HttpError(404, "NOT_FOUND", "Investigation not found");
    return reply.type("text/markdown; charset=utf-8").send(compileInvestigationReport(publicInvestigation(investigation)));
  });

  const ai = adapters.ai;
  app.get<{ Params: { id: string } }>("/investigations/:id/normalizations", async (request) => {
    const { id } = input(InvestigationParams, request.params);
    const investigation = await serviceCall(() => service.loadInvestigation(id));
    if (investigation === undefined) throw new HttpError(404, "NOT_FOUND", "Investigation not found");
    // Read jobs before normalizations so any completed job observes the summary written prior to completion.
    const jobs = ai?.normalizationJobs === undefined ? [] : await ai.normalizationJobs.listByInvestigation(id);
    const stored = ai?.normalizations === undefined ? [] : await ai.normalizations.listByInvestigation(id);
    return { normalizations: filterValidNormalizations(investigation, stored), jobs };
  });

  if (ai !== undefined) registerAiRoutes(app, service, ai);
  if (adapters.ghunt !== undefined) registerGhuntRoutes(app, adapters.ghunt.session);
  if (adapters.facecheck !== undefined) registerFacecheckRoutes(app, adapters.facecheck);
  if (adapters.decodo !== undefined) registerDecodoRoutes(app, adapters.decodo, adapters.wakeAutomaticRunner);

  return app;
}

function facecheckView(record: FacecheckSettingsRecord) {
  return { tokenConfigured: record.token !== undefined, tokenHint: record.token === undefined ? null : apiKeyHint(record.token), testingMode: record.testingMode };
}

function registerFacecheckRoutes(app: FastifyInstance, settings: FacecheckSettingsStore): void {
  function guard(headers: Parameters<typeof isLocalSameOriginRequest>[0]) {
    if (!isLocalSameOriginRequest(headers)) throw new HttpError(403, "FORBIDDEN", "FaceCheck settings can only be managed from this computer's InvestIA page");
  }
  app.get("/settings/facecheck", async (request) => {
    guard(request.headers);
    return facecheckView(await settings.load());
  });
  app.put("/settings/facecheck", async (request) => {
    guard(request.headers);
    const body = input(FacecheckSettingsBody, request.body);
    await settings.update(body);
    return facecheckView(await settings.load());
  });
  app.delete("/settings/facecheck/token", async (request) => {
    guard(request.headers);
    await settings.clearToken();
    return facecheckView(await settings.load());
  });
}

function decodoView(record: DecodoSettingsRecord) {
  return { tokenConfigured: record.token !== undefined, tokenHint: record.token === undefined ? null : apiKeyHint(record.token), apiMode: record.apiMode };
}

function registerDecodoRoutes(app: FastifyInstance, settings: DecodoSettingsStore, wakeAutomaticRunner?: () => void): void {
  const localOnly = { onRequest: async (request: FastifyRequest) => {
    if (!isLocalSameOriginRequest(request.headers)) {
      throw new HttpError(403, "FORBIDDEN", "Decodo settings can only be managed from this computer's InvestIA page");
    }
  } };
  app.get("/settings/decodo", localOnly, async () => decodoView(await settings.load()));
  app.put("/settings/decodo", localOnly, async (request) => {
    const body = input(DecodoSettingsBody, request.body);
    if (body.token !== undefined) {
      const effectiveMode = body.apiMode ?? (await settings.load()).apiMode;
      const normalized = normalizeDecodoToken(body.token, effectiveMode);
      if (!("token" in normalized)) throw new HttpError(400, "INVALID_REQUEST", "Invalid request");
      await settings.update({ ...body, token: normalized.token });
      wakeAutomaticRunner?.();
    } else {
      await settings.update(body);
    }
    return decodoView(await settings.load());
  });
  app.delete("/settings/decodo/token", localOnly, async () => {
    await settings.clearToken();
    return decodoView(await settings.load());
  });
}

function registerAiRoutes(app: FastifyInstance, service: InvestigationService, ai: AiReportAdapters): void {
  app.get("/settings/ai", async () => aiSettingsView(await ai.settings.load()));

  app.put("/settings/ai", async (request) => {
    const body = input(AiSettingsBody, request.body);
    const current = await ai.settings.load();
    let settings;
    try {
      settings = normalizeAiReportSettings({ ...current?.settings, ...body.settings });
    } catch {
      throw new HttpError(400, "INVALID_REQUEST", "Invalid request");
    }
    const record = { apiKey: body.apiKey ?? current?.apiKey ?? null, settings };
    await ai.settings.save(record, ai.clock());
    return aiSettingsView(record);
  });

  app.delete("/settings/ai/api-key", async () => {
    const current = await ai.settings.load();
    const record = { apiKey: null, settings: current?.settings ?? DEFAULT_AI_REPORT_SETTINGS };
    await ai.settings.save(record, ai.clock());
    return aiSettingsView(record);
  });

  app.get("/settings/ai/models", async () => ai.gateway.listFreeChatModels());

  app.post<{ Params: { id: string; evidenceId: string } }>(
    "/investigations/:id/evidence/:evidenceId/normalize",
    async (request) => {
      const { id, evidenceId } = input(EvidenceParams, request.params);
      input(EmptyBody, request.body);
      const investigation = await serviceCall(() => service.loadInvestigation(id));
      if (investigation === undefined) throw new HttpError(404, "NOT_FOUND", "Investigation not found");
      const evidence = investigation.evidence.find((item) => item.id === evidenceId);
      if (evidence === undefined) throw new HttpError(404, "NOT_FOUND", "Record not found");
      if (evidence.sourceId !== "decodo:url" || evidence.finding === undefined) {
        throw new HttpError(409, "CONFLICT", "Only Decodo page evidence can be normalized");
      }
      const configuration = await ai.settings.load();
      if (configuration?.apiKey == null) {
        throw new HttpError(409, "AI_NOT_CONFIGURED", "Configure an NVIDIA Build API key first");
      }
      const raw = await ai.gateway.complete(
        configuration.apiKey,
        configuration.settings,
        buildEvidenceNormalizationMessages(evidence),
      );
      let data;
      try {
        data = parseEvidenceNormalization(raw);
      } catch {
        throw new HttpError(
          502,
          "AI_PROVIDER_INVALID_RESPONSE",
          "NVIDIA Build did not return valid normalized JSON",
        );
      }
      const record: EvidenceAiNormalization = {
        evidenceId: evidence.id,
        model: configuration.settings.model,
        generatedAt: ai.clock(),
        sourceContentHash: decodoSourceContentHash(evidence),
        data,
      };
      await ai.normalizations?.save(id, record);
      return record;
    },
  );

  app.post<{ Params: { id: string; evidenceId: string } }>(
    "/investigations/:id/evidence/:evidenceId/normalize/queue",
    { onRequest: async (request) => {
      if (!isLocalSameOriginRequest(request.headers)) {
        throw new HttpError(403, "FORBIDDEN", "Evidence normalization can only be queued from this computer's InvestIA page");
      }
    } },
    async (request, reply) => {
      const { id, evidenceId } = input(EvidenceParams, request.params);
      input(EmptyBody, request.body);
      const investigation = await serviceCall(() => service.loadInvestigation(id));
      if (investigation === undefined) throw new HttpError(404, "NOT_FOUND", "Investigation not found");
      const evidence = investigation.evidence.find((item) => item.id === evidenceId);
      if (evidence === undefined) throw new HttpError(404, "NOT_FOUND", "Record not found");
      if (!isDecodoNormalizationEvidence(evidence)) {
        throw new HttpError(409, "CONFLICT", "Only Decodo page evidence can be normalized");
      }
      const configuration = await ai.settings.load();
      if (configuration?.apiKey == null) {
        throw new HttpError(409, "AI_NOT_CONFIGURED", "Configure an NVIDIA Build API key first");
      }
      if (ai.normalizationJobs === undefined) {
        throw new HttpError(503, "NORMALIZATION_QUEUE_UNAVAILABLE", "Evidence normalization queue is unavailable");
      }
      const result = await ai.normalizationJobs.enqueue(id, evidenceId);
      ai.wakeNormalizations?.();
      return reply.code(202).send(result);
    },
  );

  app.post<{ Params: { id: string } }>("/investigations/:id/report/ai", async (request, reply) => {
    const { id } = input(InvestigationParams, request.params);
    input(EmptyBody, request.body);
    const investigation = await serviceCall(() => service.loadInvestigation(id));
    if (investigation === undefined) throw new HttpError(404, "NOT_FOUND", "Investigation not found");
    const configuration = await ai.settings.load();
    if (configuration?.apiKey == null) {
      throw new HttpError(409, "AI_NOT_CONFIGURED", "Configure an NVIDIA Build API key first");
    }
    const visible = publicInvestigation(investigation);
    const storedNormalizations = ai.normalizations === undefined ? [] : await ai.normalizations.listByInvestigation(id);
    const normalizationMap = new Map(storedNormalizations.map((item) => [item.evidenceId, item]));
    const narrative = await ai.gateway.complete(
      configuration.apiKey,
      configuration.settings,
      buildAiReportMessages(visible, normalizationMap),
    );
    return reply.type("text/markdown; charset=utf-8").send(composeAiReport({
      narrative,
      model: configuration.settings.model,
      generatedAt: ai.clock(),
      omittedFindings: countOmittedAiReportFindings(visible, normalizationMap),
    }));
  });
}
