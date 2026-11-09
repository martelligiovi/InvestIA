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
