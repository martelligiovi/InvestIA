import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { GhuntProcessError, type GhuntRunner } from "./process-runner.ts";

export type GhuntSessionState = "connected" | "requires_connection" | "invalid_session";
export interface GhuntSessionStatus {
  readonly state: GhuntSessionState;
  /** Google account that owns the stored session, when GHunt reported it. */
  readonly account: string | null;
}
export type GhuntSessionErrorCode = "invalid_code" | "rejected" | "process_failure" | "timeout" | "busy";
export class GhuntSessionError extends Error {
  readonly code: GhuntSessionErrorCode;
  constructor(code: GhuntSessionErrorCode) {
    super(`GHunt session operation failed: ${code}`);
    this.code = code;
    this.name = "GhuntSessionError";
  }
}
export interface GhuntSession {
  status(): Promise<GhuntSessionStatus>;
  /** Exchanges a GHunt Companion code (base64 JSON with an oauth_token) for a stored session. */
  connect(companionCode: string): Promise<GhuntSessionStatus>;
  disconnect(): Promise<GhuntSessionStatus>;
  /** Runs one GHunt operation at a time against the stored session. */
  exclusive<T>(operation: () => Promise<T>): Promise<T>;
  markInvalid(): Promise<void>;
}
export interface GhuntSessionOptions {
  readonly sessionHome: string;
  readonly pythonExecutable?: string;
  readonly timeoutMs?: number;
}

const COMPANION_CODE_MAX = 16_384;
const RESULT_PREFIX = "INVESTIA_GHUNT_ACCOUNT=";
/** Non-interactive equivalent of `ghunt login` choice 2; the code arrives on stdin, never in argv. */
export const GHUNT_LOGIN_SCRIPT = [
  "import asyncio, base64, json, sys",
  "from ghunt.helpers import auth",
  "from ghunt.helpers.utils import get_httpx_client",
  "from ghunt.objects.base import GHuntCreds",
  "async def main():",
  "    token = json.loads(base64.b64decode(sys.stdin.read().strip(), validate=True))['oauth_token']",
  "    client = get_httpx_client()",
  "    try:",
  "        master_token, _services, email, _name = await auth.android_master_auth(client, token)",
  "        creds = GHuntCreds()",
  "        creds.android.master_token = master_token",
  "        creds.cookies = {'a': 'a'}",
  "        creds.osids = {'a': 'a'}",
  "        await auth.gen_cookies_and_osids(client, creds)",
  "        creds.save_creds(silent=True)",
  "    finally:",
  "        await client.aclose()",
  `    print('${RESULT_PREFIX}' + json.dumps(email))`,
  "asyncio.run(main())",
].join("\n");

/** Accepts only the Companion export shape so arbitrary input never reaches Python. */
export function validCompanionCode(code: unknown): code is string {
  if (typeof code !== "string") return false;
  const value = code.trim();
  if (value.length === 0 || value.length > COMPANION_CODE_MAX || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  try {
    const data: unknown = JSON.parse(Buffer.from(value, "base64").toString("utf8"));
    if (data === null || typeof data !== "object" || Array.isArray(data)) return false;
    const token = (data as Record<string, unknown>).oauth_token;
    return typeof token === "string" && /^oauth2_4\/[\x21-\x7e]+$/.test(token);
  } catch { return false; }
}

export function createGhuntSession(options: GhuntSessionOptions): GhuntSession {
  if (!options || typeof options.sessionHome !== "string" || !isAbsolute(options.sessionHome)) throw new GhuntSessionError("process_failure");
  const home = resolve(options.sessionHome);
  const credentials = join(home, ".malfrats", "ghunt", "creds.m");
  const invalidMarker = join(home, ".investia-invalid");
  const accountFile = join(home, ".investia-account.json");
  const timeoutMs = options.timeoutMs ?? 2 * 60_000;
  let queue: Promise<unknown> = Promise.resolve();
  let connecting = false;

  const exclusive = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = queue.then(operation, operation);
    queue = next.catch(() => undefined);
    return next;
  };
  const exists = async (path: string) => {
    try { return (await lstat(path)).isFile(); } catch { return false; }
  };
  const status = async (): Promise<GhuntSessionStatus> => {
    if (!await exists(credentials)) return { state: "requires_connection", account: null };
    let account: string | null = null;
    try {
      const stored: unknown = JSON.parse(await readFile(accountFile, "utf8"));
      if (typeof stored === "string" && stored.length <= 320) account = stored;
    } catch { account = null; }
    return { state: await exists(invalidMarker) ? "invalid_session" : "connected", account };
  };
  const clear = async () => {
    for (const path of [credentials, invalidMarker, accountFile]) await rm(path, { force: true });
  };
  const login = (code: string, staging: string) => new Promise<string | null>((done, reject) => {
    const child = spawn(options.pythonExecutable ?? "python", ["-B", "-c", GHUNT_LOGIN_SCRIPT], {
      cwd: staging, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, HOME: staging, USERPROFILE: staging },
    });
    let stdout = "";
    let failure: GhuntSessionError | undefined;
    const timer = setTimeout(() => { failure = new GhuntSessionError("timeout"); child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer | string) => { stdout = (stdout + chunk.toString()).slice(-4096); });
    child.stderr.on("data", () => undefined);
    child.once("error", () => { clearTimeout(timer); reject(new GhuntSessionError("process_failure")); });
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      const line = stdout.split(/\r?\n/).find((entry) => entry.startsWith(RESULT_PREFIX));
      if (exitCode !== 0 || line === undefined) return reject(new GhuntSessionError("rejected"));
      try {
        const email: unknown = JSON.parse(line.slice(RESULT_PREFIX.length));
        done(typeof email === "string" && email.length <= 320 ? email : null);
      } catch { done(null); }
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(code);
  });

  return {
    status,
    exclusive,
    async connect(companionCode) {
      if (!validCompanionCode(companionCode)) throw new GhuntSessionError("invalid_code");
      if (connecting) throw new GhuntSessionError("busy");
      connecting = true;
      try {
        return await exclusive(async () => {
          await mkdir(home, { recursive: true, mode: 0o700 });
          if (process.platform !== "win32") await chmod(home, 0o700);
          // A failed attempt must leave the previous session untouched.
          const staging = await mkdtemp(join(home, ".connect-"));
          try {
            const account = await login(companionCode.trim(), staging);
            const staged = join(staging, ".malfrats", "ghunt", "creds.m");
            if (!await exists(staged)) throw new GhuntSessionError("rejected");
            await clear();
            await mkdir(dirname(credentials), { recursive: true, mode: 0o700 });
            await rename(staged, credentials);
            await writeFile(accountFile, JSON.stringify(account), { mode: 0o600 });
          } finally { await rm(staging, { recursive: true, force: true }); }
          return status();
        });
      } finally { connecting = false; }
    },
    async disconnect() {
      return exclusive(async () => { await clear(); return status(); });
    },
    async markInvalid() {
      if (await exists(credentials)) await writeFile(invalidMarker, "", { mode: 0o600 });
    },
  };
}

/** Serializes scans with session changes and records upstream session rejections. */
export function createSessionBoundRunner(session: GhuntSession, runner: GhuntRunner): GhuntRunner {
  return {
    run(email) {
      return session.exclusive(async () => {
        try { return await runner.run(email); }
        catch (error) {
          if (error instanceof GhuntProcessError && error.code === "invalid_session") await session.markInvalid();
          throw error;
        }
      });
    },
  };
}
