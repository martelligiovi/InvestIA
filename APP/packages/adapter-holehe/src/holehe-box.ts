import type {
  EmailSeed,
  RegistrationObservation,
  RegistrationStatus,
  SeedBox,
} from "@investia/core";
import { z } from "zod";
import { HOLEHE_MODULES, type HoleheModule, type HoleheRunner } from "./holehe-contract.ts";
import { createHoleheProcessRunner } from "./process-runner.ts";

const EmailSeedSchema = z.object({
  kind: z.literal("email"),
  value: z.string().email(),
}).strict();

const BridgeResponseSchema = z.object({
  contract_version: z.literal(1),
  status: z.enum(["registered", "not_registered", "rate_limited", "error", "unknown"]),
}).strict();

export function createHoleheBox(
  runner: HoleheRunner = createHoleheProcessRunner(),
  moduleName: HoleheModule = "github",
): SeedBox<EmailSeed, RegistrationObservation> {
  return {
    id: `holehe:${moduleName}`,
    inputKind: "email",
    async execute(input) {
      const seed = EmailSeedSchema.parse(input);
      let status: RegistrationStatus = "error";
      try {
        const raw = await runner.run(moduleName, seed.value);
        const parsed = BridgeResponseSchema.safeParse(JSON.parse(raw) as unknown);
        if (parsed.success) status = parsed.data.status;
      } catch {
        // Process and protocol failures are observations of unknown registration state, not positives.
        status = "error";
      }
      return [{ kind: "registration", seed, provider: moduleName, status }];
    },
  };
}

export { HOLEHE_MODULES };
