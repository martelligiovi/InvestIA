export const HOLEHE_MODULES = ["github"] as const;
export type HoleheModule = (typeof HOLEHE_MODULES)[number];

export interface HoleheRunner {
  run(moduleName: HoleheModule, email: string): Promise<string>;
}
