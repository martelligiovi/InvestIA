import { z } from "zod";
import { isScannerFinding, type EmailSeed, type RegistrationStatus, type ScannerObservation, type SeedBox } from "@investia/core";
import { createUserScannerProcessRunner, type UserScannerRunner } from "./process-runner.ts";
export { createUserScannerProcessRunner, scannerArguments, ScannerProcessError, type ScannerProcessOptions, type UserScannerRunner } from "./process-runner.ts";

const SeedSchema = z.object({ kind: z.literal("email"), value: z.string().email().max(320) }).strict();
const ResultSchema = z.object({
  status: z.enum(["Registered", "Not Registered", "Found", "Not Found", "Error", "Skipped"]),
  email: z.string().email().optional(), username: z.string().trim().min(1).optional(),
  site_name: z.string().min(1), category: z.string().nullable().default(""),
  url: z.string().default(""), reason: z.string().default(""),
  extra: z.record(z.union([z.string(), z.boolean(), z.number().finite()])).default({}),
  media: z.record(z.string()).default({}),
}).refine((row) => (row.email !== undefined) !== (row.username !== undefined));

export function createUserScannerBox(runner: UserScannerRunner = createUserScannerProcessRunner()): SeedBox<EmailSeed, ScannerObservation> {
  return {
    id: "user-scanner:email", inputKind: "email",
    async execute(input) {
      const seed = SeedSchema.parse(input);
      const raw = await runner.run(seed.value);
      let rows;
      try { rows = z.array(ResultSchema).parse(JSON.parse(raw) as unknown); }
      catch { throw new Error("Invalid User Scanner report"); }
      return rows.map((row) => {
        const status: RegistrationStatus = row.status === "Registered" || row.status === "Found" ? "registered"
          : row.status === "Not Registered" || row.status === "Not Found" ? "not_registered"
          : row.status === "Error" ? "error" : "unknown";
        const finding = {
          target: row.email !== undefined ? { kind: "email" as const, value: row.email } : { kind: "username" as const, value: row.username! },
          upstreamStatus: row.status, url: row.url, category: row.category ?? "", reason: row.reason,
          extra: row.extra, media: row.media,
        };
        if (!isScannerFinding(finding)) throw new Error("Invalid User Scanner report");
        return { kind: "scanner_finding" as const, seed, provider: row.site_name, status, finding };
      });
    },
  };
}
