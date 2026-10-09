import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { INVESTIGATION_NAME_MAX_LENGTH, normalizeInvestigationName } from "@investia/core";
import { InvestigationApiClient } from "../api/client";
import { investigationHash } from "../routing";
import flower from "../assets/folk-flower.svg";

const RECOVERY_STORAGE_KEY = "investia.creation-recovery.v1";
const EMAIL_MAX_LENGTH = 320;
const EMAIL_PATTERN = /^(?!\.)(?!.*\.\.)([A-Z0-9_'+.\-]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9-]*\.)+[A-Z]{2,}$/i;
const EMAIL_SEED_REASON = "Semilla inicial aportada al crear la investigación.";
const CONSENT_REASON = "Consentimiento explícito al crear: autorizar consultas del catálogo para semillas actuales y futuras de este expediente hasta revocar la autorización.";

type RecoveryPhase = "creating" | "uncertain" | "partial";
interface RecoveryRecord {
  readonly version: 1;
  readonly phase: RecoveryPhase;
  readonly name: string;
  readonly intention: string;
  readonly advancementMode: "automatic" | "manual";
  readonly emails: readonly string[];
  readonly completedEmails: readonly string[];
  readonly consent?: boolean;
  readonly authorizationConfirmed?: boolean;
  readonly investigationId?: string;
}
interface EmailDraft {
  readonly key: number;
  readonly value: string;
}
type FieldErrors = Readonly<Record<string, string>>;
type RecoveryCheck = "checking" | "ready" | "error";

function readRecovery(): RecoveryRecord | null {
  try {
    const stored = window.sessionStorage.getItem(RECOVERY_STORAGE_KEY);
    if (stored === null) return null;
    const value: unknown = JSON.parse(stored);
    if (typeof value !== "object" || value === null) return null;
    const candidate = value as Partial<RecoveryRecord>;
    if (
      candidate.version !== 1 || typeof candidate.name !== "string" ||
      (candidate.intention !== undefined && typeof candidate.intention !== "string") ||
      (candidate.advancementMode !== undefined && candidate.advancementMode !== "automatic" && candidate.advancementMode !== "manual") ||
      !Array.isArray(candidate.emails) || candidate.emails.length === 0 ||
      !candidate.emails.every((email) => typeof email === "string") ||
      !Array.isArray(candidate.completedEmails) ||
      !candidate.completedEmails.every((email) => typeof email === "string")
    ) return null;
    const storedPhase = candidate.phase;
    if (storedPhase !== "creating" && storedPhase !== "uncertain" && storedPhase !== "partial") return null;
    const investigationId = typeof candidate.investigationId === "string" && candidate.investigationId.trim() !== ""
      ? candidate.investigationId
      : undefined;
    const phase: RecoveryPhase = investigationId === undefined
      ? storedPhase === "partial" ? "uncertain" : storedPhase
      : "partial";
    return {
      version: 1,
      phase,
      name: candidate.name,
      intention: candidate.intention ?? "",
      advancementMode: candidate.advancementMode ?? "manual",
      consent: candidate.consent === true,
      authorizationConfirmed: candidate.consent === true && candidate.authorizationConfirmed === true,
      emails: candidate.emails,
      completedEmails: candidate.completedEmails.filter((email) => candidate.emails?.includes(email)),
      ...(investigationId === undefined ? {} : { investigationId }),
    };
  } catch {
    return null;
  }
}

function persistRecovery(record: RecoveryRecord): boolean {
  try {
    window.sessionStorage.setItem(RECOVERY_STORAGE_KEY, JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

function clearRecovery(): void {
  try {
    window.sessionStorage.removeItem(RECOVERY_STORAGE_KEY);
  } catch {
    // Storage can be unavailable in restricted browser contexts.
  }
}

function mergePersistedEmails(record: RecoveryRecord, persistedEmails: readonly string[], authorizationRecorded = false): RecoveryRecord {
  const completed = new Set([...record.completedEmails, ...persistedEmails]);
  return {
    ...record,
    phase: "partial",
    completedEmails: record.emails.filter((email) => completed.has(email)),
    // A recorded revocation also resolves an uncertain grant: never overwrite it on retry.
    authorizationConfirmed: record.authorizationConfirmed === true || (record.consent === true && authorizationRecorded),
  };
}

function isComplete(record: RecoveryRecord): boolean {
  return (!record.consent || record.authorizationConfirmed === true) &&
    record.emails.every((email) => record.completedEmails.includes(email));
}

function completeInvestigation(id: string): void {
  clearRecovery();
  window.location.hash = investigationHash(id);
}

export function CreatePage() {
  const api = useMemo(() => new InvestigationApiClient(), []);
  const [recoveryAtLoad] = useState(readRecovery);
  const [recovery, setRecovery] = useState<RecoveryRecord | null>(recoveryAtLoad);
  const [name, setName] = useState(recoveryAtLoad?.name ?? "");
  const [intention, setIntention] = useState(recoveryAtLoad?.intention ?? "");
  const [manualMode, setManualMode] = useState(recoveryAtLoad?.advancementMode === "manual");
  const [consent, setConsent] = useState(recoveryAtLoad?.consent === true);
  const [emailRows, setEmailRows] = useState<readonly EmailDraft[]>(() =>
    (recoveryAtLoad?.emails ?? [""]).map((value, index) => ({ key: index + 1, value })),
  );
  const nextEmailKey = useRef((recoveryAtLoad?.emails.length ?? 1) + 1);
  const submissionLock = useRef(false);
  const [pending, setPending] = useState(false);
  const [recoveryCheck, setRecoveryCheck] = useState<RecoveryCheck>(
    recoveryAtLoad?.investigationId === undefined ? "ready" : "checking",
  );
  const [recoveryNotice, setRecoveryNotice] = useState("");
  const [storageProblem, setStorageProblem] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState("");

  useEffect(() => {
    if (recoveryAtLoad?.investigationId === undefined) return;
    let active = true;
    void api.getInvestigation(recoveryAtLoad.investigationId).then(
      (investigation) => {
        if (!active) return;
        const refreshed = mergePersistedEmails(
          recoveryAtLoad,
          investigation.emailSeeds.map((seed) => seed.value),
          investigation.authorization !== undefined,
        );
        if (isComplete(refreshed)) {
          completeInvestigation(recoveryAtLoad.investigationId!);
          setRecovery(null);
          return;
        }
        if (!persistRecovery(refreshed)) setStorageProblem(true);
        setRecovery(refreshed);
        setRecoveryCheck("ready");
      },
      () => {
        if (!active) return;
        setRecoveryCheck("error");
        setRecoveryNotice("No se pudo comprobar el estado del expediente. No se enviaron correos nuevos.");
      },
    );
    return () => { active = false; };
  }, []);

  function validateDraft(): { readonly name: string; readonly emails: readonly string[] } | null {
    const errors: Record<string, string> = {};
    let normalizedName = "";
    try {
      normalizedName = normalizeInvestigationName(name);
    } catch {
      if (name.trim().length === 0) {
        errors.name = "Ingresá un nombre para la investigación.";
      } else {
        errors.name = `El nombre debe tener hasta ${INVESTIGATION_NAME_MAX_LENGTH} caracteres.`;
      }
    }

    if (intention.trim().length === 0) errors.intention = "Ingresá la intención de la investigación.";

    if (emailRows.length === 0) errors.emails = "Agregá al menos un correo electrónico.";
    const normalizedEmails = emailRows.map((row) => row.value.trim());
    const emailCounts = new Map<string, number>();
    for (const email of normalizedEmails) {
      emailCounts.set(email, (emailCounts.get(email) ?? 0) + 1);
    }
    emailRows.forEach((row, index) => {
      const email = normalizedEmails[index] ?? "";
      const key = `email-${row.key}`;
      if (email.length === 0) {
        errors[key] = "Ingresá un correo electrónico.";
      } else if (email.length > EMAIL_MAX_LENGTH || !EMAIL_PATTERN.test(email)) {
        errors[key] = "Ingresá un correo electrónico válido (hasta 320 caracteres).";
      } else if ((emailCounts.get(email) ?? 0) > 1) {
        errors[key] = "Este correo está repetido.";
      }
    });

    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      setFormError("Revisá los campos marcados antes de crear la investigación.");
      const firstInvalid = Object.keys(errors)[0];
      if (firstInvalid !== undefined) {
        const firstInvalidId = firstInvalid === "name" || firstInvalid === "intention"
          ? `investigation-${firstInvalid}` : firstInvalid;
        window.requestAnimationFrame(() => document.getElementById(firstInvalidId)?.focus());
      }
      return null;
    }
    setFormError("");
    return { name: normalizedName, emails: normalizedEmails };
  }

  async function confirmAuthorization(record: RecoveryRecord): Promise<RecoveryRecord | null> {
    if (!record.consent || record.authorizationConfirmed === true) return record;
    if (record.investigationId === undefined) return null;
    try {
      const saved = await api.setAuthorization(record.investigationId, true, CONSENT_REASON);
      if (saved.authorization?.granted !== true) throw new Error("Authorization not confirmed");
      const confirmed = { ...record, authorizationConfirmed: true };
      setRecovery(confirmed);
      if (!persistRecovery(confirmed)) {
        setStorageProblem(true);
        setRecoveryNotice("La autorización se guardó, pero no su recibo de recuperación. Abrí el expediente antes de continuar.");
        return null;
      }
      return confirmed;
    } catch {
      setRecoveryNotice("No se pudo confirmar la autorización. No se enviaron correos nuevos. Al reintentar se consultará el expediente antes de volver a autorizar.");
      setRecoveryCheck("ready");
      return null;
    }
  }

  async function addUnresolvedEmails(record: RecoveryRecord): Promise<RecoveryRecord | null> {
    const id = record.investigationId;
    if (id === undefined) return null;
    let current = record;
    for (const email of record.emails) {
      if (current.completedEmails.includes(email)) continue;
      try {
        await api.addEmailSeed(id, email, EMAIL_SEED_REASON);
      } catch {
        setRecoveryNotice(
          `No se pudo confirmar el guardado de todos los correos. Se guardó ${current.completedEmails.length} de ${current.emails.length} correos. ` +
          "Al reintentar, primero se comprobará el expediente para evitar duplicados.",
        );
        setRecoveryCheck("ready");
        return current;
      }
      current = {
        ...current,
        phase: "partial",
        completedEmails: [...current.completedEmails, email],
      };
      if (!persistRecovery(current)) {
        setStorageProblem(true);
        setRecoveryNotice("Un correo se agregó, pero no se pudo guardar el recibo de recuperación. Abrí el expediente antes de continuar.");
        setRecoveryCheck("ready");
        return current;
      }
      setRecovery(current);
    }
    return current;
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submissionLock.current || recovery !== null) return;
    const validated = validateDraft();
    if (validated === null) return;

    submissionLock.current = true;
    setPending(true);
    setRecoveryNotice("");
    const initialRecord: RecoveryRecord = {
      version: 1,
      phase: "creating",
      name: validated.name,
      intention: intention.trim(),
      advancementMode: manualMode ? "manual" : "automatic",
      consent,
      authorizationConfirmed: false,
      emails: validated.emails,
      completedEmails: [],
    };
    if (!persistRecovery(initialRecord)) {
      setFormError("No se pudo guardar el borrador de recuperación en esta sesión; no se envió la solicitud.");
      setPending(false);
      submissionLock.current = false;
      return;
    }
    setRecovery(initialRecord);

    try {
      let createdId: string;
      try {
        const created = await api.createInvestigation(initialRecord.name, initialRecord.intention, initialRecord.advancementMode);
        if (typeof created.id !== "string" || created.id.trim() === "") {
          throw new Error("Creation response did not include an investigation id");
        }
        createdId = created.id;
      } catch {
        const uncertain: RecoveryRecord = { ...initialRecord, phase: "uncertain" };
        persistRecovery(uncertain);
        setRecovery(uncertain);
        setRecoveryNotice("No se pudo confirmar si se creó la investigación. Revisá el historial antes de iniciar otra; no se reenvió la solicitud automáticamente.");
        return;
      }

      const withId: RecoveryRecord = {
        ...initialRecord,
        phase: "partial",
        investigationId: createdId,
      };
      if (!persistRecovery(withId)) {
        setRecovery(withId);
        setStorageProblem(true);
        setRecoveryNotice("El expediente se creó, pero no se pudo guardar su recibo de recuperación. Abrilo antes de continuar.");
        setRecoveryCheck("ready");
        return;
      }
      setRecovery(withId);
      const authorized = await confirmAuthorization(withId);
      if (authorized === null) return;
      const completed = await addUnresolvedEmails(authorized);
      if (completed !== null && isComplete(completed)) completeInvestigation(createdId);
      else if (completed !== null) setRecovery(completed);
    } finally {
      setPending(false);
      submissionLock.current = false;
    }
  }

  async function handleRetry() {
    const current = recovery;
    if (submissionLock.current || current === null || current.investigationId === undefined || storageProblem) return;
    const investigationId = current.investigationId;
    submissionLock.current = true;
    setPending(true);
    setRecoveryCheck("checking");
    setRecoveryNotice("");
    try {
      const investigation = await api.getInvestigation(investigationId);
      let refreshed = mergePersistedEmails(current, investigation.emailSeeds.map((seed) => seed.value), investigation.authorization !== undefined);
      if (!persistRecovery(refreshed)) {
        setStorageProblem(true);
        setRecoveryNotice("No se pudo guardar el estado de recuperación; no se enviaron correos pendientes.");
        setRecoveryCheck("error");
        return;
      }
      setRecovery(refreshed);
      if (isComplete(refreshed)) {
        completeInvestigation(investigationId);
        return;
      }
      const authorized = await confirmAuthorization(refreshed);
      if (authorized === null) return;
      const completed = await addUnresolvedEmails(authorized);
      if (completed !== null) {
        refreshed = completed;
        setRecovery(refreshed);
        if (isComplete(refreshed)) completeInvestigation(investigationId);
      }
    } catch {
      setRecoveryCheck("error");
      setRecoveryNotice("No se pudo comprobar el expediente. No se enviaron correos nuevos; podés volver a consultar.");
    } finally {
      setPending(false);
      submissionLock.current = false;
    }
  }

  function updateEmail(key: number, value: string) {
    setEmailRows((rows) => rows.map((row) => row.key === key ? { ...row, value } : row));
    setFieldErrors((errors) => {
      const next = { ...errors };
      delete next[`email-${key}`];
      delete next.emails;
      return next;
    });
    setFormError("");
  }

  if (recovery !== null) {
    if (recovery.investigationId === undefined) {
      const isCreating = recovery.phase === "creating" && pending;
      return (
        <section className="creation-page recovery-page" aria-labelledby="create-title">
          <p className="eyebrow">APERTURA DE EXPEDIENTE · RECUPERACIÓN</p>
          <h1 id="create-title" className="document-title">Nueva <span>investigación</span></h1>
          {isCreating ? (
            <p className="recovery-alert" role="status">Creando la investigación y guardando el borrador de recuperación…</p>
          ) : (
            <>
              <p className="recovery-alert" role="alert">
                {recoveryNotice || "No se pudo confirmar si se creó la investigación."}
              </p>
              <p className="document-note">
                Revisá el historial para comprobar si existe antes de iniciar otra. La solicitud no se reintentará automáticamente.
              </p>
              <div className="recovery-actions">
                <a className="text-link" href="#/">Revisar historial <span aria-hidden="true">←</span></a>
                <button
                  className="text-button"
                  type="button"
                  onClick={() => {
                    clearRecovery();
                    setRecovery(null);
                    setRecoveryNotice("");
                  }}
                >
                  Ya revisé el historial; volver al formulario
                </button>
              </div>
            </>
          )}
        </section>
      );
    }

    const completedCount = recovery.completedEmails.length;
    const allComplete = isComplete(recovery);
    return (
      <section className="creation-page recovery-page" aria-labelledby="create-title">
        <p className="eyebrow">APERTURA DE EXPEDIENTE · RECUPERACIÓN</p>
        <h1 id="create-title" className="document-title">Carga <span>pendiente</span></h1>
        <p className="document-lead">La investigación <strong>{recovery.name}</strong> ya existe.</p>
        {recoveryCheck === "checking" && !pending && (
          <p className="recovery-alert" role="status">Comprobando los correos guardados en el expediente…</p>
        )}
        {pending && <p className="recovery-alert" role="status">Comprobando y guardando solo los correos pendientes…</p>}
        {recoveryCheck === "error" && !pending && (
          <p className="recovery-alert" role="alert">{recoveryNotice || "No se pudo revisar el expediente."}</p>
        )}
        {recoveryNotice !== "" && recoveryCheck !== "error" && !pending && (
          <p className="recovery-alert" role="alert">{recoveryNotice}</p>
        )}
        {!pending && recoveryCheck === "ready" && recoveryNotice === "" && (
          <p className="recovery-progress" role="status">
            Se guardó {completedCount} de {recovery.emails.length} correos iniciales.
          </p>
        )}
        {recovery.consent && !recovery.authorizationConfirmed && (
          <p className="document-note">Consentimiento conservado; autorización pendiente de confirmación. No se incorporarán semillas nuevas hasta confirmarla.</p>
        )}
        {!allComplete && (
          <p className="document-note">
            Si abrís el expediente ahora, los correos pendientes todavía no estarán incorporados. Las semillas ya guardadas pueden avanzar si el expediente está autorizado y sin pausa.
          </p>
        )}
        <div className="recovery-actions">
          {!storageProblem && (
            <button className="primary-action recovery-retry" type="button" disabled={pending} onClick={() => void handleRetry()}>
              Reintentar correos pendientes
            </button>
          )}
          <a className="text-link" href={investigationHash(recovery.investigationId)}>
            Abrir expediente <span aria-hidden="true">↗</span>
          </a>
        </div>
      </section>
    );
  }

  return (
    <section className="creation-page" aria-labelledby="create-title">
      <div className="motif-divider" aria-hidden="true"><span /><img src={flower} alt="" /><span /></div>
      <h1 id="create-title" className="document-title">Nueva <span>investigación</span></h1>
      <p className="document-lead">Cargá los datos que tenés como punto de partida</p>
      <form className="create-form" noValidate onSubmit={(event) => void handleCreate(event)}>
        <fieldset className="create-fields" disabled={pending}>
          <legend className="visually-hidden">Datos iniciales</legend>
          <div className="form-field">
            <label htmlFor="investigation-name">Nombre de la investigación</label>
            <input
              id="investigation-name"
              name="name"
              type="text"
              autoComplete="off"
              placeholder="Escribí un nombre para tu investigación"
              value={name}
              aria-invalid={fieldErrors.name !== undefined}
              aria-describedby={`name-hint${fieldErrors.name === undefined ? "" : " name-error"}`}
              onChange={(event) => {
                setName(event.currentTarget.value);
                setFieldErrors((errors) => {
                  const next = { ...errors };
                  delete next.name;
                  return next;
                });
                setFormError("");
              }}
            />
            <span id="name-hint" className="visually-hidden">Hasta {INVESTIGATION_NAME_MAX_LENGTH} caracteres Unicode.</span>
            {fieldErrors.name !== undefined && <span id="name-error" className="field-error">{fieldErrors.name}</span>}
          </div>
          <div className="form-field">
            <label htmlFor="investigation-intention">Intención de la investigación</label>
            <textarea
              id="investigation-intention"
              name="intention"
              required
              value={intention}
              placeholder="¿Qué querés investigar y para qué?"
              aria-invalid={fieldErrors.intention !== undefined}
              aria-describedby={`intention-hint${fieldErrors.intention === undefined ? "" : " intention-error"}`}
              onChange={(event) => {
                setIntention(event.currentTarget.value);
                setFieldErrors((errors) => {
                  const next = { ...errors };
                  delete next.intention;
                  return next;
                });
                setFormError("");
              }}
            />
            <span id="intention-hint">La intención se registra una sola vez al abrir el expediente.</span>
            {fieldErrors.intention !== undefined && <span id="intention-error" className="field-error">{fieldErrors.intention}</span>}
          </div>
          <div className="form-field create-advancement-field">
            <label>
              <input type="checkbox" checked={manualMode} onChange={(event) => setManualMode(event.currentTarget.checked)} />
              Elegir avance manual
            </label>
            <span>El avance automático es la opción predeterminada.</span>
          </div>
          <div className="form-field create-advancement-field">
            <label>
              <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.currentTarget.checked)} aria-describedby="creation-consent-hint" />
              Autorizar consultas del catálogo
            </label>
            <span id="creation-consent-hint">Consentimiento explícito para las semillas actuales y futuras de este expediente hasta revocar la autorización. En modo automático, las consultas avanzan sin aprobación por nodo; sin marcar, quedan esperando autorización.</span>
          </div>
          <div className="email-fields">
            <div className="email-fields-heading">
              <h2>Semillas iniciales</h2>
            </div>
            {fieldErrors.emails !== undefined && <p className="field-error" role="alert">{fieldErrors.emails}</p>}
            <div className="email-row-list">
              {emailRows.map((row, index) => {
                const errorId = `email-error-${row.key}`;
                const fieldKey = `email-${row.key}`;
                return (
                  <div className="email-row" key={row.key}>
                    <div className="form-field email-field">
                      <label htmlFor={fieldKey}>Correo electrónico {index + 1}</label>
                      <input
                        id={fieldKey}
                        name={`email-${index + 1}`}
                        type="email"
                        inputMode="email"
                        autoComplete="off"
                        maxLength={EMAIL_MAX_LENGTH}
                        placeholder="ejemplo@example.com"
                        value={row.value}
                        aria-invalid={fieldErrors[fieldKey] !== undefined}
                        aria-describedby={fieldErrors[fieldKey] === undefined ? undefined : errorId}
                        onChange={(event) => updateEmail(row.key, event.currentTarget.value)}
                      />
                      {fieldErrors[fieldKey] !== undefined && (
                        <span id={errorId} className="field-error">{fieldErrors[fieldKey]}</span>
                      )}
                    </div>
                    <button
                      className="remove-email-button"
                      type="button"
                      aria-label={`Quitar correo ${index + 1}`}
                      disabled={emailRows.length === 1}
                      onClick={() => setEmailRows((rows) => rows.length > 1 ? rows.filter((item) => item.key !== row.key) : rows)}
                    >
                      Quitar
                    </button>
                  </div>
                );
              })}
            </div>
            <button
              className="text-button add-email-button"
              type="button"
              onClick={() => {
                setEmailRows((rows) => [...rows, { key: nextEmailKey.current++, value: "" }]);
                setFormError("");
              }}
            >
              + Agregar correo
            </button>
          </div>
          {formError !== "" && <p className="form-error" role="alert">{formError}</p>}
        </fieldset>
        <button className="primary-action create-submit" type="submit" disabled={pending}>
          {pending ? "Creando…" : "Crear investigación"}
        </button>
      </form>
    </section>
  );
}
