import { createHash } from "node:crypto";
import { z } from "zod";
import { isScannerFinding, type EmailSeed, type ScannerFinding, type ScannerObservation, type SeedBox } from "@investia/core";

export interface GravatarBoxOptions {
  readonly fetch?: typeof fetch;
  /** Optional; raises the documented rate limit and is never required for public profiles. */
  readonly apiKey?: string;
  readonly timeoutMs?: number;
}

const PROFILE_URL = "https://api.gravatar.com/v3/profiles/";
const DEFAULT_TIMEOUT_MS = 10_000;
const PROFILE_FIELDS = ["display_name", "location", "description", "job_title", "company", "pronouns"] as const;

const SeedSchema = z.object({ kind: z.literal("email"), value: z.string().trim().toLowerCase().pipe(z.string().email().max(320)) }).strict();
const optionalText = z.string().nullish().transform((value) => value ?? "");
const AccountSchema = z.object({
  service_type: optionalText, service_label: optionalText, url: optionalText,
  is_hidden: z.boolean().nullish(),
});
const ProfileSchema = z.object({
  profile_url: optionalText, avatar_url: optionalText,
  display_name: optionalText, location: optionalText, description: optionalText,
  job_title: optionalText, company: optionalText, pronouns: optionalText,
  verified_accounts: z.array(AccountSchema).nullish().transform((value) => value ?? []),
});

export function gravatarHash(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

function webUrl(value: string): string {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? value : "";
  } catch {
    return "";
  }
}

function observation(seed: EmailSeed, provider: string, found: boolean, finding: Omit<ScannerFinding, "target" | "upstreamStatus" | "reason">): ScannerObservation {
  const complete = {
    target: { kind: "email" as const, value: seed.value }, upstreamStatus: found ? "Found" as const : "Not Found" as const,
    reason: "", ...finding,
  };
  if (!isScannerFinding(complete)) throw new Error("Invalid Gravatar profile");
  return { kind: "scanner_finding", seed, provider, status: found ? "registered" : "not_registered", finding: complete };
}

async function request(options: GravatarBoxOptions, hash: string): Promise<Response> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (typeof options.apiKey === "string" && options.apiKey.trim().length > 0) headers.Authorization = `Bearer ${options.apiKey.trim()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    return await (options.fetch ?? fetch)(`${PROFILE_URL}${hash}`, { headers, signal: controller.signal });
  } catch {
    throw new Error(controller.signal.aborted ? "Gravatar request timed out" : "Gravatar request failed");
  } finally {
    clearTimeout(timer);
  }
}

export function createGravatarBox(options: GravatarBoxOptions = {}): SeedBox<EmailSeed, ScannerObservation> {
  return {
    id: "gravatar:email", inputKind: "email",
    async execute(input) {
      const seed: EmailSeed = SeedSchema.parse(input);
      const response = await request(options, gravatarHash(seed.value));
      if (response.status === 404) {
        return [observation(seed, "Gravatar", false, { url: "", category: "Profile", extra: { source: "gravatar public profile" }, media: {} })];
      }
      if (response.status === 429) throw new Error("Gravatar rate limit reached; try again later.");
      if (!response.ok) throw new Error(`Gravatar request failed with HTTP ${response.status}`);
      let profile;
      try { profile = ProfileSchema.parse(await response.json() as unknown); }
      catch { throw new Error("Invalid Gravatar profile"); }

      const extra: Record<string, string> = { source: "gravatar public profile" };
      for (const field of PROFILE_FIELDS) if (profile[field].trim().length > 0) extra[field] = profile[field].trim();
      const avatar = webUrl(profile.avatar_url);
      const observations = [observation(seed, "Gravatar", true, {
        url: webUrl(profile.profile_url), category: "Profile", extra, media: avatar === "" ? {} : { avatar },
      })];
      for (const account of profile.verified_accounts) {
        const url = webUrl(account.url);
        if (account.is_hidden === true || url === "" || account.service_label.trim() === "") continue;
        observations.push(observation(seed, account.service_label.trim(), true, {
          url, category: "Linked account",
          extra: { source: "gravatar verified account", service_type: account.service_type }, media: {},
        }));
      }
      return observations;
    },
  };
}
