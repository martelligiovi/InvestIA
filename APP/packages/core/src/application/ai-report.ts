import type { Investigation, ValidationStatus } from "../domain/investigation.ts";

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

export interface AiChatMessage {
  readonly role: "system" | "user";
  readonly content: string;
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
/** Keeps the request within free-endpoint context windows; the appendix still lists every record. */
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
  "Sos un analista de inteligencia de fuentes abiertas (OSINT). Recibís los datos que recopiló una investigación autorizada a partir de una o más direcciones de correo: servicios donde una herramienta automática reportó una cuenta, URLs, categorías, metadatos públicos y las decisiones de validación del operador.",
  "",
  "Tu tarea es redactar, en español y en Markdown, un informe textual que responda de forma hipotética: si tuvieras que decidir, ¿quién podría ser esta persona? Describí su posible perfil, sus gustos e intereses probables, su actividad y sus hábitos digitales, y las conclusiones que se pueden sacar de los datos.",
  "",
  "Reglas:",
  "- Todo es hipotético. Cada afirmación sobre la persona es una hipótesis, no un hecho: usá lenguaje condicional (\"podría\", \"sugiere\", \"es compatible con\") y asigná a cada hipótesis un nivel de confianza (baja, media o alta) justificado.",
  "- Basate solo en los datos provistos. No inventes cuentas, nombres, lugares, fechas ni relaciones. Si los datos no alcanzan para una conclusión, decilo.",
  "- Citá entre paréntesis la evidencia que sostiene cada hipótesis (servicio, URL o evidenceId).",
  "- Un registro reportado por la herramienta no confirma titularidad ni identidad y puede ser un falso positivo. La evidencia rechazada por el operador no debe sostener ninguna conclusión; la evidencia pendiente vale menos que la aceptada.",
  "- No infieras categorías sensibles: salud, orientación sexual, religión, afiliación política, origen étnico, datos biométricos, antecedentes judiciales ni situación migratoria o estatus legal.",
  "- No intentes ubicar ni localizar físicamente a la persona (domicilio, lugar de trabajo o ubicación en tiempo real) ni deducir datos de contacto, y no des recomendaciones para contactar, vigilar, acosar o perjudicar a la persona.",
  "",
  "Estructura del informe:",
  "## Resumen",
  "## Perfil hipotético",
  "## Gustos e intereses posibles",
  "## Actividad y huella digital",
  "## Conclusiones",
  "## Limitaciones y confianza",
  "",
  "No agregues una sección con los datos utilizados: el sistema la anexa automáticamente al final del informe.",
].join("\n");

interface FindingInput {
  readonly evidenceId: string;
  readonly emailSeed: string;
  readonly provider: string;
  readonly target: string;
  readonly url?: string;
  readonly category?: string;
  readonly metadata?: Readonly<Record<string, string | boolean | number>>;
  readonly operatorValidation: ValidationStatus | "pending";
  readonly operatorReason?: string;
}

function findingInputs(investigation: Investigation): FindingInput[] {
  return investigation.evidence.map((evidence) => {
    const decision = investigation.validations.filter((item) => item.evidenceId === evidence.id).at(-1);
    const finding = evidence.finding;
    return {
      evidenceId: evidence.id,
      emailSeed: evidence.seed.value,
      provider: evidence.provider,
      target: finding?.target.value ?? evidence.seed.value,
      ...(finding !== undefined && finding.url.length > 0 ? { url: finding.url } : {}),
      ...(finding !== undefined && finding.category.length > 0 ? { category: finding.category } : {}),
      ...(finding !== undefined && Object.keys(finding.extra).length > 0 ? { metadata: finding.extra } : {}),
      operatorValidation: decision?.status ?? "pending",
      ...(decision !== undefined ? { operatorReason: decision.reason } : {}),
    };
  });
}

function selectFindings(investigation: Investigation): { readonly findings: FindingInput[]; readonly total: number } {
  const findings: FindingInput[] = [];
  let used = 0;
  const all = findingInputs(investigation);
  for (const finding of all) {
    const size = JSON.stringify(finding).length;
    if (used + size > MAX_FINDINGS_CHARACTERS) break;
    findings.push(finding);
    used += size;
  }
  return { findings, total: all.length };
}

/** Number of findings left out of the provider request because of its size budget. */
export function countOmittedAiReportFindings(investigation: Investigation): number {
  const { findings, total } = selectFindings(investigation);
  return total - findings.length;
}

/** Builds the provider request from persisted facts only; findings beyond the budget are counted, not sent. */
export function buildAiReportMessages(investigation: Investigation): readonly AiChatMessage[] {
  const { findings, total } = selectFindings(investigation);
  const data = {
    investigation: {
      name: investigation.name ?? null,
      intention: investigation.intention ?? null,
      createdAt: investigation.createdAt,
    },
    emailSeeds: investigation.emailSeeds.map((seed) => seed.value),
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

/** Removes inline chain-of-thought some reasoning models emit before the answer. */
export function stripModelReasoning(content: string): string {
  return content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

export interface ComposeAiReportInput {
  readonly narrative: string;
  readonly factualReport: string;
  readonly model: string;
  readonly generatedAt: string;
  /** Findings the appendix lists but the model never received. */
  readonly omittedFindings?: number;
}

function demoteHeadings(markdown: string, levels: number): string {
  return markdown.replace(/^(#{1,6}) /gm, (_match, hashes: string) => `${"#".repeat(Math.min(6, hashes.length + levels))} `);
}

export function composeAiReport(input: ComposeAiReportInput): string {
  return [
    "# Informe hipotético: ¿quién podría ser esta persona?",
    "",
    `> Generado por IA (${input.model}) el ${input.generatedAt}. Todo el contenido es hipotético: son conclusiones posibles, no hechos verificados, y no confirma identidad ni titularidad de cuentas.`,
    "",
    input.narrative.trim(),
    "",
    "---",
    "",
    "## Datos utilizados",
    "",
    (input.omittedFindings ?? 0) > 0
      ? `Estos son todos los datos recopilados. Por el tamaño del pedido, ${input.omittedFindings} hallazgos no se enviaron al modelo y no sostienen las conclusiones; igual figuran en este anexo.`
      : "Estos son todos los datos recopilados que se enviaron al modelo para elaborar las conclusiones.",
    "",
    demoteHeadings(input.factualReport.trim(), 2),
    "",
  ].join("\n");
}
