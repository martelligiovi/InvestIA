export interface Seed<K extends string = string> {
  readonly kind: K;
}

export interface EmailSeed extends Seed<"email"> {
  readonly value: string;
}

export interface UsernameSeed extends Seed<"username"> {
  readonly value: string;
}

/** One CLI-safe token: never an option, never several targets, never a path. */
export const USERNAME_SEED_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
