import { useEffect, useMemo, useState } from "react";
import type { InvestigationSummary } from "@investia/core";
import { InvestigationApiClient } from "../api/client";
import flower from "../assets/folk-flower.svg";
import { investigationHash } from "../routing";
import { AsciiStitchBorder } from "../components/AsciiStitchBorder";

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

  return (
    <section className="home-page" aria-labelledby="home-title">
      <div className="home-layout">
        <aside className="history-panel" aria-labelledby="history-title">
          <div className="history-heading">
            <img src={flower} alt="" />
            <h2 id="history-title" className="history-title">Investigaciones anteriores</h2>
          </div>
          <AsciiStitchBorder />
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
            <p className="history-message">Todavía no hay investigaciones.</p>
          )}
          {historyState.kind === "loaded" && historyState.investigations.length > 0 && (
            <ul className="history-list">
              {[...historyState.investigations].reverse().map((investigation) => (
                <li key={investigation.id}>
                  <a className="history-entry" href={investigationHash(investigation.id)}>
                    <span className="history-entry-name">{investigation.name}</span>
                    <span className="history-entry-date">{formatCreatedAt(investigation.createdAt)}</span>
                    <span className={`history-entry-state${investigation.paused ? " history-entry-state--paused" : ""}`}>{investigation.paused ? "Pausada" : "Activa"}</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <div className="home-hero">
          <div className="motif-divider" aria-hidden="true">
            <span />
            <img src={flower} alt="" />
            <span />
          </div>
          <h1 id="home-title" className="home-title">Invest<span>IA</span></h1>
          <p className="home-lead">Iniciá una investigación a partir de tus datos.</p>
          <a className="primary-action" href="#/nueva">
            <span>Nueva investigación</span>
            <span aria-hidden="true">⟶</span>
          </a>
        </div>
      </div>
    </section>
  );
}
