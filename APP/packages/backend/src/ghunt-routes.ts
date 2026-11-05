import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { GhuntSessionError, type GhuntSession, type GhuntSessionStatus } from "../../adapter-ghunt/src/index.ts";

const ConnectBody = z.object({ code: z.string().min(1).max(16_384) }).strict();
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
const SESSION_ERRORS = {
  invalid_code: [400, "GHUNT_INVALID_CODE", "Paste the code exported by GHunt Companion"],
  rejected: [502, "GHUNT_LOGIN_REJECTED", "Google rejected the GHunt Companion code; export a new one and retry"],
  process_failure: [502, "GHUNT_UNAVAILABLE", "GHunt could not complete the connection"],
  timeout: [504, "GHUNT_TIMEOUT", "GHunt did not finish connecting in time"],
  busy: [409, "GHUNT_BUSY", "A Google connection is already in progress"],
} as const;

function loopbackHost(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    const url = new URL(`http://${value}`);
    return LOOPBACK_HOSTNAMES.has(url.hostname) && url.username === "" && url.password === "" ? url.host : undefined;
  } catch { return undefined; }
}

/**
 * The API has no user accounts; the Google session is guarded against other
 * websites (CSRF) and DNS rebinding by requiring a same-origin loopback request.
 */
export function isLocalSameOriginRequest(headers: FastifyRequest["headers"]): boolean {
  const host = loopbackHost(typeof headers.host === "string" ? headers.host : undefined);
  if (host === undefined) return false;
  const site = headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin" && site !== "none") return false;
  const origin = headers.origin;
  if (origin === undefined) return true;
  if (typeof origin !== "string") return false;
  try {
    const url = new URL(origin);
    return url.protocol === "http:" && url.host === host;
  } catch { return false; }
}

function view(status: GhuntSessionStatus) {
  return { available: true, state: status.state, account: status.account };
}

function refuse(reply: FastifyReply) {
  return reply.code(403).send({ error: "FORBIDDEN", message: "Google sessions can only be managed from this computer's InvestIA page" });
}

export function registerGhuntRoutes(app: FastifyInstance, session: GhuntSession | undefined): void {
  app.get("/settings/ghunt", async (request, reply) => {
    if (!isLocalSameOriginRequest(request.headers)) return refuse(reply);
    if (session === undefined) return { available: false, state: "requires_connection", account: null };
    return view(await session.status());
  });

  app.post("/settings/ghunt/session", async (request, reply) => {
    if (!isLocalSameOriginRequest(request.headers)) return refuse(reply);
    if (session === undefined) return reply.code(409).send({ error: "GHUNT_NOT_INSTALLED", message: "GHunt is not installed in this InvestIA instance" });
    const parsed = ConnectBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_REQUEST", message: "Invalid request" });
    try {
      return view(await session.connect(parsed.data.code));
    } catch (error) {
      const [status, code, message] = error instanceof GhuntSessionError ? SESSION_ERRORS[error.code] : SESSION_ERRORS.process_failure;
      return reply.code(status).send({ error: code, message });
    }
  });

  app.delete("/settings/ghunt/session", async (request, reply) => {
    if (!isLocalSameOriginRequest(request.headers)) return refuse(reply);
    if (session === undefined) return { available: false, state: "requires_connection", account: null };
    return view(await session.disconnect());
  });
}
