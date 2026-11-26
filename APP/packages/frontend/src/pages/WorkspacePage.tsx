import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { authorizationCovers, usernameProposals, type ValidationStatus } from "@investia/core";
import { InvestigationApiClient } from "../api/client";
import { AsciiArt } from "../components/AsciiArt";
import { InvestigationGraph } from "../components/InvestigationGraph";
import { UsernameSeedsPanel } from "../components/UsernameSeedsPanel";
import { WorkspaceDetails } from "../components/WorkspaceDetails";
import { FacecheckReview } from "../components/FacecheckReview";
import { buildWorkspaceGraph, findWorkspaceNode, type WorkspaceNode } from "./workspace-model";
import { useWorkspaceController } from "./useWorkspaceController";
import { actionDisplayState, workspaceHeadline } from "./workspace-status";

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
const AUTO_AUTHORIZATION_REASON = "Autorización del expediente confirmada para ejecutar las herramientas configuradas.";

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
  const [ghuntConnected, setGhuntConnected] = useState<boolean | null>(null);
  const hasGhunt = controller.investigation?.actions.some((action) => action.spec.catalogId === "ghunt.email.v1" && action.status === "queued") === true;
  useEffect(() => {
    if (!hasGhunt) return;
    let active = true;
    const api = new InvestigationApiClient();
    const load = () => { void api.getGhuntSettings().then(
      (view) => { if (active) setGhuntConnected(view.available && view.state === "connected"); },
      () => { if (active) setGhuntConnected(null); },
    ); };
    load();
    window.addEventListener("focus", load);
    return () => { active = false; window.removeEventListener("focus", load); };
  }, [hasGhunt]);
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>("graph");
  const [detailOpen, setDetailOpen] = useState(false);
  const [facecheckReview, setFacecheckReview] = useState<string | null>(null);
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
  const { investigation, decodoConfigured, facecheckConfigured } = controller;
  const graph = useMemo(() => investigation === null ? null : buildWorkspaceGraph(investigation, ghuntConnected, decodoConfigured), [investigation, ghuntConnected, decodoConfigured]);

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
  const automatic = investigation.advancementMode === "automatic";
  const queuedActions = investigation.actions.filter((action) => action.status === "queued" && (action.queuedByCatalog === true || action.approval !== undefined));
  const coveredQueue = queuedActions.filter((action) => authorizationCovers(investigation.authorization, action.spec.catalogId));
  const uncoveredCount = queuedActions.length - coveredQueue.length;
  const claimedActions = investigation.actions.filter((action) => action.status === "claimed");
  const hasDispatchableAction = coveredQueue.some((action) => {
    if (action.spec.catalogId === "ghunt.email.v1") return ghuntConnected === true;
    if (action.spec.catalogId === "decodo.url.v1") return actionDisplayState(investigation, action, ghuntConnected, decodoConfigured) === "queued";
    return true;
  });
  const dispatchEligible = !automatic && !investigation.paused && hasDispatchableAction && !controller.stale && !controller.busy;
  const controlsDisabled = controller.busy || controller.stale;
  const usernameProposalCount = usernameProposals(investigation).length;
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
      document.querySelector<SVGGElement>(`.graph-node[data-node-id="${CSS.escape(node.groupId ?? node.relatedParentId ?? node.id)}"]`)
        ?.scrollIntoView?.({ block: "nearest", inline: "nearest", behavior: reducedMotion ? "auto" : "smooth" });
    }, reducedMotion ? 0 : DRAWER_SETTLE_MS);
  }

  function closeDetail() {
    setDetailOpen(false);
    if (selectedNodeId === null) return;
    // Return focus to the node that opened the drawer so keyboard users keep their place in the graph.
    document.querySelector<SVGGElement>(`.graph-node[data-node-id="${CSS.escape(selectedNode?.groupId ?? selectedNode?.relatedParentId ?? selectedNodeId)}"]`)?.focus();
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

  async function addUsername(username: string, reason: string): Promise<boolean> {
    return controller.mutate((api, investigationId) => api.addUsernameSeed(investigationId, username, reason));
  }

  async function decideUsername(username: string, decision: "accepted" | "rejected", reason: string): Promise<boolean> {
    return controller.mutate((api, investigationId) => api.decideUsernameProposal(investigationId, username, decision, reason));
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
                {controller.stale ? "Estado desactualizado" : workspaceHeadline(investigation, ghuntConnected, decodoConfigured)}
              </span>
            </div>
          </div>
        </div>
        <div className="workspace-header-actions">
          <details className="workspace-usernames-disclosure workspace-disclosure">
            <summary>Usernames{usernameProposalCount > 0 ? ` (${usernameProposalCount})` : ""}</summary>
            <div className="workspace-popover workspace-usernames-panel">
              <UsernameSeedsPanel investigation={investigation} disabled={controlsDisabled} onAdd={addUsername} onDecide={decideUsername} />
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

      {(uncoveredCount > 0 || investigation.authorization?.granted !== true) && (
        <div className="workspace-claimed-warning workspace-notice-with-action">
          <div>
            <span role="status">Esperando autorización: {uncoveredCount === 0
              ? "el expediente no tiene permiso para ejecutar las herramientas configuradas."
              : `${uncoveredCount === 1 ? "1 acción en cola bloqueada" : `${uncoveredCount} acciones en cola bloqueadas`}.`}</span>
            <p className="dispatch-note">Autorizar habilita semillas actuales y futuras con user-scanner (módulos loud y cross-scan), Gravatar, Maigret, GHunt, FaceCheck (envía la foto de perfil de Google y usa créditos fuera del modo prueba) y Decodo (solo URL públicas de coincidencias de FaceCheck aceptadas, nunca la foto ni la miniatura).</p>
          </div>
          <button className="workspace-button workspace-button--quiet" type="button" disabled={controlsDisabled}
            onClick={() => void controller.mutate((api, investigationId) => api.setAuthorization(investigationId, true, AUTO_AUTHORIZATION_REASON))}>
            Autorizar expediente
          </button>
        </div>
      )}
      {!automatic && hasDispatchableAction && (
        <div className="workspace-queue-notice workspace-notice-with-action">
          <span role="status">Acciones en cola · avance manual.</span>
          <button className="workspace-button workspace-button--quiet" type="button" disabled={!dispatchEligible} onClick={() => void runNextAction()}>
            Ejecutar siguiente acción en cola
          </button>
        </div>
      )}
      {claimedActions.length > 0 && (
        <p className="workspace-claimed-warning" role="status">
          Efecto externo incierto: {claimedActions.map((action) => action.id).join(", ")} está reclamada. No la vuelvas a ejecutar; se consultará su estado sin reenviar la acción.
        </p>
      )}

      {controller.operationError !== "" && <p className="workspace-alert" role="alert">{controller.operationError}</p>}
      {controller.stale && (
        <div className="workspace-alert workspace-notice-with-action">
          <span role="alert">La vista puede estar desactualizada. Actualizá el expediente antes de usar sus controles.</span>
          <button className="workspace-button workspace-button--quiet" type="button" disabled={controller.busy} onClick={() => void controller.refresh()}>
            {controller.busy ? "Actualizando…" : "Actualizar expediente"}
          </button>
        </div>
      )}
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
            ghuntConnected={ghuntConnected}
            facecheckConfigured={facecheckConfigured}
            decodoConfigured={decodoConfigured}
            normalization={selectedNode?.evidence ? controller.normalizations[selectedNode.evidence.id] : undefined}
            normalizing={selectedNode?.evidence !== undefined && controller.normalizingEvidenceId === selectedNode.evidence.id}
            normalizationError={selectedNode?.evidence ? controller.normalizationErrors[selectedNode.evidence.id] ?? "" : ""}
            onValidate={validate}
            onQueueDecodo={controller.queueDecodo}
            onRerun={controller.rerunAction}
            onNormalizeEvidence={controller.normalizeEvidence}
            onApproveGravatar={(actionId, reason) => controller.mutate((api, investigationId) => api.approveAction(investigationId, actionId, reason))}
            onReviewFacecheck={setFacecheckReview}
          />
        </div>
      </div>

      {facecheckReview !== null && <FacecheckReview
        investigation={investigation}
        actionId={facecheckReview}
        disabled={controlsDisabled}
        onDecide={(evidenceId, status, reason) => validate(evidenceId, status, reason)}
        onClose={() => setFacecheckReview(null)}
      />}

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
