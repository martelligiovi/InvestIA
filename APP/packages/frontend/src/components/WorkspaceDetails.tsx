import { Fragment, useState } from "react";
import { authorizationCovers, findingSeedNodeId, isActionEligibleByParentValidation, isSafePublicHttpUrl, latestValidationStatus, type EvidenceAiNormalization, type EvidenceRecord, type ScannerFinding, type Investigation, type ValidationStatus } from "@investia/core";
import { actionTitle, decodoPageTitle, evidenceHeading, GRAPH_PAGE_SIZE, type WorkspaceNode } from "../pages/workspace-model";
import { workspaceStatusLabel } from "../pages/workspace-status";
import { facecheckReviewState } from "./FacecheckReview";

export type NormalizationStatus = "idle" | "enqueueing" | "queued" | "running";

export interface WorkspaceDetailsProps {
  readonly investigation: Investigation;
  readonly node: WorkspaceNode | null;
  readonly disabled: boolean;
  readonly ghuntConnected?: boolean | null;
  readonly facecheckConfigured?: boolean | null;
  readonly decodoConfigured?: boolean | null;
  readonly normalization?: EvidenceAiNormalization;
  readonly normalizationStatus?: NormalizationStatus;
  readonly normalizeDisabled?: boolean;
  readonly normalizationError?: string;
  readonly onSelectNode?: (nodeId: string) => void;
  readonly onValidate: (evidenceId: string, status: ValidationStatus, reason: string) => Promise<boolean>;
  readonly onQueueDecodo?: (evidenceIds: readonly string[]) => Promise<boolean>;
  readonly onNormalizeEvidence?: (evidenceId: string) => Promise<boolean>;
  readonly onApproveGravatar?: (actionId: string, reason: string) => Promise<boolean>;
  /** Opens the card review for the candidates of one FaceCheck search. */
  readonly onReviewFacecheck?: (actionId: string) => void;
}

function FacecheckReviewCall({ investigation, actionId, onReview }: {
  readonly investigation: Investigation; readonly actionId: string; readonly onReview: (actionId: string) => void;
}) {
  const state = facecheckReviewState(investigation, actionId);
  if (state.candidates.length === 0) return null;
  const label = state.pending.length === 0 ? "todo revisado" : `${state.pending.length} por revisar`;
  return (
    <section className="fc-call" aria-labelledby="fc-call-heading">
      <h3 id="fc-call-heading">Candidatos de FaceCheck</h3>
      <p>{state.accepted.length} aceptados · {state.rejected.length} descartados · {state.pending.length} por revisar. Solo los aceptados entran en el informe.</p>
      <button type="button" className="workspace-button workspace-button--primary" onClick={() => onReview(actionId)}>
        Revisar candidatos · {label}
      </button>
    </section>
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("es-AR", { dateStyle: "medium", timeStyle: "short" }).format(date)
    : value;
}

function StateValue({ value }: { readonly value: string }) {
  return <span className="workspace-state-value" title={value}>{workspaceStatusLabel(value)}</span>;
}

function TechnicalValue({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <details className="workspace-technical-value">
      <summary aria-label={`${label}: ${value}. Mostrar valor técnico completo`}>Ver valor completo</summary>
      <code>{value}</code>
    </details>
  );
}

/** Only inline base64 images become an image source; any other value is shown as text, never loaded. */
const INLINE_IMAGE = /^data:image\/(?:webp|jpeg|png);base64,[A-Za-z0-9+/]+={0,2}$/;
function MediaValue({ value }: { readonly value: string }) {
  if (INLINE_IMAGE.test(value)) return <img className="face-thumbnail" src={value} alt="Cara encontrada por FaceCheck" />;
  if (value.startsWith("data:")) return <span>imagen embebida no admitida</span>;
  return <span>{value}</span>;
}

function SafeLink({ value, publicOnly = false }: { readonly value: string; readonly publicOnly?: boolean }) {
  if (publicOnly && !isSafePublicHttpUrl(value)) return <span>{value}</span>;
  try {
    const url = new URL(value);
    if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password) {
      return <a href={value} target="_blank" rel="noopener noreferrer">{value}</a>;
    }
  } catch { /* Untrusted or relative URLs are displayed only as text. */ }
  return <span>{value}</span>;
}

