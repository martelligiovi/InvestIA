import { useEffect, useMemo, useState } from "react";
import type { InvestigationSummary } from "@investia/core";
import { InvestigationApiClient } from "../api/client";
import { investigationHash } from "../routing";
import { AsciiArt } from "../components/AsciiArt";

const PRINCIPLES = [
  { index: "01", title: "Semillas", text: "Partís de los datos que ya tenés." },
  { index: "02", title: "Evidencia", text: "Cada hallazgo conserva su fuente." },
  { index: "03", title: "Decisión", text: "Vos validás; nada se confirma solo." },
] as const;

type HistoryState =
  | { readonly kind: "loading" }
  | { readonly kind: "loaded"; readonly investigations: readonly InvestigationSummary[] }
  | { readonly kind: "error" };

function formatCreatedAt(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Fecha no disponible";
  return new Intl.DateTimeFormat("es-AR", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
}

export function HomePage() {
  const api = useMemo(() => new InvestigationApiClient(), []);
  const [historyState, setHistoryState] = useState<HistoryState>({ kind: "loading" });
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    setHistoryState({ kind: "loading" });
    void api.listInvestigations().then(
      (investigations) => {
        if (active) setHistoryState({ kind: "loaded", investigations });
      },
      () => {
        if (active) setHistoryState({ kind: "error" });
      },
    );
    return () => { active = false; };
  }, [api, reload]);

  const investigations = historyState.kind === "loaded" ? historyState.investigations : [];

  return (
    <section className="home-page" aria-labelledby="home-title">
      <div className="home-hero">
        <div className="home-hero-copy">
          <p className="kicker">Cuaderno de evidencia · OSINT</p>
          <h1 id="home-title" className="home-title">Invest<span>IA</span></h1>
          <p className="home-lead">Iniciá una investigación a partir de tus datos.</p>
          <a className="primary-action" href="#/nueva">
            <span>Nueva investigación</span>
            <span aria-hidden="true">⟶</span>
          </a>
          <ol className="home-principles">
            {PRINCIPLES.map((principle) => (
              <li key={principle.index}>
                <span className="home-principle-index" aria-hidden="true">{principle.index}</span>
                <strong>{principle.title}</strong>
                <span>{principle.text}</span>
              </li>
            ))}
          </ol>
        </div>
        <div className="home-emblem" aria-hidden="true">
          <span className="home-sun" />
          <div className="home-stamp">
            <div className="home-stamp-face">
              <AsciiArt motif="rosette" />
              <span className="home-stamp-caption">N.º 001 · Expediente abierto</span>
            </div>
          </div>
        </div>
      </div>

      <aside className="history-panel" aria-labelledby="history-title">
        <div className="history-heading">
          <div>
            <p className="eyebrow">Archivo</p>
            <h2 id="history-title" className="history-title">Investigaciones anteriores</h2>
          </div>
          {investigations.length > 0 && (
            <span className="history-count">{investigations.length} {investigations.length === 1 ? "expediente" : "expedientes"}</span>
          )}
        </div>
        <AsciiArt motif="lozenge" className="history-divider" />
        {historyState.kind === "loading" && (
          <p className="history-message" role="status">Cargando historial…</p>
        )}
        {historyState.kind === "error" && (
          <div className="history-message" role="alert">
            <p>No se pudo cargar el historial.</p>
            <button className="text-button" type="button" onClick={() => setReload((value) => value + 1)}>
              Intentar de nuevo
            </button>
          </div>
        )}
        {historyState.kind === "loaded" && historyState.investigations.length === 0 && (
          <div className="history-empty">
            <AsciiArt motif="tree" />
            <p className="history-message">Todavía no hay investigaciones.</p>
          </div>
        )}
        {historyState.kind === "loaded" && historyState.investigations.length > 0 && (
          <ul className="history-list">
            {[...historyState.investigations].reverse().map((investigation) => (
              <li key={investigation.id}>
                <a className="history-entry" href={investigationHash(investigation.id)}>
                  <span className="history-entry-name">{investigation.name}</span>
                  <span className="history-entry-date">{formatCreatedAt(investigation.createdAt)}</span>
                  <span className={`history-entry-state status-chip${investigation.paused ? " history-entry-state--paused status-chip--muted" : ""}`}>{investigation.paused ? "Pausada" : "Activa"}</span>
                  <span className="history-entry-arrow" aria-hidden="true">→</span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </aside>
    </section>
  );
}
