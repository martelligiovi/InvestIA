import { z } from "zod";
import { isScannerFinding, type ScannerObservation, type SeedBox, type UsernameSeed } from "@investia/core";
import { createMaigretProcessRunner, MAIGRET_USERNAME_PATTERN, type MaigretRunner } from "./process-runner.ts";
export {
  createMaigretProcessRunner, MAIGRET_USERNAME_PATTERN, maigretArguments, MaigretProcessError,
  type MaigretProcessErrorCode, type MaigretProcessOptions, type MaigretRunner,
} from "./process-runner.ts";

const SeedSchema = z.object({ kind: z.literal("username"), value: z.string().trim().regex(MAIGRET_USERNAME_PATTERN) }).strict();
/** Mirrors maigret 0.6.6 `--json simple`: one entry per claimed site; unknown fields are ignored. */
const SiteSchema = z.object({
  url_user: z.string().nullish(),
  status: z.object({
    username: z.string().trim().min(1),
    status: z.literal("Claimed"),
    ids: z.record(z.unknown()).nullish(),
    tags: z.array(z.string()).nullish(),
  }),
  is_similar: z.boolean().nullish(),
  rank: z.number().finite().nullish(),
  ids_usernames: z.record(z.unknown()).nullish(),
  ids_links: z.array(z.unknown()).nullish(),
});
const ReportSchema = z.record(SiteSchema);
const IMAGE_FIELDS = new Set(["image", "avatar", "avatar_url", "profile_image"]);
/** Public profile fields worth keeping; anything else Maigret extracts is dropped. */
const PROFILE_FIELDS = new Set([
  "fullname", "name", "first_name", "last_name", "nickname", "username", "uid", "id",
  "bio", "description", "about", "status", "gender", "birthday", "language",
  "location", "country", "country_code", "city", "company", "occupation", "education", "website",
  "created_at", "updated_at", "last_seen", "is_verified",
  "follower_count", "following_count", "friends_count", "posts_count",
]);
/** Defense in depth: never keep anything that looks like a credential, even if allowlisted later. */
const SENSITIVE_FIELD = /pass|token|secret|key|session|cookie|auth|hash|credential|private/i;

function webUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  try {
    const { protocol } = new URL(value);
    return protocol === "https:" || protocol === "http:" ? value : "";
  } catch {
    return "";
  }
}

function strings(values: Iterable<unknown>): string[] {
  return [...values].filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => value.trim());
}

export function createMaigretBox(runner: MaigretRunner = createMaigretProcessRunner()): SeedBox<UsernameSeed, ScannerObservation> {
  return {
    id: "maigret:username", inputKind: "username",
    async execute(input) {
      const seed: UsernameSeed = SeedSchema.parse(input);
      const raw = await runner.run(seed.value);
      let report;
      try { report = ReportSchema.parse(JSON.parse(raw) as unknown); }
      catch { throw new Error("Invalid Maigret report"); }
      const observations: ScannerObservation[] = [];
      for (const [site, entry] of Object.entries(report)) {
        // Similar-search sites match loosely and are the main source of false positives.
        if (entry.is_similar === true) continue;
        const extra: Record<string, string | number> = { source: "maigret" };
        if (typeof entry.rank === "number") extra.rank = entry.rank;
        const media: Record<string, string> = {};
        for (const [key, value] of Object.entries(entry.status.ids ?? {})) {
          if (IMAGE_FIELDS.has(key)) {
            const avatar = webUrl(value);
            if (avatar !== "") media.avatar = avatar;
          } else if (typeof value === "string" && value.trim().length > 0 && PROFILE_FIELDS.has(key) && !SENSITIVE_FIELD.test(key)) {
            extra[key] = value.trim();
          }
        }
        const discovered = strings(Object.keys(entry.ids_usernames ?? {}));
        if (discovered.length > 0) extra.discovered_usernames = discovered.join(", ");
        const links = strings(entry.ids_links ?? []).filter((link) => webUrl(link) !== "");
        if (links.length > 0) extra.links = links.join(", ");
        const finding = {
          target: { kind: "username" as const, value: entry.status.username }, upstreamStatus: "Found" as const,
          url: webUrl(entry.url_user), category: entry.status.tags?.[0] ?? "", reason: "", extra, media,
        };
        if (!isScannerFinding(finding)) throw new Error("Invalid Maigret report");
        observations.push({ kind: "scanner_finding", seed, provider: site, status: "registered", finding });
      }
      return observations;
    },
  };
}
