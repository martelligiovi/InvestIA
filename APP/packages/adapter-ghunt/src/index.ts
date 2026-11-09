import type { EmailSeed } from "../../core/src/domain/seed.ts";
import type { ScannerObservation } from "../../core/src/domain/observation.ts";
import type { SeedBox } from "../../core/src/domain/seed-box.ts";
import { GhuntProcessError, validGhuntEmail, type GhuntRunner } from "./process-runner.ts";
export { createGhuntProcessRunner, ghuntArguments, GhuntProcessError, validGhuntEmail } from "./process-runner.ts";
export type { GhuntRunner, GhuntProcessOptions, GhuntProcessErrorCode } from "./process-runner.ts";
export { createGhuntSession, createSessionBoundRunner, GhuntSessionError, GHUNT_LOGIN_SCRIPT, validCompanionCode } from "./session.ts";
export type { GhuntSession, GhuntSessionErrorCode, GhuntSessionOptions, GhuntSessionState, GhuntSessionStatus } from "./session.ts";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() && value.length <= 1024 ? value.trim() : undefined;
}
/** Google-hosted HTTPS images only, so report values cannot smuggle arbitrary URLs into findings. */
const IMAGE_HOSTS = [".googleusercontent.com", ".ggpht.com"];
function safeUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.includes("?") || value.includes("#")) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return undefined;
    if (!IMAGE_HOSTS.some((host) => url.hostname.endsWith(host))) return undefined;
    return url.href;
  } catch { return undefined; }
}
function photo(value: unknown): string | undefined {
  const image = record(value);
  return image && image.isDefault === false ? safeUrl(image.url) : undefined;
}
function names(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.slice(0, 50).map((item) => plain(item)).filter((item): item is string => item !== undefined && item.length <= 64);
  return items.length > 0 ? items.join(", ") : undefined;
}
/** Short free text from the report: never an email address, control characters or long blobs. */
function plain(value: unknown): string | undefined {
  const result = text(value);
  return result && result.length <= 128 && !result.includes("@") && !/[\u0000-\u001f\u007f]/.test(result) ? result : undefined;
}
function editDate(value: unknown): string | undefined {
  const result = text(value);
  const parts = result?.match(/^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2}) \(UTC\)$/)?.slice(1).map(Number);
  if (!parts) return undefined;
  const [year, month, day, hour, minute, second] = parts as [number, number, number, number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day &&
    date.getUTCHours() === hour && date.getUTCMinutes() === minute && date.getUTCSeconds() === second ? result : undefined;
}
function count(value: unknown): number | undefined {
  return Array.isArray(value) && value.length > 0 ? value.length : undefined;
}
function defined(values: Record<string, string | number | boolean | undefined>): Record<string, string | number | boolean> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) as Record<string, string | number | boolean>;
}
const MAPS_STATS: Readonly<Record<string, string>> = { Reviews: "reviews", Ratings: "ratings", Photos: "photos", Videos: "videos", Answers: "answers", Edits: "edits", "Places added": "places_added", "Roads added": "roads_added", "Facts checked": "facts_checked", "Q&A": "questions_answered" };

interface Leaf { readonly category: string; readonly extra: Record<string, string | number | boolean>; readonly media?: Record<string, string>; readonly url?: string }

/** One leaf per GHunt data type; only allowlisted fields of each are kept. */
function leaves(container: Record<string, unknown>, profile: Record<string, unknown>, personId: string): Leaf[] {
  const own = (field: string) => record(record(profile[field])?.PROFILE);
  const dynamite = record(record(profile.extendedData)?.dynamiteData);
  const gplus = record(record(profile.extendedData)?.gplusData);
  const result: Leaf[] = [{ category: "Google account", extra: defined({
    person_id: personId, user_types: names(own("profileInfos")?.userTypes), entity_type: plain(dynamite?.entityType),
    customer_id: plain(dynamite?.customerId), enterprise_user: typeof gplus?.isEntrepriseUser === "boolean" ? gplus.isEntrepriseUser : undefined,
  }) }];
  const name = own("names");
  const fullname = plain(name?.fullname);
  if (fullname) result.push({ category: "Name", extra: defined({ fullname, first_name: plain(name?.firstName), last_name: plain(name?.lastName) }) });
  const avatar = photo(own("profilePhotos"));
  if (avatar) result.push({ category: "Profile photo", extra: {}, media: { avatar }, url: avatar });
  const cover = photo(own("coverPhotos"));
  if (cover) result.push({ category: "Cover photo", extra: {}, media: { cover }, url: cover });
  const edited = editDate(own("sourceIds")?.lastUpdated);
  if (edited) result.push({ category: "Last profile edit", extra: { last_updated: edited } });
  const services = names(own("inAppReachability")?.apps);
  if (services) result.push({ category: "Google services", extra: { services } });
  const stats = record(record(container.maps)?.stats) ?? {};
  const maps = defined(Object.fromEntries(Object.entries(MAPS_STATS).map(([key, field]) => {
    const value = stats[key];
    return [field, typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined];
  })));
  if (Object.keys(maps).length > 0) result.push({ category: "Maps", extra: maps, url: /^\d{1,32}$/.test(personId) ? `https://www.google.com/maps/contrib/${personId}` : "" });
  const calendar = record(container.calendar);
  if (calendar) {
    const details = record(calendar.details);
    const extra = defined({ summary: plain(details?.summary), time_zone: plain(details?.time_zone), events: count(record(calendar.events)?.items) });
    if (Object.keys(extra).length > 0) result.push({ category: "Calendar", extra });
  }
  const games = record(container.play_games);
  const player = record(games?.profile);
  if (player) {
    const playerAvatar = safeUrl(player.avatar_url);
    const extra = defined({ display_name: plain(player.display_name), gamertag: plain(player.gamertag),
      title: plain(player.title), played_games: count(games?.played_games), achievements: count(games?.achievements) });
    if (Object.keys(extra).length > 0 || playerAvatar) result.push({ category: "Play Games", extra, media: playerAvatar ? { avatar: playerAvatar } : {} });
  }
  return result;
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
      let container: Record<string, unknown> | undefined;
      try { container = record(record(JSON.parse(raw))?.PROFILE_CONTAINER); }
      catch { throw new Error("Invalid GHunt report"); }
      const profile = record(container?.profile);
      const personId = text(profile?.personId);
      if (!container || !profile || !personId) throw new Error("Invalid GHunt report");
      return leaves(container, profile, personId).map(({ category, extra, media = {}, url = "" }) => ({
        kind: "scanner_finding", seed, provider: "GHunt", status: "registered",
        finding: { target: seed, upstreamStatus: "Found", url, category, reason: "", extra: { source: "ghunt", ...extra }, media },
      }));
    },
  };
}
