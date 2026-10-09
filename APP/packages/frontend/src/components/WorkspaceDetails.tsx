import { useState } from "react";
import type { Investigation, ValidationStatus } from "@investia/core";
import type { WorkspaceNode } from "../pages/workspace-model";
import { workspaceStatusLabel } from "../pages/workspace-status";

export interface WorkspaceDetailsProps {
  readonly investigation: Investigation;
  readonly node: WorkspaceNode | null;
  readonly disabled: boolean;
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

export function WorkspaceDetails({ investigation, node, disabled, onValidate }: WorkspaceDetailsProps) {
  const [validationReason, setValidationReason] = useState("");
  const [formError, setFormError] = useState("");

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
              <p className="detail-note">Las semillas nuevas incorporan su comprobación de registro en GitHub a la cola del expediente, sin aprobación por nodo.</p>
            </>
          )}

          {node.kind === "action" && node.action !== undefined && (
            <>
              <section className="detail-fact" aria-labelledby="selected-action-heading">
                <h3 id="selected-action-heading">Comprobación de registro en GitHub</h3>
                <dl className="fact-list">
                  <dt>Proveedor</dt><dd>{node.action.spec.provider}</dd>
                  <dt>Semilla</dt><dd className="break-value">{node.action.spec.seed.value}</dd>
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
                {node.action.status === "claimed" && (
                  <p className="detail-warning" role="note">Acción reclamada: efecto externo incierto o aún en curso. Esta interfaz no la vuelve a ejecutar.</p>
                )}
              </section>
              {node.action.status === "proposed" && <p className="detail-note">Propuesta histórica conservada; no forma parte de la cola ejecutable.</p>}
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
