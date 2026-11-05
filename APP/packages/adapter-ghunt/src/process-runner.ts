import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

export interface GhuntRunner { run(email: string): Promise<string>; }
export type GhuntProcessErrorCode = "spawn_failure" | "process_failure" | "timeout" | "output_limit" | "missing_report" | "invalid_session_home" | "not_found" | "invalid_session" | "internal_failure";
export class GhuntProcessError extends Error {
  readonly code: GhuntProcessErrorCode;
  /** Non-sensitive shape of the failure (exit code, signal or errno code); never process output or paths. */
  readonly detail: string | undefined;
  constructor(code: GhuntProcessErrorCode, detail?: string) {
    super(`GHunt execution failed: ${code}${detail === undefined ? "" : ` (${detail})`}`);
    this.code = code;
    this.detail = detail;
    this.name = "GhuntProcessError";
  }
}
const TRACEBACK = "Traceback (most recent call last):";
/** Name of the final Python exception in the tail; its message may hold personal data and is dropped. */
function exceptionName(tail: string): string {
  const start = tail.lastIndexOf(TRACEBACK);
  if (start < 0) return "no traceback";
  const last = tail.slice(start).split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line && !line.startsWith(" ")).pop() ?? "";
  const name = /^([A-Za-z_]\w{0,63}(?:\.[A-Za-z_]\w{0,63}){0,7})(?::|$)/.exec(last)?.[1];
  return name === undefined || last === TRACEBACK ? "unparsed traceback" : name;
}
function exitDetail(code: number | null, signal: NodeJS.Signals | null, tail: string): string {
  return `${signal ? `signal ${signal}` : `exit ${code}`}, ${exceptionName(tail)}`;
}
function errnoDetail(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && /^E[A-Z0-9]{1,31}$/.test(code) ? code : undefined;
}
export interface GhuntProcessOptions {
  readonly sessionHome: string;
  readonly pythonExecutable?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  /** Existing directory for ephemeral reports, outside the credential home. */
  readonly outputDirectory?: string;
}

/** Mirrors the investigation service local-part rules and limits domains to Gmail. */
export function validGhuntEmail(email: string): boolean {
  return /^(?!\.)(?!.*\.\.)[A-Z0-9_'+.\-]*[A-Z0-9_+-]@(gmail\.com|googlemail\.com)$/i.test(email);
}
export function ghuntArguments(email: string, report: string): string[] {
  return ["-B", "-c", "from ghunt.ghunt import main; main()", "email", "--json", report, "--", email];
}
const NOT_FOUND = ["The target wasn't found.", "does not match a public Google Account."];
const INVALID_SESSION = ["GHuntInvalidSession", "GHuntLoginError"];
/** Classifies a failed run from a bounded output tail; the tail itself is never surfaced. */
function failureCode(tail: string): GhuntProcessErrorCode {
  if (INVALID_SESSION.some((marker) => tail.includes(marker))) return "invalid_session";
  if (NOT_FOUND.some((marker) => tail.includes(marker))) return "not_found";
  return "process_failure";
}
function inside(parent: string, path: string): boolean {
  const rel = relative(parent, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
export function createGhuntProcessRunner(options: GhuntProcessOptions): GhuntRunner {
  if (!options || typeof options.sessionHome !== "string" || !isAbsolute(options.sessionHome)) throw new GhuntProcessError("invalid_session_home");
  const home = resolve(options.sessionHome);
  const root = resolve(options.outputDirectory ?? tmpdir());
  if (inside(home, root)) throw new GhuntProcessError("invalid_session_home");
  const timeoutMs = options.timeoutMs ?? 15 * 60_000;
  const maxBytes = options.maxOutputBytes ?? 16 * 1024 * 1024;
  for (const value of [timeoutMs, maxBytes]) if (!Number.isSafeInteger(value) || value <= 0 || value > 0x7fffffff) throw new RangeError("Invalid GHunt limit");
  return {
    async run(email) {
      if (!validGhuntEmail(email)) throw new Error("A valid Gmail email seed is required");
      try {
      try {
        const info = await lstat(home);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error();
        if (process.platform !== "win32" && ((info.mode & 0o077) !== 0 || (typeof process.getuid === "function" && info.uid !== process.getuid()))) throw new Error();
      } catch { throw new GhuntProcessError("invalid_session_home"); }
      if (inside(await realpath(home), await realpath(root))) throw new GhuntProcessError("invalid_session_home");
      const directory = await mkdtemp(join(root, "ghunt-run-"));
      const report = join(directory, "report.json");
      try {
        const tail = await new Promise<string>((done, reject) => {
          const child = spawn(options.pythonExecutable ?? "python", ghuntArguments(email, report), {
            cwd: directory, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, HOME: home, USERPROFILE: home },
          });
          let failure: GhuntProcessError | undefined;
          let bytes = 0;
          let tail = "";
          const terminate = (code: GhuntProcessErrorCode) => {
            if (failure) return;
            failure = new GhuntProcessError(code);
            child.kill("SIGKILL");
          };
          const drain = (chunk: Buffer | string) => {
            bytes += Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(chunk);
            if (bytes > maxBytes) terminate("output_limit");
            else tail = (tail + chunk.toString()).slice(-4096);
          };
          child.stdout.on("data", drain);
          child.stderr.on("data", drain);
          const timer = setTimeout(() => terminate("timeout"), timeoutMs);
          child.once("error", () => { clearTimeout(timer); reject(new GhuntProcessError("spawn_failure")); });
          child.once("close", (code, signal) => {
            clearTimeout(timer);
            if (failure) reject(failure);
            else if (code !== 0) {
              const classified = failureCode(tail);
              reject(new GhuntProcessError(classified, classified === "process_failure" ? exitDetail(code, signal, tail) : undefined));
            }
            else done(tail);
          });
        });
        let info;
        try { info = await lstat(report); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT" && failureCode(tail) === "not_found") throw new GhuntProcessError("not_found");
          throw new GhuntProcessError("missing_report");
        }
        let handle;
        try {
          if (!info.isFile() || info.isSymbolicLink()) throw new Error();
          handle = await open(report, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        } catch { throw new GhuntProcessError("missing_report"); }
        try {
          const info = await handle.stat();
          if (!info.isFile()) throw new GhuntProcessError("missing_report");
          if (info.size > maxBytes) throw new GhuntProcessError("output_limit");
          const buffer = Buffer.alloc(maxBytes + 1);
          let total = 0;
          while (total < buffer.length) {
            const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
            if (bytesRead === 0) break;
            total += bytesRead;
          }
          if (total > maxBytes) throw new GhuntProcessError("output_limit");
          return buffer.subarray(0, total).toString("utf8");
        } finally { await handle.close(); }
      } finally { await rm(directory, { recursive: true, force: true }); }
      } catch (error) {
        if (error instanceof GhuntProcessError) throw error;
        throw new GhuntProcessError("internal_failure", errnoDetail(error));
      }
    },
  };
}
