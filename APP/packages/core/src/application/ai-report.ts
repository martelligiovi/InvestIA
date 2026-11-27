import {
  decodoSourceContentHash,
  stripModelReasoning,
  type AiChatMessage,
  type EvidenceAiNormalization,
  type NormalizedPageData,
} from "../domain/evidence-normalization.ts";
import type { Investigation, ValidationStatus } from "../domain/investigation.ts";
import { reportableEvidence } from "./compile-report.ts";

export { stripModelReasoning, type AiChatMessage };

export const AI_REASONING_EFFORTS = ["default", "low", "medium", "high"] as const;
export type AiReasoningEffort = (typeof AI_REASONING_EFFORTS)[number];

export interface AiReportSettings {
  readonly model: string;
  /** "default" leaves the provider's own reasoning behavior untouched. */
  readonly reasoningEffort: AiReasoningEffort;
  readonly temperature: number;
  readonly topP: number;
  readonly maxTokens: number;
}

export const DEFAULT_AI_REPORT_SETTINGS: AiReportSettings = {
  model: "nvidia/nemotron-3.5-super-vl-120b-a12b",
  reasoningEffort: "default",
  temperature: 0.6,
  topP: 0.95,
  maxTokens: 8192,
};

export const AI_MAX_TOKENS_RANGE = { min: 256, max: 32_768 } as const;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Keeps the request within free-endpoint context windows; omitted records are counted in the report note. */
const MAX_FINDINGS_CHARACTERS = 60_000;

function invalid(): never {
  throw new Error("Invalid AI report settings");
}

function numberInRange(value: unknown, min: number, max: number, minExclusive = false): number {
  if (typeof value !== "number" || !Number.isFinite(value)) invalid();
  if ((minExclusive ? value <= min : value < min) || value > max) invalid();
  return value;
}

/** Merges partial settings over the defaults and rejects values the provider cannot accept. */
export function normalizeAiReportSettings(value: Partial<Record<keyof AiReportSettings, unknown>> | undefined): AiReportSettings {
  const merged = { ...DEFAULT_AI_REPORT_SETTINGS, ...value };
  if (typeof merged.model !== "string" || merged.model.length > 200 || !MODEL_ID_PATTERN.test(merged.model)) invalid();
  if (!AI_REASONING_EFFORTS.includes(merged.reasoningEffort as AiReasoningEffort)) invalid();
  const maxTokens = numberInRange(merged.maxTokens, AI_MAX_TOKENS_RANGE.min, AI_MAX_TOKENS_RANGE.max);
  if (!Number.isInteger(maxTokens)) invalid();
  return {
    model: merged.model,
    reasoningEffort: merged.reasoningEffort as AiReasoningEffort,
    temperature: numberInRange(merged.temperature, 0, 2),
    topP: numberInRange(merged.topP, 0, 1, true),
    maxTokens,
  };
}

