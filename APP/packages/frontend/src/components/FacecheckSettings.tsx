import { useEffect, useMemo, useState, type FormEvent } from "react";
import { InvestigationApiClient, type FacecheckSettingsUpdate, type FacecheckSettingsView } from "../api/client";
import { SettingsCard, type SettingsStatus } from "./SettingsCard";

function messageFor(error: unknown): string {
  return error instanceof Error && error.message.trim() !== "" ? error.message : "Ocurrió un error inesperado.";
}

function statusOf(view: FacecheckSettingsView | null, error: string): SettingsStatus {
  if (view === null) return error === "" ? { label: "Cargando…", tone: "pending" } : { label: "Sin datos", tone: "off" };
  if (!view.tokenConfigured) return { label: "Sin token configurado", tone: "warn" };
  return { label: `Token configurado${view.tokenHint === null ? "" : ` · ${view.tokenHint}`}`, tone: "ok" };
}

export function FacecheckSettings() {
  const api = useMemo(() => new InvestigationApiClient(), []);
  const [view, setView] = useState<FacecheckSettingsView | null>(null);
  const [token, setToken] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void api.getFacecheckSettings().then(
      (loaded) => { if (active) setView(loaded); },
      (failure: unknown) => { if (active) setError(`No se pudo cargar FaceCheck: ${messageFor(failure)}`); },
    );
    return () => { active = false; };
  }, [api]);

  async function apply(operation: () => Promise<FacecheckSettingsView>) {
    setPending(true);
    setError("");
    try { setView(await operation()); }
    catch (failure) { setError(`No se pudo guardar FaceCheck: ${messageFor(failure)}`); }
    finally { setPending(false); }
  }

  function save(update: FacecheckSettingsUpdate) {
    return apply(() => api.saveFacecheckSettings(update));
  }

  async function saveToken(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || token.trim() === "") return;
    const submitted = token.trim();
    setToken("");
    await save({ token: submitted });
  }

  return (
    <SettingsCard id="facecheck-settings" index="03" eyebrow="Búsqueda facial" title="FaceCheck.id"
      description="Busca en internet caras parecidas a la foto de perfil de Google que encontró GHunt. Cada resultado es un candidato: vos confirmás o descartás cada uno."
      status={statusOf(view, error)}>
      {view === null ? (error === "" && <p className="settings-muted">Cargando FaceCheck…</p>) : (
        <>
          <form className="settings-form" onSubmit={(event) => void saveToken(event)}>
            <div className="form-field">
              <label htmlFor="facecheck-token">Token de la API de FaceCheck</label>
              <div className="settings-inline">
                <input id="facecheck-token" type="password" autoComplete="off" spellCheck={false} value={token} disabled={pending}
                  placeholder={view.tokenConfigured ? "Dejalo vacío para conservar el actual" : ""}
                  aria-describedby="facecheck-token-hint" onChange={(event) => { setToken(event.currentTarget.value); setError(""); }} />
                <button className="primary-action" type="submit" disabled={pending || token.trim() === ""}>{pending ? "Guardando…" : "Guardar token"}</button>
              </div>
              <span id="facecheck-token-hint" className="field-hint">
                Conseguí un token en la <a href="https://facecheck.id/en/Face-Search/API" target="_blank" rel="noreferrer">API de FaceCheck</a>. Se guarda en el servidor y nunca se vuelve a mostrar completo.
              </span>
            </div>
            {view.tokenConfigured && <div className="settings-row-actions">
              <button className="text-button" type="button" disabled={pending} onClick={() => void apply(() => api.removeFacecheckToken())}>Quitar token</button>
            </div>}
          </form>
          <div className={`settings-toggle${view.testingMode ? " settings-toggle--on" : ""}`}>
            <label className="settings-switch">
              <input type="checkbox" checked={view.testingMode} disabled={pending}
                aria-describedby="facecheck-testing-hint" onChange={(event) => void save({ testingMode: event.currentTarget.checked })} />
              <span className="settings-switch-track" aria-hidden="true" />
              <span className="settings-switch-label">Modo prueba</span>
            </label>
            <p id="facecheck-testing-hint" className="field-hint">
              {view.testingMode
                ? "En modo prueba solo se escanean 100.000 caras: es rápido y no descuenta créditos, pero los resultados no sirven de mucho. Una búsqueda real cuesta 3 créditos."
                : "Las búsquedas reales descuentan créditos: cada una cuesta 3 créditos. En modo prueba solo se escanean 100.000 caras."}
            </p>
          </div>
        </>
      )}
      {error !== "" && <p className="form-error" role="alert">{error}</p>}
    </SettingsCard>
  );
}
