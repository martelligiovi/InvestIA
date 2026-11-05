import { useEffect, useMemo, useState, type FormEvent } from "react";
import { InvestigationApiClient, type GhuntSettingsView } from "../api/client";

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
    <section id="ghunt-settings" className="create-section" aria-labelledby="ghunt-settings-title">
      <div className="create-section-heading"><h2 id="ghunt-settings-title">Google (GHunt)</h2></div>
      {view === null ? (error === "" && <p>Cargando conexión de Google…</p>) : !view.available ? (
        <p>GHunt no está instalado en esta instancia.</p>
      ) : (
        <>
          <p>Estado: <strong>{view.state === "connected" ? `conectado${view.account === null ? "" : ` (${view.account})`}` : view.state === "invalid_session" ? "sesión inválida" : "requiere conexión"}</strong></p>
          <form hidden={view.state === "connected"} onSubmit={(event) => void connect(event)}>
            <p className="field-hint">Instalá <a href="https://github.com/mxrch/ghunt_companion" target="_blank" rel="noreferrer">GHunt Companion</a>, iniciá sesión en Google en el navegador y exportá el código. Pegalo abajo para conectar esta instancia.</p>
            <div className="form-field">
              <label htmlFor="ghunt-code">Código de GHunt Companion</label>
              <input id="ghunt-code" type="password" autoComplete="off" spellCheck={false} value={code} disabled={pending} onChange={(event) => { setCode(event.currentTarget.value); setError(""); }} />
            </div>
            <button className="primary-action" type="submit" disabled={pending || code.trim() === ""}>{pending ? "Conectando…" : "Conectar Google"}</button>
          </form>
          {view.state !== "requires_connection" && <button className="text-button" type="button" disabled={pending} onClick={() => void disconnect()}>Desconectar</button>}
        </>
      )}
      {error !== "" && <p className="form-error" role="alert">{error}</p>}
    </section>
  );
}