export const AI_REPORT_SYSTEM_PROMPT = [
  "Sos un analista que redacta un informe ejecutivo conciso sobre una persona a partir de datos públicos recopilados en una investigación autorizada.",
  "",
  "Tu tarea es redactar, en español y en Markdown, un informe breve, claro y directo que una persona pueda leer de corrido para entender quién es el sujeto: cómo se llama, a qué se dedica o qué estudia, dónde se ubica a grandes rasgos, qué le gusta o interesa, qué actividades realiza y qué foco o motivaciones se desprenden de su perfil.",
  "",
  "Reglas de estilo y redacción:",
  "- Escribí en tono natural, concreto y directo, sin relleno ni burocracia. Priorizá claridad y síntesis (pocos párrafos o viñetas breves por sección).",
  "- NO nombres fuentes, plataformas, herramientas, sitios web, URLs, puntajes ni identificadores técnicos (nunca menciones nombres de servicios ni palabras como FaceCheck, Decodo, GHunt, Gravatar, user-scanner, Maigret, pending, score o evidence-...).",
  "- NO agregues título principal, avisos legales ni disclaimers (el encabezado ya aclara el alcance del informe) y no uses la palabra \"hipotético\".",
  "- Cuando exista una contradicción real o un dato poco sólido, señalalo en una frase simple y humana sin forzar certezas.",
  "",
  "Reglas de rigor y seguridad:",
  "- Basate únicamente en los datos provistos. No inventes cuentas, nombres, trabajos, estudios, lugares, fechas, relaciones ni motivaciones sin respaldo en la información recibida; si falta información para un apartado, omitilo o indicalo brevemente.",
  "- Un hallazgo automático puede ser un falso positivo y no confirma por sí solo identidad ni titularidad de cuentas. No uses evidencia rechazada por el operador para sostener conclusiones; la evidencia pendiente pesa menos que la aceptada.",
  "- No infieras ni reproduzcas categorías sensibles: salud, orientación sexual, religión, afiliación política, origen étnico, datos biométricos, antecedentes judiciales ni situación migratoria o estatus legal.",
  "- No deduzcas ni reproduzcas domicilio particular, lugar exacto de trabajo, ubicación física en tiempo real ni datos privados de contacto, y no des recomendaciones para contactar, vigilar, acosar o perjudicar a la persona.",
  "",
  "Estructura del informe:",
  "## Perfil general",
  "## Ocupación y formación",
  "## Intereses y actividades",
  "## Foco y motivaciones",
  "",
  "No agregues encabezados de fuentes, anexos, tablas ni secciones de datos utilizados.",
].join("\n");

const COMPACT_DECODO_METADATA_KEYS = ["title", "status_code", "source", "api_mode", "content_truncated"] as const;
const AI_NORMALIZED_PAGE_NOTE = "Extracted by AI from the stored raw page.";

interface AiNormalizedPageInput extends NormalizedPageData {
  readonly model: string;
  readonly generatedAt: string;
  readonly note: string;
}

interface FindingInput {
  readonly evidenceId: string;
  /** Exactly one: the email, confirmed username, profile photo or URL the producing action ran on. */
  readonly emailSeed?: string;
  readonly usernameSeed?: string;
  readonly photoSeed?: string;
  readonly urlSeed?: string;
  readonly provider: string;
  readonly target: string;
  readonly url?: string;
  readonly category?: string;
  readonly metadata?: Readonly<Record<string, string | boolean | number>>;
  readonly aiNormalizedPage?: AiNormalizedPageInput;
  readonly operatorValidation: ValidationStatus | "pending";
  readonly operatorReason?: string;
}

