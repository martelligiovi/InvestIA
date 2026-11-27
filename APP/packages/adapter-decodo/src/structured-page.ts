import { Buffer } from "node:buffer";

export const MAX_JSON_LD_BLOCKS = 8;
const MAX_JSON_LD_BYTES = 64 * 1024;
const MAX_NODES = 128;
const MAX_VALUES = 32;
const TEXT_FIELDS = ["name", "alternateName", "headline", "description", "jobTitle", "knowsAbout"] as const;
const ENTITY_FIELDS = ["worksFor", "affiliation", "alumniOf"] as const;
const LOCATION_FIELDS = ["addressLocality", "addressRegion", "addressCountry"] as const;
const SUBJECT_TYPES = /^(?:https?:\/\/schema\.org\/)?(?:Person|Organization|Article|NewsArticle|BlogPosting|ProfilePage)$/;

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, key)
    ? (value as Record<string, unknown>)[key] : undefined;
}

function values(value: unknown): unknown[] {
  return Array.isArray(value) ? value.slice(0, MAX_VALUES) : [value];
}

/** Read inline claims only. Do not resolve contexts, references, or URLs. */
export function readStructuredPage(
  source: string, start: number, end: number,
  text: (value: string, subjectName?: boolean) => void, link: (value: string) => void,
): void {
  if (end - start > MAX_JSON_LD_BYTES) return;
  const raw = source.slice(start, end);
  if (Buffer.byteLength(raw, "utf8") > MAX_JSON_LD_BYTES) return;

  let root: unknown;
  try { root = JSON.parse(raw); } catch { return; }
  const queue = values(root);
  const emit = (value: unknown, add: (value: string) => void) => {
    for (const entry of values(value)) if (typeof entry === "string") add(entry);
  };
  for (let i = 0; i < queue.length; i++) {
    const node = queue[i];
    for (const childKey of ["@graph", "mainEntity"]) {
      for (const child of values(field(node, childKey))) {
        if (queue.length < MAX_NODES && child !== null && typeof child === "object" && !Array.isArray(child)) queue.push(child);
      }
    }
    const isSubject = values(field(node, "@type")).some((type) => typeof type === "string" && SUBJECT_TYPES.test(type));
    for (const key of TEXT_FIELDS) {
      emit(field(node, key), (value) => text(value, key === "name" && isSubject));
    }
    for (const key of ENTITY_FIELDS) {
      for (const entry of values(field(node, key))) emit(typeof entry === "string" ? entry : field(entry, "name"), text);
    }
    for (const address of values(field(node, "address"))) {
      for (const key of LOCATION_FIELDS) {
        const location = field(address, key);
        emit(typeof location === "string" ? location : field(location, "name"), text);
      }
    }
    emit(field(node, "url"), link);
    emit(field(node, "sameAs"), link);
  }
}
