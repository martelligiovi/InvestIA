import { useEffect, useMemo, useState, type FormEvent } from "react";
import { InvestigationApiClient, type FacecheckSettingsUpdate, type FacecheckSettingsView } from "../api/client";

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

  return (
    <section id="facecheck-settings" className="create-section" aria-labelledby="facecheck-settings-title">
      <div className="create-section-heading"><h2 id="facecheck-settings-title">FaceCheck.id</h2></div>
      <p className="field-hint">
        Busca en internet caras parecidas a la foto de perfil de Google que encontró GHunt. Cada resultado es un candidato: vos confirmás o rechazás cada uno. Conseguí un token en la{" "}
        <a href="https://facecheck.id/en/Face-Search/API" target="_blank" rel="noreferrer">API de FaceCheck</a>.
      </p>
      {view === null ? (error === "" && <p>Cargando FaceCheck…</p>) : (
        <>
          <p>Estado: <strong>{view.tokenConfigured ? `token configurado${view.tokenHint === null ? "" : ` (${view.tokenHint})`}` : "sin token configurado"}</strong></p>
          <form onSubmit={(event) => void saveToken(event)}>
            <div className="form-field">
              <label htmlFor="facecheck-token">Token de la API de FaceCheck</label>
              <input id="facecheck-token" type="password" autoComplete="off" spellCheck={false} value={token} disabled={pending} onChange={(event) => { setToken(event.currentTarget.value); setError(""); }} />
            </div>
            <button className="primary-action" type="submit" disabled={pending || token.trim() === ""}>{pending ? "Guardando…" : "Guardar token"}</button>
          </form>
          {view.tokenConfigured && <button className="text-button" type="button" disabled={pending} onClick={() => void apply(() => api.removeFacecheckToken())}>Quitar token</button>}
          <div className="form-field">
            <label>
              <input type="checkbox" checked={view.testingMode} disabled={pending} onChange={(event) => void save({ testingMode: event.currentTarget.checked })} />
              {" "}Modo prueba
            </label>
            <p className="field-hint">
              {view.testingMode
                ? "En modo prueba solo se escanean 100.000 caras: es rápido y no descuenta créditos, pero los resultados no sirven de mucho. Una búsqueda real cuesta 3 créditos."
                : "Las búsquedas reales descuentan créditos: cada una cuesta 3 créditos. En modo prueba solo se escanean 100.000 caras."}
            </p>
          </div>
        </>
      )}
      {error !== "" && <p className="form-error" role="alert">{error}</p>}
    </section>
  );
}
