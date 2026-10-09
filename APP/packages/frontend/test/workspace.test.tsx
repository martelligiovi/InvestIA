import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EvidenceRecord, GitHubCatalogAction, Investigation, ValidationDecision } from "@investia/core";
import App from "../src/App";
import { WorkspacePage } from "../src/pages/WorkspacePage";

type CapturedCall = { input: RequestInfo | URL; init?: RequestInit };
type RouteHandler = (call: CapturedCall) => Promise<Response>;
const createdAt = "2025-03-16T12:00:00.000Z";
const email = "ana@example.test";
const seed = { kind: "email" as const, value: email };
const approval = { at: createdAt, reason: "Aprobación registrada", operator: "local-operator" as const };

function action(status: GitHubCatalogAction["status"] = "proposed"): GitHubCatalogAction {
  return {
    id: "action-1",
    spec: { catalogId: "github.email-registration.v1", provider: "github", seed },
    status,
    proposedAt: createdAt,
    proposalReason: "Comprobar el registro público",
    ...(status === "proposed" ? {} : { approval }),
    ...(status === "claimed" ? { claim: { id: "claim-1", claimedAt: createdAt } } : {}),
    ...(status === "succeeded" || status === "failed" ? { completedAt: createdAt } : {}),
    ...(status === "failed" ? { failure: "Execution failed." } : {}),
  };
}

function evidence(id = "evidence-1", actionId = "action-1", value = email): EvidenceRecord {
  return {
    id,
    actionId,
    seed: { kind: "email", value },
    provider: "github",
    status: "registered",
    sourceId: "github-adapter",
    recordedAt: createdAt,
  };
}

