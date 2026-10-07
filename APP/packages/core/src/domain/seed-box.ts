import type { Observation } from "./observation.ts";
import type { Seed } from "./seed.ts";

export interface SeedBox<I extends Seed, O extends Observation> {
  readonly id: string;
  readonly inputKind: I["kind"];
  execute(seed: I): Promise<readonly O[]>;
}
