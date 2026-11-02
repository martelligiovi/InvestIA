import type { EmailSeed, Seed, UsernameSeed } from "./seed.ts";

export type RegistrationStatus =
  | "registered"
  | "not_registered"
  | "rate_limited"
  | "error"
  | "unknown";

export interface RegistrationObservation {
  readonly kind: "registration";
  readonly seed: Seed;
  readonly provider: string;
  readonly status: RegistrationStatus;
}

export interface IdentityObservation {
  readonly kind: "identity";
  readonly subject: string;
  readonly basis: string;
}

export interface ScannerFinding {
  readonly target: { readonly kind: "email" | "username"; readonly value: string };
  readonly upstreamStatus: "Registered" | "Not Registered" | "Found" | "Not Found" | "Error" | "Skipped";
  readonly url: string;
  readonly category: string;
  readonly reason: string;
  readonly extra: Readonly<Record<string, string | boolean | number>>;
  readonly media: Readonly<Record<string, string>>;
}

export interface ScannerObservation {
  readonly kind: "scanner_finding";
  /** Seed the tool ran on (operator-supplied or confirmed), not a discovered target. */
  readonly seed: EmailSeed | UsernameSeed;
  readonly provider: string;
  readonly status: RegistrationStatus;
  readonly finding: ScannerFinding;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isScannerFinding(value: unknown): value is ScannerFinding {
  if (!record(value) || !record(value.target) || !record(value.extra) || !record(value.media)) return false;
  return ["email", "username"].includes(String(value.target.kind)) &&
    typeof value.target.value === "string" && value.target.value.trim().length > 0 &&
    (value.target.kind !== "email" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.target.value)) &&
    ["Registered", "Not Registered", "Found", "Not Found", "Error", "Skipped"].includes(String(value.upstreamStatus)) &&
    [value.url, value.category, value.reason].every((field) => typeof field === "string") &&
    Object.values(value.extra).every((field) => typeof field === "string" || typeof field === "boolean" ||
      (typeof field === "number" && Number.isFinite(field))) &&
    Object.values(value.media).every((field) => typeof field === "string");
}

export type Observation = RegistrationObservation | IdentityObservation | ScannerObservation;