const DECODO_PAGE_FIELDS = new Set(["title", "status_code", "description", "content", "content_truncated", "preview", "links"]);
const TARGET_LABELS: Readonly<Record<ScannerFinding["target"]["kind"], string>> = { email: "Email", photo: "Foto", username: "Usuario", url: "URL" };

function DecodoPageDetails({ finding }: { readonly finding: ScannerFinding }) {
  const { status_code: status, description, content, content_truncated: truncated, links } = finding.extra;
  const publicLinks = typeof links === "string"
    ? [...new Set(links.split("\n").map((link) => link.trim()).filter(isSafePublicHttpUrl))]
    : [];
  return (
    <section className="detail-fact" aria-labelledby="decodo-page-heading">
      <h3 id="decodo-page-heading">Página recopilada por Decodo</h3>
      <dl className="fact-list">
        <dt>Título</dt><dd>{decodoPageTitle(finding)}</dd>
        <dt>URL final</dt><dd><SafeLink value={finding.url} publicOnly /></dd>
        {typeof status === "number" && <><dt>Estado HTTP</dt><dd>{status}</dd></>}
        {typeof description === "string" && description !== "" && <><dt>Descripción</dt><dd>{description}</dd></>}
      </dl>
      {typeof content === "string" && content !== "" && <>
        <h4 id="decodo-content-heading">Texto recopilado</h4>
        {truncated === true && <p className="detail-note">El contenido se guardó truncado por el límite de tamaño.</p>}
        <pre className="decodo-page-content" aria-labelledby="decodo-content-heading" tabIndex={0}>{content}</pre>
      </>}
      {publicLinks.length > 0 && <>
        <h4>Enlaces públicos extraídos</h4>
        <ul className="decodo-page-links">{publicLinks.map((url) => <li key={url}><SafeLink value={url} publicOnly /></li>)}</ul>
      </>}
    </section>
  );
}

const NORMALIZED_PRIMARY_LISTS = [
  ["Handles", "handles"],
  ["Roles / ocupaciones", "rolesOrOccupations"],
  ["Organizaciones", "organizations"],
  ["Educación", "education"],
  ["Ubicaciones mencionadas", "locationsMentioned"],
  ["Temas e intereses", "topicsOrInterests"],
  ["Hechos destacados", "notableFacts"],
] as const;

function NormalizationAlert({ error }: { readonly error: string }) {
  const settingsLabel = "Ajustes de IA";
  const index = error.indexOf(settingsLabel);
  if (index >= 0) {
    return (
      <p className="workspace-alert" role="alert">
        {error.slice(0, index)}
        <a href="#/ajustes">{settingsLabel}</a>
        {error.slice(index + settingsLabel.length)}
      </p>
    );
  }
  return <p className="workspace-alert" role="alert">{error}</p>;
}

