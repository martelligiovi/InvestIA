import { useEffect, useMemo, useState, type FormEvent } from "react";
import { InvestigationApiClient, type FacecheckSettingsUpdate, type FacecheckSettingsView } from "../api/client";
import { SETTINGS_INTEGRATIONS, SettingsCard, SettingsFooter, type SettingsCardStatus } from "./SettingsCard";

function messageFor(error: unknown): string {
  return error instanceof Error && error.message.trim() !== "" ? error.message : "Ocurrió un error inesperado.";
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

  const status: SettingsCardStatus = pending
    ? { label: "En curso", tone: "pending" }
    : view === null
      ? error === "" ? { label: "Cargando", tone: "pending" } : { label: "Error de carga", tone: "warn" }
      : view.tokenConfigured
        ? { label: `Token configurado${view.tokenHint === null ? "" : ` (${view.tokenHint})`}`, tone: "ok" }
        : { label: "Sin token configurado", tone: "off" };

  return (
    <SettingsCard {...SETTINGS_INTEGRATIONS.facecheck} status={status}
      description="Busca caras parecidas a la de la foto de perfil de Google que encontró GHunt. Vos confirmás o rechazás cada candidato.">
      <p id="facecheck-token-hint" className="field-hint">
        Conseguí un token en la <a href="https://facecheck.id/en/Face-Search/API" target="_blank" rel="noreferrer">API de FaceCheck</a>.
      </p>
      {view === null ? (
        error === "" && <p>Cargando FaceCheck…</p>
      ) : (
        <div className="settings-form">
          <form className="settings-group" onSubmit={(event) => void saveToken(event)}>
            <div className="form-field">
              <label htmlFor="facecheck-token">Token de la API de FaceCheck</label>
              <div className="settings-inline">
                <input id="facecheck-token" type="password" autoComplete="off" spellCheck={false} value={token} disabled={pending}
                  aria-describedby="facecheck-token-hint" onChange={(event) => { setToken(event.currentTarget.value); setError(""); }} />
                <button className="primary-action" type="submit" disabled={pending || token.trim() === ""}>{pending ? "Guardando…" : "Guardar token"}</button>
              </div>
            </div>
          </form>
          <div className="settings-group">
            <label className="settings-toggle">
              <span className="settings-switch">
                <input type="checkbox" checked={view.testingMode} disabled={pending} aria-describedby="facecheck-testing-hint"
                  onChange={(event) => void save({ testingMode: event.currentTarget.checked })} />
              </span>
              <span>Modo prueba</span>
            </label>
            <p id="facecheck-testing-hint" className="field-hint">
              {view.testingMode
                ? "En modo prueba solo se escanean 100.000 caras: es rápido y no descuenta créditos, pero los resultados no sirven de mucho. Una búsqueda real cuesta 3 créditos."
                : "Las búsquedas reales descuentan créditos: cada una cuesta 3 créditos. En modo prueba solo se escanean 100.000 caras."}
            </p>
          </div>
        </div>
      )}
      {error !== "" && <p className="form-error" role="alert">{error}</p>}
      {view?.tokenConfigured && (
        <SettingsFooter secondary={
          <button className="text-button" type="button" disabled={pending} onClick={() => void apply(() => api.removeFacecheckToken())}>Quitar token</button>
        } />
      )}
    </SettingsCard>
  );
}