function compactDecodoMetadata(
  extra: Readonly<Record<string, string | boolean | number>>,
): Readonly<Record<string, string | boolean | number>> {
  const result: Record<string, string | boolean | number> = {};
  for (const key of COMPACT_DECODO_METADATA_KEYS) {
    const value = extra[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function findingInputs(
  investigation: Investigation,
  normalizations?: ReadonlyMap<string, EvidenceAiNormalization>,
): FindingInput[] {
  return reportableEvidence(investigation).evidence.map((evidence) => {
    const decision = investigation.validations.filter((item) => item.evidenceId === evidence.id).at(-1);
    const finding = evidence.finding;
    const normalization = evidence.sourceId === "decodo:url" && finding !== undefined
      ? normalizations?.get(evidence.id)
      : undefined;
    const useNormalization = normalization !== undefined &&
      normalization.sourceContentHash === decodoSourceContentHash(evidence);
    const metadata = finding === undefined
      ? undefined
      : useNormalization
        ? compactDecodoMetadata(finding.extra)
        : finding.extra;
    return {
      evidenceId: evidence.id,
      ...(evidence.seed.kind === "username" ? { usernameSeed: evidence.seed.value }
        : evidence.seed.kind === "photo" ? { photoSeed: evidence.seed.value }
        : evidence.seed.kind === "url" ? { urlSeed: evidence.seed.value } : { emailSeed: evidence.seed.value }),
      provider: evidence.provider,
      target: finding?.target.value ?? evidence.seed.value,
      ...(finding !== undefined && finding.url.length > 0 ? { url: finding.url } : {}),
      ...(finding !== undefined && finding.category.length > 0 ? { category: finding.category } : {}),
      ...(metadata !== undefined && Object.keys(metadata).length > 0 ? { metadata } : {}),
      ...(useNormalization ? {
        aiNormalizedPage: {
          model: normalization.model,
          generatedAt: normalization.generatedAt,
          note: AI_NORMALIZED_PAGE_NOTE,
          ...normalization.data,
        },
      } : {}),
      operatorValidation: decision?.status ?? "pending",
      ...(decision !== undefined ? { operatorReason: decision.reason } : {}),
    };
  });
}

function selectFindings(
  investigation: Investigation,
  normalizations?: ReadonlyMap<string, EvidenceAiNormalization>,
): { readonly findings: FindingInput[]; readonly total: number } {
  const findings: FindingInput[] = [];
  let used = 0;
  const all = findingInputs(investigation, normalizations);
  for (const finding of all) {
    const size = JSON.stringify(finding).length;
    if (used + size > MAX_FINDINGS_CHARACTERS) break;
    findings.push(finding);
    used += size;
  }
  return { findings, total: all.length };
}

/** Number of findings left out of the provider request because of its size budget. */
export function countOmittedAiReportFindings(
  investigation: Investigation,
  normalizations?: ReadonlyMap<string, EvidenceAiNormalization>,
): number {
  const { findings, total } = selectFindings(investigation, normalizations);
  return total - findings.length;
}

/** Builds the provider request from persisted facts only; findings beyond the budget are counted, not sent. */
export function buildAiReportMessages(
  investigation: Investigation,
  normalizations?: ReadonlyMap<string, EvidenceAiNormalization>,
): readonly AiChatMessage[] {
  const { findings, total } = selectFindings(investigation, normalizations);
  const data = {
    investigation: {
      name: investigation.name ?? null,
      intention: investigation.intention ?? null,
      createdAt: investigation.createdAt,
    },
    emailSeeds: investigation.emailSeeds.map((seed) => seed.value),
    usernameSeeds: (investigation.usernameSeeds ?? []).filter((record) => record.status === "accepted").map((record) => record.value),
    findings,
    ...(findings.length < total ? { omittedFindings: total - findings.length } : {}),
  };
  return [
    { role: "system", content: AI_REPORT_SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        `Intención declarada de la investigación: ${investigation.intention ?? "no registrada"}`,
        "",
        "Datos recopilados:",
        "```json",
        JSON.stringify(data, null, 2),
        "```",
      ].join("\n"),
    },
  ];
}

export interface ComposeAiReportInput {
  readonly narrative: string;
  /** Optional historical caller field; the concise AI report never appends raw factual tables. */
  readonly factualReport?: string;
  readonly model: string;
  readonly generatedAt: string;
  /** Findings omitted from the provider request due to the context budget. */
  readonly omittedFindings?: number;
}

const SOURCE_SECTION_HEADING = /^(?:datos utilizados|fuentes(?:\s+(?:utilizadas|y|de\s+datos))?|evidencias?(?:\s+utilizadas?)?|anexo(?:\s+factual)?|referencias)\b/i;
const ATX_HEADING_LINE = /^[ \t]*(#{1,6})[ \t]+(.+)$/;
const EMPTY_HEADING_LINE = /^[ \t]*#{1,6}[ \t]*$/;
const DISCLAIMER_PHRASE = /no verifica|no confirma|fuentes públicas|asistida por IA|generad[oa] por IA|titularidad de cuentas/i;
const TECH_CITATION_TERM = /\bevidence-[a-z0-9-]+\b|https?:\/\/|\b(?:facecheck|decodo|ghunt|gravatar|user-scanner|maigret|scores?|pending)\b/i;
const INLINE_TOOL_ATTRIBUTION = /\b(?:según|de acuerdo con|conforme a|mediante|vía|a partir de|en) (?:los (?:datos|resultados) de )?(?:facecheck|decodo|ghunt|gravatar|user-scanner|maigret)\b(?: ?,)?/gi;
const BARE_EVIDENCE_ID = /\bevidence-[a-z0-9-]+\b/gi;
const EMPTY_LIST_ITEM_LINE = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]*$/;
const HORIZONTAL_RULE_LINE = /^[ \t]*---+[ \t]*$/;
const TABLE_SEPARATOR_CELL = /^:?-{3,}:?$/;
const URL_TRAILING_PUNCTUATION = new Set([".", ",", ";", ":", "!", "?", ")"]);

function isDisclaimerEchoLine(line: string): boolean {
  const trimmed = line.trim();
  const isBlockquote = trimmed.startsWith(">");
  const stripped = (isBlockquote ? trimmed.slice(1).trimStart() : trimmed).replace(/^[*_]+/, "");
  if (/^(?:Síntesis asistida por IA|Generado por IA|Informe generado por IA)\b/i.test(stripped)) return true;
  if (isBlockquote && DISCLAIMER_PHRASE.test(stripped)) return true;
  if (/^(?:Aviso|Nota|Descargo)[*_]*:/i.test(stripped)) return DISCLAIMER_PHRASE.test(stripped);
  return false;
}

function isOuterPipeRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length >= 2 && trimmed.startsWith("|") && trimmed.endsWith("|");
}

function isTableSeparatorLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return false;
  const cells = trimmed.split("|");
  if (trimmed.startsWith("|")) cells.shift();
  if (trimmed.endsWith("|")) cells.pop();
  return cells.length > 0 && cells.every((cell) => TABLE_SEPARATOR_CELL.test(cell.trim()));
}

