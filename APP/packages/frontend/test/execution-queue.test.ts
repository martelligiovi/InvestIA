import { describe, expect, it } from "vitest";
import { findingSeedNodeId, SCOPED_CATALOG_IDS, type EvidenceRecord, type Investigation } from "@investia/core";
import { buildExecutionQueue, explainActionFailure, type QueueAction } from "../src/pages/execution-queue";

const at = "2025-03-16T12:00:00.000Z";
const email = { kind: "email", value: "ana@example.test" } as const;
const scanner = { catalogId: "user-scanner.email.v1", provider: "user-scanner", seed: email } as const;
const gravatar = { catalogId: "gravatar.email.v1", provider: "gravatar", seed: email } as const;
const ghunt = { catalogId: "ghunt.email.v1", provider: "ghunt", seed: email } as const;
const facecheck = { catalogId: "facecheck.photo.v1", provider: "facecheck", seed: { kind: "photo", value: "https://lh3.googleusercontent.com/profile" } } as const;
const decodo = { catalogId: "decodo.url.v1", provider: "decodo", seed: { kind: "url", value: "https://example.test/profile?private=not-shown" } } as const;
const ready = { ghuntConnected: true, facecheckConfigured: true, decodoConfigured: true };
const rerun = { previousStatus: "succeeded", fingerprint: "a".repeat(64) } as const;

type QueueFixtureAction = QueueAction & { readonly sourceActionId?: string };

function action(id: string, status: QueueAction["status"], overrides: Partial<QueueFixtureAction> = {}): QueueFixtureAction {
  return { id, status, spec: scanner, proposedAt: at, proposalReason: "Fixture", queuedByCatalog: true, ...overrides };
}

function snapshot(actions: readonly QueueFixtureAction[], overrides: Partial<Investigation> = {}): Investigation {
  return {
    id: "case-1", revision: 1, createdAt: at, updatedAt: at, paused: false, emailSeeds: [email], actions,
    evidence: [], validations: [], audit: [],
    authorization: { granted: true, at, reason: "Fixture", operator: "local-operator", catalogScopes: SCOPED_CATALOG_IDS },
    ...overrides,
  };
}

