import { describe, expect, it } from "vitest";
import { findingSeedNodeId, SCOPED_CATALOG_IDS, type EvidenceAiNormalization, type EvidenceNormalizationJob, type EvidenceRecord, type Investigation } from "@investia/core";
import { buildExecutionQueue, explainActionFailure, formatQueueTimestamp, type QueueAction } from "../src/pages/execution-queue";

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
    expect(initial.items.map(({ targetId }) => targetId)).toEqual(["scanner"]);

    const queue = buildExecutionQueue(snapshot([
      action("queued-z", "queued", { spec: ghunt }), action("failed", "failed", { spec: decodo, failure: "Decodo target requires login" }),
      action("queued-a", "queued", { spec: decodo }), action("proposal", "proposed", { spec: gravatar }),
      action("done", "succeeded"), action("queued-m", "queued"), running,
      action("rerun-failed", "succeeded", { lastRerunFailed: true, lastRerunFailure: "The replacement returned no confirmed results." }),
    ]), ready);
    expect(queue.items.map(({ targetId, kind, label }) => [targetId, kind, label])).toEqual([
      ["scanner", "running", "En ejecución"], ["queued-z", "queued", "Siguiente"], ["queued-a", "queued", "En cola · #2"],
      ["queued-m", "queued", "En cola · #3"], ["proposal", "waiting", "Espera tu aprobación"], ["rerun-failed", "completed", "Completo"],
      ["done", "completed", "Completo"], ["rerun-failed", "failed", "Reintento fallido"], ["failed", "failed", "Falló"],
    ]);
    expect(queue.items[0]).toMatchObject({ title: "Escaneo de correo · user-scanner", target: email.value });
    expect(queue.items[1]).toMatchObject({ title: "Perfil de Google · GHunt", target: email.value });
    expect(queue.items[2]).toMatchObject({ title: "Decodo · example.test", target: "/profile" });
    expect(queue.items.slice(-2).map(({ failureExplanation }) => failureExplanation)).toEqual([
      "La reejecución no devolvió resultados confirmados.", "La página requiere iniciar sesión para ver su contenido.",
    ]);
    expect(queue).toMatchObject({ total: 9, ringMode: "spinning", counts: {
      running: 1, queued: 3, waiting: 1, completed: 2, failed: 2,
    } });
  });

  it.each([
    ["empty", []],
    ["spinning", ["claimed", "queued"]],
    ["spinning", ["claimed", "failed", "queued"]],
    ["pending", ["proposed"]],
    ["pending", ["succeeded", "queued", "failed"]],
    ["complete_with_errors", ["succeeded", "failed"]],
    ["complete", ["succeeded"]],
  ] as const)("renders ring mode %s for %j without a percentage", (ringMode, statuses) => {
    const actions = statuses.map((status, index) => action(String(index), status));
    const queue = buildExecutionQueue(snapshot(actions), ready);
    expect(queue).toMatchObject({ total: actions.length, ringMode });
    expect(queue).not.toHaveProperty("percent");
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
    expect(queue.items.filter(({ kind }) => kind === "waiting").map(({ targetId, label }) => [targetId, label])).toEqual([
      ["grandchild", "Esperando reejecución previa"], ["proposal", "Esperando reejecución previa"], ["child", "Esperando reejecución previa"],
    ]);
    expect(queue.items.filter(({ targetId }) => targetId === "ancestor")).toMatchObject([
      { attemptNumber: 2, title: "Reintento 2 de Escaneo de correo · user-scanner",
        ...(status === "claimed" ? { kind: "running", label: "Reejecutando" } : { kind: "queued", label: "En cola · #2" }) },
      { attemptNumber: 1, kind: "completed", label: "Completo" },
    ]);
    expect(queue.items.find(({ targetId }) => targetId === "unrelated")).toMatchObject({ kind: "queued", label: "Siguiente" });
    expect(queue.items.find(({ targetId }) => targetId === "completed-child")).toMatchObject({ kind: "completed" });

    const settled = actions.map((entry) => entry.id === "ancestor" ? action("ancestor", "succeeded") : entry);
    expect(buildExecutionQueue(snapshot(settled, { evidence: [evidence] }), ready).items.filter(({ kind }) => kind === "queued").map(({ targetId }) => targetId))
      .toEqual(["grandchild", "unrelated", "child"]);
  });

  it("keeps each legacy failure, including the previous failure during an active retry", () => {
    const failure = "Decodo target requires login";
    const entry = action("old-failure", "failed", { spec: decodo, failure, lastRerunFailed: true,
      lastRerunFailure: "Prior results changed during execution; the replacement was not applied." });
    expect(buildExecutionQueue(snapshot([entry]), ready)).toMatchObject({ ringMode: "complete_with_errors", items: [
      { attemptNumber: 2, kind: "failed", label: "Reintento fallido", title: "Reintento 2 de Decodo · example.test",
        failureExplanation: "Los resultados anteriores cambiaron durante la reejecución y no se reemplazaron." },
      { attemptNumber: 1, kind: "failed", label: "Falló", failureExplanation: "La página requiere iniciar sesión para ver su contenido." },
    ] });
    const claimed = action(entry.id, "claimed", { spec: decodo, failure, completedAt: at,
      rerun: { previousStatus: "failed", fingerprint: "0".repeat(64) } });
    expect(buildExecutionQueue(snapshot([claimed]), ready).items).toMatchObject([
      { attemptNumber: 2, kind: "running", title: "Reintento 2 de Decodo · example.test" },
      { attemptNumber: 1, kind: "failed", executedAt: at, failureExplanation: "La página requiere iniciar sesión para ver su contenido." },
    ]);
  });

  it("keeps all terminal audit attempts newest first with distinct failures while another retry waits", () => {
    const entry = action("scrape", "queued", { spec: decodo, rerun, lastRerunFailed: true, lastRerunFailure: "Decodo request timed out" });
    const terminal = { at, actor: "system" as const, actionId: entry.id };
    const audit = [
      { ...terminal, id: "1", kind: "action_succeeded", reason: "Completed" },
      { ...terminal, id: "2", kind: "action_failed", reason: "Failed", failure: "Decodo target requires login" },
      { ...terminal, id: "3", kind: "action_rerun_succeeded", reason: "Completed" },
      { ...terminal, id: "4", kind: "action_failed", reason: "The replacement returned no confirmed results." },
      { ...terminal, id: "5", kind: "action_failed", reason: "Failed", failure: "Decodo returned empty page content" },
    ] as const;
    // The base branch does not yet declare the composed rerun success audit kind.
    const queue = buildExecutionQueue(snapshot([entry], { audit: audit as unknown as Investigation["audit"], paused: true }), ready);
    expect(queue.items).toMatchObject([
      { attemptNumber: 6, kind: "waiting", title: "Reintento 6 de Decodo · example.test", label: "En cola · pausada" },
      { attemptNumber: 3, kind: "completed", title: "Reintento 3 de Decodo · example.test", label: "Completo · intento 3", executedAt: at },
      { attemptNumber: 1, kind: "completed", title: "Decodo · example.test", label: "Completo", executedAt: at },
      { attemptNumber: 5, kind: "failed", label: "Reintento fallido", failureExplanation: "Decodo no encontró contenido para mostrar en la página.", executedAt: at },
      { attemptNumber: 4, kind: "failed", label: "Reintento fallido", failureExplanation: "La reejecución no devolvió resultados confirmados.", executedAt: at },
      { attemptNumber: 2, kind: "failed", label: "Reintento fallido", failureExplanation: "La página requiere iniciar sesión para ver su contenido.", executedAt: at },
    ]);
    expect(queue.items.every((item) => item.targetKind === "action" && item.targetId === entry.id && item.selectable)).toBe(true);
    expect(new Set(queue.items.map(({ id }) => id)).size).toBe(6);
  });

  it("uses current action fields only for the matching terminal failure when audit details are absent", () => {
    const entry = action("scrape", "failed", { spec: decodo, failure: "Decodo target requires login",
      lastRerunFailed: true, lastRerunFailure: "Decodo request timed out" });
    const audit = [1, 2, 3].map((attempt) => ({ id: String(attempt), actionId: entry.id, at,
      actor: "system" as const, kind: "action_failed" as const, reason: "Unrecognized provider response" }));
    expect(buildExecutionQueue(snapshot([entry], { audit }), ready).items.map(({ failureExplanation }) => failureExplanation)).toEqual([
      "Decodo tardó demasiado en responder y se agotó el tiempo de espera.",
      "Decodo no pudo completar la consulta y no hay un motivo específico registrado.",
      "La página requiere iniciar sesión para ver su contenido.",
    ]);
  });

  it.each([
    ["action_proposed", "User Scanner found a GRAVATAR profile", "Perfil de Gravatar"],
    ["action_queued", "Catalog queued a FACECHECK search for the photo GHunt found", "Búsqueda facial · FaceCheck"],
    ["action_queued", "Catalog queued a DECODO scrape for the accepted FaceCheck result URL", "Decodo"],
    ["action_queued", "Catalog queued a MAIGRET search", "Búsqueda de usuario · Maigret"],
    ["action_queued", "Catalog queued a GHUNT lookup", "Perfil de Google · GHunt"],
    ["action_queued", "Catalog queued a USER-SCANNER check", "Escaneo de correo · user-scanner"],
    ["action_queued", "Catalog queued a USER SCANNER check", "Escaneo de correo · user-scanner"],
    ["action_proposed", "Unrecognized tool", "Acción histórica"],
  ] as const)("retains pruned attempts with the historical title inferred from %s: %s", (kind, reason, title) => {
    const event = { at, actor: "system", actionId: "pruned" } as const;
    const audit = [
      { ...event, id: "source", kind, reason },
      { ...event, id: "first", kind: "action_succeeded", reason: "Finished" },
      { ...event, id: "second", kind: "action_failed", reason: "Prior results changed during execution; the replacement was not applied." },
      { ...event, id: "third", kind: "action_rerun_succeeded", reason: "Finished" },
      { ...event, id: "fourth", kind: "action_failed", reason: "The replacement returned no confirmed results." },
      { ...event, id: "fifth", kind: "action_failed", reason: "Decodo request timed out", failure: "Unknown provider detail" },
      { ...event, id: "sixth", kind: "action_failed", reason: "Failed", failure: "Decodo target requires login" },
    ] as unknown as Investigation["audit"];
    const before = buildExecutionQueue(snapshot([action(event.actionId, "failed")], { audit }), ready);
    const after = buildExecutionQueue(snapshot([], { audit }), ready);
    expect(after.counts).toEqual(before.counts);
    expect(after).toMatchObject({ total: 6, counts: { completed: 2, failed: 4, running: 0, queued: 0, waiting: 0 }, items: [
      { attemptNumber: 3, kind: "completed", title: `Reintento 3 de ${title}`, label: "Completo · intento 3" },
      { attemptNumber: 1, kind: "completed", title, label: "Completo" },
      { attemptNumber: 6, kind: "failed", title: `Reintento 6 de ${title}`, label: "Reintento fallido",
        failureExplanation: "La página requiere iniciar sesión para ver su contenido." },
      { attemptNumber: 5, kind: "failed", title: `Reintento 5 de ${title}`, label: "Reintento fallido",
        failureExplanation: title === "Decodo" ? "Decodo no pudo completar la consulta y no hay un motivo específico registrado."
          : "La acción no pudo completarse y no hay un motivo específico registrado." },
      { attemptNumber: 4, kind: "failed", title: `Reintento 4 de ${title}`, label: "Reintento fallido",
        failureExplanation: "La reejecución no devolvió resultados confirmados." },
      { attemptNumber: 2, kind: "failed", title: `Reintento 2 de ${title}`, label: "Reintento fallido",
        failureExplanation: "Los resultados anteriores cambiaron durante la reejecución y no se reemplazaron." },
    ] });
    for (const item of after.items) expect(item).toMatchObject({
      id: `action-pruned:pruned:attempt:${item.attemptNumber}`, targetKind: "action", targetId: "pruned",
      selectable: false, target: "Acción reemplazada", executedAt: at,
    });
  });

  it.each([["succeeded", "action_succeeded", "completed"], ["failed", "action_failed", "failed"]] as const)(
    "sorts mixed %s history by execution time, then reverse insertion order", (status, eventKind, kind) => {
      const earlier = "2025-03-16T11:00:00.000Z";
      const later = "2025-03-16T13:00:00.000Z";
      const actions = [action("current", status, { completedAt: earlier }), action("legacy", status, { completedAt: earlier }),
        action("invalid", status, { completedAt: "invalid" }), action("missing", status)];
      const recordedOrder = [["current", at], ["old-a", earlier], ["old-b", earlier], ["old-a", earlier], ["current", at]] as const;
      const audit: Investigation["audit"] = recordedOrder.map(([actionId, executedAt], index) => ({
        id: String(index), actionId, at: executedAt, actor: "system", kind: eventKind, reason: "Finished",
      }));
      const job = (id: string, timestamps: Partial<EvidenceNormalizationJob> = {}): EvidenceNormalizationJob => ({
        id, evidenceId: id, status, attemptNumber: 1, createdAt: earlier, investigationId: "case-1", ...timestamps,
      });
      const queue = buildExecutionQueue(snapshot(actions, { audit }), { ...ready,
        normalizationJobs: [job("finished", { completedAt: later, startedAt: earlier }), job("started", { startedAt: at }), job("created")],
      });
      expect(queue.counts[kind]).toBe(11);
      expect(queue.items.filter((item) => item.kind === kind).map(({ id, executedAt }) => [id, executedAt])).toEqual([
        ["norm:finished", later], ["norm:started", at], ["action:current:attempt:2", at], ["action:current:attempt:1", at],
        ["norm:created", earlier], ["action-pruned:old-a:attempt:2", earlier], ["action-pruned:old-b:attempt:1", earlier],
        ["action-pruned:old-a:attempt:1", earlier], ["action:legacy:attempt:1", earlier],
        ["action:missing:attempt:1", undefined], ["action:invalid:attempt:1", "invalid"],
      ]);
    },
  );

  it("identifies a pruned manual Decodo request from its audit provenance", () => {
    const audit: Investigation["audit"] = [
      { id: "queued", actionId: "scrape", evidenceId: "match", at, actor: "operator",
        kind: "action_queued", reason: "Verified FaceCheck match; fetch the linked page" },
      { id: "done", actionId: "scrape", at, actor: "system",
        kind: "action_succeeded", reason: "Completed" },
    ];
    expect(buildExecutionQueue(snapshot([], { audit }), ready).items).toMatchObject([
      { title: "Decodo", target: "Acción reemplazada", selectable: false, kind: "completed" },
    ]);
  });

  it.each([["succeeded", "action_succeeded"], ["failed", "action_failed"]] as const)(
    "breaks %s ties by reverse audit order across actions", (status, kind) => {
      const audit: Investigation["audit"] = ["b", "a"].map((actionId) => ({
        id: `event-${actionId}`, actionId, at, actor: "system", kind, reason: "Finished",
      }));
      const queue = buildExecutionQueue(snapshot([action("a", status), action("b", status)], { audit }), ready);
      expect(queue.items.map(({ targetId }) => targetId)).toEqual(["a", "b"]);
    },
  );

  it("omits impossible ISO calendar dates in formatQueueTimestamp", () => {
    expect(formatQueueTimestamp("2026-02-30T12:00:00.000Z", new Date(2026, 2, 2))).toBeUndefined();
    expect(formatQueueTimestamp("2026-04-31T08:00:00.000Z", new Date(2026, 4, 1))).toBeUndefined();
  });

  it("groups normalization jobs in FIFO order with separate attempts, including legacy and pruned evidence", () => {
    const seed = decodo.seed;
    const page: EvidenceRecord = { id: "page", actionId: "scrape", seed, provider: "Decodo", status: "registered", sourceId: "decodo:url", recordedAt: at,
      finding: { target: seed, upstreamStatus: "Found", url: seed.value, category: "Web page", reason: "Fixture", media: {}, extra: {} } };
    const metadataPage = { ...page, id: "metadata", finding: undefined, metadata: { pageUrl: "https://other.example.test/about" } };
    const normalized: EvidenceAiNormalization = { evidenceId: page.id, model: "fixture", generatedAt: at, sourceContentHash: "a".repeat(64),
      data: { summary: "Fixture", handles: [], rolesOrOccupations: [], organizations: [], education: [], locationsMentioned: [],
        topicsOrInterests: [], notableFacts: [], relatedUrls: [], limitations: [] } };
    const job = (id: string, evidenceId: string, status: EvidenceNormalizationJob["status"], attemptNumber = 1): EvidenceNormalizationJob =>
      ({ id, evidenceId, status, attemptNumber, createdAt: at, investigationId: "case-1" });
    const queue = buildExecutionQueue(snapshot([action("next", "queued")], { evidence: [page, metadataPage] }), { ...ready,
      normalizations: { page: normalized, metadata: { ...normalized, evidenceId: metadataPage.id } },
      normalizationJobs: [job("already-done", metadataPage.id, "succeeded"), job("running", page.id, "running", 2),
        job("next-norm", metadataPage.id, "queued", 2), job("second-norm", "old-page", "queued", 2),
        { ...job("failed", "old-page", "failed"), errorCode: "EVIDENCE_UNAVAILABLE" }],
    });
    expect(queue).toMatchObject({ ringMode: "spinning", counts: { running: 1, queued: 3, completed: 2, failed: 1 }, items: [
      { targetKind: "evidence", targetId: page.id, attemptNumber: 2, title: "Reintento 2 de Normalización con IA · example.test", target: "/profile", kind: "running", label: "Reintentando" },
      { targetKind: "action", kind: "queued", label: "Siguiente" },
      { targetId: metadataPage.id, target: "/about", title: "Reintento 2 de Normalización con IA · other.example.test", kind: "queued", label: "Siguiente" },
      { targetId: "old-page", kind: "queued", label: "En cola · #2", selectable: false },
      { targetId: metadataPage.id, attemptNumber: 1, kind: "completed", label: "Completo", executedAt: at },
      { id: "norm-legacy:page:attempt:1", attemptNumber: 1, kind: "completed", title: "Normalización con IA · example.test", label: "Completo", selectable: true, executedAt: normalized.generatedAt },
      { targetId: "old-page", kind: "failed", title: "Normalización con IA", target: "Página reemplazada", selectable: false,
        label: "Falló", failureExplanation: "La página guardada ya no está disponible para normalizar." },
    ] });
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
    expect(noMatch.items.map(({ targetId, label }) => [targetId, label])).toEqual([
      ["other", "Siguiente"], ["legacy", "Espera tu aprobación"], ["scanner", "Completo"],
    ]);
    const linked = buildExecutionQueue(snapshot(actions, { evidence: [match] }), ready);
    expect(linked.items.map(({ targetId, label }) => [targetId, label])).toEqual([
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

  it("keeps the original Decodo failure explanation during a retry of a legacy audited action", () => {
    const entry = action("scrape", "claimed", {
      spec: decodo,
      failure: "Decodo target requires login",
      rerun: { previousStatus: "failed", fingerprint: "0".repeat(64) },
    });
    const queue = buildExecutionQueue(snapshot([entry], {
      audit: [{
        id: "original-failure", actionId: entry.id, at, actor: "system",
        kind: "action_failed",
        reason: "Execution failed; the terminal failure was retained and automatic retries are disabled.",
      }],
    }), ready);

    expect(queue.items).toMatchObject([
      { attemptNumber: 2, kind: "running", title: "Reintento 2 de Decodo · example.test" },
      { attemptNumber: 1, kind: "failed", failureExplanation: "La página requiere iniciar sesión para ver su contenido." },
    ]);
  });

  it("keeps the legacy success when its first queued retry outlives pruned evidence", () => {
    const retry: EvidenceNormalizationJob = {
      id: "retry", evidenceId: "old-page", investigationId: "case-1",
      attemptNumber: 2, status: "failed", errorCode: "EVIDENCE_UNAVAILABLE", createdAt: at,
    };
    const queue = buildExecutionQueue(snapshot([]), {
      ...ready, normalizations: {}, normalizationJobs: [retry],
    });

    expect(queue.items).toMatchObject([
      { attemptNumber: 1, kind: "completed", target: "Página reemplazada", selectable: false },
      { attemptNumber: 2, kind: "failed", target: "Página reemplazada", selectable: false },
    ]);
  });
});

describe("local queue timestamps", () => {
  const now = new Date(2026, 10, 27, 18);

  it.each([
    [new Date(2026, 10, 27, 4, 5), "04:05"],
    [new Date(2026, 10, 26, 12, 14), "26/11 12:14"],
    [new Date(2025, 2, 6, 12, 14), "06/03/2025 12:14"],
  ] as const)("formats the execution date %s by its local calendar day and year", (date, label) => {
    expect(formatQueueTimestamp(date.toISOString(), now)).toBe(label);
  });

  it.each([undefined, "", "invalid"])("omits a missing or invalid timestamp (%s)", (timestamp) => {
    expect(formatQueueTimestamp(timestamp, now)).toBeUndefined();
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
