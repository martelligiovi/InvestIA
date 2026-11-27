import assert from "node:assert/strict";
import test from "node:test";
import {
  AI_REPORT_SYSTEM_PROMPT,
  buildAiReportMessages,
  composeAiReport,
  compileInvestigationReport,
  countOmittedAiReportFindings,
  decodoSourceContentHash,
  DEFAULT_AI_REPORT_SETTINGS,
  normalizeAiReportSettings,
  stripModelReasoning,
  findingSeedNodeId,
  type EvidenceAiNormalization,
  type EvidenceRecord,
  type GitHubCatalogAction,
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

function requestData(value: Investigation): { findings: { evidenceId: string; url?: string; urlSeed?: string; operatorValidation: string }[]; omittedFindings?: number } {
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

test("AI request and factual report exclude non-accepted FaceCheck candidates without charging the size budget", () => {
  const value = facecheckCase();
  const data = requestData(value);
  assert.deepEqual(data.findings.map((item) => item.evidenceId), ["evidence-1", "evidence-2", "face-accepted", "face-reaccepted"]);
  assert.equal(data.findings[2]!.operatorValidation, "accepted");
  assert.equal(data.findings[3]!.operatorValidation, "accepted");
  assert.equal(data.omittedFindings, undefined);
  assert.equal(countOmittedAiReportFindings(value), 0);
  const factualReport = compileInvestigationReport(value);
  for (const name of ["accepted", "reaccepted"]) assert.ok(factualReport.includes(`https://candidate\\.example/${name}`));
  for (const name of ["rejected", "rerejected", "inconclusive", "undecided"]) assert.ok(!factualReport.includes(`https://candidate\\.example/${name}`));
  const aiReport = composeAiReport({ narrative: "Resumen conciso", model: "test/model", generatedAt: "2026-10-01" });
  assert.doesNotMatch(aiReport, /Datos utilizados|candidate\\\.example/);

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

test("Decodo evidence reaches factual and AI reports only for FaceCheck parents still accepted", () => {
  const base = facecheckCase();
  const parents = base.evidence.filter((record) => record.sourceId === "facecheck:photo");
  const seed = { kind: "url", value: "https://example.org/public-profile" } as const;
  const actions: GitHubCatalogAction[] = parents.map((parent) => ({
    id: `scrape-${parent.id}`, spec: { catalogId: "decodo.url.v1", provider: "decodo", seed },
    sourceSeedId: findingSeedNodeId(parent.id), status: "succeeded", proposedAt: base.createdAt, proposalReason: "Accepted result URL.",
  }));
  const children: EvidenceRecord[] = parents.map((parent, index) => ({
    id: `child-${parent.id}`, actionId: actions[index]!.id, seed, provider: "Decodo", status: "registered",
    sourceId: "decodo:url", recordedAt: base.updatedAt,
    finding: { target: seed, upstreamStatus: "Found", url: seed.value, category: "Page", reason: "", extra: { title: `Scraped ${parent.id}` }, media: {} },
  }));
  const snapshot = { ...base, actions, evidence: [...base.evidence, ...children] };
  const factualReport = compileInvestigationReport(snapshot);
  const aiMessage = buildAiReportMessages(snapshot)[1]!.content;
  const aiReport = composeAiReport({ narrative: "Summary", factualReport, model: "test/model", generatedAt: "2026-10-01" });
  for (const parent of ["rejected", "rerejected", "inconclusive", "undecided"]) {
    const title = `Scraped face-${parent}`;
    assert.ok(!factualReport.includes(title.replace("-", "\\-")), `factual report must not expose ${title}`);
    assert.ok(!aiMessage.includes(title), `AI request must not expose ${title}`);
    assert.ok(!aiReport.includes(title.replace("-", "\\-")), `AI report must not expose ${title}`);
  }
  assert.equal(countOmittedAiReportFindings(snapshot), 0);
  const findings = requestData(snapshot).findings.filter((record) => record.evidenceId.startsWith("child-"));
  assert.deepEqual(findings.map((record) => [record.evidenceId, record.urlSeed]), [
    ["child-face-accepted", seed.value], ["child-face-reaccepted", seed.value],
  ]);
  assert.ok(factualReport.includes("url: https://example\\.org/public\\-profile"));
  assert.ok(factualReport.includes("Scraped face\\-reaccepted"));
  assert.ok(aiMessage.includes("Scraped face-reaccepted"));
  assert.ok(!aiReport.includes("Scraped face\\-reaccepted"));
});

test("Decodo results with unresolved explicit parents are excluded from factual and AI evidence", () => {
  const base = investigation();
  const seed = { kind: "url", value: "https://example.org/public-profile" } as const;
  const action: GitHubCatalogAction = {
    id: "scrape", spec: { catalogId: "decodo.url.v1", provider: "decodo", seed },
    status: "succeeded", proposedAt: base.createdAt, proposalReason: "Scrape result URL.",
  };
  const child: EvidenceRecord = {
    id: "child", actionId: action.id, seed, provider: "Decodo", status: "registered",
    sourceId: "decodo:url", recordedAt: base.updatedAt,
    finding: { target: seed, upstreamStatus: "Found", url: seed.value, category: "Page", reason: "Public excerpt", extra: {}, media: {} },
  };
  const snapshot = { ...base, evidence: [...base.evidence, child] };
  const unlinked = { ...snapshot, actions: [action] };
  assert.match(compileInvestigationReport(unlinked), /\| child \| scrape \|/);
  assert.ok(requestData(unlinked).findings.some(({ evidenceId }) => evidenceId === child.id));

  for (const parentId of ["missing-parent", base.evidence[0]!.id]) {
    const linked = { ...snapshot, actions: [{ ...action, sourceSeedId: findingSeedNodeId(parentId) }], validations: [
      ...base.validations, { ...base.validations[0]!, evidenceId: parentId, status: "accepted" as const },
    ] };
    const withoutChild = { ...linked, evidence: base.evidence };
    assert.equal(compileInvestigationReport(linked), compileInvestigationReport(withoutChild));
    assert.deepEqual(requestData(linked), requestData(withoutChild));
    assert.equal(countOmittedAiReportFindings(linked), countOmittedAiReportFindings(withoutChild));
  }
});

test("rejected evidence from another provider remains in factual report and AI request payload", () => {
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

test("system prompt asks for a concise Spanish profile report without naming sources or technical IDs", () => {
  for (const phrase of [
    "español",
    "Perfil general",
    "Ocupación y formación",
    "Intereses y actividades",
    "Foco y motivaciones",
    "NO nombres fuentes, plataformas, herramientas, sitios web, URLs, puntajes ni identificadores técnicos",
    "falso positivo",
    "no confirma por sí solo identidad ni titularidad de cuentas",
    "pendiente pesa menos que la aceptada",
    "salud",
    "orientación sexual",
    "situación migratoria o estatus legal",
    "rechazada",
    "domicilio particular",
    "No agregues encabezados de fuentes, anexos, tablas ni secciones de datos utilizados",
  ]) {
    assert.ok(AI_REPORT_SYSTEM_PROMPT.includes(phrase), phrase);
  }
  assert.doesNotMatch(AI_REPORT_SYSTEM_PROMPT, /Citá entre paréntesis/);
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

test("concise report notes omitted count inline when the request budget truncated findings", () => {
  const report = composeAiReport({
    narrative: "## Perfil general\nTexto",
    model: "openai/gpt-oss-20b",
    generatedAt: "2026-10-28T12:00:00.000Z",
    omittedFindings: 12,
  });
  assert.match(report, /Por límite de contexto se omitieron 12 registros\./);
  assert.doesNotMatch(report, /Datos utilizados/);
});

test("composed report returns only the concise header note and narrative without raw factual appendix", () => {
  const report = composeAiReport({
    narrative: [
      "## Perfil general",
      "Ana se dedica al [desarrollo de software](https://example.org/dev/) (Decodo, evidence-123) y disfruta de la música. https://example.org/perfil/",
      "- https://example.org/solo-link/",
      "",
      "## Datos utilizados",
      "| Decodo | https://example.org | evidence-123 |",
    ].join("\n"),
    factualReport: "# Caso Ana\n\n## Evidence\nrows",
    model: "openai/gpt-oss-20b",
    generatedAt: "2026-10-28T12:00:00.000Z",
  });
  assert.equal(report, [
    "# Informe de perfil",
    "",
    "> Síntesis asistida por IA (openai/gpt-oss-20b) generada el 2026-10-28T12:00:00.000Z a partir de fuentes públicas; no verifica identidad ni titularidad de cuentas.",
    "",
    "## Perfil general\nAna se dedica al desarrollo de software y disfruta de la música.",
    "",
  ].join("\n"));
  assert.doesNotMatch(report, /Datos utilizados|Caso Ana|Evidence|Decodo|evidence-123|https?:\/\/|\[|\]/);
});

test("concise report strips echoes and technical formatting without losing profile text (S1–S3)", () => {
  const note = {
    model: "test/model",
    generatedAt: "2026-10-01T00:00:00.000Z",
  };
  const cases: readonly (readonly [string, string])[] = [
    ["# Informe de perfil", "## Perfil general\nNo hay datos suficientes para redactar el informe."],
    ["> Generado por IA", "## Perfil general\nNo hay datos suficientes para redactar el informe."],
    ["Ana hace cerámica.\n\n> Generado por IA a partir de fuentes públicas.", "Ana hace cerámica."],
    ["Según Decodo, Ana hace cerámica.", "Ana hace cerámica."],
    ["Ana hace cerámica.\n\nDato | Valor\n--- | ---\nOrigen | interno", "Ana hace cerámica."],
    ['Le gusta la [cerámica](https://example.org/taller/ "Taller").', "Le gusta la cerámica."],
    ["Ana hace cerámica. https://[2001:db8::1]/perfil/", "Ana hace cerámica."],
    ["Ana hace cerámica. https://example.org/perfil/.", "Ana hace cerámica.."],
    ["Ana hace cerámica.\n1. https://example.org/perfil/", "Ana hace cerámica."],
    ...["Datos utilizados", "Fuentes", "Anexo", "Referencias", "Evidencias"].map((heading): readonly [string, string] => [
      `## Perfil general\nAna vive en Córdoba.\n\n## ${heading}\nFicha interna.\n\n## Intereses y actividades\nHace cerámica.`,
      "## Perfil general\nAna vive en Córdoba.\n\n## Intereses y actividades\nHace cerámica.",
    ]),
  ];

  for (const [narrative, expected] of cases) {
    const report = composeAiReport({ ...note, narrative });
    assert.equal(report.split("\n\n").slice(2).join("\n\n").trimEnd(), expected, narrative);
    assert.equal(report.match(/^> /gm)?.length, 1, narrative);
  }
});

test("AI report removes alternate echoes and audit markup (S1–S3)", () => {
  const fallback = "## Perfil general\nNo hay datos suficientes para redactar el informe.";
  for (const [narrative, expected] of [
    ["# Perfil de Ana", fallback],
    ["**Aviso:** Esta síntesis no verifica identidad ni titularidad de cuentas.", fallback],
    ["Ana hace cerámica.\n\n| Dato | Valor |\n--- | ---\nOrigen | interno", "Ana hace cerámica."],
    ['Le gusta la [cerámica](https://example.org/taller_(centro)/ "Taller").', "Le gusta la cerámica."],
  ] as const) {
    const report = composeAiReport({ narrative, model: "test/model", generatedAt: "2026-10-01" });
    assert.equal(report.split("\n\n").slice(2).join("\n\n").trimEnd(), expected, narrative);
  }
});

test("AI report falls back after a standalone verification echo or empty H1 (S3)", () => {
  for (const narrative of [
    "> Esta síntesis no verifica identidad ni titularidad de cuentas.",
    "#",
  ]) {
    const report = composeAiReport({
      narrative,
      model: "test/model",
      generatedAt: "2026-10-01",
    });
    assert.equal(report.match(/^> /gm)?.length, 1, narrative);
    assert.equal(
      report.split("\n\n").slice(2).join("\n\n").trimEnd(),
      "## Perfil general\nNo hay datos suficientes para redactar el informe.",
      narrative,
    );
  }
});

test("model reasoning blocks are removed from the narrative", () => {
  assert.equal(stripModelReasoning("<think>plan\nsecreto</think>\n\n## Resumen\nTexto"), "## Resumen\nTexto");
  assert.equal(stripModelReasoning("  ## Resumen\nTexto  "), "## Resumen\nTexto");
});

test("AI report substitutes compact provenance and aiNormalizedPage only when Decodo sourceContentHash matches, leaving factual report untouched", () => {
  const base = investigation();
  const urlSeed = { kind: "url" as const, value: "https://example.org/ana-profile" };
  const decodoFresh: EvidenceRecord = {
    id: "decodo-fresh",
    actionId: "action-decodo-1",
    seed: urlSeed,
    provider: "Decodo",
    status: "registered",
    sourceId: "decodo:url",
    recordedAt: "2026-11-26T10:00:00.000Z",
    finding: {
      target: urlSeed,
      upstreamStatus: "Found",
      url: "https://example.org/ana-profile",
      category: "Web page",
      reason: "Ana — Sitio personal",
      media: {},
      extra: {
        source: "decodo",
        api_mode: "web_data",
        status_code: 200,
        content_format: "html",
        content_length: 5500,
        content_truncated: false,
        title: "Ana — Sitio personal",
        description: "Descripción extensa original",
        preview: "Vista previa extensa original",
        content: `Contenido crudo extenso: ${"A".repeat(5200)}`,
        links: "https://github.com/ana\nhttps://example.org/blog",
        extracted_links_count: 2,
      },
    },
  };
  const decodoStale: EvidenceRecord = {
    ...decodoFresh,
    id: "decodo-stale",
    finding: {
      ...decodoFresh.finding!,
      url: "https://example.org/ana-updated",
      extra: {
        ...decodoFresh.finding!.extra,
        title: "Ana — Página actualizada",
        content: "Contenido nuevo sin re-normalizar",
      },
    },
  };

  const snapshot: Investigation = {
    ...base,
    evidence: [base.evidence[0]!, decodoFresh, decodoStale],
    validations: [],
  };

  const freshNorm: EvidenceAiNormalization = {
    evidenceId: "decodo-fresh",
    model: "nvidia/nemotron-3.5-super-vl-120b-a12b",
    generatedAt: "2026-11-26T10:05:00.000Z",
    sourceContentHash: decodoSourceContentHash(decodoFresh),
    data: {
      summary: "Sitio personal público de Ana con enlaces a proyectos.",
      entityName: "Ana",
      handles: ["@ana"],
      rolesOrOccupations: ["Desarrolladora"],
      organizations: [],
      education: [],
      locationsMentioned: [],
      topicsOrInterests: ["Código abierto"],
      notableFacts: ["Mantiene repositorios públicos."],
      relatedUrls: ["https://github.com/ana"],
      limitations: [],
    },
  };
  const staleNorm: EvidenceAiNormalization = {
    ...freshNorm,
    evidenceId: "decodo-stale",
    sourceContentHash: "0".repeat(64),
  };
  const nonDecodoNorm: EvidenceAiNormalization = {
    ...freshNorm,
    evidenceId: "evidence-1",
    sourceContentHash: decodoSourceContentHash(base.evidence[0]!),
  };

  const normalizations = new Map<string, EvidenceAiNormalization>([
    [freshNorm.evidenceId, freshNorm],
    [staleNorm.evidenceId, staleNorm],
    [nonDecodoNorm.evidenceId, nonDecodoNorm],
  ]);

  const baselineMessages = buildAiReportMessages(snapshot);
  const baselineJson = JSON.parse(baselineMessages[1]!.content.slice(baselineMessages[1]!.content.indexOf("```json") + 7, baselineMessages[1]!.content.lastIndexOf("```")));
  assert.equal(baselineJson.findings[1].metadata.content, decodoFresh.finding!.extra.content);
  assert.equal(baselineJson.findings[1].aiNormalizedPage, undefined);

  const normalizedMessages = buildAiReportMessages(snapshot, normalizations);
  const normalizedUser = normalizedMessages[1]!.content;
  const normalizedJson = JSON.parse(normalizedUser.slice(normalizedUser.indexOf("```json") + 7, normalizedUser.lastIndexOf("```")));

  assert.equal("aiNormalizedPage" in normalizedJson.findings[0], false);
  assert.deepEqual(normalizedJson.findings[0].metadata, { display_name: "Ana Rock" });

  assert.deepEqual(normalizedJson.findings[1].metadata, {
    title: "Ana — Sitio personal",
    status_code: 200,
    source: "decodo",
    api_mode: "web_data",
    content_truncated: false,
  });
  assert.deepEqual(normalizedJson.findings[1].aiNormalizedPage, {
    model: "nvidia/nemotron-3.5-super-vl-120b-a12b",
    generatedAt: "2026-11-26T10:05:00.000Z",
    note: "Extracted by AI from the stored raw page.",
    ...freshNorm.data,
  });
  assert.equal(normalizedUser.includes("A".repeat(5200)), false);

  assert.equal("aiNormalizedPage" in normalizedJson.findings[2], false);
  assert.equal(normalizedJson.findings[2].metadata.content, "Contenido nuevo sin re-normalizar");

  const factual = compileInvestigationReport(snapshot);
  assert.ok(factual.includes("A".repeat(5200)));
  assert.equal(factual.includes("aiNormalizedPage"), false);
  assert.equal(factual.includes("Sitio personal público de Ana con enlaces a proyectos."), false);
});

test("matching Decodo AI normalizations conserve AI report prompt budget and reduce omitted findings", () => {
  const base = investigation();
  const evidence: EvidenceRecord[] = Array.from({ length: 12 }, (_, index) => {
    const seed = { kind: "url" as const, value: `https://example.org/page-${index}` };
    return {
      id: `decodo-${index}`,
      actionId: `action-${index}`,
      seed,
      provider: "Decodo",
      status: "registered",
      sourceId: "decodo:url",
      recordedAt: "2026-11-26T10:00:00.000Z",
      finding: {
        target: seed,
        upstreamStatus: "Found",
        url: seed.value,
        category: "Web page",
        reason: `Página ${index}`,
        media: {},
        extra: {
          source: "decodo",
          api_mode: "web_data",
          status_code: 200,
          content_truncated: true,
          title: `Página ${index}`,
          content: `Texto extenso ${index}: ${"X".repeat(5800)}`,
          links: `https://example.com/ref-${index}`,
        },
      },
    };
  });
  const largeInvestigation: Investigation = { ...base, evidence, validations: [] };

  const rawOmitted = countOmittedAiReportFindings(largeInvestigation);
  assert.ok(rawOmitted > 0, "unnormalized 6k-char pages should exceed 60k finding budget");

  const normalizations = new Map<string, EvidenceAiNormalization>(
    evidence.map((record, index) => [
      record.id,
      {
        evidenceId: record.id,
        model: "nvidia/nemotron-3.5-super-vl-120b-a12b",
        generatedAt: "2026-11-26T10:10:00.000Z",
        sourceContentHash: decodoSourceContentHash(record),
        data: {
          summary: `Resumen compacto de la página ${index}.`,
          handles: [],
          rolesOrOccupations: [],
          organizations: [],
          education: [],
          locationsMentioned: [],
          topicsOrInterests: [],
          notableFacts: [],
          relatedUrls: [`https://example.com/ref-${index}`],
          limitations: ["Contenido truncado."],
        },
      },
    ]),
  );

  assert.equal(countOmittedAiReportFindings(largeInvestigation, normalizations), 0);
  const user = buildAiReportMessages(largeInvestigation, normalizations)[1]!.content;
  const json = JSON.parse(user.slice(user.indexOf("```json") + 7, user.lastIndexOf("```")));
  assert.equal(json.findings.length, 12);
  assert.equal(json.omittedFindings, undefined);
});