describe("execution queue", () => {
  it("groups existing stages without sorting runnable actions by ID or inventing future stages", () => {
    const running = action("scanner", "claimed");
    const initial = buildExecutionQueue(snapshot([running]), ready);
    expect(initial.items.map(({ actionId }) => actionId)).toEqual(["scanner"]);

    const queue = buildExecutionQueue(snapshot([
      action("queued-z", "queued", { spec: ghunt }), action("failed", "failed", { spec: decodo, failure: "Decodo target requires login" }),
      action("queued-a", "queued", { spec: decodo }), action("proposal", "proposed", { spec: gravatar }),
      action("done", "succeeded"), action("queued-m", "queued"), running,
      action("rerun-failed", "succeeded", { lastRerunFailed: true, lastRerunFailure: "The replacement returned no confirmed results." }),
    ]), ready);
    expect(queue.items.map(({ actionId, kind, label }) => [actionId, kind, label])).toEqual([
      ["scanner", "running", "En ejecución"], ["queued-z", "queued", "Siguiente"], ["queued-a", "queued", "En cola · #2"],
      ["queued-m", "queued", "En cola · #3"], ["proposal", "waiting", "Espera tu aprobación"], ["done", "completed", "Completo"],
      ["failed", "failed", "Falló"], ["rerun-failed", "failed", "Reejecución fallida · se conservó el resultado anterior"],
    ]);
    expect(queue.items[0]).toMatchObject({ title: "Escaneo de correo · user-scanner", target: email.value });
    expect(queue.items[1]).toMatchObject({ title: "Perfil de Google · GHunt", target: email.value });
    expect(queue.items[2]).toMatchObject({ title: "Decodo · example.test", target: "/profile" });
    expect(queue.items.slice(-2).map(({ failureExplanation }) => failureExplanation)).toEqual([
      "La página requiere iniciar sesión para ver su contenido.", "La reejecución no devolvió resultados confirmados.",
    ]);
    expect(queue).toMatchObject({ total: 8, settled: 3, percent: 38, ringMode: "progress_active", counts: {
      running: 1, queued: 3, waiting: 1, completed: 1, failed: 2,
    } });
  });

  it.each([
    ["empty", [], 0, null],
    ["spinning", ["claimed", "queued"], 0, 0],
    ["progress_active", ["claimed", "failed", "queued"], 1, 33],
    ["progress", ["proposed"], 0, 0],
    ["progress", ["succeeded", "queued", "proposed"], 1, 33],
    ["complete_with_errors", ["succeeded", "failed"], 2, 100],
    ["complete", ["succeeded"], 1, 100],
  ] as const)("renders progress mode %s for %j", (ringMode, statuses, settled, percent) => {
    const actions = statuses.map((status, index) => action(String(index), status));
    expect(buildExecutionQueue(snapshot(actions), ready)).toMatchObject({ total: actions.length, settled, percent, ringMode });
  });

  it.each(["queued", "claimed"] as const)("blocks descendants through both types of provenance while the rerun is %s", (status) => {
    const evidence: EvidenceRecord = {
      id: "finding/1", actionId: "child", seed: email, provider: "Fixture", status: "registered", sourceId: "fixture", recordedAt: at,
    };
    const actions = [
      action("grandchild", "queued", { sourceSeedId: findingSeedNodeId(evidence.id) }),
      action("unrelated", "queued"), action("proposal", "proposed", { sourceActionId: "grandchild" }),
      action("child", "queued", { sourceActionId: "ancestor" }), action("ancestor", status, { rerun }),
      action("completed-child", "succeeded", { sourceActionId: "ancestor" }),
    ];
    const queue = buildExecutionQueue(snapshot(actions, { evidence: [evidence] }), ready);
    expect(queue.items.filter(({ kind }) => kind === "waiting").map(({ actionId, label }) => [actionId, label])).toEqual([
      ["grandchild", "Esperando reejecución previa"], ["proposal", "Esperando reejecución previa"], ["child", "Esperando reejecución previa"],
    ]);
    expect(queue.items.find(({ actionId }) => actionId === "ancestor")).toMatchObject(
      status === "claimed" ? { kind: "running", label: "Reejecutando" } : { kind: "queued", label: "En cola · #2" },
    );
    expect(queue.items.find(({ actionId }) => actionId === "unrelated")).toMatchObject({ kind: "queued", label: "Siguiente" });
    expect(queue.items.find(({ actionId }) => actionId === "completed-child")).toMatchObject({ kind: "completed" });

    const settled = actions.map((entry) => entry.id === "ancestor" ? action("ancestor", "succeeded") : entry);
    expect(buildExecutionQueue(snapshot(settled, { evidence: [evidence] }), ready).items.filter(({ kind }) => kind === "queued").map(({ actionId }) => actionId))
      .toEqual(["grandchild", "unrelated", "child"]);
  });

  it("uses the latest rerun failure when the earlier attempt also failed", () => {
    const entry = action("old-failure", "failed", { failure: "Execution failed.", lastRerunFailed: true,
      lastRerunFailure: "Prior results changed during execution; the replacement was not applied." });
    expect(buildExecutionQueue(snapshot([entry]), ready)).toMatchObject({ ringMode: "complete_with_errors", items: [{
      kind: "failed", label: "Falló", failureExplanation: "Los resultados anteriores cambiaron durante la reejecución y no se reemplazaron.",
    }] });
  });

  it.each([
    [ghunt, { ghuntConnected: false }, "Requiere iniciar sesión en Google"],
    [ghunt, { ghuntConnected: null }, "Conexión de Google desconocida"],
    [facecheck, { facecheckConfigured: false }, "Requiere token de FaceCheck"],
    [facecheck, { facecheckConfigured: null }, "Token de FaceCheck sin confirmar"],
    [decodo, { decodoConfigured: false }, "Requiere token de Decodo"],
    [decodo, { decodoConfigured: null }, "Token de Decodo sin confirmar"],
    [gravatar, {}, "En espera de user-scanner"],
  ] as const)("explains settings or scanner blockers for %j", (spec, options, label) => {
    expect(buildExecutionQueue(snapshot([action("blocked", "queued", { spec })]), { ...ready, ...options }).items)
      .toMatchObject([{ kind: "waiting", label }]);
  });

  it("reflects how the next claim reconciles an unlinked legacy Gravatar action after the scanner succeeds", () => {
    const actions = [action("legacy", "queued", { spec: gravatar }), action("scanner", "succeeded"), action("other", "queued")];
    const match: EvidenceRecord = {
      id: "match", actionId: "scanner", seed: email, provider: "Gravatar", status: "registered", sourceId: "user-scanner:email", recordedAt: at,
      finding: { target: email, upstreamStatus: "Registered", url: "https://gravatar.com/example", category: "Profile", reason: "Fixture", extra: {}, media: {} },
    };
    const noMatch = buildExecutionQueue(snapshot(actions), ready);
    expect(noMatch.items.map(({ actionId, label }) => [actionId, label])).toEqual([
      ["other", "Siguiente"], ["legacy", "Espera tu aprobación"], ["scanner", "Completo"],
    ]);
    const linked = buildExecutionQueue(snapshot(actions, { evidence: [match] }), ready);
    expect(linked.items.map(({ actionId, label }) => [actionId, label])).toEqual([
      ["legacy", "Siguiente"], ["other", "En cola · #2"], ["scanner", "Completo"],
    ]);
  });

  it("keeps authorization, pause, actionable approval, and match validation gates", () => {
    const queued = action("next", "queued");
    const labelIn = (current: Investigation) => buildExecutionQueue(current, ready).items[0]?.label;
    expect(labelIn(snapshot([queued], { authorization: undefined }))).toBe("Esperando autorización");
    expect(labelIn(snapshot([queued], { paused: true }))).toBe("En cola · pausada");
    expect(labelIn(snapshot([action("next", "queued", { queuedByCatalog: undefined })]))).toBe("En cola · no ejecutable");
    const unlinkedRerun = action("rerun", "queued", { spec: gravatar, rerun });
    expect(labelIn(snapshot([unlinkedRerun]))).toBe("Siguiente");

    const match: EvidenceRecord = {
      id: "match", actionId: "face-search", seed: facecheck.seed, provider: "FaceCheck", status: "registered", sourceId: "facecheck:photo", recordedAt: at,
    };
    const scrape = action("scrape", "queued", { spec: decodo, sourceSeedId: findingSeedNodeId(match.id) });
    const accepted = { id: "accept", evidenceId: match.id, status: "accepted", at, reason: "Fixture", operator: "local-operator" } as const;
    expect(labelIn(snapshot([scrape], { evidence: [match] }))).toBe("Requiere aceptar la coincidencia");
    expect(labelIn(snapshot([scrape], { evidence: [match], validations: [accepted] }))).toBe("Siguiente");
    expect(labelIn(snapshot([scrape], { evidence: [match], validations: [accepted, { ...accepted, id: "reject", status: "rejected" }] })))
      .toBe("Requiere aceptar la coincidencia");
  });

  it("reserves 100% for a fully settled queue", () => {
    const actions = Array.from({ length: 200 }, (_, index) =>
      action(`stage-${index}`, index === 199 ? "queued" : "succeeded"));
    const queue = buildExecutionQueue(snapshot(actions), ready);
    expect(queue.ringMode).toBe("progress");
    expect(queue.percent).toBeLessThan(100);
  });

  it("does not ask for approval of a historical GitHub proposal", () => {
    const entry = action("historical", "proposed", {
      spec: { catalogId: "github.email-registration.v1", provider: "github", seed: email },
      queuedByCatalog: undefined,
    });
    expect(buildExecutionQueue(snapshot([entry]), ready).items[0]).toMatchObject({
      kind: "waiting",
      label: expect.stringMatching(/histórica|no ejecutable/iu),
    });
  });
});

