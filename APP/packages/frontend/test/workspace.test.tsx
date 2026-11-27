import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EvidenceNormalizationJob, EvidenceRecord, GitHubCatalogAction, Investigation, ValidationDecision } from "@investia/core";
import App from "../src/App";
import { ExecutionQueuePopover } from "../src/components/ExecutionQueuePopover";
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

describe("espacio de investigación factual", () => {
  it("muestra avance automático sin controles de propuesta, aprobación ni despacho", async () => {
    const queued = { ...action("queued"), approval: undefined, queuedByCatalog: true as const };
    const { calls } = installFetch(async () => json(snapshot({ advancementMode: "automatic", actions: [queued] })));
    render(<WorkspacePage id="case-1" />);
    await screen.findByRole("heading", { name: "Caso de prueba" });
    expect(document.querySelector(".workspace-state-tag")).toHaveTextContent("Esperando autorización");
    expect(screen.getByRole("status")).toHaveTextContent(/cola bloqueada/i);
    expect(screen.getByRole("button", { name: "Autorizar expediente" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /ejecutar siguiente/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/motivo para proponer/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /proponer comprobación/i })).not.toBeInTheDocument();
    expect(calls.every((call) => call.init?.method === undefined)).toBe(true);
  });
  it("aprueba solo la propuesta Gravatar seleccionada con motivo sin despachar en modo manual", async () => {
    const proposed: GitHubCatalogAction = { id: "grav-1", spec: { catalogId: "gravatar.email.v1", provider: "gravatar", seed }, status: "proposed", proposedAt: createdAt, proposalReason: "No encontrado" };
    let current = snapshot({ advancementMode: "manual", actions: [proposed] });
    const pending = deferred<Response>();
    const { calls } = installFetch(async (call) => {
      if (pathOf(call) === "/investigations/case-1") return json(current);
      if (pathOf(call) === "/investigations/case-1/actions/grav-1/approval") return pending.promise;
      throw new Error(`Ruta inesperada: ${pathOf(call)}`);
    });
    const user = userEvent.setup();
    render(<WorkspacePage id="case-1" />);
    const list = await screen.findByText(/Lista accesible de nodos/i).then((summary) => summary.closest("details")!);
    await user.click(list.querySelector("summary")!);
    await user.click(within(list).getByRole("button", { name: /Acción: grav-1/i }));
    const approve = screen.getByRole("button", { name: /aprobar búsqueda de gravatar/i });
    expect(approve).toBeDisabled();
    await user.type(screen.getByLabelText(/motivo de aprobación/i), "   ");
    expect(approve).toBeDisabled();
    await user.type(screen.getByLabelText(/motivo de aprobación/i), "Consultar perfil");
    await user.click(approve);
    expect(approve).toBeDisabled();
    expect(calls.filter((call) => pathOf(call).endsWith("/approval")).map(bodyOf)).toEqual([{ reason: "   Consultar perfil" }]);
    current = { ...current, revision: 2, actions: [{ ...proposed, status: "queued", approval }] };
    pending.resolve(json(current.actions[0]));
    await waitFor(() => expect(screen.queryByRole("button", { name: /aprobar búsqueda de gravatar/i })).not.toBeInTheDocument());
    expect(calls.some((call) => /actions\/(run|gravatar)$/.test(pathOf(call)))).toBe(false);
  });

  it("bloquea la aprobación de Gravatar cuando el estado es desconocido", async () => {
    const proposed: GitHubCatalogAction = { id: "grav-1", spec: { catalogId: "gravatar.email.v1", provider: "gravatar", seed }, status: "proposed", proposedAt: createdAt, proposalReason: "No encontrado" };
    let loads = 0;
    installFetch(async (call) => {
      if (pathOf(call) === "/investigations/case-1") return ++loads === 1 ? json(snapshot({ actions: [proposed] })) : json({ message: "lectura no disponible" }, 503);
      return json({ message: "respuesta perdida" }, 503);
    });
    const user = userEvent.setup();
    render(<WorkspacePage id="case-1" />);
    const list = await screen.findByText(/Lista accesible de nodos/i).then((summary) => summary.closest("details")!);
    await user.click(list.querySelector("summary")!);
    await user.click(within(list).getByRole("button", { name: /Acción: grav-1/i }));
    await user.type(screen.getByLabelText(/motivo de aprobación/i), "Consultar perfil");
    await user.click(screen.getByRole("button", { name: /aprobar búsqueda de gravatar/i }));
    await screen.findByText(/no se pudo confirmar la operación/i);
    expect(screen.getByRole("button", { name: /aprobar búsqueda de gravatar/i })).toBeDisabled();
    expect(screen.getByLabelText(/motivo de aprobación/i)).toBeDisabled();
  });

  it("prioriza grafo y detalle sin barras operativas, con controles secundarios cerrados", async () => {
    const { calls } = installFetch(async () => json(snapshot({ authorization: { granted: true, at: createdAt, reason: "Permiso", operator: "local-operator" } })));
    render(<WorkspacePage id="case-1" />);
    await screen.findByRole("heading", { name: "Caso de prueba" });
    expect(document.querySelector(".workspace-meta-bar, .workspace-commandbar, .workspace-command-bar")).toBeNull();
    expect(screen.queryByText("Controles del expediente")).not.toBeInTheDocument();
    const header = within(document.querySelector<HTMLElement>(".workspace-header-actions")!);
    for (const label of ["Usernames", "Pausar"]) expect(header.getByText(label, { selector: "summary" }).closest("details")).not.toHaveAttribute("open");
    for (const name of ["Obtener informe", "Generar informe con IA"]) expect(header.getByRole("button", { name })).toBeEnabled();
    for (const name of ["Autorizar expediente", "Actualizar expediente", "Ejecutar siguiente acción en cola"]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
    await waitFor(() => {
      expect(calls.map(pathOf)).toEqual(["/investigations/case-1", "/investigations/case-1/normalizations"]);
    });
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
    const secondAction = { ...action("succeeded"), id: "action-2", spec: { ...action("succeeded").spec, seed: { kind: "email" as const, value: "otra@example.test" } } as GitHubCatalogAction["spec"] };
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

  it("ofrece zoom, ajuste y pestañas móviles usables sin mutar el expediente", async () => {
    const { calls } = installFetch(async () => json(snapshot()));
    const user = userEvent.setup();
    render(<WorkspacePage id="case-1" />);
    const graph = await screen.findByRole("group", { name: /grafo factual/i });
    await user.click(screen.getByRole("button", { name: /acercar grafo/i }));
    // Zoom remains available, but now anchors at the viewport center rather than the origin.
    expect(graph.querySelector("g[transform]")?.getAttribute("transform")).toMatch(/^translate\([\d.-]+ [\d.-]+\) scale\(1\.25\)$/u);
    await user.click(screen.getByRole("button", { name: "Centrar nodo seleccionado" }));
    expect(graph.querySelector("g[transform]")?.getAttribute("transform")).toMatch(/^translate\([\d.-]+ [\d.-]+\) scale\(1\)$/u);
    expect(screen.getByRole("button", { name: /alejar grafo/i })).toBeDisabled();
    await user.click(screen.getByRole("tab", { name: "Detalle" }));
    expect(document.querySelector(".workspace-layout")).toHaveAttribute("data-mobile-panel", "detail");

    await waitFor(() => {
      expect(calls.map(pathOf)).toEqual(["/investigations/case-1", "/investigations/case-1/normalizations"]);
    });
    expect(calls.every((call) => call.init?.method === undefined)).toBe(true);
  });

  it.each(["success", "failure", "stale"] as const)("confirma la reejecución sin perder la rama antes de tiempo (%s)", async (outcome) => {
    const root: GitHubCatalogAction = { ...action("succeeded"), approval: undefined, queuedByCatalog: true,
      spec: { catalogId: "user-scanner.email.v1", provider: "user-scanner", seed } };
    const child: GitHubCatalogAction = { ...root, id: "child-1", sourceActionId: root.id, status: "succeeded" };
    const before = snapshot({ advancementMode: "manual", actions: [root, child], evidence: [evidence()],
      authorization: { ...approval, granted: true, catalogScopes: ["user-scanner.email.v1"] } });
    const rerun = { previousStatus: "succeeded" as const, fingerprint: "fixture-digest" };
    let current = before;
    const { calls } = installFetch(async (call) => {
      if (pathOf(call) === "/investigations/case-1") return json(current);
      if (pathOf(call) === "/investigations/case-1/actions/action-1/rerun") {
        if (outcome === "stale") {
          current = { ...before, revision: 2 };
          return json({ error: "CONFLICT", message: "The action cannot be rerun in the current state" }, 409);
        }
        current = { ...before, revision: 2, actions: [{ ...root, status: "queued", rerun }, child] };
        return json(current, 202);
      }
      if (pathOf(call) === "/investigations/case-1/actions/run") {
        const claimed = { ...root, status: "claimed" as const, rerun, claim: { id: "new-claim", claimedAt: createdAt } };
        current = { ...before, revision: 3, actions: [claimed, child] };
        return json({ action: claimed });
      }
      throw new Error(`Ruta inesperada: ${pathOf(call)}`);
    });
    const user = userEvent.setup();
    render(<WorkspacePage id="case-1" />);
    const nodeList = await screen.findByText(/Lista accesible de nodos/i).then((entry) => entry.closest("details")!);
    await user.click(nodeList.querySelector("summary")!);
    await user.click(within(nodeList).getByRole("button", { name: /Acción: action-1/i }));
    await user.click(screen.getByRole("button", { name: "Reejecutar" }));
    expect(screen.getByText(/solo si la nueva ejecución termina bien/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(calls.filter((call) => call.init?.method === "POST")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Reejecutar" }));
    await user.click(screen.getByRole("button", { name: "Confirmar reejecución" }));
    const posts = calls.filter((call) => call.init?.method === "POST");
    expect(posts.map(pathOf)).toEqual(["/investigations/case-1/actions/action-1/rerun"]);
    expect(bodyOf(posts[0]!)).toEqual({ expectedRevision: 1 });
    expect(within(nodeList).getByRole("button", { name: /Acción: child-1/i })).toBeInTheDocument();
    expect(within(nodeList).getByRole("button", { name: /Evidencia: evidence-1/i })).toBeInTheDocument();
    if (outcome === "stale") {
      expect(await screen.findByText(/El expediente cambió o la acción ya no admite/i)).toBeInTheDocument();
      return;
    }
    expect(await screen.findByText(/Reejecución en cola/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reejecutar" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Ejecutar siguiente acción en cola" }));
    expect(await screen.findByText(/Reejecución en curso/i)).toBeInTheDocument();
    expect(within(nodeList).getByRole("button", { name: /Acción: child-1/i })).toBeInTheDocument();
    current = outcome === "success"
      ? { ...before, revision: 4, actions: [root], evidence: [evidence("replacement")] }
      : { ...before, revision: 4, actions: [{ ...root, lastRerunFailed: true, lastRerunFailure: "Decodo scrape blocked by anti-bot protection (999)" }, child] };
    if (outcome === "success") {
      expect(await within(nodeList).findByRole("button", { name: /Evidencia: replacement/i }, { timeout: 7_000 })).toBeInTheDocument();
      expect(within(nodeList).queryByRole("button", { name: /Acción: child-1/i })).not.toBeInTheDocument();
    } else {
      expect(await screen.findByText(/La reejecución falló\. Se conservaron/i, {}, { timeout: 7_000 })).toBeInTheDocument();
      expect(screen.getByText(/Decodo scrape blocked by anti-bot protection \(999\)/)).toBeInTheDocument();
      expect(within(nodeList).getByRole("button", { name: /Acción: child-1/i })).toBeInTheDocument();
    }
  }, 12_000);

  it("permite ampliar una autorización histórica para reejecutar una acción terminal", async () => {
    const root: GitHubCatalogAction = {
      ...action("succeeded"),
      spec: { catalogId: "gravatar.email.v1", provider: "gravatar", seed },
    };
    let current = snapshot({
      advancementMode: "manual",
      actions: [root],
      authorization: { ...approval, granted: true, catalogScope: "user-scanner.email.v1" },
    });
    const { calls } = installFetch(async (call) => {
      if (pathOf(call) === "/investigations/case-1") return json(current);
      if (pathOf(call) === "/investigations/case-1/authorization") {
        current = {
          ...current, revision: current.revision + 1,
          authorization: { ...approval, granted: true, catalogScopes: ["gravatar.email.v1"] },
        };
        return json(current);
      }
      throw new Error(`Ruta inesperada: ${pathOf(call)}`);
    });
    const user = userEvent.setup();
    render(<WorkspacePage id="case-1" />);
    const list = await screen.findByText(/Lista accesible de nodos/i).then((entry) => entry.closest("details")!);
    await user.click(list.querySelector("summary")!);
    await user.click(within(list).getByRole("button", { name: /Acción: action-1/i }));
    expect(screen.getByRole("button", { name: "Reejecutar" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Autorizar expediente" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Reejecutar" })).toBeEnabled());
    expect(calls.filter(({ init }) => init?.method === "POST").map(pathOf))
      .toEqual(["/investigations/case-1/authorization"]);
  });

  it("muestra un fallo terminal de catálogo histórico sin ofrecer reejecución", async () => {
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
    expect(screen.queryByRole("button", { name: /ejecutar siguiente acción en cola/i })).not.toBeInTheDocument();
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
    const run = await screen.findByRole("button", { name: /ejecutar siguiente acción en cola/i });
    expect(run).toBeEnabled();
    expect(calls.some((call) => call.init?.method === "POST")).toBe(false);
    await user.click(run);
    await waitFor(() => expect(run).not.toBeInTheDocument());
    expect(calls.filter((call) => pathOf(call).endsWith("/actions/run"))).toHaveLength(1);
    expect(calls.some((call) => /approval|proposals/.test(pathOf(call)))).toBe(false);
  });

  it("conserva propuestas históricas sin aprobarlas al autorizar el expediente", async () => {
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

    const authorize = screen.getByRole("button", { name: "Autorizar expediente" });
    await user.click(authorize);
    await waitFor(() => expect(authorize).not.toBeInTheDocument());
    expect(screen.getByText(/Propuesta histórica conservada/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /revocar autorización|ejecutar siguiente/i })).not.toBeInTheDocument();
    expect(calls.filter((call) => call.init?.method === "POST").map(pathOf)).toEqual(["/investigations/case-1/authorization"]);
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

  it("invalida el informe al autorizar el expediente", async () => {
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

    await user.click(screen.getByRole("button", { name: "Autorizar expediente" }));
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

  it("bloquea controles si fallan la mutación y la lectura, y permite recuperar la vista sin mutar", async () => {
    let loads = 0;
    const { calls } = installFetch(async (call) => {
      const path = pathOf(call);
      if (path === "/investigations/case-1") {
        loads += 1;
        if (loads === 1) return json(snapshot({ actions: [action("queued")] }));
        if (loads === 2) return json({ error: "UNAVAILABLE", message: "lectura no disponible" }, 503);
        return json(snapshot({ revision: 2, name: "Versión actualizada", actions: [action("queued")] }));
      }
      if (path.endsWith("/authorization")) return json({ error: "UNAVAILABLE", message: "respuesta perdida" }, 503);
      throw new Error(`Ruta inesperada: ${path}`);
    });
    const user = userEvent.setup();
    render(<WorkspacePage id="case-1" />);
    const authorize = await screen.findByRole("button", { name: "Autorizar expediente" });
    await user.click(authorize);

    const alert = await screen.findByText(/no se pudo confirmar la operación/i);
    expect(alert).toHaveTextContent(/lectura no disponible/i);
    expect(alert).toHaveTextContent(/estado.*desconocido|no se pudo.*refrescar/i);
    expect(alert).not.toHaveTextContent(/se volvió a consultar/i);
    expect(screen.queryByRole("button", { name: /ejecutar siguiente acción en cola/i })).not.toBeInTheDocument();
    expect(authorize).toBeDisabled();
    expect(calls.filter((call) => pathOf(call) === "/investigations/case-1")).toHaveLength(2);
    const refresh = screen.getByRole("button", { name: "Actualizar expediente" });
    expect(refresh.closest(".workspace-alert")).toHaveTextContent("La vista puede estar desactualizada.");
    await user.click(refresh);
    await screen.findByRole("heading", { name: "Versión actualizada" });
    expect(authorize).toBeEnabled();
    expect(refresh).not.toBeInTheDocument();
    expect(calls.map((call) => `${call.init?.method ?? "GET"} ${pathOf(call)}`)).toEqual([
      "GET /investigations/case-1", "GET /investigations/case-1/normalizations",
      "POST /investigations/case-1/authorization", "GET /investigations/case-1", "GET /investigations/case-1",
      "GET /investigations/case-1/normalizations",
    ]);
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
    const authorize = await screen.findByRole("button", { name: "Autorizar expediente" });
    await user.click(authorize);

    expect(await screen.findByRole("alert")).toHaveTextContent(/respuesta perdida/i);
    await waitFor(() => expect(authorize).toBeEnabled());
    expect(loads).toBe(2);
    expect(calls.filter((call) => pathOf(call) === "/investigations/case-1")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /ejecutar siguiente acción en cola/i })).not.toBeInTheDocument();
  });
});

describe("acciones GHunt", () => {
  it.each(["requires_connection", "connected"] as const)("muestra el estado de conexión %s sin despachar", async (state) => {
    const queued: GitHubCatalogAction = { id: "ghunt-1", spec: { catalogId: "ghunt.email.v1", provider: "ghunt", seed }, status: "queued", queuedByCatalog: true, proposedAt: createdAt, proposalReason: "Consulta Gmail" };
    const current = snapshot({ advancementMode: "automatic", authorization: { granted: true, at: createdAt, reason: "Permiso", operator: "local-operator", catalogScopes: ["ghunt.email.v1"] }, actions: [queued] });
    const { calls } = installFetch(async (call) => pathOf(call) === "/settings/ghunt"
      ? json({ available: true, state, account: state === "connected" ? "test@example.test" : null })
      : json(current));
    const user = userEvent.setup();
    render(<WorkspacePage id="case-1" />);
    const list = await screen.findByText(/Lista accesible de nodos/i).then((summary) => summary.closest("details")!);
    await user.click(list.querySelector("summary")!);
    await user.click(within(list).getByRole("button", { name: /Acción: ghunt-1.*GHunt/i }));
    const detail = screen.getByRole("tabpanel", { name: "Detalle" });
    expect(within(detail).getByRole("heading", { name: "GHunt" })).toBeInTheDocument();
    if (state === "requires_connection") {
      expect(within(detail).getAllByText(/requiere login/i).length).toBeGreaterThan(0);
      expect(within(detail).getByRole("link", { name: "Conectar Google" })).toHaveAttribute("href", "#/ajustes?seccion=ghunt");
      await waitFor(() => expect(document.querySelector(".workspace-state-tag")).toHaveTextContent("Esperando conexión de Google"));
    } else {
      expect(within(detail).queryByRole("link", { name: "Conectar Google" })).not.toBeInTheDocument();
      await waitFor(() => expect(document.querySelector(".workspace-state-tag")).toHaveTextContent("Cola automática habilitada"));
    }
    expect(calls.filter((call) => pathOf(call) === "/settings/ghunt")).toHaveLength(1);
    expect(calls.every((call) => call.init?.method === undefined)).toBe(true);
  });

  it("en modo manual solo permite ejecutar GHunt conectado mediante el control del expediente", async () => {
    const queued: GitHubCatalogAction = { id: "ghunt-1", spec: { catalogId: "ghunt.email.v1", provider: "ghunt", seed }, status: "queued", queuedByCatalog: true, proposedAt: createdAt, proposalReason: "Consulta Gmail" };
    const current = snapshot({ advancementMode: "manual", authorization: { granted: true, at: createdAt, reason: "Permiso", operator: "local-operator", catalogScopes: ["ghunt.email.v1"] }, actions: [queued] });
    const { calls } = installFetch(async (call) => pathOf(call) === "/settings/ghunt" ? json({ available: true, state: "connected", account: null }) : json(current));
    render(<WorkspacePage id="case-1" />);
    const run = await screen.findByRole("button", { name: /ejecutar siguiente acción en cola/i });
    expect(run).toBeEnabled();
    expect(document.querySelector(".workspace-state-tag")).toHaveTextContent("Avance manual");
    expect(calls.every((call) => call.init?.method === undefined)).toBe(true);
    expect(calls.filter((call) => pathOf(call) === "/settings/ghunt")).toHaveLength(1);
  });

  it("indica cuando una autorización de user-scanner no cubre GHunt", async () => {
    const queued: GitHubCatalogAction = { id: "ghunt-1", spec: { catalogId: "ghunt.email.v1", provider: "ghunt", seed }, status: "queued", queuedByCatalog: true, proposedAt: createdAt, proposalReason: "Consulta Gmail" };
    installFetch(async (call) => pathOf(call) === "/settings/ghunt" ? json({ available: true, state: "connected", account: null }) : json(snapshot({ actions: [queued], authorization: { granted: true, at: createdAt, reason: "Anterior", operator: "local-operator", catalogScopes: ["user-scanner.email.v1"] } })));
    const user = userEvent.setup();
    render(<WorkspacePage id="case-1" />);
    const list = await screen.findByText(/Lista accesible de nodos/i).then((summary) => summary.closest("details")!);
    await user.click(list.querySelector("summary")!);
    await user.click(within(list).getByRole("button", { name: /Acción: ghunt-1/i }));
    expect(screen.getByText("El expediente requiere autorización para ejecutar GHunt.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Autorizar expediente" })).toBeEnabled();
  });
});

describe("detalle del nodo como panel desplegable", () => {
  const layout = () => document.querySelector<HTMLElement>(".workspace-layout")!;

  it("permanece cerrado hasta seleccionar un nodo y se abre con la selección", async () => {
    installFetch(async () => json(snapshot()));
    const user = userEvent.setup();
    render(<WorkspacePage id="case-1" />);
    await screen.findByRole("heading", { name: "Caso de prueba" });
    expect(layout()).toHaveAttribute("data-detail-open", "false");
    const seedNode = screen.getAllByRole("button", { name: /^Semilla:/u }).find((element) => element.tagName.toLowerCase() === "g")!;
    await user.click(seedNode);
    expect(layout()).toHaveAttribute("data-detail-open", "true");
    expect(within(screen.getByRole("tabpanel", { name: "Detalle" })).getByRole("heading", { name: "Semilla" })).toBeInTheDocument();
  });

  it("se cierra con su botón o con Escape y devuelve el foco al nodo seleccionado", async () => {
    installFetch(async () => json(snapshot()));
    const user = userEvent.setup();
    render(<WorkspacePage id="case-1" />);
    await screen.findByRole("heading", { name: "Caso de prueba" });
    const seedNode = screen.getAllByRole("button", { name: /^Semilla:/u }).find((element) => element.tagName.toLowerCase() === "g")!;
    await user.click(seedNode);
    await user.click(screen.getByRole("button", { name: "Cerrar detalle" }));
    expect(layout()).toHaveAttribute("data-detail-open", "false");
    expect(seedNode).toHaveFocus();

    fireEvent.keyDown(seedNode, { key: "Enter" });
    expect(layout()).toHaveAttribute("data-detail-open", "true");
    fireEvent.keyDown(screen.getByRole("button", { name: "Cerrar detalle" }), { key: "Escape" });
    expect(layout()).toHaveAttribute("data-detail-open", "false");
    expect(seedNode).toHaveFocus();
  });
});

describe("informe con IA", () => {
  it("genera el informe con IA por POST y lo presenta rotulado como IA", async () => {
    const markdown = "# Informe de perfil\n\n## Perfil general";
    const { calls } = installFetch(async (call) => {
      if (pathOf(call) === "/investigations/case-1") return json(snapshot());
      if (pathOf(call) === "/investigations/case-1/report/ai") return reportResponse(markdown);
      throw new Error(`Ruta inesperada: ${pathOf(call)}`);
    });
    const user = userEvent.setup();
    render(<WorkspacePage id="case-1" />);
    await screen.findByRole("heading", { name: "Caso de prueba" });
    expect(screen.getByRole("button", { name: "Obtener informe" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Generar informe con IA" }));

    const preview = await screen.findByLabelText("Vista previa del informe con IA");
    expect(preview.tagName).toBe("PRE");
    expect(preview.textContent).toBe(markdown);
    expect(screen.getByRole("heading", { name: "Informe con IA" })).toBeInTheDocument();
    expect(screen.getByText("SÍNTESIS ASISTIDA POR IA")).toBeInTheDocument();
    expect(screen.queryByText(/hipotétic/i)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /descargar markdown/i })).toHaveAttribute("download", "informe-ia-case-1.md");
    const aiCalls = calls.filter((call) => pathOf(call) === "/investigations/case-1/report/ai");
    expect(aiCalls).toHaveLength(1);
    expect(aiCalls[0]?.init?.method).toBe("POST");
    expect(calls.some((call) => pathOf(call) === "/investigations/case-1/report")).toBe(false);
  });

  it.each([
    ["AI_NOT_CONFIGURED", 409, "Falta la API key de NVIDIA Build. Cargala en Ajustes de IA."],
    ["AI_PROVIDER_UNAUTHORIZED", 502, "NVIDIA Build rechazó la API key. Revisala en Ajustes de IA."],
    ["AI_PROVIDER_RATE_LIMITED", 502, "NVIDIA Build alcanzó el límite de uso gratuito. Probá de nuevo más tarde."],
    ["AI_PROVIDER_REJECTED", 502, "NVIDIA Build rechazó el modelo o los parámetros. Probá otro modelo o restaurá los valores por defecto."],
    ["AI_PROVIDER_UNAVAILABLE", 502, "NVIDIA Build no respondió o no devolvió un informe. Probá de nuevo."],
    ["AI_PROVIDER_TIMEOUT", 502, "El modelo no empezó a responder a tiempo; su endpoint gratuito puede estar saturado. Elegí otro modelo en Ajustes de IA o probá más tarde."],
    ["AI_PROVIDER_TRUNCATED", 502, "El modelo agotó el máximo de tokens antes de escribir el informe. Subí el máximo de tokens o bajá el esfuerzo de razonamiento en Ajustes de IA."],
  ] as const)("traduce %s a un mensaje en español", async (code, status, message) => {
    installFetch(async (call) => {
      if (pathOf(call) === "/investigations/case-1") return json(snapshot());
      if (pathOf(call) === "/investigations/case-1/report/ai") return json({ error: code, message: "provider detail" }, status);
      throw new Error(`Ruta inesperada: ${pathOf(call)}`);
    });
    const user = userEvent.setup();
    render(<WorkspacePage id="case-1" />);
    await user.click(await screen.findByRole("button", { name: "Generar informe con IA" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.queryByLabelText(/vista previa del informe/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generar informe con IA" })).toBeEnabled();
  });

  it("avisa mientras genera y lleva la vista al informe o al error cuando llegan", async () => {
    const scrolled: Element[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function scrollIntoView(this: Element) { scrolled.push(this); };
    try {
      let respond: (response: Response) => void = () => undefined;
      let attempt = 0;
      installFetch(async (call) => {
        if (pathOf(call) === "/investigations/case-1") return json(snapshot());
        if (pathOf(call) === "/investigations/case-1/report/ai") {
          attempt++;
          if (attempt === 1) return json({ error: "AI_PROVIDER_UNAVAILABLE", message: "detail" }, 502);
          return new Promise<Response>((resolve) => { respond = resolve; });
        }
        throw new Error(`Ruta inesperada: ${pathOf(call)}`);
      });
      const user = userEvent.setup();
      render(<WorkspacePage id="case-1" />);
      await user.click(await screen.findByRole("button", { name: "Generar informe con IA" }));
      const alert = await screen.findByRole("alert");
      expect(scrolled).toContain(alert);
      expect(alert).toHaveFocus();

      await user.click(screen.getByRole("button", { name: "Generar informe con IA" }));
      expect(await screen.findByText("Generando el informe con IA en NVIDIA Build. Puede tardar varios minutos; el resultado aparece al final de la página.")).toHaveAttribute("role", "status");
      respond(reportResponse("# Informe con IA"));

      const preview = await screen.findByLabelText("Vista previa del informe con IA");
      const report = preview.closest("details")!;
      expect(scrolled).toContain(report);
      expect(report).toHaveFocus();
      expect(screen.queryByText(/Generando el informe con IA/)).not.toBeInTheDocument();
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it("mantiene el informe factual de Obtener informe después de generar uno con IA", async () => {
    installFetch(async (call) => {
      if (pathOf(call) === "/investigations/case-1") return json(snapshot());
      if (pathOf(call) === "/investigations/case-1/report/ai") return reportResponse("# Informe con IA");
      if (pathOf(call) === "/investigations/case-1/report") return reportResponse("# Informe factual");
      throw new Error(`Ruta inesperada: ${pathOf(call)}`);
    });
    const user = userEvent.setup();
    render(<WorkspacePage id="case-1" />);
    await user.click(await screen.findByRole("button", { name: "Generar informe con IA" }));
    await screen.findByLabelText("Vista previa del informe con IA");

    await user.click(screen.getByRole("button", { name: "Obtener informe" }));

    const preview = await screen.findByLabelText("Vista previa del informe");
    expect(preview).toHaveTextContent("# Informe factual");
    expect(screen.queryByLabelText("Vista previa del informe con IA")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Informe Markdown" })).toBeInTheDocument();
    expect(screen.getByText("Informe Markdown · vista previa y descarga")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /descargar markdown/i })).toHaveAttribute("download", "investigacion-case-1.md");
  });
});

describe("execution queue popover", () => {
  it("shows a spinning ring without percentages, orders recorded stages, and opens action detail", async () => {
    const { calls } = installFetch(async () => json(snapshot({
      authorization: { granted: true, at: createdAt, reason: "Fixture", operator: "local-operator" },
      actions: [
        { ...action("failed"), id: "failed", failure: "Decodo target requires login", spec: {
          catalogId: "decodo.url.v1", provider: "decodo", seed: { kind: "url", value: "https://example.test/profile" },
        } },
        { ...action("queued"), id: "queued-z" }, { ...action("succeeded"), id: "done" },
        { ...action("queued"), id: "queued-a" }, { ...action("claimed"), id: "running" },
      ],
    })));
    const user = userEvent.setup();
    render(<WorkspacePage id="case-1" />);
    const summary = (await screen.findByText("Cola", { exact: true })).closest("summary")!;
    const disclosure = summary.closest("details")!;
    const ring = summary.querySelector("svg")!;
    expect(ring).toHaveAttribute("width", "22");
    expect(ring).toHaveAttribute("height", "22");
    expect(ring).toHaveAttribute("data-mode", "spinning");
    expect(ring.querySelector(".queue-ring-sweep")).toBeInTheDocument();
    expect(ring.querySelector(".queue-ring-progress")).not.toBeInTheDocument();
    expect(ring.querySelector(".queue-ring-alert")).toBeInTheDocument();
    expect(summary).not.toHaveTextContent("%");
    expect(disclosure).not.toHaveAttribute("open");

    await user.click(summary);
    expect(disclosure).toHaveAttribute("open");
    const panel = screen.getByRole("region", { name: "Cola de ejecución" });
    expect(panel).not.toHaveTextContent("%");
    expect(within(panel).getByText("1 en ejecución · 2 en cola · 1 completa · 1 fallida")).toBeInTheDocument();
    expect(within(panel).getByText("Las etapas siguientes se suman al desbloquearse nuevos hallazgos.")).toBeInTheDocument();

    // Active (running + queued) stay expanded; completed and errors start collapsed with errors last.
    const initialRows = within(panel).getAllByRole("listitem");
    expect(initialRows.map((row) => row.getAttribute("data-kind"))).toEqual(["running", "queued", "queued"]);
    expect(within(initialRows[0]!).getByRole("progressbar")).not.toHaveAttribute("aria-valuenow");
    expect(within(initialRows[1]!).getByText("Siguiente")).toBeInTheDocument();
    const second = within(initialRows[2]!).getByRole("button", { name: /En cola · #2/u });

    const completedToggle = within(panel).getByRole("button", { name: /Completadas/u });
    const errorsToggle = within(panel).getByRole("button", { name: /Errores/u });
    expect(completedToggle).toHaveAttribute("aria-expanded", "false");
    expect(errorsToggle).toHaveAttribute("aria-expanded", "false");
    expect(Boolean(completedToggle.compareDocumentPosition(errorsToggle) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(within(panel).getByText("Completo")).not.toBeVisible();
    expect(within(panel).getByText("La página requiere iniciar sesión para ver su contenido.")).not.toBeVisible();

    await user.click(completedToggle);
    expect(completedToggle).toHaveAttribute("aria-expanded", "true");
    expect(within(panel).getByText("Completo")).toBeInTheDocument();

    await user.click(errorsToggle);
    expect(errorsToggle).toHaveAttribute("aria-expanded", "true");
    expect(within(panel).getByRole("button", { name: /Falló/u }))
      .toHaveAccessibleDescription("La página requiere iniciar sesión para ver su contenido.");
    const expandedRows = within(panel).getAllByRole("listitem");
    expect(expandedRows.map((row) => row.getAttribute("data-kind"))).toEqual(["running", "queued", "queued", "completed", "failed"]);

    await user.click(second);
    expect(disclosure).not.toHaveAttribute("open");
    expect(summary).toHaveFocus();
    expect(screen.getByRole("tab", { name: "Detalle" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "Detalle" }).closest(".workspace-layout")).toHaveAttribute("data-detail-open", "true");
    expect(within(screen.getByRole("tabpanel", { name: "Detalle" })).getByRole("heading", { name: "Comprobación de registro en GitHub" }))
      .toBeInTheDocument();
    const graph = screen.getByRole("group", { name: "Grafo factual de semillas, acciones y observaciones" });
    expect(within(graph).getByRole("button", { name: /^Acción: queued-a\./u })).toHaveAttribute("aria-pressed", "true");
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => ["/investigations/case-1", "/investigations/case-1/normalizations"].includes(pathOf(call)) &&
      (call.init?.method ?? "GET") === "GET")).toBe(true);

    // Reopening starts with completed and errors cleanly collapsed again.
    await user.click(summary);
    expect(within(panel).getByRole("button", { name: /Completadas/u })).toHaveAttribute("aria-expanded", "false");
    expect(within(panel).getByRole("button", { name: /Errores/u })).toHaveAttribute("aria-expanded", "false");
  });

  it("dismisses an empty queue with Escape or an outside click", async () => {
    installFetch(async () => json(snapshot()));
    const user = userEvent.setup();
    render(<WorkspacePage id="case-1" />);
    const summary = (await screen.findByText("Cola", { exact: true })).closest("summary")!;
    const disclosure = summary.closest("details")!;
    expect(summary.querySelector("svg")).toHaveAttribute("data-mode", "empty");

    await user.click(summary);
    const panel = screen.getByRole("region", { name: "Cola de ejecución" });
    await user.click(within(panel).getByText("Todavía no hay acciones en cola."));
    expect(disclosure).toHaveAttribute("open");
    await user.keyboard("{Escape}");
    expect(disclosure).not.toHaveAttribute("open");

    await user.click(summary);
    expect(disclosure).toHaveAttribute("open");
    await user.click(screen.getByRole("heading", { name: "Caso de prueba" }));
    expect(disclosure).not.toHaveAttribute("open");
  });

  it("dismisses the queue with Escape after keyboard focus moves to the detail", async () => {
    installFetch(async () => json(snapshot({ actions: [action("succeeded")] })));
    const user = userEvent.setup();
    render(<WorkspacePage id="case-1" />);
    const summary = (await screen.findByText("Cola", { exact: true })).closest("summary")!;
    await user.click(summary);
    const panel = screen.getByRole("region", { name: "Cola de ejecución" });
    await user.click(within(panel).getByRole("button", { name: /Completadas/u }));
    await user.click(within(panel).getByRole("button", { name: /Completo/u }));
    await user.click(summary);
    const detail = screen.getByRole("tabpanel", { name: "Detalle" });
    detail.focus();
    expect(detail).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(summary.closest("details")).not.toHaveAttribute("open");
  });

  it("keeps retry history collapsed with distinct descriptions for attempts of the same action", async () => {
    const completedRetry = { ...action("claimed"), id: "completed-retry", rerun: { previousStatus: "succeeded", fingerprint: "0".repeat(64) } } as const;
    const failedRetry = { ...action("claimed"), id: "failed-retry", rerun: { previousStatus: "failed", fingerprint: "0".repeat(64) } } as const;
    const failed = { ...action("failed"), id: "failed-twice", lastRerunFailed: true,
      lastRerunFailure: "The replacement returned no confirmed results." } as const;
    const audit = [
      { id: "success", actionId: completedRetry.id, actor: "system", at: createdAt, kind: "action_succeeded", reason: "Completed" },
      { id: "failure", actionId: failedRetry.id, actor: "system", at: createdAt, kind: "action_failed", reason: "Failed" },
    ] as const;
    installFetch(async () => json(snapshot({ actions: [completedRetry, failedRetry, failed], audit })));
    const user = userEvent.setup();
    render(<WorkspacePage id="case-1" />);
    const summary = (await screen.findByText("Cola", { exact: true })).closest("summary")!;
    await user.click(summary);
    const panel = screen.getByRole("region", { name: "Cola de ejecución" });
    const rows = within(panel).getAllByRole("listitem");
    expect(rows.map((row) => row.dataset.kind)).toEqual(["running", "running"]);
    for (const row of rows) expect(within(row).getByRole("button", { name: /^Reintento 2 de /u })).toBeVisible();

    const toggles = [/Completadas/u, /Errores/u].map((name) => within(panel).getByRole("button", { name }));
    for (const toggle of toggles) {
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      const target = document.getElementById(toggle.getAttribute("aria-controls")!);
      expect(target).toBeInTheDocument();
      expect(target).not.toBeVisible();
      await user.click(toggle);
      expect(summary.closest("details")).toHaveAttribute("open");
      expect(target).toBeVisible();
    }
    expect(within(panel).getByRole("button", { name: /Completo/u })).toBeVisible();
    const failures = within(panel).getAllByRole("button", { name: /Falló|Reintento fallido/u });
    expect(failures).toHaveLength(3);
    expect(new Set(failures.map((button) => button.getAttribute("aria-describedby"))).size).toBe(3);
    expect(failures[0]).toHaveAccessibleDescription(/La acción no pudo completarse/u);
    expect(failures[1]).toHaveAccessibleDescription(/La acción no pudo completarse/u);
    expect(failures[2]).toHaveAccessibleDescription("La reejecución no devolvió resultados confirmados.");

    await user.click(screen.getByRole("heading", { name: "Caso de prueba" }));
    expect(summary.closest("details")).not.toHaveAttribute("open");
    await user.click(summary);
    for (const toggle of toggles) expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("shows replaced action attempts as read-only history, newest first with local times", async () => {
    const now = new Date(2026, 10, 27, 18);
    const today = new Date(2026, 10, 27, 14, 50).toISOString();
    const yesterday = new Date(2026, 10, 26, 12, 14).toISOString();
    const current = snapshot({
      actions: [
        { ...action("succeeded"), completedAt: yesterday },
        { ...action("claimed"), id: "running" },
        { ...action("failed"), id: "failed", completedAt: yesterday },
      ],
      audit: [
        { id: "queued", actionId: "old", at: yesterday, actor: "system", kind: "action_queued", reason: "Catalog queued a Maigret search" },
        { id: "success", actionId: "old", at: today, actor: "system", kind: "action_succeeded", reason: "Completed" },
        { id: "failure", actionId: "old", at: today, actor: "system", kind: "action_failed", reason: "The replacement returned no confirmed results." },
      ],
    });
    const onSelectAction = vi.fn();
    const user = userEvent.setup();
    render(<ExecutionQueuePopover investigation={current} ghuntConnected={true} facecheckConfigured={true} decodoConfigured={true}
      now={now} onSelectAction={onSelectAction} />);
    const summary = screen.getByText("Cola", { exact: true }).closest("summary")!;
    await user.click(summary);
    const panel = within(screen.getByRole("region", { name: "Cola de ejecución" }));
    await user.click(panel.getByRole("button", { name: /Completadas 2/u }));
    await user.click(panel.getByRole("button", { name: /Errores 2/u }));
    const rows = panel.getAllByRole("listitem");
    expect(rows.map((row) => row.dataset.kind)).toEqual(["running", "completed", "completed", "failed", "failed"]);
    expect(rows.map((row) => {
      const time = row.querySelector("time");
      return time && [time.textContent, time.getAttribute("datetime")];
    })).toEqual([null, ["14:50", today], ["26/11 12:14", yesterday], ["14:50", today], ["26/11 12:14", yesterday]]);
    expect(within(rows[2]!).getByRole("button")).toBeVisible();
    expect(within(rows[4]!).getByRole("button")).toBeVisible();
    expect(within(rows[3]!).getByText("La reejecución no devolvió resultados confirmados.")).toBeVisible();
    for (const [row, title] of [[rows[1]!, "Búsqueda de usuario · Maigret"], [rows[3]!, "Reintento 2 de Búsqueda de usuario · Maigret"]] as const) {
      expect(within(row).getByText(title)).toBeVisible();
      expect(within(row).queryByRole("button")).not.toBeInTheDocument();
      await user.click(within(row).getByText("Acción reemplazada"));
    }
    expect(onSelectAction).not.toHaveBeenCalled();
    expect(summary.closest("details")).toHaveAttribute("open");
  });

  it("opens Decodo evidence from a normalization row and keeps pruned history non-interactive", async () => {
    const pageSeed = { kind: "url", value: "https://example.test/profile" } as const;
    const scrape: GitHubCatalogAction = { ...action("succeeded"), id: "scrape",
      spec: { catalogId: "decodo.url.v1", provider: "decodo", seed: pageSeed } };
    const page: EvidenceRecord = { ...evidence("page", scrape.id), provider: "Decodo", sourceId: "decodo:url", seed: pageSeed,
      finding: { target: pageSeed, url: pageSeed.value, upstreamStatus: "Found", category: "Web page", reason: "Fixture", media: {}, extra: {} } };
    const queued: EvidenceNormalizationJob = { id: "queued", investigationId: "case-1", evidenceId: page.id,
      attemptNumber: 1, status: "queued", createdAt };
    const pruned: EvidenceNormalizationJob = { ...queued, id: "pruned", evidenceId: "old-page", status: "failed", errorCode: "EVIDENCE_UNAVAILABLE" };
    const { calls } = installFetch(async (call) => pathOf(call).endsWith("/normalizations")
      ? json({ normalizations: [], jobs: [pruned, queued] })
      : json(snapshot({ actions: [scrape], evidence: [page] })));
    const user = userEvent.setup();
    render(<WorkspacePage id="case-1" />);
    const summary = (await screen.findByText("Cola", { exact: true })).closest("summary")!;
    await user.click(summary);
    const panel = within(screen.getByRole("region", { name: "Cola de ejecución" }));
    const row = await panel.findByRole("button", { name: /Normalización con IA · example\.test.*\/profile/u });
    expect(summary.querySelector("svg")).toHaveAttribute("data-mode", "pending");
    await user.click(panel.getByRole("button", { name: /Errores/u }));
    const prunedRow = panel.getByText("Página reemplazada").closest("li")!;
    expect(within(prunedRow).queryByRole("button")).not.toBeInTheDocument();
    expect(within(prunedRow).getByText("La página guardada ya no está disponible para normalizar.")).toBeVisible();
    await user.click(row);
    expect(summary.closest("details")).not.toHaveAttribute("open");
    expect(screen.getByRole("tab", { name: "Detalle" })).toHaveAttribute("aria-selected", "true");
    const detail = within(screen.getByRole("tabpanel", { name: "Detalle" }));
    expect(detail.getByRole("heading", { name: "Página recopilada por Decodo" })).toBeVisible();
    expect(detail.getByRole("button", { name: "En cola para normalizar con IA" })).toBeDisabled();
    expect(calls.every((call) => call.init?.method === undefined)).toBe(true);
  });
});

describe("desplegables del encabezado", () => {
  it("se cierran al interactuar fuera de ellos o con Escape, sin cerrarse al usarlos", async () => {
    installFetch(async () => json(snapshot()));
    const user = userEvent.setup();
    render(<WorkspacePage id="case-1" />);
    await screen.findByRole("heading", { name: "Caso de prueba" });
    const pause = screen.getByText("Pausar", { selector: "summary" });
    const controls = pause.closest("details")!;
    await user.click(pause);
    expect(controls).toHaveAttribute("open");
    await user.click(within(controls).getByLabelText("Motivo para pausar el expediente"));
    expect(controls).toHaveAttribute("open");
    await user.click(screen.getByRole("heading", { name: "Caso de prueba" }));
    expect(controls).not.toHaveAttribute("open");

    await user.click(pause);
    await user.keyboard("{Escape}");
    expect(controls).not.toHaveAttribute("open");
  });
});
