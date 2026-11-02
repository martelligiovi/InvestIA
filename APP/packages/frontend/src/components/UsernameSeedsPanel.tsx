import { useState } from "react";
import { USERNAME_SEED_PATTERN, usernameProposals, type Investigation } from "@investia/core";

interface UsernameSeedsPanelProps {
  readonly investigation: Investigation;
  readonly disabled: boolean;
  readonly onAdd: (username: string, reason: string) => Promise<boolean>;
  readonly onDecide: (username: string, decision: "accepted" | "rejected", reason: string) => Promise<boolean>;
}

/** Operator-controlled username seeds: discovered usernames run only after an explicit decision. */
export function UsernameSeedsPanel({ investigation, disabled, onAdd, onDecide }: UsernameSeedsPanelProps) {
  const [username, setUsername] = useState("");
  const [addReason, setAddReason] = useState("");
  const [decisionReason, setDecisionReason] = useState("");
  const proposals = usernameProposals(investigation);
  const decided = investigation.usernameSeeds ?? [];
  const candidate = username.trim();
  const candidateInvalid = candidate !== "" && !USERNAME_SEED_PATTERN.test(candidate);

  async function add() {
    if (await onAdd(candidate, addReason)) {
      setUsername("");
      setAddReason("");
    }
  }

  async function decide(value: string, decision: "accepted" | "rejected") {
    if (await onDecide(value, decision, decisionReason)) setDecisionReason("");
  }

  return (
    <div className="username-seeds-panel">
      <p className="dispatch-note">Los usernames descubiertos no se investigan solos: aceptarlos encola una búsqueda con Maigret, que corre solo con autorización vigente para Maigret.</p>
      <h3 id="username-proposals-heading">Propuestos</h3>
      {proposals.length === 0 ? <p>Sin usernames propuestos.</p> : (
        <>
          <label className="form-field">
            <span>Motivo de la decisión</span>
            <input value={decisionReason} maxLength={2_000} disabled={disabled} onChange={(event) => setDecisionReason(event.currentTarget.value)} />
          </label>
          <ul className="username-proposals" aria-label="Usernames propuestos">
            {proposals.map((proposal) => (
              <li key={proposal.value}>
                <span className="break-value">{proposal.value}</span> <span className="detail-note">· hallado por {proposal.provider}</span>
                <span className="username-proposal-actions">
                  <button className="workspace-button" type="button" aria-label={`Aceptar ${proposal.value}`} disabled={disabled || decisionReason.trim() === ""} onClick={() => void decide(proposal.value, "accepted")}>Aceptar</button>
                  <button className="workspace-button workspace-button--quiet" type="button" aria-label={`Rechazar ${proposal.value}`} disabled={disabled || decisionReason.trim() === ""} onClick={() => void decide(proposal.value, "rejected")}>Rechazar</button>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {decided.length > 0 && (
        <>
          <h3 id="username-decided-heading">Decididos</h3>
          <ul className="username-decided" aria-label="Usernames decididos">
            {decided.map((record) => (
              <li key={record.value}>
                <span className="break-value">{record.value}</span>{" · "}
                {record.origin.kind === "operator" ? "Aportado por el operador" : record.status === "accepted" ? "Aceptado" : "Rechazado"}
              </li>
            ))}
          </ul>
        </>
      )}
      <h3 id="username-add-heading">Agregar a mano</h3>
      <label className="form-field">
        <span>Username</span>
        <input value={username} maxLength={64} disabled={disabled} aria-invalid={candidateInvalid} aria-describedby="username-add-hint" onChange={(event) => setUsername(event.currentTarget.value)} />
      </label>
      {candidateInvalid && <p id="username-add-hint" className="detail-note">Usá letras, números, punto, guion o guion bajo, sin espacios ni guion inicial (hasta 64).</p>}
      <label className="form-field">
        <span>Motivo del username</span>
        <input value={addReason} maxLength={2_000} disabled={disabled} onChange={(event) => setAddReason(event.currentTarget.value)} />
      </label>
      <button className="workspace-button" type="button" disabled={disabled || candidate === "" || candidateInvalid || addReason.trim() === ""} onClick={() => void add()}>Agregar username</button>
    </div>
  );
}
