import { useEffect, useMemo, useState, type FormEvent } from "react";
import { InvestigationApiClient, type DecodoApiMode, type DecodoSettingsStatus } from "../api/client";
import { SETTINGS_INTEGRATIONS, SettingsCard, SettingsFooter, type SettingsCardStatus } from "./SettingsCard";

function messageFor(error: unknown): string {
  return error instanceof Error && error.message.trim() !== "" ? error.message : "Ocurrió un error inesperado.";
}

export function DecodoSettings() {
  const api = useMemo(() => new InvestigationApiClient(), []);
  const [view, setView] = useState<DecodoSettingsStatus | null>(null);
  const [draftMode, setDraftMode] = useState<DecodoApiMode | null>(null);
  const [token, setToken] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const apiMode = draftMode ?? view?.apiMode;
  const hasChanges = token.trim() !== "" || apiMode !== view?.apiMode;

  useEffect(() => {
    let active = true;
    void api.getDecodoSettings().then(
      (loaded) => { if (active) setView(loaded); },
      (failure: unknown) => { if (active) setError(`No se pudo cargar Decodo: ${messageFor(failure)}`); },
    );
    return () => { active = false; };
  }, [api]);

  async function apply(operation: () => Promise<void>, errorPrefix: string) {
    setPending(true);
    setError("");
    setToken("");
    try { await operation(); }
    catch (failure) { setError(`${errorPrefix}: ${messageFor(failure)}`); }
    finally { setPending(false); }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || view === null || !hasChanges) return;
    const submitted = token.trim();
    await apply(async () => {
      const saved = await api.saveDecodoSettings({
        ...(submitted === "" ? {} : { token: submitted }),
        ...(apiMode === undefined || apiMode === view.apiMode ? {} : { apiMode }),
      });
      setView(saved);
      setDraftMode(null);
    }, "No se pudieron guardar los ajustes de Decodo");
  }

  const status: SettingsCardStatus = pending
    ? { label: "En curso", tone: "pending" }
    : view === null
      ? error === "" ? { label: "Cargando", tone: "pending" } : { label: "Error de carga", tone: "warn" }
      : view.tokenConfigured
        ? { label: `Token configurado${view.tokenHint === null ? "" : ` (${view.tokenHint})`}`, tone: "ok" }
        : { label: "Sin token configurado", tone: "off" };
  const errorMessage = error === "" ? null : <p className="form-error" role="alert">{error}</p>;

  return (
    <SettingsCard {...SETTINGS_INTEGRATIONS.decodo} status={status}
      description="Configurá la recopilación de páginas públicas asociadas a coincidencias que ya aceptaste.">
      <div className="settings-privacy">
        <p>Aceptar una coincidencia de FaceCheck encola el scraping de su URL pública con Decodo. Se envía solo la URL, nunca la foto ni la miniatura. En avance automático, el servidor procesa la cola si el expediente está autorizado y sin pausa y hay un token configurado.</p>
        <p>Si LinkedIn u otro sitio exige inicio de sesión, la acción muestra un error y no guarda una página vacía.</p>
      </div>
      {view === null ? (errorMessage ?? <p>Cargando Decodo…</p>) : (
        <form className="settings-form" onSubmit={(event) => void save(event)}>
          <div className="settings-fields-pair">
            <div className="form-field">
              <label htmlFor="decodo-token">Token de la API de Decodo</label>
              <input id="decodo-token" type="password" autoComplete="off" spellCheck={false} value={token} disabled={pending}
                placeholder={view.tokenConfigured ? "Dejalo vacío para conservar el actual" : undefined}
                onChange={(event) => { setToken(event.currentTarget.value); setError(""); }} />
            </div>
            <div className="form-field">
              <label htmlFor="decodo-api-mode">Modo de API</label>
              <select id="decodo-api-mode" value={apiMode} disabled={pending}
                onChange={(event) => { setDraftMode(event.currentTarget.value as DecodoApiMode); setError(""); }}>
                <option value="web_data">Web Data API (Bearer)</option>
                <option value="scraping_v2">Web Scraping API v2 (Basic)</option>
              </select>
            </div>
          </div>
          {errorMessage}
          <SettingsFooter
            secondary={view.tokenConfigured ? (
              <button className="text-button" type="button" disabled={pending} onClick={() => void apply(async () => {
                setView(await api.deleteDecodoToken());
              }, "No se pudo quitar el token de Decodo")}>Quitar token</button>
            ) : undefined}
            primary={<button className="primary-action" type="submit" disabled={pending || !hasChanges}>{pending ? "Procesando…" : "Guardar Decodo"}</button>}
          />
        </form>
      )}
    </SettingsCard>
  );
}
