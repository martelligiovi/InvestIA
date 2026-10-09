import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { ValidationStatus } from "@investia/core";
import flower from "../assets/folk-flower.svg";
import { InvestigationGraph } from "../components/InvestigationGraph";
import { WorkspaceDetails } from "../components/WorkspaceDetails";
import { buildWorkspaceGraph, type WorkspaceNode } from "./workspace-model";
import { useWorkspaceController } from "./useWorkspaceController";
import { workspaceHeadline } from "./workspace-status";

export interface WorkspacePageProps {
  readonly id: string;
}

type MobilePanel = "graph" | "detail";

function LoadingWorkspace() {
  return (
    <section className="workspace-state-page" aria-live="polite">
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
  const [authorizationReason, setAuthorizationReason] = useState("");
  const [pauseReason, setPauseReason] = useState("");
  const [formError, setFormError] = useState("");
  const graphTabRef = useRef<HTMLButtonElement>(null);
  const detailTabRef = useRef<HTMLButtonElement>(null);
  const investigation = controller.investigation;
  const graph = useMemo(() => investigation === null ? null : buildWorkspaceGraph(investigation), [investigation]);

  if (controller.phase === "loading" || (investigation === null && controller.phase === "ready")) return <LoadingWorkspace />;
  if (controller.phase === "error") {
    return (
      <section className="workspace-state-page" aria-labelledby="workspace-error-title">
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
        <p className="eyebrow">CUADERNO DE INVESTIGACIÓN</p>
        <h1 id="workspace-not-found-title" className="document-title">No existe este expediente</h1>
        <p>La referencia <code className="break-value">{id}</code> no corresponde a una investigación disponible.</p>
        <a className="text-link" href="#/">Volver al historial <span aria-hidden="true">←</span></a>
      </section>
    );
  }

  if (investigation === null || graph === null) return <LoadingWorkspace />;
  const selectedNode: WorkspaceNode | null = graph.nodes.find((node) => node.id === selectedId) ?? graph.nodes[0] ?? null;
  const selectedNodeId = selectedNode?.id ?? null;
  const authorizationGranted = investigation.authorization?.granted === true;
  const automatic = investigation.advancementMode === "automatic";
  const queuedActions = investigation.actions.filter((action) => action.status === "queued" && (action.queuedByCatalog === true || action.approval !== undefined));
  const claimedActions = investigation.actions.filter((action) => action.status === "claimed");
  const dispatchEligible = !automatic && !investigation.paused && authorizationGranted && queuedActions.length > 0 && !controller.stale && !controller.busy;
  const controlsDisabled = controller.busy || controller.stale;
  const investigationPaused = investigation.paused;
  const reportIsFresh = controller.report !== null && controller.reportRevision === investigation.revision && !controller.stale;

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
        <a className="workspace-brand" href="#/" aria-label="InvestIA, inicio"><img src={flower} alt="" /></a>
        <a className="workspace-back-link" href="#/" aria-label="Volver al historial">
          <span aria-hidden="true">←</span><span>Volver al historial</span>
        </a>
        <div className="workspace-title-block">
          <p className="eyebrow">INVESTIGACIÓN · {investigation.revision.toString().padStart(2, "0")}</p>
          <h1 id="workspace-title">{investigation.name ?? "Investigación"}</h1>
          <span className={`workspace-state-tag${investigation.paused ? " is-paused" : ""}`}>
            {controller.stale ? "Estado desactualizado" : workspaceHeadline(investigation)}
          </span>
        </div>
        <div className="workspace-header-actions">
          <details className="workspace-pause-disclosure">
            <summary>{investigation.paused ? "Reanudar" : "Pausar"}</summary>
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
          </details>
          <button className="workspace-button workspace-button--report" type="button" disabled={controller.busy || controller.stale} onClick={() => void controller.loadReport()}>
            {controller.reportLoading ? "Obteniendo informe…" : "Obtener informe"}
          </button>
        </div>
      </header>


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

      <div className="workspace-layout" data-mobile-panel={mobilePanel}>
        <div id="workspace-graph-panel" className="workspace-graph-column" role="tabpanel" aria-labelledby="workspace-graph-tab" tabIndex={0}>
          <InvestigationGraph graph={graph} selectedId={selectedNodeId} onSelect={(node) => setSelectedId(node.id)} />
        </div>
        <div id="workspace-detail-panel" className="workspace-detail-column" role="tabpanel" aria-labelledby="workspace-detail-tab" tabIndex={0}>
          <WorkspaceDetails
            key={selectedNodeId ?? "empty"}
            investigation={investigation}
            node={selectedNode}
            disabled={controlsDisabled}
            onValidate={validate}
          />
          <details className="workspace-case-controls">
            <summary>Controles del expediente</summary>
            <p className="case-reference">Referencia <code className="break-value" aria-label={`Referencia completa: ${investigation.id}`}>{investigation.id}</code> · Revisión {investigation.revision} · Actualizado {investigation.updatedAt}</p>
            <button className="workspace-button workspace-button--quiet" type="button" disabled={controller.busy} onClick={() => void controller.refresh()}>
              {controller.busy ? "Actualizando…" : "Actualizar expediente"}
            </button>
            <p>{investigation.authorization === undefined ? "Sin autorización registrada" : authorizationGranted ? "Autorización otorgada" : "Autorización revocada"}</p>
            <label className="form-field">
              <span>Motivo de autorización</span>
              <textarea value={authorizationReason} maxLength={2_000} onChange={(event) => { setAuthorizationReason(event.currentTarget.value); setFormError(""); }} disabled={controlsDisabled} rows={2} />
            </label>
            <div className="authorization-actions">
              <button className="workspace-button" type="button" disabled={controlsDisabled || authorizationReason.trim() === "" || authorizationGranted} onClick={() => void updateAuthorization(true)}>Otorgar autorización</button>
              <button className="workspace-button" type="button" disabled={controlsDisabled || authorizationReason.trim() === "" || !authorizationGranted} onClick={() => void updateAuthorization(false)}>Revocar autorización</button>
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
          </details>
        </div>
      </div>

      {controller.reportError !== "" && <p className="workspace-alert" role="alert">{controller.reportError}</p>}
      {reportIsFresh && !controller.busy && controller.report !== null && (
        <details className="workspace-report" open>
          <summary>Informe Markdown · vista previa y descarga</summary>
          <div className="report-heading-row">
            <div>
              <p className="eyebrow">SALIDA DOCUMENTAL</p>
              <h2 id="report-heading">Informe Markdown</h2>
            </div>
            <a
              className="workspace-button"
              href={`data:text/markdown;charset=utf-8,${encodeURIComponent(controller.report)}`}
              download={`investigacion-${id.replace(/[^a-zA-Z0-9._-]/gu, "_")}.md`}
            >
              Descargar Markdown
            </a>
          </div>
          <pre aria-label="Vista previa del informe">{controller.report}</pre>
        </details>
      )}
    </section>
  );
}