function DecodoAiNormalizationSection({
  evidenceId,
  normalizeDisabled = false,
  normalization,
  normalizationStatus = "idle",
  normalizationError = "",
  onNormalize,
}: {
  readonly evidenceId: string;
  readonly normalizeDisabled?: boolean;
  readonly normalization?: EvidenceAiNormalization;
  readonly normalizationStatus?: NormalizationStatus;
  readonly normalizationError?: string;
  readonly onNormalize?: (evidenceId: string) => Promise<boolean>;
}) {
  const buttonLabels: Record<NormalizationStatus, string> = {
    enqueueing: "Encolando normalización…",
    queued: "En cola para normalizar con IA",
    running: "Normalizando con IA…",
    idle: normalization === undefined ? "Normalizar con IA" : "Volver a normalizar con IA",
  };
  const data = normalization?.data;
  return (
    <section className="detail-fact decodo-ai-normalization" aria-labelledby="decodo-ai-normalization-heading">
      <h3 id="decodo-ai-normalization-heading">Resumen estructurado (asistido por IA)</h3>
      <p className="detail-note">
        Vista derivada generada a pedido con NVIDIA Build a partir de la página guardada. No modifica ni reemplaza la evidencia factual recopilada por Decodo.
      </p>
      <div className="decodo-ai-actions">
        <button
          type="button"
          className="workspace-button"
          disabled={normalizeDisabled || normalizationStatus !== "idle" || onNormalize === undefined}
          onClick={() => { if (onNormalize !== undefined) void onNormalize(evidenceId); }}
        >
          {buttonLabels[normalizationStatus]}
        </button>
      </div>
      {normalizationError !== "" && <NormalizationAlert error={normalizationError} />}
      {normalization !== undefined && data !== undefined && (
        <div className="decodo-ai-summary">
          <dl className="fact-list">
            <dt>Modelo</dt><dd className="break-value">{normalization.model}</dd>
            <dt>Generado</dt><dd>{formatDate(normalization.generatedAt)}</dd>
            {data.entityName !== undefined && data.entityName !== "" && (
              <><dt>Entidad</dt><dd className="break-value">{data.entityName}</dd></>
            )}
            <dt>Resumen</dt><dd className="break-value">{data.summary}</dd>
            {NORMALIZED_PRIMARY_LISTS.map(([label, field]) => {
              const items = data[field];
              if (items.length === 0) return null;
              return (
                <Fragment key={field}>
                  <dt>{label}</dt>
                  <dd>
                    <ul className="decodo-ai-list">
                      {items.map((item, index) => <li key={`${index}-${item}`} className="break-value">{item}</li>)}
                    </ul>
                  </dd>
                </Fragment>
              );
            })}
            {data.relatedUrls.length > 0 && (
              <>
                <dt>Enlaces relacionados</dt>
                <dd>
                  <ul className="decodo-ai-list">
                    {data.relatedUrls.map((url, index) => (
                      <li key={`${index}-${url}`} className="break-value"><SafeLink value={url} publicOnly /></li>
                    ))}
                  </ul>
                </dd>
              </>
            )}
            {data.limitations.length > 0 && (
              <>
                <dt>Limitaciones</dt>
                <dd>
                  <ul className="decodo-ai-list">
                    {data.limitations.map((item, index) => <li key={`${index}-${item}`} className="break-value">{item}</li>)}
                  </ul>
                </dd>
              </>
            )}
          </dl>
          <details className="decodo-ai-json">
            <summary>Ver JSON estructurado</summary>
            <pre aria-label="JSON normalizado por IA">{JSON.stringify(data, null, 2)}</pre>
          </details>
        </div>
      )}
    </section>
  );
}

/** The FaceCheck search behind a candidate group, a single candidate or the search action itself. */
function facecheckActionOf(node: WorkspaceNode): string | undefined {
  if (node.kind === "leaf-group" && node.hiddenMembers !== undefined) {
    return node.producerActionId ?? node.members?.[0]?.evidence?.actionId;
  }
  if (node.kind === "evidence" && node.evidence?.sourceId === "facecheck:photo") return node.evidence.actionId;
  if (node.kind === "action" && node.action?.spec.catalogId === "facecheck.photo.v1") return node.action.id;
  return undefined;
}

function facecheckGroupHeading(members: readonly WorkspaceNode[], investigation: Investigation): string {
  const latest = new Map(investigation.validations.map((decision) => [decision.evidenceId, decision.status]));
  const accepted = members.filter((member) => latest.get(member.evidence?.id ?? "") === "accepted").length;
  const pending = members.length - accepted;
  if (accepted > 0 && pending > 0) return `Candidatos · ${accepted} aceptados y ${pending} por revisar`;
  if (accepted > 0) return `Candidatos aceptados · ${accepted}`;
  if (pending > 0) return `Candidatos por revisar · ${pending}`;
  return "Ningún candidato aceptado";
}

function canQueueDecodo(investigation: Investigation, evidence: EvidenceRecord | undefined): evidence is EvidenceRecord {
  if (evidence?.sourceId !== "facecheck:photo" || latestValidationStatus(investigation, evidence.id) !== "accepted" ||
    !isSafePublicHttpUrl(evidence.finding?.url)) return false;
  const sourceSeedId = findingSeedNodeId(evidence.id);
  return !investigation.actions.some((action) => action.spec.catalogId === "decodo.url.v1" && action.sourceSeedId === sourceSeedId);
}

function DecodoReadinessNotes({ investigation, decodoConfigured }: Pick<WorkspaceDetailsProps, "investigation" | "decodoConfigured">) {
  return <>
    {!authorizationCovers(investigation.authorization, "decodo.url.v1") && <p className="detail-note">El expediente requiere autorización para ejecutar Decodo.</p>}
    {decodoConfigured === false && <p className="detail-note">Falta el token de Decodo. <a href="#/ajustes">Configurar Decodo</a></p>}
  </>;
}

