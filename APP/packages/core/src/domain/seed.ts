export interface Seed<K extends string = string> {
  readonly kind: K;
}

export interface EmailSeed extends Seed<"email"> {
  readonly value: string;
}

export interface UsernameSeed extends Seed<"username"> {
  readonly value: string;
}

/** A Google-hosted profile photo found by a tool; its value is the image URL. */
export interface PhotoSeed extends Seed<"photo"> {
  readonly value: string;
}

export interface UrlSeed extends Seed<"url"> {
  readonly value: string;
}

const URL_SEED_MAX_LENGTH = 2048;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const LOCAL_HOST_SUFFIX = /(?:^|\.)(?:localhost|local|internal|home\.arpa)$/;

function isPublicHostname(hostname: string): boolean {
  // The URL parser normalizes IPv6 routing prefixes and IPv4 literals (including legacy forms).
  // Only global-unicast IPv6 space is eligible, excluding IPv4-mapped addresses as well.
  if (hostname.startsWith("[")) return /^\[[23][0-9a-f]{3}:/.test(hostname);
  if (/^(?:\d+\.){3}\d+$/.test(hostname)) {
    const [first, second] = hostname.split(".").map(Number) as [number, number, number, number];
    return first !== 0 && first !== 10 && first !== 127 && first < 224 &&
      !(first === 100 && second >= 64 && second <= 127) && !(first === 169 && second === 254) &&
      !(first === 172 && second >= 16 && second <= 31) && !(first === 192 && second === 168);
  }
  const domain = hostname.replace(/\.$/, "");
  const labels = domain.split(".");
  return labels.length > 1 && !LOCAL_HOST_SUFFIX.test(domain) && labels.every((label) => DNS_LABEL.test(label));
}

/** Checks a literal HTTP(S) URL; does not resolve DNS or check redirects. */
export function isSafePublicHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > URL_SEED_MAX_LENGTH || /[\s\\\x00-\x1f\x7f]/.test(value) ||
    !/^https?:\/\/[^/?#@]+(?:[/?#]|$)/i.test(value)) return false;
  try {
    const url = new URL(value);
    if (url.username !== "" || url.password !== "" || !isPublicHostname(url.hostname)) return false;
    url.hash = "";
    // Normalization can expand the string (for example by percent-encoding Unicode in the path).
    return url.href.length <= URL_SEED_MAX_LENGTH;
  } catch {
    return false;
  }
}

export function urlSeed(value: string): UrlSeed {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!isSafePublicHttpUrl(normalized)) throw new Error("A valid public HTTP URL seed is required");
  const parsed = new URL(normalized);
  parsed.hash = "";
  return { kind: "url", value: parsed.href };
}

const GOOGLE_PHOTO_HOSTS = [".googleusercontent.com", ".ggpht.com"];

/** HTTPS Google image hosts only, without credentials, query or fragment, so a photo seed is never an arbitrary URL. */
export function isGooglePhotoUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 1024 || value.includes("?") || value.includes("#")) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "" && url.href === value &&
      GOOGLE_PHOTO_HOSTS.some((host) => url.hostname.endsWith(host));
  } catch {
    return false;
  }
}

/** One CLI-safe token: never an option, never several targets, never a path. */
export const USERNAME_SEED_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
