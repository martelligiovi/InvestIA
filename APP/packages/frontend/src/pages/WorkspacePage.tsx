import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { ValidationStatus } from "@investia/core";
import { AsciiArt } from "../components/AsciiArt";
import { InvestigationGraph } from "../components/InvestigationGraph";
import { WorkspaceDetails } from "../components/WorkspaceDetails";
import { buildWorkspaceGraph, findWorkspaceNode, type WorkspaceNode } from "./workspace-model";
import { useWorkspaceController } from "./useWorkspaceController";
import { hasCatalogAuthorization, workspaceHeadline } from "./workspace-status";

function revealElement(element: HTMLElement) {
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  element.scrollIntoView?.({ block: "start", behavior: reducedMotion ? "auto" : "smooth" });
  element.focus({ preventScroll: true });
}

export interface WorkspacePageProps {
  readonly id: string;
}

type MobilePanel = "graph" | "detail";

/** Matches the drawer's grid-track transition in workspace.css. */
const DRAWER_SETTLE_MS = 560;

function LoadingWorkspace() {
  return (
    <section className="workspace-state-page" aria-live="polite">
      <AsciiArt motif="rosette" className="workspace-state-art" />
      <p className="eyebrow">CUADERNO DE INVESTIGACIÓN</p>
      <h1 className="document-title">Cargando expediente…</h1>
      <p role="status">Leyendo el estado registrado de la investigación.</p>
    </section>
  );
}

