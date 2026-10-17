import { spawn } from "node:child_process";
import { mkdir, mkdtemp, lstat, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface UserScannerRunner { run(email: string): Promise<string>; }
export type ScannerProcessErrorCode = "spawn_failure" | "process_failure" | "timeout" | "output_limit" | "missing_report";
export class ScannerProcessError extends Error {
  readonly code: ScannerProcessErrorCode;
  constructor(code: ScannerProcessErrorCode) {
    super(`User Scanner execution failed: ${code}`);
    this.name = "ScannerProcessError";
    this.code = code;
  }
}
export interface ScannerProcessOptions {
  readonly pythonExecutable?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly outputDirectory?: string;
}

export function scannerArguments(email: string, reportPath: string): string[] {
  return ["-B", "-m", "user_scanner", "-e", email, "--allow-loud", "--cross-scan", "--cross-links", "all", "--cross-emails", "all", "--cross-depth", "2", "--cross-sweep", "25", "--verbose", "-f", "json", "-o", reportPath];
}

export function createUserScannerProcessRunner(options: ScannerProcessOptions = {}): UserScannerRunner {
  const python = options.pythonExecutable ?? process.env.PYTHON ?? "python";
  const timeoutMs = options.timeoutMs ?? 20 * 60_000;
  const maxBytes = options.maxOutputBytes ?? 16 * 1024 * 1024;
  const root = resolve(options.outputDirectory ?? ".scanner-runs");
  for (const [name, value] of [["timeoutMs", timeoutMs], ["maxOutputBytes", maxBytes]] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be positive`);
  }
  return {
    async run(email) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("A valid email seed is required");
      await mkdir(root, { recursive: true, mode: 0o700 });
      const directory = await mkdtemp(join(root, "scan-"));
      const report = join(directory, "report.json");
      try {
        await new Promise<void>((resolveRun, reject) => {
          const child = spawn(python, scannerArguments(email, report), { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
          let failure: ScannerProcessError | undefined;
          let bytes = 0;
          const terminate = (code: ScannerProcessErrorCode) => {
            if (failure) return;
            failure = new ScannerProcessError(code);
            child.kill("SIGKILL");
          };
          // Count and drain diagnostics without retaining target addresses or provider errors.
          const drain = (chunk: Buffer | string) => {
            bytes += Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(chunk);
            if (bytes > maxBytes) terminate("output_limit");
          };
          child.stdout.on("data", drain);
          child.stderr.on("data", drain);
          const timer = setTimeout(() => terminate("timeout"), timeoutMs);
          child.once("error", () => { clearTimeout(timer); reject(new ScannerProcessError("spawn_failure")); });
          child.once("close", (code) => {
            clearTimeout(timer);
            if (failure) reject(failure);
            else if (code !== 0) reject(new ScannerProcessError("process_failure"));
            else resolveRun();
          });
        });
        let info;
        try { info = await lstat(report); } catch { throw new ScannerProcessError("missing_report"); }
        if (!info.isFile() || info.isSymbolicLink()) throw new ScannerProcessError("missing_report");
        if (info.size > maxBytes) throw new ScannerProcessError("output_limit");
        const bytes = await readFile(report);
        if (bytes.byteLength > maxBytes) throw new ScannerProcessError("output_limit");
        return bytes.toString("utf8");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}
