export interface Seed<K extends string = string> {
  readonly kind: K;
}

export interface EmailSeed extends Seed<"email"> {
  readonly value: string;
}