describe("public execution failure explanations", () => {
  it.each([
    ["Decodo service failure (HTTP 613)", "Decodo no pudo obtener el contenido de la página (código 613)."],
    ["Decodo service failure (HTTP 612)", "Decodo no pudo obtener el contenido de la página (código 612)."],
    ["Decodo service failure (HTTP 503)", "El servicio de Decodo devolvió un error (código 503)."],
    ["Decodo service failure (HTTP 601)", "El servicio de Decodo devolvió un error (código 601)."],
    ["Decodo scrape blocked by anti-bot protection (999)", "La protección contra bots de la página bloqueó la consulta (código 999)."],
    ["Decodo target requires login", "La página requiere iniciar sesión para ver su contenido."],
    ["Decodo returned empty page content", "Decodo no encontró contenido para mostrar en la página."],
    ["Decodo request timed out", "Decodo tardó demasiado en responder y se agotó el tiempo de espera."],
    ["Decodo API credentials were rejected", "Decodo rechazó el token. Revisá que sea válido para el modo de API elegido."],
    ["Decodo API rate limit or quota exceeded", "Se alcanzó el límite de consultas de Decodo o se agotó la cuota."],
    ["Decodo API token is not configured", "Falta configurar el token de Decodo."],
    ["Decodo API token contains control characters", "El token de Decodo contiene caracteres no permitidos."],
    ["Decodo API token contains whitespace", "El token de Decodo contiene espacios."],
    ["Decodo API mode is invalid", "El modo de API de Decodo no es válido. Revisá la configuración."],
    ["Decodo settings could not be loaded", "No se pudo cargar la configuración de Decodo."],
    ["A valid public HTTP URL seed is required", "Decodo necesita una URL pública y válida para consultar la página."],
    ["Decodo API rejected the scrape request", "Decodo rechazó la solicitud para consultar la página."],
    ["Decodo request failed", "No se pudo completar la consulta a Decodo."],
    ["Decodo request failed (HTTP 404)", "No se pudo completar la consulta a Decodo (HTTP 404)."],
    ["Decodo target returned HTTP 404", "La página respondió con un error (HTTP 404)."],
    ["Unexpected Decodo response (invalid JSON)", "No se pudo leer la respuesta de Decodo: el formato no era válido."],
    ["Unexpected Decodo response (missing results)", "La respuesta de Decodo no incluía resultados."],
    ["Unexpected Decodo response (missing status)", "Decodo no informó el estado de la consulta."],
    ["Unexpected Decodo response (missing text content)", "La respuesta de Decodo no incluía el texto de la página."],
    ["Unexpected Decodo response", "Decodo devolvió una respuesta inesperada que no se pudo usar."],
    ["The replacement returned no confirmed results.", "La reejecución no devolvió resultados confirmados."],
    ["Prior results changed during execution; the replacement was not applied.", "Los resultados anteriores cambiaron durante la reejecución y no se reemplazaron."],
  ])("translates %s", (raw, explanation) => {
    expect(explainActionFailure(raw, "decodo.url.v1")).toBe(explanation);
  });

  it("normalizes control characters but never echoes unknown strings, payloads, or credentials", () => {
    expect(explainActionFailure("\u0000Decodo target requires login\u202e")).toBe("La página requiere iniciar sesión para ver su contenido.");
    const generic = "La acción no pudo completarse y no hay un motivo específico registrado.";
    expect(explainActionFailure("Execution failed.")).toBe(generic);
    expect(explainActionFailure(undefined)).toBe(generic);
    expect(explainActionFailure(`Decodo target returned HTTP 404\n${"private-payload ".repeat(200)}`)).toBe(generic);
    expect(explainActionFailure("Decodo target returned HTTP 404secret", "decodo.url.v1"))
      .toBe("Decodo no pudo completar la consulta y no hay un motivo específico registrado.");
  });
});
