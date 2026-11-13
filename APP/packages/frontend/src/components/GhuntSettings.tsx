import { useEffect, useMemo, useState, type FormEvent } from "react";
import { InvestigationApiClient, type GhuntSettingsView } from "../api/client";
import { SettingsCard, type SettingsStatus } from "./SettingsCard";

function messageFor(error: unknown): string {
  return error instanceof Error && error.message.trim() !== "" ? error.message : "Ocurrió un error inesperado.";
}

function statusOf(view: GhuntSettingsView | null, error: string): SettingsStatus {
  if (view === null) return error === "" ? { label: "Cargando…", tone: "pending" } : { label: "Sin datos", tone: "off" };
  if (!view.available) return { label: "No instalado", tone: "off" };
  if (view.state === "connected") return { label: `Conectado${view.account === null ? "" : ` · ${view.account}`}`, tone: "ok" };
  if (view.state === "invalid_session") return { label: "Sesión inválida", tone: "warn" };
  return { label: "Requiere conexión", tone: "warn" };
}

export function GhuntSettings() {
  const api = useMemo(() => new InvestigationApiClient(), []);
  const [view, setView] = useState<GhuntSettingsView | null>(null);
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (window.location.hash.includes("?seccion=ghunt")) {
      document.getElementById("ghunt-settings")?.scrollIntoView?.({ block: "start" });
    }
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

  return (
    <SettingsCard id="ghunt-settings" index="02" eyebrow="Cuenta de Google" title="Google (GHunt)"
      description="Consulta la cuenta de Google asociada a un Gmail (foto de perfil, nombre y servicios). Usa una sesión de Google que conectás una sola vez."
      status={statusOf(view, error)}>
      {view === null ? (error === "" && <p className="settings-muted">Cargando conexión de Google…</p>) : !view.available ? (
        <p className="settings-muted">GHunt no está instalado en esta instancia.</p>
      ) : (
        <>
          {view.state === "connected" && <p className="settings-muted">Las búsquedas de GHunt usan esta sesión. Desconectala si querés usar otra cuenta.</p>}
          <form className="settings-form" hidden={view.state === "connected"} onSubmit={(event) => void connect(event)}>
            <ol className="settings-steps">
              <li>Instalá <a href="https://github.com/mxrch/ghunt_companion" target="_blank" rel="noreferrer">GHunt Companion</a> en el navegador.</li>
              <li>Iniciá sesión en Google y exportá el código.</li>
              <li>Pegalo abajo para conectar esta instancia.</li>
            </ol>
            <div className="form-field">
              <label htmlFor="ghunt-code">Código de GHunt Companion</label>
              <div className="settings-inline">
                <input id="ghunt-code" type="password" autoComplete="off" spellCheck={false} value={code} disabled={pending} onChange={(event) => { setCode(event.currentTarget.value); setError(""); }} />
                <button className="primary-action" type="submit" disabled={pending || code.trim() === ""}>{pending ? "Conectando…" : "Conectar Google"}</button>
              </div>
            </div>
          </form>
          {view.state !== "requires_connection" && <div className="settings-card-footer">
            <button className="secondary-action" type="button" disabled={pending} onClick={() => void disconnect()}>Desconectar</button>
          </div>}
        </>
      )}
      {error !== "" && <p className="form-error" role="alert">{error}</p>}
    </SettingsCard>
  );
}
