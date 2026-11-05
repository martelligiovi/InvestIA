import type { EmailSeed } from "../../core/src/domain/seed.ts";
import type { ScannerObservation } from "../../core/src/domain/observation.ts";
import type { SeedBox } from "../../core/src/domain/seed-box.ts";
import { GhuntProcessError, validGhuntEmail, type GhuntRunner } from "./process-runner.ts";
export { createGhuntProcessRunner, ghuntArguments, GhuntProcessError, validGhuntEmail } from "./process-runner.ts";
export type { GhuntRunner, GhuntProcessOptions, GhuntProcessErrorCode } from "./process-runner.ts";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() && value.length <= 1024 ? value.trim() : undefined;
}
function avatar(value: unknown): string | undefined {
  const photo = record(value);
  if (!photo || photo.isDefault !== false || typeof photo.url !== "string") return undefined;
  try {
    const url = new URL(photo.url);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return undefined;
    return url.href;
  } catch { return undefined; }
}

/** The runner is mandatory: session ownership and authorization belong to the caller. */
export function createGhuntBox(runner: GhuntRunner): SeedBox<EmailSeed, ScannerObservation> {
  return {
    id: "ghunt:email", inputKind: "email",
    async execute(input) {
      if (!input || input.kind !== "email" || typeof input.value !== "string" || Object.keys(input).some((key) => key !== "kind" && key !== "value")) {
        throw new Error("A valid Gmail email seed is required");
      }
      const value = input.value.trim();
      if (!validGhuntEmail(value)) throw new Error("A valid Gmail email seed is required");
      const seed: EmailSeed = { kind: "email", value };
      let raw: string;
      try { raw = await runner.run(value); }
      catch (error) {
        if (error instanceof GhuntProcessError && error.code === "not_found") return [];
        throw error;
      }
      let profile: Record<string, unknown> | undefined;
      try { profile = record(record(record(JSON.parse(raw))?.PROFILE_CONTAINER)?.profile); }
      catch { throw new Error("Invalid GHunt report"); }
      const personId = text(profile?.personId);
      if (!profile || !personId) throw new Error("Invalid GHunt report");
      const fullname = text(record(record(profile.names)?.PROFILE)?.fullname);
      const photo = avatar(record(profile.profilePhotos)?.PROFILE);
      const extra: Record<string, string> = { source: "ghunt public profile", person_id: personId };
      if (fullname) extra.fullname = fullname;
      const media: Record<string, string> = photo ? { avatar: photo } : {};
      return [{
        kind: "scanner_finding", seed, provider: "GHunt", status: "registered",
        finding: { target: seed, upstreamStatus: "Found", url: "", category: "Profile", reason: "", extra, media },
      }];
    },
  };
}
