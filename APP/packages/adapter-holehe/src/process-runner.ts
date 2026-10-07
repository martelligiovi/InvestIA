import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { HoleheModule, HoleheRunner } from "./holehe-contract.ts";

export type HoleheProcessErrorCode = "spawn_failure" | "process_failure" | "timeout" | "output_limit";

export class HoleheProcessError extends Error {
  readonly code: HoleheProcessErrorCode;

  constructor(code: HoleheProcessErrorCode) {
    super(`Holehe bridge failed: ${code}`);
    this.name = "HoleheProcessError";
    this.code = code;
  }
}

export interface HoleheProcessOptions {
  readonly pythonExecutable?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export function createHoleheProcessRunner(options: HoleheProcessOptions = {}): HoleheRunner {
  const pythonExecutable = options.pythonExecutable ?? process.env.PYTHON ?? "python";
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxOutputBytes = options.maxOutputBytes ?? 64 * 1024;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new RangeError("timeoutMs must be positive");
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new RangeError("maxOutputBytes must be positive");
  }

  const bridgePath = fileURLToPath(new URL("../python/holehe_bridge.py", import.meta.url));
  return {
    run(moduleName: HoleheModule, email: string): Promise<string> {
      return new Promise((resolve, reject) => {
        const child = spawn(pythonExecutable, ["-B", bridgePath, moduleName, email], {
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let settled = false;
        let outputBytes = 0;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const output: Buffer[] = [];

        const finish = (error?: HoleheProcessError, value?: string) => {
          if (settled) return;
          settled = true;
          if (timeout) clearTimeout(timeout);
          if (error) reject(error);
          else resolve(value ?? "");
        };

        child.stdout.on("data", (chunk: Buffer | string) => {
          if (settled) return;
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          outputBytes += buffer.byteLength;
          if (outputBytes > maxOutputBytes) {
            child.kill("SIGKILL");
            finish(new HoleheProcessError("output_limit"));
            return;
          }
          output.push(buffer);
        });

        // Drain but never retain or echo stderr: upstream exceptions can contain the target email.
        child.stderr.resume();
        child.on("error", () => finish(new HoleheProcessError("spawn_failure")));
        child.on("close", (code) => {
          if (code !== 0) {
            finish(new HoleheProcessError("process_failure"));
            return;
          }
          finish(undefined, Buffer.concat(output).toString("utf8"));
        });

        timeout = setTimeout(() => {
          child.kill("SIGKILL");
          finish(new HoleheProcessError("timeout"));
        }, timeoutMs);
      });
    },
  };
}
