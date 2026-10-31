export interface Seed<K extends string = string> {
  readonly kind: K;
}

export interface EmailSeed extends Seed<"email"> {
  readonly value: string;
}

export interface UsernameSeed extends Seed<"username"> {
  readonly value: string;
}
