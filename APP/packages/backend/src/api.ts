import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import {
  compileInvestigationReport,
  INVESTIGATION_NAME_MAX_LENGTH,
  type GitHubCatalogAction,
  type Investigation,
  type InvestigationService,
} from "@investia/core";
import {
  InvestigationClaimConflictError,
  InvestigationNotFoundError,
} from "./postgres-investigation-store.ts";
import type { InvestigationActionRunner } from "./investigation-run-graph.ts";
import type { InvestigationProjector } from "./neo4j-investigation-projector.ts";
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
const AuthorizationBody = ReasonBody.extend({ granted: z.boolean() }).strict();
const ValidationBody = ReasonBody.extend({ status: z.enum(["accepted", "rejected", "inconclusive"]) }).strict();
const EmptyBody = z.object({}).strict().optional();
const InvestigationParams = z.object({ id: z.string().min(1).max(200) }).strict();
const ActionParams = InvestigationParams.extend({ actionId: z.string().min(1).max(200) }).strict();
const EvidenceParams = InvestigationParams.extend({ evidenceId: z.string().min(1).max(200) }).strict();

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
  if (error instanceof InvestigationNotFoundError) return new HttpError(404, "NOT_FOUND", "Investigation not found");
  if (error instanceof InvestigationClaimConflictError) return new HttpError(409, "CONFLICT", "Action state changed; reload before retrying");
  if (isErrorCode(error, "23505")) return new HttpError(409, "CONFLICT", "The requested record already exists");
  if (error instanceof Error) {
    if (error.message === "A valid email seed is required") return new HttpError(400, "INVALID_REQUEST", "Invalid request");
    if (error.message.startsWith("Action not found:") || error.message.startsWith("Evidence not found:")) {
      return new HttpError(404, "NOT_FOUND", "Record not found");
    }
    if ([
      "Email seed already exists in this investigation",
      "GitHub actions require an email seed already recorded in this investigation",
      "A GitHub catalog action already exists for this email seed",
      "Only a proposed action can be approved",
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

function publicAction(action: GitHubCatalogAction): GitHubCatalogAction {
  return action.failure === undefined ? action : { ...action, failure: "Execution failed." };
}

function publicInvestigation(investigation: Investigation): Investigation {
  return { ...investigation, actions: investigation.actions.map(publicAction) };
}

function statusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) return undefined;
  const value = error.statusCode;
  return typeof value === "number" ? value : undefined;
}

export interface BackendAppAdapters {
  readonly actionRunner: InvestigationActionRunner;
  readonly projector: InvestigationProjector;
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

  app.get("/investigations", async () => serviceCall(() => service.listInvestigations()));

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

  app.post<{ Params: { id: string } }>("/investigations/:id/actions/proposals", async (request, reply) => {
    const { id } = input(InvestigationParams, request.params);
    const body = input(EmailBody, request.body);
    const action = await serviceCall(() => service.proposeGitHubAction(id, body.email, body.reason));
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

  return app;
}