function snapshot(overrides: Partial<Investigation> = {}): Investigation {
  return {
    id: "case-1",
    name: "Caso de prueba",
    revision: 1,
    createdAt,
    updatedAt: createdAt,
    paused: false,
    emailSeeds: [seed],
    actions: [],
    evidence: [],
    validations: [],
    audit: [],
    ...overrides,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function installFetch(handler: RouteHandler) {
  const calls: CapturedCall[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { input, init };
    calls.push(call);
    return handler(call);
  });
  vi.stubGlobal("fetch", fetcher);
  return { calls, fetcher };
}

function pathOf(call: CapturedCall): string {
  return String(call.input);
}

function bodyOf(call: CapturedCall): unknown {
  return call.init?.body === undefined ? undefined : JSON.parse(String(call.init.body));
}

function reportResponse(body: string): Response {
  return new Response(body, { headers: { "content-type": "text/markdown; charset=utf-8" } });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function openCaseControls(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByText("Controles del expediente"));
}

describe("espacio de investigación factual", () => {
  it("muestra avance automático sin controles de propuesta, aprobación ni despacho", async () => {
    const queued = { ...action("queued"), approval: undefined, queuedByCatalog: true as const };
    const { calls } = installFetch(async () => json(snapshot({ advancementMode: "automatic", actions: [queued] })));
    const user = userEvent.setup();
    render(<WorkspacePage id="case-1" />);
    await screen.findByRole("heading", { name: "Caso de prueba" });
    expect(document.querySelector(".workspace-state-tag")).toHaveTextContent("Esperando autorización");
    expect(screen.getByRole("status")).toHaveTextContent(/cola bloqueada/i);
    await openCaseControls(user);
    expect(screen.getByText(/avance automático/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /ejecutar siguiente/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/motivo para proponer/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /proponer comprobación/i })).not.toBeInTheDocument();
    expect(calls.every((call) => call.init?.method === undefined)).toBe(true);
  });
  it("prioriza grafo y detalle sin barras operativas, con controles secundarios cerrados", async () => {
    const { calls } = installFetch(async () => json(snapshot()));
    const user = userEvent.setup();
    render(<WorkspacePage id="case-1" />);
    await screen.findByRole("heading", { name: "Caso de prueba" });
    expect(document.querySelector(".workspace-meta-bar, .workspace-commandbar, .workspace-command-bar")).toBeNull();
    const detail = screen.getByRole("tabpanel", { name: "Detalle" });
    expect(within(detail).queryByRole("button", { name: /proponer comprobación/i })).not.toBeInTheDocument();
    const controls = within(detail).getByText("Controles del expediente").closest("details")!;
    expect(controls).not.toHaveAttribute("open");
    expect(within(controls).getByRole("button", { name: /ejecutar siguiente/i })).not.toBeVisible();
    await openCaseControls(user);
    expect(within(controls).getByRole("button", { name: /ejecutar siguiente acción en cola/i })).toBeDisabled();
    expect(within(controls).getByRole("button", { name: /actualizar expediente/i })).toBeEnabled();
    expect(calls).toHaveLength(1);
  });
  it("carga, permite reintentar errores y distingue un expediente inexistente", async () => {
    let attempts = 0;
    installFetch(async () => {
      attempts += 1;
      return attempts === 1
        ? json({ error: "UNAVAILABLE", message: "sin conexión" }, 503)
        : json(snapshot());
    });
    const user = userEvent.setup();
    render(<WorkspacePage id="case-1" />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/sin conexión/i);
    await user.click(screen.getByRole("button", { name: /intentar de nuevo/i }));
    expect(await screen.findByRole("heading", { name: "Caso de prueba" })).toBeInTheDocument();

    cleanup();
    installFetch(async () => json({ error: "NOT_FOUND", message: "Investigation not found" }, 404));
    render(<WorkspacePage id="missing" />);
    expect(await screen.findByText(/no existe/i)).toBeInTheDocument();
  });

  it("dibuja solo relaciones respaldadas por IDs y selecciona el mismo nodo desde la lista accesible", async () => {
    const secondAction = { ...action("succeeded"), id: "action-2", spec: { ...action("succeeded").spec, seed: { kind: "email" as const, value: "otra@example.test" } } };
    const secondEvidence = { ...evidence(), id: "evidence-2", actionId: "missing-action", seed: { kind: "email" as const, value: "sin-semilla@example.test" } };
    installFetch(async () => json(snapshot({
      emailSeeds: [seed, { kind: "email", value: "otra@example.test" }],
      actions: [action("succeeded"), secondAction],
      evidence: [evidence(), secondEvidence],
    })));
    const user = userEvent.setup();
    render(<WorkspacePage id="case-1" />);

    const graph = await screen.findByRole("group", { name: /grafo factual/i });
    expect(graph.querySelectorAll("[data-edge]")).toHaveLength(4);
    expect(graph.querySelector('[data-edge="action-result:action-2"]')).not.toBeNull();
    expect(graph.querySelector('[data-edge="action-evidence:evidence-2"]')).toBeNull();
    expect(screen.getAllByRole("button", { name: /Semilla: ana@example\.test/i }).length).toBeGreaterThan(0);
    const nodeList = screen.getByText(/Lista accesible de nodos/i).closest("details")!;
    await user.click(nodeList.querySelector("summary")!);
    const actionNode = within(nodeList).getByRole("button", { name: /Acción: action-1/i });
    actionNode.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByText(/Estado de la acción/i)).toBeInTheDocument();
    expect(screen.getAllByText("Completada").length).toBeGreaterThan(0);
    expect(within(screen.getByRole("tabpanel", { name: "Detalle" })).getByText(/Comprobación de registro en GitHub/i)).toBeInTheDocument();
  });

  it("refresca explícitamente sin mutar y ofrece zoom, ajuste y pestañas móviles usables", async () => {
    let current = snapshot();
    const { calls } = installFetch(async (call) => {
      if (pathOf(call) !== "/investigations/case-1" || call.init?.method !== undefined) throw new Error(`Solicitud inesperada: ${pathOf(call)}`);
      return json(current);
    });
    const user = userEvent.setup();
    render(<WorkspacePage id="case-1" />);
    const graph = await screen.findByRole("group", { name: /grafo factual/i });
    await user.click(screen.getByRole("button", { name: /acercar grafo/i }));
    expect(graph.querySelector("g[transform]")).toHaveAttribute("transform", "translate(0 0) scale(1.25)");
    await user.click(screen.getByRole("button", { name: /ajustar grafo/i }));
    expect(graph.querySelector("g[transform]")).toHaveAttribute("transform", "translate(0 0) scale(1)");
    await user.click(screen.getByRole("tab", { name: "Detalle" }));
    expect(document.querySelector(".workspace-layout")).toHaveAttribute("data-mobile-panel", "detail");

    await openCaseControls(user);
    current = { ...current, revision: 2, name: "Versión actualizada" };
    await user.click(screen.getByRole("button", { name: /actualizar expediente/i }));
    expect(await screen.findByRole("heading", { name: "Versión actualizada" })).toBeInTheDocument();
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.init?.method === undefined)).toBe(true);
  });

  it("muestra un fallo terminal sin ofrecer reejecución", async () => {
    const { calls } = installFetch(async (call) => {
      if (pathOf(call) === "/investigations/case-1") return json(snapshot({ actions: [action("failed")] }));
      throw new Error(`Ruta inesperada: ${pathOf(call)}`);
    });
    const user = userEvent.setup();
    render(<WorkspacePage id="case-1" />);
    const nodeList = await screen.findByText(/Lista accesible de nodos/i).then((summary) => summary.closest("details")!);
    await user.click(nodeList.querySelector("summary")!);
    await user.click(within(nodeList).getByRole("button", { name: /Acción: action-1/i }));
    expect(screen.getAllByText("Fallida").length).toBeGreaterThan(0);
    expect(screen.getByText("Execution failed.")).toBeInTheDocument();
    await user.click(within(nodeList).getByRole("button", { name: /^Resultado:/i }));
    expect(screen.getByRole("heading", { name: "Error de ejecución" })).toBeInTheDocument();
    expect(screen.getByText("Execution failed.")).toBeInTheDocument();
    expect(screen.queryByLabelText(/motivo de validación/i)).not.toBeInTheDocument();
    await openCaseControls(user);
    expect(screen.getByRole("button", { name: /ejecutar siguiente acción en cola/i })).toBeDisabled();
    expect(calls.some((call) => pathOf(call).endsWith("/actions/run"))).toBe(false);
  });

  it("no ejecuta al cargar, proponer, aprobar ni autorizar; el despacho exige todos los gates y clic explícito", async () => {
    let current = snapshot({ paused: true, authorization: { granted: true, at: createdAt, reason: "Permiso", operator: "local-operator" }, actions: [action("queued")] });
    const { calls } = installFetch(async (call) => {
      const path = pathOf(call);
      if (path.endsWith("/case-1")) return json(current);
      if (path.endsWith("/resume")) {
        current = { ...current, paused: false, revision: current.revision + 1 };
        return json(current);
      }
      if (path.endsWith("/actions/run")) {
        current = { ...current, actions: [action("claimed")], revision: current.revision + 1 };
        return json({ action: action("claimed") });
      }
      throw new Error(`Ruta inesperada: ${path}`);
    });
    const user = userEvent.setup();
    render(<WorkspacePage id="case-1" />);
    await openCaseControls(user);
    const run = await screen.findByRole("button", { name: /ejecutar siguiente acción en cola/i });
    expect(run).toBeDisabled();
    expect(calls.some((call) => pathOf(call).endsWith("/actions/run"))).toBe(false);

    await user.click(screen.getByText("Reanudar", { selector: "summary" }));
    await user.type(screen.getByLabelText(/motivo para reanudar/i), "Revisión terminada");
    await user.click(screen.getByRole("button", { name: /reanudar expediente/i }));
    await waitFor(() => expect(run).toBeEnabled());
    expect(calls.some((call) => pathOf(call).endsWith("/actions/run"))).toBe(false);

    await user.click(run);
    await waitFor(() => expect(calls.filter((call) => pathOf(call).endsWith("/actions/run"))).toHaveLength(1));
    await waitFor(() => expect(screen.getByText(/efecto externo incierto/i)).toBeInTheDocument());
    expect(calls.filter((call) => pathOf(call) === "/investigations/case-1")).toHaveLength(3);
  });

  it.each(["manual", undefined] as const)("avance %s permite run-next del caso sin aprobación por nodo", async (mode) => {
    const queued = { ...action("queued"), approval: undefined, queuedByCatalog: true as const };
    let current = snapshot({ advancementMode: mode, authorization: { granted: true, at: createdAt, reason: "Permiso del caso", operator: "local-operator" }, actions: [queued] });
    const { calls } = installFetch(async (call) => {
      if (pathOf(call) === "/investigations/case-1") return json(current);
      if (pathOf(call).endsWith("/actions/run")) {
        current = { ...current, revision: current.revision + 1, actions: [{ ...queued, status: "succeeded" }] };
        return json({ action: current.actions[0] });
      }
      throw new Error(`Ruta inesperada: ${pathOf(call)}`);
    });
    const user = userEvent.setup();
    render(<WorkspacePage id="case-1" />);
    await openCaseControls(user);
    const run = screen.getByRole("button", { name: /ejecutar siguiente acción en cola/i });
    expect(run).toBeEnabled();
    expect(calls.some((call) => call.init?.method === "POST")).toBe(false);
    await user.click(run);
    await waitFor(() => expect(run).toBeDisabled());
    expect(calls.filter((call) => pathOf(call).endsWith("/actions/run"))).toHaveLength(1);
    expect(calls.some((call) => /approval|proposals/.test(pathOf(call)))).toBe(false);
  });

  it("conserva propuestas históricas sin controles de aprobación y otorga/revoca autorización aparte", async () => {
    let current = snapshot({ actions: [action()] });
    const { calls } = installFetch(async (call) => {
      const path = pathOf(call);
      if (path === "/investigations/case-1") return json(current);
      if (path.endsWith("/authorization")) {
        const granted = (bodyOf(call) as { granted: boolean }).granted;
        current = { ...current, revision: current.revision + 1, authorization: { granted, at: createdAt, reason: "Permiso de prueba", operator: "local-operator" } };
        return json(current);
      }
      throw new Error(`Ruta inesperada: ${path}`);
    });
    const user = userEvent.setup();
    render(<WorkspacePage id="case-1" />);
    const nodeList = await screen.findByText(/Lista accesible de nodos/i).then((summary) => summary.closest("details")!);
    await user.click(nodeList.querySelector("summary")!);
    await user.click(within(nodeList).getByRole("button", { name: /Acción: action-1/i }));
    expect(screen.queryByLabelText(/motivo de aprobación/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /aprobar acción/i })).not.toBeInTheDocument();
    expect(screen.getByText(/Propuesta histórica conservada/i)).toBeInTheDocument();
    expect(calls.some((call) => pathOf(call).endsWith("/actions/run"))).toBe(false);

    await openCaseControls(user);
    await user.type(screen.getByLabelText(/motivo de autorización/i), "Permiso expreso");
    await user.click(screen.getByRole("button", { name: /otorgar autorización/i }));
    await waitFor(() => expect(screen.getByText(/Autorización otorgada/i)).toBeInTheDocument());
    await user.clear(screen.getByLabelText(/motivo de autorización/i));
    await user.type(screen.getByLabelText(/motivo de autorización/i), "Retiro del permiso");
    await user.click(screen.getByRole("button", { name: /revocar autorización/i }));
    expect(calls.filter((call) => pathOf(call).endsWith("/authorization")).map(bodyOf)).toEqual([
      { granted: true, reason: "Permiso expreso" },
      { granted: false, reason: "Retiro del permiso" },
    ]);
  });

  it("valida evidencia con historial/procedencia y presenta informe como texto inocuo, también pausada", async () => {
    const prior: ValidationDecision = { id: "validation-0", evidenceId: "evidence-1", status: "inconclusive", reason: "Pendiente", at: createdAt, operator: "local-operator" };
    let current = snapshot({ paused: true, actions: [action("succeeded")], evidence: [evidence()], validations: [prior] });
    const report = "# Informe\n\n<script>window.ejecutado = true</script>";
    const { calls } = installFetch(async (call) => {
      const path = pathOf(call);
      if (path === "/investigations/case-1") return json(current);
      if (path.endsWith("/validation")) {
        const body = bodyOf(call) as { status: ValidationDecision["status"]; reason: string };
        const decision: ValidationDecision = { id: "validation-1", evidenceId: "evidence-1", status: body.status, reason: body.reason, at: createdAt, operator: "local-operator" };
        current = { ...current, revision: current.revision + 1, validations: [...current.validations, decision] };
        return json(current, 201);
      }
      if (path.endsWith("/report")) return reportResponse(report);
      throw new Error(`Ruta inesperada: ${path}`);
    });
    const user = userEvent.setup();
    render(<WorkspacePage id="case-1" />);
    const nodeList = await screen.findByText(/Lista accesible de nodos/i).then((summary) => summary.closest("details")!);
    await user.click(nodeList.querySelector("summary")!);
    await user.click(within(nodeList).getByRole("button", { name: /Evidencia: evidence-1/i }));
    expect(screen.getByText("github-adapter")).toBeInTheDocument();
    expect(screen.getAllByText("Registrado").length).toBeGreaterThan(0);
    expect(screen.getByText(/no confirma identidad/i)).toBeInTheDocument();
    expect(screen.getAllByText("Inconclusa").length).toBeGreaterThan(0);
    await user.type(screen.getByLabelText(/motivo de validación/i), "La fuente coincide");
    await user.click(screen.getByRole("button", { name: /aceptar observación/i }));
    expect(await screen.findByText(/La fuente coincide/)).toBeInTheDocument();
    expect(screen.getAllByText("Aceptada").length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: /obtener informe/i }));
    const preview = await screen.findByLabelText(/vista previa del informe/i);
    expect(preview.tagName).toBe("PRE");
    expect(preview).toHaveTextContent("<script>window.ejecutado = true</script>");
    expect(preview.querySelector("script")).toBeNull();
    await user.click(screen.getByText("Informe Markdown · vista previa y descarga"));
    expect(preview).not.toBeVisible();
    await user.click(screen.getByText("Informe Markdown · vista previa y descarga"));
    expect(preview).toBeVisible();
    expect(calls.some((call) => pathOf(call).endsWith("/pause"))).toBe(false);
    expect(calls.some((call) => pathOf(call).endsWith("/report"))).toBe(true);
  });

  it("reinicia el estado de ruta y descarta un informe tardío al cambiar de expediente", async () => {
    const delayedReport = deferred<Response>();
    const { calls } = installFetch(async (call) => {
      if (pathOf(call) === "/investigations/case-a") return json(snapshot({ id: "case-a", name: "Expediente A" }));
      if (pathOf(call) === "/investigations/case-a/report") return delayedReport.promise;
      if (pathOf(call) === "/investigations/case-b") return json(snapshot({ id: "case-b", name: "Expediente B" }));
      throw new Error(`Ruta inesperada: ${pathOf(call)}`);
    });
    const user = userEvent.setup();
    window.history.replaceState(null, "", "/#/investigaciones/case-a");
    render(<App />);

    await screen.findByRole("heading", { name: "Expediente A" });
    await user.click(screen.getByRole("button", { name: /obtener informe/i }));
    await waitFor(() => expect(calls.some((call) => pathOf(call) === "/investigations/case-a/report")).toBe(true));

    window.history.replaceState(null, "", "/#/investigaciones/case-b");
    fireEvent(window, new HashChangeEvent("hashchange"));
    expect(await screen.findByRole("heading", { name: "Expediente B" })).toBeInTheDocument();
    expect(screen.queryByLabelText(/motivo para proponer/i)).not.toBeInTheDocument();

    delayedReport.resolve(reportResponse("# Informe del expediente A"));
    await waitFor(() => expect(screen.queryByLabelText(/vista previa del informe/i)).not.toBeInTheDocument());
    expect(screen.queryByRole("link", { name: /descargar markdown/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    window.history.replaceState(null, "", "/");
  });

  it("ignora la respuesta de carga tardía de una ruta anterior", async () => {
    const delayedA = deferred<Response>();
    installFetch(async (call) => {
      if (pathOf(call) === "/investigations/case-a") return delayedA.promise;
      if (pathOf(call) === "/investigations/case-b") return json(snapshot({ id: "case-b", name: "Expediente B" }));
      throw new Error(`Ruta inesperada: ${pathOf(call)}`);
    });
    window.history.replaceState(null, "", "/#/investigaciones/case-a");
    render(<App />);

    window.history.replaceState(null, "", "/#/investigaciones/case-b");
    fireEvent(window, new HashChangeEvent("hashchange"));
    expect(await screen.findByRole("heading", { name: "Expediente B" })).toBeInTheDocument();
    delayedA.resolve(json(snapshot({ id: "case-a", name: "Expediente A" })));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Expediente B" })).toBeInTheDocument());
    expect(screen.queryByRole("heading", { name: "Expediente A" })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    window.history.replaceState(null, "", "/");
  });

  it("invalida el informe al cambiar la revisión por actualización o mutación", async () => {
    let current = snapshot();
    const report = "# Informe de revisión";
    installFetch(async (call) => {
      const path = pathOf(call);
      if (path === "/investigations/case-1") return json(current);
      if (path.endsWith("/report")) return reportResponse(report);
      if (path.endsWith("/authorization")) {
        current = { ...current, revision: current.revision + 1, authorization: { granted: true, at: createdAt, reason: "Permiso", operator: "local-operator" } };
        return json(current);
      }
      throw new Error(`Ruta inesperada: ${path}`);
    });
    const user = userEvent.setup();
    render(<WorkspacePage id="case-1" />);
    await user.click(await screen.findByRole("button", { name: /obtener informe/i }));
    expect(await screen.findByLabelText(/vista previa del informe/i)).toHaveTextContent(report);

    await openCaseControls(user);
    current = { ...current, revision: current.revision + 1, name: "Revisión nueva" };
    await user.click(screen.getByRole("button", { name: /actualizar expediente/i }));
    await waitFor(() => expect(screen.queryByLabelText(/vista previa del informe/i)).not.toBeInTheDocument());
    expect(screen.queryByRole("link", { name: /descargar markdown/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /obtener informe/i }));
    expect(await screen.findByLabelText(/vista previa del informe/i)).toBeInTheDocument();
    await user.type(screen.getByLabelText(/motivo de autorización/i), "Permiso expreso");
    await user.click(screen.getByRole("button", { name: /otorgar autorización/i }));
    await waitFor(() => expect(screen.queryByLabelText(/vista previa del informe/i)).not.toBeInTheDocument());
    expect(screen.queryByRole("link", { name: /descargar markdown/i })).not.toBeInTheDocument();
  });

  it("reinicia motivos de validación entre observaciones y no solicita motivos entre acciones", async () => {
    const current = snapshot({
      emailSeeds: [seed, { kind: "email", value: "otra@example.test" }],
      actions: [action(), { ...action(), id: "action-2" }],
      evidence: [evidence(), evidence("evidence-2", "action-2", "otra@example.test")],
    });
    installFetch(async (call) => pathOf(call) === "/investigations/case-1" ? json(current) : (() => { throw new Error(`Ruta inesperada: ${pathOf(call)}`); })());
    const user = userEvent.setup();
    render(<WorkspacePage id="case-1" />);
    const list = await screen.findByText(/Lista accesible de nodos/i).then((summary) => summary.closest("details")!);
    await user.click(list.querySelector("summary")!);

    await user.click(within(list).getByRole("button", { name: /Evidencia: evidence-1/i }));
    await user.type(screen.getByLabelText(/motivo de validación/i), "Motivo de evidencia A");
    await user.click(within(list).getByRole("button", { name: /Evidencia: evidence-2/i }));
    expect(screen.getByLabelText(/motivo de validación/i)).toHaveValue("");

    await user.click(within(list).getByRole("button", { name: /Acción: action-1/i }));
    expect(screen.queryByLabelText(/motivo de aprobación/i)).not.toBeInTheDocument();
    await user.click(within(list).getByRole("button", { name: /Acción: action-2/i }));
    expect(screen.queryByLabelText(/motivo de aprobación/i)).not.toBeInTheDocument();
  });

  it("implementa navegación de pestañas accesible con flechas, inicio y fin", async () => {
    installFetch(async () => json(snapshot()));
    const user = userEvent.setup();
    render(<WorkspacePage id="case-1" />);
    const graphTab = await screen.findByRole("tab", { name: "Grafo" });
    const detailTab = screen.getByRole("tab", { name: "Detalle" });
    const graphPanel = screen.getByRole("tabpanel", { name: "Grafo" });
    const detailPanel = screen.getByRole("tabpanel", { name: "Detalle" });

    expect(graphTab).toHaveAttribute("aria-controls", graphPanel.id);
    expect(graphPanel).toHaveAttribute("aria-labelledby", graphTab.id);
    expect(detailTab).toHaveAttribute("aria-controls", detailPanel.id);
    expect(detailPanel).toHaveAttribute("aria-labelledby", detailTab.id);
    expect(graphTab).toHaveAttribute("tabindex", "0");
    expect(detailTab).toHaveAttribute("tabindex", "-1");

    graphTab.focus();
    await user.keyboard("{ARROWRIGHT}");
    expect(detailTab).toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(detailTab);
    await user.keyboard("{HOME}");
    expect(graphTab).toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(graphTab);
    await user.keyboard("{END}");
    expect(detailTab).toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(detailTab);
    await user.keyboard("{ARROWLEFT}");
    expect(graphTab).toHaveAttribute("aria-selected", "true");
  });

  it("bloquea controles y declara el estado desconocido cuando mutación y refetch fallan", async () => {
    let loads = 0;
    const { calls } = installFetch(async (call) => {
      const path = pathOf(call);
      if (path === "/investigations/case-1") {
        loads += 1;
        return loads === 1
          ? json(snapshot({ actions: [action("queued")] }))
          : json({ error: "UNAVAILABLE", message: "lectura no disponible" }, 503);
      }
      if (path.endsWith("/authorization")) return json({ error: "UNAVAILABLE", message: "respuesta perdida" }, 503);
      throw new Error(`Ruta inesperada: ${path}`);
    });
    const user = userEvent.setup();
    render(<WorkspacePage id="case-1" />);
    await openCaseControls(user);
    await user.type(screen.getByLabelText(/motivo de autorización/i), "Permiso expreso");
    await user.click(screen.getByRole("button", { name: /otorgar autorización/i }));

    const alert = await screen.findByText(/no se pudo confirmar la operación/i);
    expect(alert).toHaveTextContent(/lectura no disponible/i);
    expect(alert).toHaveTextContent(/estado.*desconocido|no se pudo.*refrescar/i);
    expect(alert).not.toHaveTextContent(/se volvió a consultar/i);
    expect(screen.getByRole("button", { name: /ejecutar siguiente acción en cola/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /otorgar autorización/i })).toBeDisabled();
    expect(calls.filter((call) => pathOf(call) === "/investigations/case-1")).toHaveLength(2);
  });

  it("si una mutación falla vuelve a leer el snapshot antes de exponer los gates", async () => {
    let loads = 0;
    const { calls } = installFetch(async (call) => {
      const path = pathOf(call);
      if (path === "/investigations/case-1") {
        loads += 1;
        return json(snapshot({ authorization: { granted: false, at: createdAt, reason: "No", operator: "local-operator" } }));
      }
      if (path.endsWith("/authorization")) return json({ error: "UNAVAILABLE", message: "respuesta perdida" }, 503);
      throw new Error(`Ruta inesperada: ${path}`);
    });
    const user = userEvent.setup();
    render(<WorkspacePage id="case-1" />);
    await openCaseControls(user);
    await user.type(screen.getByLabelText(/motivo de autorización/i), "Permiso expreso");
    await user.click(screen.getByRole("button", { name: /otorgar autorización/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/respuesta perdida/i);
    await waitFor(() => expect(loads).toBe(2));
    expect(calls.filter((call) => pathOf(call) === "/investigations/case-1")).toHaveLength(2);
    expect(screen.getByRole("button", { name: /ejecutar siguiente acción en cola/i })).toBeDisabled();
  });
});