export function WorkspacePage({ id }: WorkspacePageProps) {
  const controller = useWorkspaceController(id);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>("graph");
  const [detailOpen, setDetailOpen] = useState(false);
  const [authorizationReason, setAuthorizationReason] = useState("");
  const [pauseReason, setPauseReason] = useState("");
  const [formError, setFormError] = useState("");
  const graphTabRef = useRef<HTMLButtonElement>(null);
  const detailTabRef = useRef<HTMLButtonElement>(null);
  const reportRef = useRef<HTMLDetailsElement>(null);
  const reportErrorRef = useRef<HTMLParagraphElement>(null);
  const revealedReport = useRef<string | null>(null);

  // Reports and their errors render below the full-height workspace; bring each new one into view.
  useEffect(() => {
    const element = reportRef.current;
    if (element === null || controller.report === null || revealedReport.current === controller.report) return;
    revealedReport.current = controller.report;
    revealElement(element);
  }, [controller.report, controller.busy]);

  useEffect(() => {
    const element = reportErrorRef.current;
    if (element !== null && controller.reportError !== "") revealElement(element);
  }, [controller.reportError]);
  const investigation = controller.investigation;
  const graph = useMemo(() => investigation === null ? null : buildWorkspaceGraph(investigation), [investigation]);

  useEffect(() => {
    // Header disclosures behave as popovers: interacting elsewhere or pressing Escape dismisses them.
    function dismissDisclosures(keep: EventTarget | null) {
      for (const disclosure of document.querySelectorAll<HTMLDetailsElement>(".workspace-disclosure[open]")) {
        if (keep instanceof Node && disclosure.contains(keep)) continue;
        const hadFocus = disclosure.contains(document.activeElement);
        disclosure.open = false;
        if (hadFocus) disclosure.querySelector("summary")?.focus();
      }
    }
    const onPointerDown = (event: PointerEvent) => dismissDisclosures(event.target);
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") dismissDisclosures(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  if (controller.phase === "loading" || (investigation === null && controller.phase === "ready")) return <LoadingWorkspace />;
  if (controller.phase === "error") {
    return (
      <section className="workspace-state-page" aria-labelledby="workspace-error-title">
        <AsciiArt motif="tree" className="workspace-state-art" />
        <p className="eyebrow">CUADERNO DE INVESTIGACIÓN</p>
        <h1 id="workspace-error-title" className="document-title">No se pudo cargar el expediente</h1>
        <p role="alert">{controller.loadError || "Revisá la conexión e intentá otra vez."}</p>
        <div className="workspace-state-actions">
          <button className="workspace-button workspace-button--primary" type="button" disabled={controller.busy} onClick={() => void controller.retryLoad()}>
            Intentar de nuevo
          </button>
          <a className="text-link" href="#/">Volver al historial <span aria-hidden="true">←</span></a>
        </div>
      </section>
    );
  }
  if (controller.phase === "not-found" || investigation === null) {
    return (
      <section className="workspace-state-page" aria-labelledby="workspace-not-found-title">
        <AsciiArt motif="tree" className="workspace-state-art" />
        <p className="eyebrow">CUADERNO DE INVESTIGACIÓN</p>
        <h1 id="workspace-not-found-title" className="document-title">No existe este expediente</h1>
        <p>La referencia <code className="break-value">{id}</code> no corresponde a una investigación disponible.</p>
        <a className="text-link" href="#/">Volver al historial <span aria-hidden="true">←</span></a>
      </section>
    );
  }

  if (investigation === null || graph === null) return <LoadingWorkspace />;
  const selectedNode: WorkspaceNode | null = findWorkspaceNode(graph, selectedId) ?? graph.nodes[0] ?? null;
  const selectedNodeId = selectedNode?.id ?? null;
  const authorizationGranted = hasCatalogAuthorization(investigation);
  const automatic = investigation.advancementMode === "automatic";
  const queuedActions = investigation.actions.filter((action) => action.status === "queued" && (action.queuedByCatalog === true || action.approval !== undefined));
  const claimedActions = investigation.actions.filter((action) => action.status === "claimed");
  const dispatchEligible = !automatic && !investigation.paused && authorizationGranted && queuedActions.length > 0 && !controller.stale && !controller.busy;
  const controlsDisabled = controller.busy || controller.stale;
  const investigationPaused = investigation.paused;
  const reportIsFresh = controller.report !== null && controller.reportRevision === investigation.revision && !controller.stale;
  const aiReport = controller.reportKind === "ai";
  const reportFileId = id.replace(/[^a-zA-Z0-9._-]/gu, "_");

  function selectNode(node: WorkspaceNode) {
    setSelectedId(node.id);
    setDetailOpen(true);
    // The opening drawer narrows the canvas; once it settles, bring the chosen node back into view.
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    window.setTimeout(() => {
      document.querySelector<SVGGElement>(`.graph-node[data-node-id="${CSS.escape(node.groupId ?? node.id)}"]`)
        ?.scrollIntoView?.({ block: "nearest", inline: "nearest", behavior: reducedMotion ? "auto" : "smooth" });
    }, reducedMotion ? 0 : DRAWER_SETTLE_MS);
  }

  function closeDetail() {
    setDetailOpen(false);
    if (selectedNodeId === null) return;
    // Return focus to the node that opened the drawer so keyboard users keep their place in the graph.
    document.querySelector<SVGGElement>(`.graph-node[data-node-id="${CSS.escape(selectedNode?.groupId ?? selectedNodeId)}"]`)?.focus();
  }

  function handleMobileTabKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const currentPanel = event.currentTarget.id === "workspace-graph-tab" ? "graph" : "detail";
    let nextPanel: MobilePanel | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") nextPanel = currentPanel === "graph" ? "detail" : "graph";
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextPanel = currentPanel === "graph" ? "detail" : "graph";
    if (event.key === "Home") nextPanel = "graph";
    if (event.key === "End") nextPanel = "detail";
    if (nextPanel === null) return;
    event.preventDefault();
    setMobilePanel(nextPanel);
    (nextPanel === "graph" ? graphTabRef : detailTabRef).current?.focus();
  }

  async function updateAuthorization(granted: boolean) {
    if (authorizationReason.trim() === "") {
      setFormError("Escribí un motivo para cambiar la autorización.");
      return;
    }
    const saved = await controller.mutate((api, investigationId) => api.setAuthorization(investigationId, granted, authorizationReason));
    if (saved) {
      setAuthorizationReason("");
      setFormError("");
    }
  }

  async function togglePause() {
    if (pauseReason.trim() === "") {
      setFormError("Escribí un motivo para pausar o reanudar el expediente.");
      return;
    }
    const wasPaused = investigationPaused;
    const saved = await controller.mutate((api, investigationId) => wasPaused
      ? api.resumeInvestigation(investigationId, pauseReason)
      : api.pauseInvestigation(investigationId, pauseReason));
    if (saved) {
      setPauseReason("");
      setFormError("");
    }
  }

  async function validate(evidenceId: string, status: ValidationStatus, reason: string): Promise<boolean> {
    return controller.mutate((api, investigationId) => api.validateEvidence(investigationId, evidenceId, status, reason));
  }

  async function runNextAction() {
    if (!dispatchEligible) return;
    await controller.mutate((api, investigationId) => api.runNextAction(investigationId), true);
  }

  return (
    <section className="investigation-workspace" aria-labelledby="workspace-title">
      <header className="workspace-header">
        <div className="workspace-header-main">
          <a className="workspace-back-link" href="#/" aria-label="Volver al historial">
            <span aria-hidden="true">←</span><span>Volver al historial</span>
          </a>
          <div className="workspace-title-block">
            <p className="eyebrow">INVESTIGACIÓN · {investigation.revision.toString().padStart(2, "0")}</p>
            <div className="workspace-title-row">
              <h1 id="workspace-title">{investigation.name ?? "Investigación"}</h1>
              <span className={`workspace-state-tag status-chip${investigation.paused ? " is-paused status-chip--muted" : ""}`}>
                {controller.stale ? "Estado desactualizado" : workspaceHeadline(investigation)}
              </span>
            </div>
          </div>
        </div>
        <div className="workspace-header-actions">
          <details className="workspace-case-controls workspace-disclosure">
            <summary>Controles del expediente</summary>
            <div className="workspace-popover workspace-case-panel">
              <p className="case-reference">Referencia <code className="break-value" aria-label={`Referencia completa: ${investigation.id}`}>{investigation.id}</code> · Revisión {investigation.revision} · Actualizado {investigation.updatedAt}</p>
              <button className="workspace-button workspace-button--quiet" type="button" disabled={controller.busy} onClick={() => void controller.refresh()}>
                {controller.busy ? "Actualizando…" : "Actualizar expediente"}
              </button>
              <p>{investigation.authorization === undefined ? "Sin autorización registrada" : authorizationGranted ? "Autorización otorgada" : investigation.authorization.granted ? "Autorización previa: requiere consentimiento para las herramientas nuevas del catálogo" : "Autorización revocada"}</p>
              <p className="dispatch-note">Autorizar habilita user-scanner con módulos loud que pueden enviar correos o notificaciones y cross-scan de usuarios, enlaces y emails descubiertos, la consulta del perfil público de Gravatar y la búsqueda de usernames aceptados con Maigret en unos 500 sitios. Revocar o pausar no cancela una ejecución en curso.</p>
              <label className="form-field">
                <span>Motivo de autorización</span>
                <textarea value={authorizationReason} maxLength={2_000} onChange={(event) => { setAuthorizationReason(event.currentTarget.value); setFormError(""); }} disabled={controlsDisabled} rows={2} />
              </label>
              <div className="authorization-actions">
                <button className="workspace-button" type="button" disabled={controlsDisabled || authorizationReason.trim() === "" || authorizationGranted} onClick={() => void updateAuthorization(true)}>Otorgar autorización</button>
                <button className="workspace-button" type="button" disabled={controlsDisabled || authorizationReason.trim() === "" || investigation.authorization?.granted !== true} onClick={() => void updateAuthorization(false)}>Revocar autorización</button>
              </div>
              <p>{queuedActions.length} acción{queuedActions.length === 1 ? "" : "es"} {authorizationGranted && !investigation.paused ? "en cola habilitada" : "en cola bloqueada"}.</p>
              {automatic ? (
                <p className="dispatch-note">Avance automático: el servidor procesa la cola cuando el expediente está autorizado y sin pausa.</p>
              ) : (
                <>
                  <button className="workspace-button" type="button" disabled={!dispatchEligible} onClick={() => void runNextAction()}>Ejecutar siguiente acción en cola</button>
                  <p className="dispatch-note">Avance manual: cola del expediente, no del nodo seleccionado. Solo se ejecuta al presionar este control, sin aprobación por nodo.</p>
                </>
              )}
              <ul className="dispatch-gates" aria-label="Condiciones para ejecutar">
                <li>Pausa: {investigation.paused ? "bloquea nuevas acciones" : "sin pausa"}</li>
                <li>Autorización: {authorizationGranted ? "otorgada" : "no otorgada"}</li>
                <li>Catálogo: {queuedActions.length > 0 ? "acción disponible" : "sin acción en cola"}</li>
                <li>Vista: {controller.stale ? "desactualizada" : "snapshot leído"}</li>
              </ul>
            </div>
          </details>
          <details className="workspace-pause-disclosure workspace-disclosure">
            <summary>{investigation.paused ? "Reanudar" : "Pausar"}</summary>
            <div className="workspace-popover workspace-pause-panel">
              <label className="workspace-header-reason">
                <span>Motivo para {investigation.paused ? "reanudar" : "pausar"}</span>
                <input
                  value={pauseReason}
                  maxLength={2_000}
                  onChange={(event) => { setPauseReason(event.currentTarget.value); setFormError(""); }}
                  disabled={controlsDisabled}
                  aria-label={`Motivo para ${investigation.paused ? "reanudar" : "pausar"} el expediente`}
                />
              </label>
              <button className="workspace-button workspace-button--primary" type="button" disabled={controlsDisabled || pauseReason.trim() === ""} onClick={() => void togglePause()}>
                {investigation.paused ? "Reanudar expediente" : "Pausar expediente"}
              </button>
              <p className="workspace-pause-note">Pausar impide nuevas reclamaciones; no cancela acciones en curso.</p>
            </div>
          </details>
          <button className="workspace-button workspace-button--report" type="button" disabled={controller.busy || controller.stale} onClick={() => void controller.loadReport()}>
            {controller.reportLoadingKind === "factual" ? "Obteniendo informe…" : "Obtener informe"}
          </button>
          <button className="workspace-button workspace-button--ai-report" type="button" disabled={controller.busy || controller.stale} onClick={() => void controller.loadAiReport()}>
            {controller.reportLoadingKind === "ai" ? "Generando informe con IA…" : "Generar informe con IA"}
          </button>
        </div>
      </header>
      {controller.reportLoadingKind === "ai" && (
        <p className="workspace-claimed-warning" role="status">Generando el informe con IA en NVIDIA Build. Puede tardar varios minutos; el resultado aparece al final de la página.</p>
      )}


      {!authorizationGranted && queuedActions.length > 0 && (
        <p className="workspace-claimed-warning" role="status">Esperando autorización: {queuedActions.length} acción{queuedActions.length === 1 ? "" : "es"} en cola bloqueada. No se ejecutan consultas hasta otorgar autorización explícita al expediente.</p>
      )}
      {claimedActions.length > 0 && (
        <p className="workspace-claimed-warning" role="status">
          Efecto externo incierto: {claimedActions.map((action) => action.id).join(", ")} está reclamada. No la vuelvas a ejecutar; se consultará su estado sin reenviar la acción.
        </p>
      )}

      {controller.operationError !== "" && <p className="workspace-alert" role="alert">{controller.operationError}</p>}
      {controller.stale && <p className="workspace-alert" role="alert">La vista puede estar desactualizada. Actualizá el expediente antes de usar sus controles.</p>}
      {formError !== "" && <p className="workspace-alert" role="alert">{formError}</p>}

      <div className="workspace-mobile-tabs" role="tablist" aria-label="Panel del expediente">
        <button
          ref={graphTabRef}
          id="workspace-graph-tab"
          type="button"
          role="tab"
          aria-selected={mobilePanel === "graph"}
          aria-controls="workspace-graph-panel"
          tabIndex={mobilePanel === "graph" ? 0 : -1}
          onKeyDown={handleMobileTabKeyDown}
          onClick={() => setMobilePanel("graph")}
        >Grafo</button>
        <button
          ref={detailTabRef}
          id="workspace-detail-tab"
          type="button"
          role="tab"
          aria-selected={mobilePanel === "detail"}
          aria-controls="workspace-detail-panel"
          tabIndex={mobilePanel === "detail" ? 0 : -1}
          onKeyDown={handleMobileTabKeyDown}
          onClick={() => setMobilePanel("detail")}
        >Detalle</button>
      </div>

      <div className="workspace-layout" data-mobile-panel={mobilePanel} data-detail-open={detailOpen}>
        <div id="workspace-graph-panel" className="workspace-graph-column" role="tabpanel" aria-labelledby="workspace-graph-tab" tabIndex={0}>
          <InvestigationGraph graph={graph} selectedId={selectedNodeId} onSelect={selectNode} />
        </div>
        <div
          id="workspace-detail-panel"
          className="workspace-detail-column"
          role="tabpanel"
          aria-labelledby="workspace-detail-tab"
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key !== "Escape" || !detailOpen) return;
            event.stopPropagation();
            closeDetail();
          }}
        >
          <span className="detail-seam" aria-hidden="true" />
          <button className="detail-close" type="button" aria-label="Cerrar detalle" onClick={closeDetail}>
            <span aria-hidden="true">×</span>
          </button>
          <WorkspaceDetails
            key={selectedNodeId ?? "empty"}
            investigation={investigation}
            node={selectedNode}
            onSelectNode={(id) => { const node = findWorkspaceNode(graph, id); if (node) selectNode(node); }}
            disabled={controlsDisabled}
            onValidate={validate}
          />
        </div>
      </div>

      {controller.reportError !== "" && <p ref={reportErrorRef} className="workspace-alert" role="alert" tabIndex={-1}>{controller.reportError}</p>}
      {reportIsFresh && !controller.busy && controller.report !== null && (
        <details ref={reportRef} className="workspace-report" open tabIndex={-1}>
          <summary>{aiReport ? "Informe con IA · vista previa y descarga" : "Informe Markdown · vista previa y descarga"}</summary>
          <div className="report-heading-row">
            <div>
              <p className="eyebrow">{aiReport ? "SALIDA GENERADA CON IA · HIPOTÉTICA" : "SALIDA DOCUMENTAL"}</p>
              <h2 id="report-heading">{aiReport ? "Informe con IA (hipotético)" : "Informe Markdown"}</h2>
            </div>
            <a
              className="workspace-button"
              href={`data:text/markdown;charset=utf-8,${encodeURIComponent(controller.report)}`}
              download={aiReport ? `informe-ia-${reportFileId}.md` : `investigacion-${reportFileId}.md`}
            >
              Descargar Markdown
            </a>
          </div>
          <pre aria-label={aiReport ? "Vista previa del informe con IA" : "Vista previa del informe"}>{controller.report}</pre>
        </details>
      )}
    </section>
  );
}