function stripAtxClosingHashes(text: string): string {
  const trimmed = text.trimEnd();
  let end = trimmed.length;
  while (end > 0 && trimmed[end - 1] === "#") end--;
  if (end < trimmed.length && (end === 0 || trimmed[end - 1] === " " || trimmed[end - 1] === "\t")) {
    return trimmed.slice(0, end).trim();
  }
  return trimmed.trim();
}

function stripMarkdownHttpLinks(line: string): string {
  const lastParen = line.lastIndexOf(")");
  if (lastParen === -1) return line;
  let out = "";
  let emitted = 0;
  let openBracket = -1;
  let unclosedDoubleFrom = line.length;
  let unclosedSingleFrom = line.length;
  let i = 0;
  while (i < line.length) {
    const ch = line[i]!;
    if (ch === "[") {
      openBracket = i;
      i++;
      continue;
    }
    if (ch === "]" && openBracket !== -1 && i < lastParen && line[i + 1] === "(") {
      let urlStart = i + 2;
      while (urlStart < line.length && (line[urlStart] === " " || line[urlStart] === "\t")) urlStart++;
      const probe = line.slice(urlStart, urlStart + 9).toLowerCase();
      const isHttpTarget = probe.startsWith("http://") || probe.startsWith("https://")
        || probe.startsWith("<http://") || probe.startsWith("<https://");
      if (isHttpTarget) {
        let j = urlStart;
        let closeParen = -1;
        if (line[j] === "<") {
          const closeAngle = line.indexOf(">", j + 1);
          j = closeAngle !== -1 && closeAngle < lastParen ? closeAngle + 1 : lastParen + 1;
        } else {
          let parenDepth = 0;
          while (j <= lastParen) {
            const cur = line[j]!;
            if (cur === " " || cur === "\t") break;
            if (cur === "(") {
              parenDepth++;
            } else if (cur === ")") {
              if (parenDepth === 0) {
                closeParen = j;
                break;
              }
              parenDepth--;
            }
            j++;
          }
        }
        if (closeParen === -1 && j <= lastParen) {
          while (j <= lastParen && (line[j] === " " || line[j] === "\t")) j++;
          const titleQuote = j <= lastParen ? line[j] : "";
          if (titleQuote === '"' || titleQuote === "'") {
            const unclosedFrom = titleQuote === '"' ? unclosedDoubleFrom : unclosedSingleFrom;
            if (j < unclosedFrom) {
              let q = j + 1;
              let closedQuote = -1;
              while (q < lastParen) {
                if (line[q] === "\\" && q + 1 < lastParen) {
                  q += 2;
                  continue;
                }
                if (line[q] === titleQuote) {
                  closedQuote = q;
                  break;
                }
                q++;
              }
              if (closedQuote !== -1) {
                j = closedQuote + 1;
                while (j <= lastParen && (line[j] === " " || line[j] === "\t")) j++;
                if (j <= lastParen && line[j] === ")") closeParen = j;
              } else if (titleQuote === '"') {
                unclosedDoubleFrom = j;
              } else {
                unclosedSingleFrom = j;
              }
            }
          } else if (j <= lastParen && line[j] === ")") {
            closeParen = j;
          }
        }
        if (closeParen !== -1) {
          out += line.slice(emitted, openBracket);
          const label = line.slice(openBracket + 1, i);
          out += /^https?:\/\//i.test(label.trim()) ? "" : label;
          emitted = closeParen + 1;
          i = closeParen + 1;
          openBracket = -1;
          continue;
        }
      }
      openBracket = -1;
    }
    i++;
  }
  out += line.slice(emitted);
  return out;
}