type LeafGroupDetailsProps = Pick<WorkspaceDetailsProps, "investigation" | "disabled" | "decodoConfigured" | "onSelectNode" | "onQueueDecodo"> & {
  readonly node: WorkspaceNode;
};

function LeafGroupDetails({ node, investigation, disabled, decodoConfigured, onSelectNode, onQueueDecodo }: LeafGroupDetailsProps) {
  const [page, setPage] = useState(0);
  const members = node.members ?? [];
  const lastPage = Math.max(0, Math.ceil(members.length / GRAPH_PAGE_SIZE) - 1);
  const currentPage = Math.min(page, lastPage);
  const start = currentPage * GRAPH_PAGE_SIZE;
  const facecheck = node.hiddenMembers !== undefined;
  const eligibleIds = new Set(facecheck && onQueueDecodo !== undefined
    ? members.flatMap(({ evidence }) => canQueueDecodo(investigation, evidence) ? [evidence.id] : [])
    : []);
  return (
    <section className="detail-fact" aria-labelledby="group-heading">
      <h3 id="group-heading">{facecheck ? facecheckGroupHeading(members, investigation) : `Semillas agrupadas · ${members.length} resultados`}</h3>
      {facecheck
        ? <p className="detail-note">{node.hiddenMembers! > 0 && `Los ${node.hiddenMembers} descartados no se muestran en el grafo; siguen en la pestaña Descartados de la revisión. `}Abrir un candidato no ejecuta ninguna acción.</p>
        : <p className="detail-note">Son semillas producidas por la misma acción, sin acciones asociadas por ahora. Abrir un resultado no ejecuta ninguna acción ni expande el grafo.</p>}
      {eligibleIds.size > 0 && <>
        <p className="detail-note">Podés encolar el scraping de las URL públicas aceptadas sin volver a ejecutar FaceCheck.</p>
        <DecodoReadinessNotes investigation={investigation} decodoConfigured={decodoConfigured} />
        <button type="button" className="workspace-button" disabled={disabled} onClick={() => void onQueueDecodo?.([...eligibleIds])}>
          {eligibleIds.size === 1 ? "Aplicar Decodo" : `Aplicar Decodo a aceptados (${eligibleIds.size})`}
        </button>
      </>}
      <ul className="leaf-group-members">
        {members.slice(start, start + GRAPH_PAGE_SIZE).map((member) => {
          const evidenceId = member.evidence?.id;
          const canQueue = evidenceId !== undefined && eligibleIds.has(evidenceId);
          return <li key={member.id} className={canQueue ? "leaf-group-member--with-action" : undefined}>
            <button type="button" className="workspace-button"
              aria-label={`Ver resultado: ${member.title}`} disabled={onSelectNode === undefined}
              onClick={() => onSelectNode?.(member.id)}>{member.title}</button>
            {canQueue && <button type="button" className="workspace-button" aria-label={`Aplicar Decodo a ${member.title}`}
              disabled={disabled} onClick={() => void onQueueDecodo?.([evidenceId])}>Decodo</button>}
          </li>;
        })}
      </ul>
      {lastPage > 0 && <nav className="graph-pagination" aria-label="Páginas del grupo">
        <p role="status">Resultados {start + 1}–{Math.min(start + GRAPH_PAGE_SIZE, members.length)} de {members.length}</p>
        <div>
          <button type="button" aria-label="Primera página del grupo" disabled={currentPage === 0} onClick={() => setPage(0)}>«</button>
          <button type="button" aria-label="Página anterior del grupo" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Anterior</button>
          <span>{currentPage + 1} / {lastPage + 1}</span>
          <button type="button" aria-label="Siguiente página del grupo" disabled={currentPage === lastPage} onClick={() => setPage(currentPage + 1)}>Siguiente</button>
          <button type="button" aria-label="Última página del grupo" disabled={currentPage === lastPage} onClick={() => setPage(lastPage)}>»</button>
        </div>
      </nav>}
    </section>
  );
}

