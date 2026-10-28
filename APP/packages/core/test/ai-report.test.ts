import assert from "node:assert/strict";
import test from "node:test";
import {
  AI_REPORT_SYSTEM_PROMPT,
  buildAiReportMessages,
  composeAiReport,
  DEFAULT_AI_REPORT_SETTINGS,
  normalizeAiReportSettings,
  stripModelReasoning,
  type Investigation,
} from "../src/index.ts";

function investigation(): Investigation {
  const seed = { kind: "email" as const, value: "ana@example.com" };
  return {
    id: "investigation-1",
    name: "Caso Ana",
    intention: "Entender la huella pública del correo",
    advancementMode: "manual",
    revision: 7,
    createdAt: "2026-10-01T10:00:00.000Z",
    updatedAt: "2026-10-01T11:00:00.000Z",
    paused: false,
    authorization: { granted: true, at: "2026-10-01T10:01:00.000Z", reason: "Autorizado", operator: "local-operator" },
    emailSeeds: [seed],
    actions: [],
    evidence: [
      {
        id: "evidence-1",
        actionId: "action-1",
        seed,
        provider: "spotify",
        status: "registered",
        finding: {
          target: { kind: "email", value: "ana@example.com" },
          upstreamStatus: "Registered",
          url: "https://open.spotify.com/user/ana",
          category: "music",
          reason: "",
          extra: { display_name: "Ana Rock" },
          media: {},
        },
        sourceId: "user-scanner",
        recordedAt: "2026-10-01T10:30:00.000Z",
      },
      {
        id: "evidence-2",
        actionId: "action-1",
        seed,
        provider: "steam",
        status: "registered",
        sourceId: "user-scanner",
        recordedAt: "2026-10-01T10:31:00.000Z",
      },
    ],
    validations: [
      { id: "validation-1", evidenceId: "evidence-2", status: "rejected", reason: "Falso positivo", at: "2026-10-01T10:40:00.000Z", operator: "local-operator" },
    ],
    audit: [],
  };
}

test("defaults make a configuration that only needs an API key", () => {
  assert.deepEqual(DEFAULT_AI_REPORT_SETTINGS, {
    model: "deepseek-ai/deepseek-v4.1-flash",
    reasoningEffort: "default",
    temperature: 0.6,
    topP: 0.95,
    maxTokens: 4096,
  });
  assert.deepEqual(normalizeAiReportSettings(undefined), DEFAULT_AI_REPORT_SETTINGS);
  assert.deepEqual(normalizeAiReportSettings({ model: "openai/gpt-oss-20b", reasoningEffort: "high" }), {
    ...DEFAULT_AI_REPORT_SETTINGS,
    model: "openai/gpt-oss-20b",
    reasoningEffort: "high",
  });
});

test("settings normalization rejects values the provider cannot accept", () => {
  for (const invalid of [
    { model: "" },
    { model: "no-slash" },
    { model: "a/b c" },
    { reasoningEffort: "extreme" },
    { temperature: -0.1 },
    { temperature: 2.1 },
    { topP: 0 },
    { topP: 1.1 },
    { maxTokens: 255 },
    { maxTokens: 32_769 },
    { maxTokens: 1000.5 },
  ]) {
    assert.throws(() => normalizeAiReportSettings(invalid), /Invalid AI report settings/, JSON.stringify(invalid));
  }
});

test("system prompt asks who the person could be, in Spanish, as a hypothesis", () => {
  for (const phrase of [
    "¿quién podría ser esta persona?",
    "hipótesis",
    "confianza",
    "español",
    "Conclusiones",
    "Gustos e intereses posibles",
    "salud",
    "orientación sexual",
    "rechazada",
    "No agregues una sección con los datos",
  ]) {
    assert.ok(AI_REPORT_SYSTEM_PROMPT.includes(phrase), phrase);
  }
});

test("messages carry the system prompt and every collected finding with its validation", () => {
  const messages = buildAiReportMessages(investigation());
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[0], { role: "system", content: AI_REPORT_SYSTEM_PROMPT });
  assert.equal(messages[1]!.role, "user");
  const user = messages[1]!.content;
  assert.match(user, /Entender la huella pública del correo/);
  const json = JSON.parse(user.slice(user.indexOf("```json") + 7, user.lastIndexOf("```")));
  assert.deepEqual(json.emailSeeds, ["ana@example.com"]);
  assert.deepEqual(json.findings, [
    {
      evidenceId: "evidence-1",
      emailSeed: "ana@example.com",
      provider: "spotify",
      target: "ana@example.com",
      url: "https://open.spotify.com/user/ana",
      category: "music",
      metadata: { display_name: "Ana Rock" },
      operatorValidation: "pending",
    },
    {
      evidenceId: "evidence-2",
      emailSeed: "ana@example.com",
      provider: "steam",
      target: "ana@example.com",
      operatorValidation: "rejected",
      operatorReason: "Falso positivo",
    },
  ]);
});

test("findings beyond the request budget are counted instead of sent", () => {
  const base = investigation();
  const template = base.evidence[0]!;
  const evidence = Array.from({ length: 400 }, (_, index) => ({
    ...template,
    id: `evidence-${index}`,
    finding: { ...template.finding!, extra: { bio: "x".repeat(200) } },
  }));
  const user = buildAiReportMessages({ ...base, evidence, validations: [] })[1]!.content;
  const json = JSON.parse(user.slice(user.indexOf("```json") + 7, user.lastIndexOf("```")));
  assert.ok(json.findings.length > 0 && json.findings.length < 400);
  assert.equal(json.findings.length + json.omittedFindings, 400);
});

test("composed report puts the hypothetical narrative first and all the data used last", () => {
  const report = composeAiReport({
    narrative: "## Resumen\nPodría tratarse de una persona aficionada a la música.",
    factualReport: "# Caso Ana\n\n## Evidence\nrows",
    model: "openai/gpt-oss-20b",
    generatedAt: "2026-10-28T12:00:00.000Z",
  });
  assert.equal(report, [
    "# Informe hipotético: ¿quién podría ser esta persona?",
    "",
    "> Generado por IA (openai/gpt-oss-20b) el 2026-10-28T12:00:00.000Z. Todo el contenido es hipotético: son conclusiones posibles, no hechos verificados, y no confirma identidad ni titularidad de cuentas.",
    "",
    "## Resumen\nPodría tratarse de una persona aficionada a la música.",
    "",
    "---",
    "",
    "## Datos utilizados",
    "",
    "Estos son todos los datos recopilados que se enviaron al modelo para elaborar las conclusiones.",
    "",
    "### Caso Ana",
    "",
    "#### Evidence",
    "rows",
    "",
  ].join("\n"));
});

test("model reasoning blocks are removed from the narrative", () => {
  assert.equal(stripModelReasoning("<think>plan\nsecreto</think>\n\n## Resumen\nTexto"), "## Resumen\nTexto");
  assert.equal(stripModelReasoning("  ## Resumen\nTexto  "), "## Resumen\nTexto");
});
