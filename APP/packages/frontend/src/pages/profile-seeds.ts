import type { EvidenceRecord } from "@investia/core";

export interface ProfileSeed {
  readonly field: string;
  readonly label: string;
  readonly value: string;
  readonly isUrl: boolean;
}

const PROFILE_FIELDS: Readonly<Record<string, string>> = {
  display_name: "Nombre mostrado", username: "Nombre de usuario", location: "Ubicación",
  description: "Descripción", job_title: "Profesión", company: "Organización", pronouns: "Pronombres",
};

/** Derived values retain their source evidence; selecting them never schedules a lookup. */
export function profileSeeds(evidence: EvidenceRecord): readonly ProfileSeed[] {
  const finding = evidence.finding;
  if (evidence.sourceId !== "gravatar:email" || !finding || evidence.status !== "registered") return [];
  const seeds: ProfileSeed[] = [];
  function add(field: string, label: string, raw: unknown, isUrl = false) {
    if (typeof raw !== "string" || raw.trim() === "") return;
    seeds.push({ field, label, value: raw.trim(), isUrl });
  }
  for (const [field, label] of Object.entries(PROFILE_FIELDS)) add(field, label, finding.extra[field]);
  add("url", finding.category === "Linked account" ? `Cuenta vinculada · ${evidence.provider}` : "Perfil público", finding.url, true);
  for (const [field, value] of Object.entries(finding.media)) {
    add(`media:${field}`, field === "avatar" ? "Foto de perfil" : `Imagen · ${field}`, value, true);
  }
  return seeds;
}