export function WorkspaceDetails({ investigation, node, disabled, ghuntConnected, facecheckConfigured, decodoConfigured,
  normalization, normalizationStatus, normalizeDisabled, normalizationError, onValidate, onSelectNode, onQueueDecodo,
  onNormalizeEvidence, onApproveGravatar, onReviewFacecheck }: WorkspaceDetailsProps) {
  const [validationReason, setValidationReason] = useState("");
  const [approvalReason, setApprovalReason] = useState("");
  const [formError, setFormError] = useState("");
  const decodoFinding = node?.evidence?.sourceId === "decodo:url" ? node.evidence.finding : undefined;
  const isDecodoAction = node?.action?.spec.catalogId === "decodo.url.v1";

  async function validate(evidenceId: string, status: ValidationStatus) {
    if (validationReason.trim() === "") {
      setFormError("Escribí un motivo para validar la observación.");
      return;
    }
    const done = await onValidate(evidenceId, status, validationReason);
    if (done) setValidationReason("");
  }

  function updateReason(setter: (value: string) => void, value: string) {
    setter(value);
    setFormError("");
  }

  return (
    <aside className="workspace-detail-panel" aria-labelledby="detail-heading">
      <div className="detail-heading-row">
        <span className="detail-mark" aria-hidden="true">+</span>
        <div>
          <p className="eyebrow">REGISTRO SELECCIONADO</p>
          <h2 id="detail-heading">Detalle del nodo</h2>
        </div>
      </div>
      {node === null ? (
        <p className="detail-empty">Seleccioná una semilla, acción u observación del grafo.</p>
      ) : (
        <div className="detail-content" key={node.id}>
          {onReviewFacecheck !== undefined && facecheckActionOf(node) !== undefined &&
            <FacecheckReviewCall investigation={investigation} actionId={facecheckActionOf(node)!} onReview={onReviewFacecheck} />}
          {node.kind === "leaf-group" && <LeafGroupDetails key={node.id} node={node} investigation={investigation} disabled={disabled}
            decodoConfigured={decodoConfigured} onSelectNode={onSelectNode} onQueueDecodo={onQueueDecodo} />}
          {node.groupId !== undefined && onSelectNode !== undefined && <button type="button" className="workspace-button"
            onClick={() => onSelectNode(node.groupId!)}>Volver al grupo</button>}
          {node.relatedParentId !== undefined && onSelectNode !== undefined && <button type="button" className="workspace-button"
            onClick={() => onSelectNode(node.relatedParentId!)}>Volver a la semilla vinculada</button>}
          {node.kind === "seed" && node.seedValue !== undefined && (
            <>
              <section className="detail-fact" aria-labelledby="selected-seed-heading">
                <h3 id="selected-seed-heading">Semilla</h3>
                <dl className="fact-list">
                  <dt>Tipo de dato</dt><dd>Correo electrónico</dd>
                  <dt>Valor</dt><dd className="break-value">{node.seedValue}</dd>
                  <dt>Estado</dt><dd>Dato aportado al expediente</dd>
                </dl>
              </section>
              {investigation.emailSeeds.some((seed) => seed.value === node.seedValue) && <p className="detail-note">User Scanner se encola al agregar el correo; al finalizar, si encuentra Gravatar se encola la consulta y, si no, se propone para tu aprobación. Las consultas loud pueden enviar correos o notificaciones. La ejecución requiere autorización y respeta el modo de avance.</p>}
            </>
          )}

          {node.kind === "action" && node.action !== undefined && (
            <>
              <section className="detail-fact" aria-labelledby="selected-action-heading">
                <h3 id="selected-action-heading">{actionTitle(node.action)}</h3>
                <dl className="fact-list">
                  <dt>Proveedor</dt><dd>{node.action.spec.provider}</dd>
                  <dt>{isDecodoAction ? "URL objetivo" : "Semilla"}</dt><dd className="break-value">{isDecodoAction
                    ? <SafeLink value={node.action.spec.seed.value} publicOnly /> : node.action.spec.seed.value}</dd>
                  <dt>Estado de la acción</dt><dd><StateValue value={node.state} /></dd>
                </dl>
                <details className="detail-provenance">
                  <summary>Origen y trazabilidad</summary>
                <dl className="fact-list">
                  <dt>Identificador</dt><dd><TechnicalValue label="Identificador de acción" value={node.action.id} /></dd>
                  <dt>Catálogo</dt><dd><TechnicalValue label="Catálogo de acción" value={node.action.spec.catalogId} /></dd>
                  <dt>{node.action.queuedByCatalog ? "Origen del catálogo" : "Motivo de propuesta histórica"}</dt><dd>{node.action.proposalReason}</dd>
                  <dt>Registrada</dt><dd>{formatDate(node.action.proposedAt)}</dd>
                  {node.action.approval !== undefined && <>
                    <dt>Motivo de aprobación</dt><dd>{node.action.approval.reason}</dd>
                    <dt>Aprobada</dt><dd>{formatDate(node.action.approval.at)}</dd>
                  </>}
                  {node.action.claim !== undefined && <>
                    <dt>Reclamo</dt><dd><TechnicalValue label="Identificador del reclamo" value={node.action.claim.id} /></dd>
                    <dt>Inicio reclamado</dt><dd>{formatDate(node.action.claim.claimedAt)}</dd>
                  </>}
                  {node.action.completedAt !== undefined && <><dt>Finalización</dt><dd>{formatDate(node.action.completedAt)}</dd></>}
                  {node.action.failure !== undefined && <><dt>Detalle de error</dt><dd>{node.action.failure}</dd></>}
                  {node.action.unsupportedObservationCount !== undefined && <><dt>Observaciones no admitidas</dt><dd>{node.action.unsupportedObservationCount}</dd></>}
                </dl>
                </details>
                {node.action.spec.catalogId === "ghunt.email.v1" && node.action.status === "queued" && <>
                  {!authorizationCovers(investigation.authorization, node.action.spec.catalogId) && <p className="detail-note">El expediente requiere autorización para ejecutar GHunt.</p>}
                  {ghuntConnected === false && <p className="detail-note"><span className="workspace-state-value">Requiere login</span> · <a href="#/ajustes?seccion=ghunt">Conectar Google</a></p>}
                  {ghuntConnected === null && <p className="detail-note">No se pudo confirmar la conexión de Google.</p>}
                </>}
                {node.action.spec.catalogId === "facecheck.photo.v1" && node.action.status === "queued" && facecheckConfigured === false &&
                  <p className="detail-note">Falta el token de FaceCheck. <a href="#/ajustes">Configurar FaceCheck</a></p>}
                {isDecodoAction && node.action.status === "queued" && <>
                  <DecodoReadinessNotes investigation={investigation} decodoConfigured={decodoConfigured} />
                  {!isActionEligibleByParentValidation(investigation, node.action) && <p className="detail-note">La coincidencia de FaceCheck ya no está aceptada. Decodo espera a que vuelvas a aceptarla.</p>}
                </>}
                {node.action.status === "claimed" && (
                  <p className="detail-warning" role="note">Acción reclamada: efecto externo incierto o aún en curso. Esta interfaz no la vuelve a ejecutar.</p>
                )}
              </section>
              {node.action.status === "proposed" && (node.action.spec.catalogId === "gravatar.email.v1" && onApproveGravatar !== undefined ? (
                <section className="detail-control" aria-labelledby="approval-heading">
                  <h3 id="approval-heading">¿Querés buscarlo por Gravatar?</h3>
                  <p className="detail-note">Aprobar agrega la acción a la cola; su ejecución requiere autorización, ausencia de pausa y respeta el modo de avance.</p>
                  <label className="form-field"><span>Motivo de aprobación</span>
                    <textarea value={approvalReason} maxLength={2_000} rows={3} disabled={disabled} onChange={(event) => setApprovalReason(event.currentTarget.value)} />
                  </label>
                  <button className="workspace-button" type="button" disabled={disabled || approvalReason.trim() === ""} onClick={() => void onApproveGravatar(node.action!.id, approvalReason)}>Aprobar búsqueda de Gravatar</button>
                </section>
              ) : <p className="detail-note">Propuesta histórica conservada; no forma parte de la cola ejecutable.</p>)}
            </>
          )}

          {node.kind === "result" && node.action !== undefined && (
            <section className="detail-fact" aria-labelledby="selected-result-heading">
              <h3 id="selected-result-heading">{node.state === "failed" ? "Error de ejecución" : "Sin información admitida"}</h3>
              <dl className="fact-list">
                <dt>Resultado</dt><dd><StateValue value={node.state} /></dd>
                <dt>Proveedor</dt><dd>{node.action.spec.provider}</dd>
                <dt>Semilla</dt><dd className="break-value">{node.action.spec.seed.value}</dd>
                <dt>Acción referida</dt><dd><TechnicalValue label="Identificador de acción" value={node.action.id} /></dd>
                {node.action.completedAt !== undefined && <><dt>Finalización</dt><dd>{formatDate(node.action.completedAt)}</dd></>}
                {node.state === "failed" && <><dt>Detalle de error</dt><dd className="break-value">{node.action.failure || "La acción falló sin un detalle de error registrado."}</dd></>}
                {node.action.unsupportedObservationCount !== undefined && <><dt>Observaciones no admitidas</dt><dd>{node.action.unsupportedObservationCount}</dd></>}
              </dl>
              <p className="detail-note">{node.state === "failed" ? "La ejecución falló; no se infiere un estado de registro." : "La ejecución terminó correctamente, pero no produjo observaciones admitidas. Esto no significa que el correo no esté registrado."} Este resultado deriva de la acción; no es evidencia ni admite validación humana.</p>
            </section>
          )}

          {node.kind === "evidence" && node.evidence !== undefined && (
            <>
              {node.relatedNodes !== undefined && onSelectNode !== undefined && <section className="detail-fact" aria-labelledby="related-observations-heading">
                <h3 id="related-observations-heading">Observaciones del mismo perfil</h3>
                <p className="detail-note">Comparten el enlace del perfil; esto no confirma identidad ni titularidad. Cada observación conserva su validación independiente.</p>
                {node.relatedNodes.map((related) => <button key={related.id} type="button" className="workspace-button"
                  onClick={() => onSelectNode(related.id)}>Ver observación relacionada · {related.evidence?.finding?.upstreamStatus}</button>)}
              </section>}
              {node.profileSeed && <section className="detail-fact" aria-labelledby="profile-seed-heading">
                <h3 id="profile-seed-heading">{node.profileSeed.label}</h3>
                <p className="break-value">{node.profileSeed.isUrl
                  ? <SafeLink value={node.profileSeed.value} /> : node.profileSeed.value}</p>
                <p className="detail-note">Semilla descubierta en {node.evidence.provider}. Seleccionarla no ejecuta nuevas búsquedas. No confirma identidad ni titularidad.</p>
                <p className="detail-note">La validación de abajo corresponde a la observación original completa, no a este campo por separado.</p>
              </section>}
              {decodoFinding !== undefined && <DecodoPageDetails finding={decodoFinding} />}
              {node.evidence.sourceId === "decodo:url" && (
                <DecodoAiNormalizationSection
                  evidenceId={node.evidence.id}
                  normalizeDisabled={normalizeDisabled}
                  normalization={normalization}
                  normalizationStatus={normalizationStatus}
                  normalizationError={normalizationError}
                  onNormalize={onNormalizeEvidence}
                />
              )}
              <section className="detail-fact" aria-labelledby="selected-evidence-heading">
                <h3 id="selected-evidence-heading">{evidenceHeading(node.evidence)}</h3>
                <dl className="fact-list">
                  <dt>Identificador de evidencia</dt><dd><TechnicalValue label="Identificador de evidencia" value={node.evidence.id} /></dd>
                  <dt>Resultado</dt><dd><StateValue value={node.evidence.status} /></dd>
                  <dt>Proveedor</dt><dd>{node.evidence.provider}</dd>
                  <dt>Fuente</dt><dd><TechnicalValue label="Fuente de la evidencia" value={node.evidence.sourceId} /></dd>
                  <dt>Acción referida</dt><dd><TechnicalValue label="Identificador de la acción referida" value={node.evidence.actionId} /></dd>
                  <dt>Semilla observada</dt><dd className="break-value">{node.evidence.seed.value}</dd>
                  <dt>Registrada</dt><dd>{formatDate(node.evidence.recordedAt)}</dd>
                  {node.evidence.finding && <>
                    <dt>Tipo de objetivo descubierto</dt><dd>{TARGET_LABELS[node.evidence.finding.target.kind]}</dd>
                    <dt>Objetivo observado</dt><dd className="break-value">{node.evidence.finding.target.kind === "url"
                      ? <SafeLink value={node.evidence.finding.target.value} publicOnly /> : node.evidence.finding.target.value}</dd>
                    <dt>Estado original de la herramienta</dt><dd>{node.evidence.finding.upstreamStatus}</dd>
                    {decodoFinding === undefined && <><dt>Enlace</dt><dd className="break-value"><SafeLink value={node.evidence.finding.url} /></dd></>}
                    <dt>Categoría</dt><dd>{node.evidence.finding.category}</dd>
                    {decodoFinding === undefined && <><dt>Motivo informado</dt><dd className="break-value">{node.evidence.finding.reason}</dd></>}
                  </>}
                </dl>
                {node.evidence.finding && <>
                  <h4>Metadatos y procedencia</h4>
                  <dl className="fact-list">{Object.entries(node.evidence.finding.extra)
                    .filter(([key]) => decodoFinding === undefined || !DECODO_PAGE_FIELDS.has(key))
                    .map(([key, value]) => <Fragment key={key}><dt className="break-value">{key}</dt><dd className="break-value">{String(value)}</dd></Fragment>)}</dl>
                  {decodoFinding === undefined && <>
                    <h4>Referencias multimedia</h4>
                    <dl className="fact-list">{Object.entries(node.evidence.finding.media).map(([key, value]) => <Fragment key={key}><dt className="break-value">{key}</dt><dd className="break-value"><MediaValue value={value} /></dd></Fragment>)}</dl>
                  </>}
                </>}
                {node.evidence.sourceId === "facecheck:photo" && <p className="detail-warning">
                  Este resultado es un candidato: FaceCheck encontró una cara parecida a la foto de perfil, no necesariamente la misma persona. Necesita que confirmes o rechaces si es esa persona. Si lo aceptás, se encola el scraping de su URL pública con Decodo, nunca de la foto ni de la miniatura. En avance automático no necesitás ejecutar otra acción.
                  {node.evidence.finding?.extra.testing_mode === true && " Se encontró en modo prueba (solo 100.000 caras), así que es poco fiable."}
                </p>}
                <p className="detail-warning">La herramienta reportó un hallazgo positivo para el objetivo observado. No confirma identidad ni titularidad y puede contener errores. La confianza informada por la herramienta no es una validación humana.</p>
              </section>
              {onQueueDecodo !== undefined && canQueueDecodo(investigation, node.evidence) && <section className="detail-control" aria-labelledby="decodo-action-heading">
                <h3 id="decodo-action-heading">Acción de Decodo</h3>
                <p className="detail-note">Agrega a la cola el scraping de esta URL pública. No vuelve a ejecutar FaceCheck.</p>
                <DecodoReadinessNotes investigation={investigation} decodoConfigured={decodoConfigured} />
                <button type="button" className="workspace-button" disabled={disabled}
                  onClick={() => void onQueueDecodo([node.evidence!.id])}>Aplicar scraping con Decodo</button>
              </section>}
              <section className="detail-control" aria-labelledby="validation-heading">
                <h3 id="validation-heading">Validación humana</h3>
                <label className="form-field">
                  <span>Motivo de validación</span>
                  <textarea value={validationReason} maxLength={2_000} onChange={(event) => updateReason(setValidationReason, event.currentTarget.value)} disabled={disabled} rows={3} />
                </label>
                <div className="validation-actions">
                  <button className="workspace-button" type="button" disabled={disabled || validationReason.trim() === ""} onClick={() => void validate(node.evidence!.id, "accepted")}>Aceptar observación</button>
                  <button className="workspace-button" type="button" disabled={disabled || validationReason.trim() === ""} onClick={() => void validate(node.evidence!.id, "rejected")}>Rechazar observación</button>
                  <button className="workspace-button" type="button" disabled={disabled || validationReason.trim() === ""} onClick={() => void validate(node.evidence!.id, "inconclusive")}>Marcar inconclusa</button>
                </div>
              </section>
              <details className="detail-history">
                <summary>Historial de validaciones</summary>
                {investigation.validations.filter((decision) => decision.evidenceId === node.evidence!.id).length === 0 ? (
                  <p>Todavía no hay decisiones humanas sobre esta evidencia.</p>
                ) : (
                  <ol>
                    {investigation.validations.filter((decision) => decision.evidenceId === node.evidence!.id).map((decision) => (
                      <li key={decision.id}>
                        <StateValue value={decision.status} /> · {decision.reason} <time dateTime={decision.at}>{formatDate(decision.at)}</time>
                      </li>
                    ))}
                  </ol>
                )}
              </details>
            </>
          )}
          {formError !== "" && <p className="detail-form-error" role="alert">{formError}</p>}
        </div>
      )}
    </aside>
  );
}
