import type { Seed } from "./seed.ts";

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

export type Observation = RegistrationObservation | IdentityObservation;
