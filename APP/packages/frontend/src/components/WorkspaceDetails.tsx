import { useState } from "react";
import type { Investigation, ValidationStatus } from "@investia/core";
import type { WorkspaceNode } from "../pages/workspace-model";
import { workspaceStatusLabel } from "../pages/workspace-status";

export interface WorkspaceDetailsProps {
  readonly investigation: Investigation;
  readonly node: WorkspaceNode | null;
  readonly disabled: boolean;
  readonly onPropose: (email: string, reason: string) => Promise<boolean>;
  readonly onApprove: (actionId: string, reason: string) => Promise<boolean>;
  readonly onValidate: (evidenceId: string, status: ValidationStatus, reason: string) => Promise<boolean>;
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

export function WorkspaceDetails({ investigation, node, disabled, onPropose, onApprove, onValidate }: WorkspaceDetailsProps) {
  const [proposalReason, setProposalReason] = useState("");
  const [approvalReason, setApprovalReason] = useState("");
  const [validationReason, setValidationReason] = useState("");
  const [formError, setFormError] = useState("");

  async function propose(email: string) {
    if (proposalReason.trim() === "") {
      setFormError("Escribí un motivo para proponer la comprobación.");
      return;
    }
    const done = await onPropose(email, proposalReason);
    if (done) setProposalReason("");
  }

  async function approve(actionId: string) {
    if (approvalReason.trim() === "") {
      setFormError("Escribí un motivo para aprobar la acción.");
      return;
    }
    const done = await onApprove(actionId, approvalReason);
    if (done) setApprovalReason("");
  }

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
        <span className="detail-mark" aria-hidden="true">✳</span>
        <div>
          <p className="eyebrow">REGISTRO SELECCIONADO</p>
          <h2 id="detail-heading">Detalle del nodo</h2>
        </div>
      </div>
      {node === null ? (
        <p className="detail-empty">Seleccioná una semilla, acción u observación del grafo.</p>
      ) : (
        <div className="detail-content" key={node.id}>
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
              <section className="detail-control" aria-labelledby="github-proposal-heading">
                <h3 id="github-proposal-heading">Proponer comprobación de registro en GitHub</h3>
                <p>Holehe · registro en GitHub. Proponer no aprueba ni ejecuta.</p>
                {investigation.actions.some((action) => action.spec.seed.value === node.seedValue) ? (
                  <p className="detail-note">Ya hay una acción GitHub registrada para esta semilla.</p>
                ) : (
                  <>
                    <label className="form-field">
                      <span>Motivo para proponer</span>
                      <textarea value={proposalReason} maxLength={2_000} onChange={(event) => updateReason(setProposalReason, event.currentTarget.value)} disabled={disabled} rows={3} />
                    </label>
                    <button className="workspace-button workspace-button--primary" type="button" disabled={disabled || proposalReason.trim() === ""} onClick={() => void propose(node.seedValue!)}>
                      Proponer comprobación de registro en GitHub
                    </button>
                  </>
                )}
              </section>
            </>
          )}

          {node.kind === "action" && node.action !== undefined && (
            <>
              <section className="detail-fact" aria-labelledby="selected-action-heading">
                <h3 id="selected-action-heading">Comprobación de registro en GitHub</h3>
                <dl className="fact-list">
                  <dt>Proveedor</dt><dd>{node.action.spec.provider}</dd>
                  <dt>Semilla</dt><dd className="break-value">{node.action.spec.seed.value}</dd>
                  <dt>Estado de la acción</dt><dd><StateValue value={node.action.status} /></dd>
                </dl>
                <details className="detail-provenance">
                  <summary>Propuesta y trazabilidad</summary>
                <dl className="fact-list">
                  <dt>Identificador</dt><dd><TechnicalValue label="Identificador de acción" value={node.action.id} /></dd>
                  <dt>Catálogo</dt><dd><TechnicalValue label="Catálogo de acción" value={node.action.spec.catalogId} /></dd>
                  <dt>Motivo de propuesta</dt><dd>{node.action.proposalReason}</dd>
                  <dt>Propuesta</dt><dd>{formatDate(node.action.proposedAt)}</dd>
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
                {node.action.status === "claimed" && (
                  <p className="detail-warning" role="note">Acción reclamada: efecto externo incierto o aún en curso. Esta interfaz no la vuelve a ejecutar.</p>
                )}
              </section>
              {node.action.status === "proposed" && node.action.approval === undefined && (
                <section className="detail-control" aria-labelledby="approval-heading">
                  <h3 id="approval-heading">Aprobación explícita</h3>
                  <p>Aprobar solo la incorpora a la cola; no inicia una ejecución.</p>
                  <label className="form-field">
                    <span>Motivo de aprobación</span>
                    <textarea value={approvalReason} maxLength={2_000} onChange={(event) => updateReason(setApprovalReason, event.currentTarget.value)} disabled={disabled} rows={3} />
                  </label>
                  <button className="workspace-button workspace-button--primary" type="button" disabled={disabled || approvalReason.trim() === ""} onClick={() => void approve(node.action!.id)}>
                    Aprobar acción
                  </button>
                </section>
              )}
            </>
          )}

          {node.kind === "evidence" && node.evidence !== undefined && (
            <>
              <section className="detail-fact" aria-labelledby="selected-evidence-heading">
                <h3 id="selected-evidence-heading">Observación de registro</h3>
                <dl className="fact-list">
                  <dt>Identificador de evidencia</dt><dd><TechnicalValue label="Identificador de evidencia" value={node.evidence.id} /></dd>
                  <dt>Resultado</dt><dd><StateValue value={node.evidence.status} /></dd>
                  <dt>Proveedor</dt><dd>{node.evidence.provider}</dd>
                  <dt>Fuente</dt><dd><TechnicalValue label="Fuente de la evidencia" value={node.evidence.sourceId} /></dd>
                  <dt>Acción referida</dt><dd><TechnicalValue label="Identificador de la acción referida" value={node.evidence.actionId} /></dd>
                  <dt>Semilla observada</dt><dd className="break-value">{node.evidence.seed.value}</dd>
                  <dt>Registrada</dt><dd>{formatDate(node.evidence.recordedAt)}</dd>
                </dl>
                <p className="detail-warning">Un registro no confirma identidad.</p>
              </section>
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
