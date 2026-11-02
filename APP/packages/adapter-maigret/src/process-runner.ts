import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface MaigretRunner { run(username: string): Promise<string>; }
export type MaigretProcessErrorCode = "spawn_failure" | "process_failure" | "timeout" | "output_limit" | "missing_report";
export class MaigretProcessError extends Error {
  readonly code: MaigretProcessErrorCode;
  constructor(code: MaigretProcessErrorCode) {
    super(`Maigret execution failed: ${code}`);
    this.name = "MaigretProcessError";
    this.code = code;
  }
}
export interface MaigretProcessOptions {
  readonly pythonExecutable?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly outputDirectory?: string;
}

/** One CLI token: never an option, never several targets, never a path. */
export const MAIGRET_USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Recursion stays off: new usernames reach Maigret only as operator-confirmed seeds.
 * Auto-update stays off: the pinned release always uses its bundled site database.
 */
export function maigretArguments(username: string, folder: string): string[] {
  return [
    "-B", "-m", "maigret", username, "--json", "simple", "--folderoutput", folder,
    "--top-sites", "500", "--timeout", "30", "--retries", "1",
    "--no-recursion", "--no-autoupdate", "--no-color", "--no-progressbar",
  ];
}

export function createMaigretProcessRunner(options: MaigretProcessOptions = {}): MaigretRunner {
  const python = options.pythonExecutable ?? process.env.MAIGRET_PYTHON ?? "python";
  const timeoutMs = options.timeoutMs ?? 15 * 60_000;
  const maxBytes = options.maxOutputBytes ?? 16 * 1024 * 1024;
  const root = resolve(options.outputDirectory ?? ".maigret-runs");
  for (const [name, value] of [["timeoutMs", timeoutMs], ["maxOutputBytes", maxBytes]] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be positive`);
  }
  return {
    async run(username) {
      if (!MAIGRET_USERNAME_PATTERN.test(username)) throw new Error("A valid username seed is required");
      await mkdir(root, { recursive: true, mode: 0o700 });
      const directory = await mkdtemp(join(root, "scan-"));
      const report = join(directory, `report_${username}_simple.json`);
      try {
        await new Promise<void>((resolveRun, reject) => {
          const child = spawn(python, maigretArguments(username, directory), {
            cwd: directory, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
          });
          let failure: MaigretProcessError | undefined;
          let bytes = 0;
          const terminate = (code: MaigretProcessErrorCode) => {
            if (failure) return;
            failure = new MaigretProcessError(code);
            child.kill("SIGKILL");
          };
          // Count and drain diagnostics without retaining usernames or provider errors.
          const drain = (chunk: Buffer | string) => {
            bytes += Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(chunk);
            if (bytes > maxBytes) terminate("output_limit");
          };
          child.stdout.on("data", drain);
          child.stderr.on("data", drain);
          const timer = setTimeout(() => terminate("timeout"), timeoutMs);
          child.once("error", () => { clearTimeout(timer); reject(new MaigretProcessError("spawn_failure")); });
          child.once("close", (code) => {
            clearTimeout(timer);
            if (failure) reject(failure);
            else if (code !== 0) reject(new MaigretProcessError("process_failure"));
            else resolveRun();
          });
        });
        let info;
        try { info = await lstat(report); } catch { throw new MaigretProcessError("missing_report"); }
        if (!info.isFile() || info.isSymbolicLink()) throw new MaigretProcessError("missing_report");
        if (info.size > maxBytes) throw new MaigretProcessError("output_limit");
        const bytes = await readFile(report);
        if (bytes.byteLength > maxBytes) throw new MaigretProcessError("output_limit");
        return bytes.toString("utf8");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}