function stripParentheticalTechCitations(line: string): string {
  let out = "";
  let openStart = -1;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === "(") {
      openStart = out.length;
      out += ch;
    } else if (ch === ")" && openStart !== -1) {
      const inner = out.slice(openStart + 1);
      if (TECH_CITATION_TERM.test(inner)) {
        out = out.slice(0, openStart);
      } else {
        out += ch;
      }
      openStart = -1;
    } else {
      out += ch;
    }
  }
  return out;
}

function stripBareHttpUrls(line: string): string {
  const lower = line.toLowerCase();
  let nextHttp = lower.indexOf("http://");
  let nextHttps = lower.indexOf("https://");
  if (nextHttp === -1 && nextHttps === -1) return line;
  let out = "";
  let i = 0;
  while (i < line.length) {
    if (nextHttp !== -1 && nextHttp < i) nextHttp = lower.indexOf("http://", i);
    if (nextHttps !== -1 && nextHttps < i) nextHttps = lower.indexOf("https://", i);
    const start = nextHttp === -1 ? nextHttps : nextHttps === -1 ? nextHttp : Math.min(nextHttp, nextHttps);
    if (start === -1) {
      out += line.slice(i);
      break;
    }
    out += line.slice(i, start);
    let end = start + (start === nextHttps ? 8 : 7);
    while (end < line.length) {
      const ch = line[end]!;
      if (ch === " " || ch === "\t" || ch === "<" || ch === ">" || ch === '"' || ch === "'") break;
      end++;
    }
    while (end > start && URL_TRAILING_PUNCTUATION.has(line[end - 1]!)) {
      end--;
    }
    i = end;
  }
  return out;
}

