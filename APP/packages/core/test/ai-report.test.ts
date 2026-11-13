import assert from "node:assert/strict";
import test from "node:test";
import {
  AI_REPORT_SYSTEM_PROMPT,
  buildAiReportMessages,
  composeAiReport,
  compileInvestigationReport,
  countOmittedAiReportFindings,
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

function facecheckCase(): Investigation {
  const base = investigation();
  const names = ["accepted", "rejected", "reaccepted", "rerejected", "inconclusive", "undecided"];
  const evidence = names.map((name) => ({
    ...base.evidence[0]!,
    id: `face-${name}`,
    provider: "facecheck",
    sourceId: "facecheck:photo",
    seed: { kind: "photo" as const, value: "https://photos.example/seed" },
    finding: { ...base.evidence[0]!.finding!, url: `https://candidate.example/${name}` },
  }));
  const decisions = [
    ["accepted", "accepted"], ["rejected", "rejected"],
    ["reaccepted", "rejected"], ["reaccepted", "accepted"],
    ["rerejected", "accepted"], ["rerejected", "rejected"], ["inconclusive", "inconclusive"],
  ] as const;
  return {
    ...base,
    evidence: [...base.evidence, ...evidence],
    validations: [...base.validations, ...decisions.map(([name, status], index) => ({
      id: `decision-${index}`, evidenceId: `face-${name}`, status,
      reason: "review", at: "2026-10-01T10:00:00.000Z", operator: "local-operator" as const,
    }))],
  };
}

function requestData(value: Investigation): { findings: { evidenceId: string; url?: string; operatorValidation: string }[]; omittedFindings?: number } {
  const user = buildAiReportMessages(value)[1]!.content;
  return JSON.parse(user.slice(user.indexOf("```json") + 7, user.lastIndexOf("```")));
}

test("factual report includes only FaceCheck candidates with a latest accepted decision", () => {
  const value = facecheckCase();
  const report = compileInvestigationReport(value);
  const evidenceSection = report.split("## Evidence\n")[1]!.split("\n## Validation decisions")[0]!;
  for (const name of ["accepted", "reaccepted"]) assert.ok(evidenceSection.includes(`https://candidate\\.example/${name}`));
  for (const name of ["rejected", "rerejected", "inconclusive", "undecided"]) assert.ok(!report.includes(`https://candidate\\.example/${name}`));
  assert.ok(evidenceSection.includes("FaceCheck candidates: 2 accepted (included), 2 discarded and 2 not reviewed (excluded)."));
  assert.equal(report, compileInvestigationReport(value));
  const withoutCandidates = { ...value, evidence: value.evidence.filter((item) => item.sourceId !== "facecheck:photo") };
  assert.equal(report.split("## Validation decisions\n")[1], compileInvestigationReport(withoutCandidates).split("## Validation decisions\n")[1]);
});

test("AI request and factual appendix exclude non-accepted FaceCheck candidates without charging the size budget", () => {
  const value = facecheckCase();
  const data = requestData(value);
  assert.deepEqual(data.findings.map((item) => item.evidenceId), ["evidence-1", "evidence-2", "face-accepted", "face-reaccepted"]);
  assert.equal(data.findings[2]!.operatorValidation, "accepted");
  assert.equal(data.findings[3]!.operatorValidation, "accepted");
  assert.equal(data.omittedFindings, undefined);
  assert.equal(countOmittedAiReportFindings(value), 0);
  const report = composeAiReport({ narrative: "Resumen", factualReport: compileInvestigationReport(value), model: "test/model", generatedAt: "2026-10-01" });
  for (const name of ["accepted", "reaccepted"]) assert.ok(report.includes(`https://candidate\\.example/${name}`));
  for (const name of ["rejected", "rerejected", "inconclusive", "undecided"]) assert.ok(!report.includes(`https://candidate\\.example/${name}`));

  const base = investigation();
  const evidence = Array.from({ length: 400 }, (_, index) => ({
    ...base.evidence[0]!, id: `large-${index}`, finding: { ...base.evidence[0]!.finding!, extra: { bio: "x".repeat(200) } },
  }));
  const large = { ...base, evidence, validations: [] };
  const excluded = { ...large, evidence: [value.evidence[3]!, ...evidence] };
  assert.ok(countOmittedAiReportFindings(large) > 0);
  assert.deepEqual(requestData(excluded), requestData(large));
  assert.equal(countOmittedAiReportFindings(excluded), countOmittedAiReportFindings(large));
});

test("rejected evidence from another provider remains in factual and AI reports", () => {
  const value = investigation();
  const report = compileInvestigationReport(value);
  assert.ok(report.includes("| evidence\\-2 | action\\-1 | email: ana@example\\.com | steam | registered | user\\-scanner |"));
  assert.deepEqual(requestData(value).findings[1], {
    evidenceId: "evidence-2", emailSeed: "ana@example.com", provider: "steam", target: "ana@example.com",
    operatorValidation: "rejected", operatorReason: "Falso positivo",
  });
});

test("a report without FaceCheck candidates retains its existing evidence section", () => {
  const report = compileInvestigationReport(investigation());
  const section = report.split("## Evidence\n")[1]!.split("\n## Validation decisions")[0]!;
  assert.equal(section, [
    "| Evidence | Action | Seed | Provider | Registration status | Source | Recorded at | Target kind | Observed target | Upstream status | URL | Category | Reason | Metadata | Media |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    "| evidence\\-1 | action\\-1 | email: ana@example\\.com | spotify | registered | user\\-scanner | 2026\\-10\\-01T10:30:00\\.000Z | email | ana@example\\.com | Registered | https://open\\.spotify\\.com/user/ana | music |  | \\{\"display\\_name\":\"Ana Rock\"\\} | \\{\\} |",
    "| evidence\\-2 | action\\-1 | email: ana@example\\.com | steam | registered | user\\-scanner | 2026\\-10\\-01T10:31:00\\.000Z | email | ana@example\\.com | registered |  |  |  | \\{\\} | \\{\\} |",
    "",
  ].join("\n"));
  assert.ok(!report.includes("FaceCheck candidates:"));
});

test("defaults make a configuration that only needs an API key", () => {
  assert.deepEqual(DEFAULT_AI_REPORT_SETTINGS, {
    model: "nvidia/nemotron-3.5-super-vl-120b-a12b",
    reasoningEffort: "default",
    temperature: 0.6,
    topP: 0.95,
    maxTokens: 8192,
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
    "situación migratoria o estatus legal",
    "rechazada",
    "No intentes ubicar ni localizar físicamente a la persona",
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
  assert.equal(countOmittedAiReportFindings({ ...base, evidence, validations: [] }), json.omittedFindings);
  assert.equal(countOmittedAiReportFindings(base), 0);
});

test("appendix says which findings were not sent when the request budget truncated them", () => {
  const report = composeAiReport({
    narrative: "## Resumen\nTexto",
    factualReport: "# Caso",
    model: "openai/gpt-oss-20b",
    generatedAt: "2026-10-28T12:00:00.000Z",
    omittedFindings: 12,
  });
  assert.match(report, /Estos son todos los datos recopilados\. Por el tamaño del pedido, 12 hallazgos no se enviaron al modelo y no sostienen las conclusiones; igual figuran en este anexo\./);
  assert.doesNotMatch(report, /que se enviaron al modelo para elaborar/);
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
