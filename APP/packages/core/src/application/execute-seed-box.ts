import type { Observation } from "../domain/observation.ts";
import type { Seed } from "../domain/seed.ts";
import type { SeedBox } from "../domain/seed-box.ts";

export interface ExecutionState {
  readonly authorized: boolean;
  readonly approved: boolean;
  readonly paused: boolean;
}

export type ExecutionDenialCode = "paused" | "unauthorized" | "unapproved";

export class ExecutionDeniedError extends Error {
  readonly code: ExecutionDenialCode;

  constructor(code: ExecutionDenialCode) {
    super(`Seed box execution denied: ${code}`);
    this.name = "ExecutionDeniedError";
    this.code = code;
  }
}

export async function executeSeedBox<I extends Seed, O extends Observation>(
  box: SeedBox<I, O>,
  seed: I,
  state: ExecutionState,
): Promise<readonly O[]> {
  if (state.paused !== false) throw new ExecutionDeniedError("paused");
  if (state.authorized !== true) throw new ExecutionDeniedError("unauthorized");
  if (state.approved !== true) throw new ExecutionDeniedError("unapproved");
  return box.execute(seed);
}
