import { useEffect, useMemo, useState, type FormEvent } from "react";
import { InvestigationApiClient, type GhuntSettingsView } from "../api/client";
import { SETTINGS_INTEGRATIONS, SettingsCard, SettingsFooter, type SettingsCardStatus } from "./SettingsCard";

function messageFor(error: unknown): string {
  return error instanceof Error && error.message.trim() !== "" ? error.message : "Ocurrió un error inesperado.";
}

export function GhuntSettings() {
  const api = useMemo(() => new InvestigationApiClient(), []);
  const [view, setView] = useState<GhuntSettingsView | null>(null);
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void api.getGhuntSettings().then(
      (loaded) => { if (active) setView(loaded); },
      (failure: unknown) => { if (active) setError(`No se pudo cargar Google (GHunt): ${messageFor(failure)}`); },
    );
    return () => { active = false; };
  }, [api]);

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || code.trim() === "") return;
    const submitted = code;
    setCode("");
    setPending(true);
    setError("");
    try { setView(await api.connectGhunt(submitted)); }
    catch (failure) { setError(`No se pudo conectar Google: ${messageFor(failure)}`); }
    finally { setPending(false); }
  }

  async function disconnect() {
    if (pending) return;
    setPending(true);
    setError("");
    try { setView(await api.disconnectGhunt()); }
    catch (failure) { setError(`No se pudo desconectar Google: ${messageFor(failure)}`); }
    finally { setPending(false); }
  }

  const connected = view?.state === "connected";
  const status: SettingsCardStatus = pending
    ? { label: "En curso", tone: "pending" }
    : view === null
      ? error === "" ? { label: "Cargando", tone: "pending" } : { label: "Error de carga", tone: "warn" }
      : !view.available ? { label: "No disponible", tone: "off" }
        : connected ? { label: "Sesión activa", tone: "ok" }
          : view.state === "invalid_session" ? { label: "Sesión inválida", tone: "warn" }
            : { label: "Requiere conexión", tone: "off" };

  return (
    <SettingsCard {...SETTINGS_INTEGRATIONS.google} status={status}
      description="Conectá una sesión de Google para consultar perfiles públicos a partir de correos de Gmail.">
      {view === null ? (error === "" && <p>Cargando conexión de Google…</p>) : !view.available ? (
        <p className="settings-notice">GHunt no está instalado en esta instancia.</p>
      ) : (
        <>
          {connected && (
            <p className="settings-notice">Conectado{view.account === null ? " con Google." : ` como ${view.account}.`}</p>
          )}
          {view.state === "invalid_session" && (
            <p className="settings-notice">La sesión no es válida o venció. Exportá un código nuevo para volver a conectar.</p>
          )}
          <form className="settings-form" hidden={connected} onSubmit={(event) => void connect(event)}>
            <ol className="settings-steps">
              <li>Instalá <a href="https://github.com/mxrch/ghunt_companion" target="_blank" rel="noreferrer">GHunt Companion</a>.</li>
              <li>Iniciá sesión en Google en el navegador y exportá el código.</li>
              <li>Pegá el código acá para conectar esta instancia.</li>
            </ol>
            <div className="form-field">
              <label htmlFor="ghunt-code">Código de GHunt Companion</label>
              <div className="settings-inline">
                <input id="ghunt-code" type="password" autoComplete="off" spellCheck={false} value={code} disabled={pending} onChange={(event) => { setCode(event.currentTarget.value); setError(""); }} />
                <button className="primary-action" type="submit" disabled={pending || code.trim() === ""}>{pending ? "Conectando…" : "Conectar Google"}</button>
              </div>
            </div>
          </form>
        </>
      )}
      {error !== "" && <p className="form-error" role="alert">{error}</p>}
      {view?.available && view.state !== "requires_connection" && (
        <SettingsFooter secondary={
          <button className="text-button" type="button" disabled={pending} onClick={() => void disconnect()}>Desconectar</button>
        } />
      )}
    </SettingsCard>
  );
}