function cleanNarrativeLine(line: string): string | null {
  let indentEnd = 0;
  while (indentEnd < line.length && (line[indentEnd] === " " || line[indentEnd] === "\t")) indentEnd++;
  const indent = line.slice(0, indentEnd);
  const originalBody = line.slice(indentEnd);
  if (originalBody.length === 0) return "";

  const hadLeadingCapital = indent.length === 0 && /^[A-ZÁÉÍÓÚÑ]/.test(originalBody);
  let body = originalBody.replace(/[ \t]{2,}/g, " ");
  body = stripMarkdownHttpLinks(body);
  body = stripParentheticalTechCitations(body);
  body = body.replace(INLINE_TOOL_ATTRIBUTION, "");
  body = stripBareHttpUrls(body);
  body = body.replace(BARE_EVIDENCE_ID, "");
  body = body
    .replace(/[ \t]{2,}/g, " ")
    .replace(/, ([.;:])/g, "$1")
    .replace(/ ([.,;:])/g, "$1")
    .trim();

  if (body.length === 0 || EMPTY_LIST_ITEM_LINE.test(body)) return null;
  if (hadLeadingCapital && /^[a-záéíóúñ]/.test(body)) {
    body = body[0]!.toUpperCase() + body.slice(1);
  }
  return `${indent}${body}`;
}

function cleanAiReportNarrative(raw: string): string {
  const sourceLines = raw.replace(/\r\n?/g, "\n").split("\n");
  const keptLines: string[] = [];
  let skippingSectionLevel: number | null = null;

  for (let i = 0; i < sourceLines.length; i++) {
    const line = sourceLines[i]!;
    const headingMatch = ATX_HEADING_LINE.exec(line);
    if (headingMatch !== null) {
      const level = headingMatch[1]!.length;
      const headingText = stripAtxClosingHashes(headingMatch[2]!);
      if (skippingSectionLevel !== null && level <= skippingSectionLevel) {
        skippingSectionLevel = null;
      }
      if (skippingSectionLevel !== null) continue;
      if (SOURCE_SECTION_HEADING.test(headingText)) {
        skippingSectionLevel = level;
        continue;
      }
      if (level === 1) continue;
    } else if (skippingSectionLevel !== null) {
      continue;
    }

    if (EMPTY_HEADING_LINE.test(line)) continue;
    if (isDisclaimerEchoLine(line)) continue;

    if (i + 1 < sourceLines.length && line.includes("|") && isTableSeparatorLine(sourceLines[i + 1]!)) {
      i += 1;
      while (i + 1 < sourceLines.length && sourceLines[i + 1]!.trim().length > 0 && sourceLines[i + 1]!.includes("|")) {
        i += 1;
      }
      continue;
    }
    if (isTableSeparatorLine(line)) {
      while (i + 1 < sourceLines.length && sourceLines[i + 1]!.trim().length > 0 && sourceLines[i + 1]!.includes("|")) {
        i += 1;
      }
      continue;
    }
    if (isOuterPipeRow(line)) continue;

    const cleaned = cleanNarrativeLine(line);
    if (cleaned === null) continue;
    keptLines.push(cleaned);
  }

  const collapsed: string[] = [];
  for (const line of keptLines) {
    if (line === "") {
      if (collapsed.length === 0 || collapsed[collapsed.length - 1] === "") continue;
      collapsed.push("");
    } else {
      collapsed.push(line);
    }
  }
  while (collapsed.length > 0 && (collapsed[collapsed.length - 1] === "" || HORIZONTAL_RULE_LINE.test(collapsed[collapsed.length - 1]!))) {
    collapsed.pop();
  }
  while (collapsed.length > 0 && (collapsed[0] === "" || HORIZONTAL_RULE_LINE.test(collapsed[0]!))) {
    collapsed.shift();
  }

  return collapsed.join("\n") || "## Perfil general\nNo hay datos suficientes para redactar el informe.";
}

export function composeAiReport(input: ComposeAiReportInput): string {
  const omissionNote = (input.omittedFindings ?? 0) > 0
    ? ` Por límite de contexto se omitieron ${input.omittedFindings} registros.`
    : "";
  return [
    "# Informe de perfil",
    "",
    `> Síntesis asistida por IA (${input.model}) generada el ${input.generatedAt} a partir de fuentes públicas; no verifica identidad ni titularidad de cuentas.${omissionNote}`,
    "",
    cleanAiReportNarrative(input.narrative),
    "",
  ].join("\n");
}
