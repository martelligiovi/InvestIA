import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { EvidenceRecord, Investigation, ValidationStatus } from "@investia/core";

export type FacecheckDecision = "accepted" | "rejected";

export interface FacecheckReviewProps {
  readonly investigation: Investigation;
  readonly actionId: string;
  readonly disabled: boolean;
  readonly onDecide: (evidenceId: string, status: FacecheckDecision, reason: string) => Promise<boolean>;
  readonly onClose: () => void;
}

const REASONS: Record<FacecheckDecision, string> = {
  accepted: "Revisión de FaceCheck: es la persona buscada.",
  rejected: "Revisión de FaceCheck: no es la persona buscada.",
};

/** Only inline base64 images become an image source; any other value is never loaded. */
const INLINE_IMAGE = /^data:image\/(?:webp|jpeg|png);base64,[A-Za-z0-9+/]+={0,2}$/;

const SITES: readonly (readonly [string, string])[] = [
  ["instagram.com", "Instagram"], ["facebook.com", "Facebook"], ["fb.com", "Facebook"], ["linkedin.com", "LinkedIn"],
  ["github.com", "GitHub"], ["tiktok.com", "TikTok"], ["x.com", "X (Twitter)"], ["twitter.com", "X (Twitter)"],
  ["youtube.com", "YouTube"], ["reddit.com", "Reddit"], ["pinterest.com", "Pinterest"], ["vk.com", "VK"],
  ["ok.ru", "OK.ru"], ["threads.net", "Threads"], ["clubhouse.com", "Clubhouse"], ["researchgate.net", "ResearchGate"],
  ["flickr.com", "Flickr"], ["tumblr.com", "Tumblr"], ["medium.com", "Medium"], ["bing.com", "Bing"],
];

function safeUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url : undefined;
  } catch {
    return undefined;
  }
}

/** Human name of the site a candidate was found on: a known network, else its host. */
export function siteName(value: string): string {
  const url = safeUrl(value);
  if (url === undefined) return "Sitio desconocido";
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  return SITES.find(([domain]) => host === domain || host.endsWith(`.${domain}`))?.[1] ?? host;
}

function pagePath(url: URL): string {
  const path = decodeURIComponentSafe(url.pathname).replace(/\/+$/, "");
  return path === "" ? url.hostname.replace(/^www\./, "") : path;
}

function decodeURIComponentSafe(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

function score(evidence: EvidenceRecord): number {
  const value = evidence.finding?.extra.score;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export interface FacecheckReviewState {
  readonly candidates: readonly EvidenceRecord[];
  readonly pending: readonly EvidenceRecord[];
  readonly accepted: readonly EvidenceRecord[];
  readonly rejected: readonly EvidenceRecord[];
  readonly decisionOf: (evidenceId: string) => ValidationStatus | undefined;
}

/** Candidates of one FaceCheck search by their latest decision; inconclusive ones still need a review. */
export function facecheckReviewState(investigation: Investigation, actionId: string): FacecheckReviewState {
  const latest = new Map<string, ValidationStatus>();
  for (const decision of investigation.validations) latest.set(decision.evidenceId, decision.status);
  const candidates = investigation.evidence
    .filter((evidence) => evidence.actionId === actionId && evidence.sourceId === "facecheck:photo")
    .slice().sort((left, right) => score(right) - score(left));
  return {
    candidates,
    pending: candidates.filter((evidence) => { const status = latest.get(evidence.id); return status !== "accepted" && status !== "rejected"; }),
    accepted: candidates.filter((evidence) => latest.get(evidence.id) === "accepted"),
    rejected: candidates.filter((evidence) => latest.get(evidence.id) === "rejected"),
    decisionOf: (evidenceId) => latest.get(evidenceId),
  };
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function Thumbnail({ evidence, size }: { readonly evidence: EvidenceRecord; readonly size: "large" | "small" }) {
  const value = evidence.finding?.media.thumbnail ?? "";
  const site = siteName(evidence.finding?.url ?? "");
  return INLINE_IMAGE.test(value)
    ? <img className={`fc-thumb fc-thumb--${size}`} src={value} alt={`Cara encontrada por FaceCheck en ${site}`} />
    : <div className={`fc-thumb fc-thumb--${size} fc-thumb--missing`}><span>Sin imagen admitida</span></div>;
}

function PageLink({ evidence, compact = false }: { readonly evidence: EvidenceRecord; readonly compact?: boolean }) {
  const raw = evidence.finding?.url ?? "";
  const url = safeUrl(raw);
  const site = siteName(raw);
  if (url === undefined) return <span className="fc-link fc-link--unsafe">Enlace no admitido</span>;
  return (
    <a className="fc-link" href={url.href} target="_blank" rel="noopener noreferrer" aria-label={`Abrir la página en ${site} (pestaña nueva)`}>
      {compact ? "Abrir ↗" : <>Abrir la página <span aria-hidden="true">↗</span></>}
    </a>
  );
}

function ScoreMeter({ value }: { readonly value: number }) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div className="fc-score">
      <span className="fc-score-label">Score</span>
      <span className="fc-score-value">{value}</span>
      <span className="fc-score-track" aria-hidden="true"><span style={{ width: `${clamped}%` }} /></span>
    </div>
  );
}

function ReferencePhoto({ url }: { readonly url: string | undefined }) {
  const [shown, setShown] = useState(false);
  if (url === undefined) return null;
  return (
    <figure className="fc-reference">
      {shown
        ? <img className="fc-thumb fc-thumb--reference" src={url} alt="Foto de perfil de Google (la buscada)" referrerPolicy="no-referrer" />
        : <button type="button" className="fc-reference-reveal" onClick={() => setShown(true)}>
            <span className="fc-reference-icon" aria-hidden="true">◐</span>
            <span>Mostrar foto de perfil</span>
            <small>Se carga desde Google para comparar</small>
          </button>}
      <figcaption>La buscada</figcaption>
    </figure>
  );
}

export function FacecheckReview({ investigation, actionId, disabled, onDecide, onClose }: FacecheckReviewProps) {
  const state = useMemo(() => facecheckReviewState(investigation, actionId), [investigation, actionId]);
  const [tab, setTab] = useState<"review" | "accepted" | "rejected">("review");
  const [skipped, setSkipped] = useState<readonly string[]>([]);
  const [revisit, setRevisit] = useState<string | null>(null);
  const [history, setHistory] = useState<readonly string[]>([]);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus();
    return () => opener?.focus();
  }, []);

  const queue = useMemo(() => {
    const fresh = state.pending.filter((evidence) => !skipped.includes(evidence.id));
    const later = skipped.map((id) => state.pending.find((evidence) => evidence.id === id)).filter((evidence) => evidence !== undefined);
    return [...fresh, ...later];
  }, [state.pending, skipped]);

  const current = (revisit !== null ? state.candidates.find((evidence) => evidence.id === revisit) : undefined) ?? queue[0];
  const reviewed = state.candidates.length - state.pending.length;
  const photoSeed = investigation.actions.find((action) => action.id === actionId)?.spec.seed;
  const referenceUrl = photoSeed?.kind === "photo" && safeUrl(photoSeed.value)?.protocol === "https:" &&
    /(^|\.)googleusercontent\.com$/.test(new URL(photoSeed.value).hostname) ? photoSeed.value : undefined;

  function decide(evidence: EvidenceRecord, status: FacecheckDecision) {
    if (disabled) return;
    setHistory((previous) => [...previous.filter((id) => id !== evidence.id), evidence.id]);
    setSkipped((previous) => previous.filter((id) => id !== evidence.id));
    if (revisit === evidence.id) setRevisit(null);
    void onDecide(evidence.id, status, REASONS[status]);
  }

  function skip() {
    if (disabled || current === undefined) return;
    if (revisit !== null) { setRevisit(null); return; }
    setSkipped((previous) => [...previous.filter((id) => id !== current.id), current.id]);
  }

  function back() {
    const previous = history.at(-1);
    if (disabled || previous === undefined) return;
    setHistory((items) => items.slice(0, -1));
    setRevisit(previous);
    setTab("review");
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") { event.stopPropagation(); onClose(); return; }
    if (disabled || tab !== "review" || current === undefined || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "ArrowRight") { event.preventDefault(); decide(current, "accepted"); }
    else if (event.key === "ArrowLeft") { event.preventDefault(); decide(current, "rejected"); }
    else if (event.key === "ArrowDown") { event.preventDefault(); skip(); }
    else if (event.key.toLowerCase() === "z" && history.length > 0) { event.preventDefault(); back(); }
  }

  const progress = state.candidates.length === 0 ? 0 : Math.round((reviewed / state.candidates.length) * 100);
  const currentDecision = current === undefined ? undefined : state.decisionOf(current.id);
  const rank = current === undefined ? 0 : state.candidates.indexOf(current) + 1;

  return (
    <div className="fc-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={panelRef} className="fc-dialog" role="dialog" aria-modal="true" aria-labelledby="fc-title" tabIndex={-1} onKeyDown={onKeyDown}>
        <header className="fc-header">
          <div>
            <p className="eyebrow">FaceCheck · revisión de candidatos</p>
            <h2 id="fc-title">Revisar candidatos de FaceCheck</h2>
            <p className="fc-subtitle">FaceCheck encontró caras parecidas, no necesariamente la misma persona. Decidí una por una; solo las aceptadas cuentan como evidencia.</p>
          </div>
          <button type="button" className="fc-close" aria-label="Cerrar revisión" onClick={onClose}><span aria-hidden="true">×</span></button>
        </header>

        <div className="fc-progress" aria-hidden="true"><span style={{ width: `${progress}%` }} /></div>

        <div className="fc-tabs" role="tablist" aria-label="Candidatos">
          {([
            ["review", `Por revisar (${state.pending.length})`],
            ["accepted", `Aceptados (${state.accepted.length})`],
            ["rejected", `Descartados (${state.rejected.length})`],
          ] as const).map(([id, label]) => (
            <button key={id} type="button" role="tab" id={`fc-tab-${id}`} aria-selected={tab === id} aria-controls={`fc-panel-${id}`}
              className={`fc-tab fc-tab--${id}`} onClick={() => setTab(id)}>{label}</button>
          ))}
        </div>

        {tab === "review" && (
          <section id="fc-panel-review" role="tabpanel" aria-labelledby="fc-tab-review" className="fc-panel">
            <p className="fc-count">{state.pending.length === 0 ? "Nada por revisar" : `${state.pending.length} por revisar`}</p>
            {current === undefined ? (
              <div className="fc-done" role="status">
                <span className="fc-done-mark" aria-hidden="true">✓</span>
                <h3>{state.candidates.length === 1 ? "Revisaste el candidato" : `Revisaste los ${state.candidates.length} candidatos`}</h3>
                <p>{plural(state.accepted.length, "aceptado", "aceptados")} y {plural(state.rejected.length, "descartado", "descartados")}.</p>
                <p className="fc-muted">Solo los aceptados entran en el informe. Podés cambiar cualquier decisión desde las pestañas.</p>
                <div className="fc-done-actions">
                  {history.length > 0 && <button type="button" className="workspace-button" disabled={disabled} onClick={back}>Volver al anterior</button>}
                  <button type="button" className="workspace-button workspace-button--primary" onClick={onClose}>Listo</button>
                </div>
              </div>
            ) : (
              <>
                <div className="fc-stage">
                  <ReferencePhoto url={referenceUrl} />
                  <article key={current.id} className={`fc-card${currentDecision === "accepted" || currentDecision === "rejected" ? ` fc-card--${currentDecision}` : ""}`}
                    aria-label={`Candidato ${rank} de ${state.candidates.length}: ${siteName(current.finding?.url ?? "")}`}>
                    <div className="fc-card-media">
                      <Thumbnail evidence={current} size="large" />
                      {currentDecision === "accepted" && <span className="fc-stamp fc-stamp--accepted">Ya decidido: Aceptado</span>}
                      {currentDecision === "rejected" && <span className="fc-stamp fc-stamp--rejected">Ya decidido: Descartado</span>}
                    </div>
                    <div className="fc-card-body">
                      <p className="fc-rank">Candidato {rank} de {state.candidates.length}</p>
                      <h3>{siteName(current.finding?.url ?? "")}</h3>
                      {safeUrl(current.finding?.url ?? "") !== undefined && <p className="fc-path" title={current.finding?.url}>{pagePath(safeUrl(current.finding!.url)!)}</p>}
                      <ScoreMeter value={score(current)} />
                      {current.finding?.extra.testing_mode === true && <p className="fc-flag">Encontrado en modo prueba: poco fiable</p>}
                      <PageLink evidence={current} />
                    </div>
                  </article>
                </div>

                <div className="fc-actions">
                  <button type="button" className="fc-action fc-action--reject" disabled={disabled} onClick={() => decide(current, "rejected")}>
                    <span className="fc-action-icon" aria-hidden="true">✕</span>Descartar
                  </button>
                  <button type="button" className="fc-action fc-action--skip" disabled={disabled} onClick={skip}>{revisit !== null ? "Seguir revisando" : "Saltar"}</button>
                  <button type="button" className="fc-action fc-action--accept" disabled={disabled} onClick={() => decide(current, "accepted")}>
                    <span className="fc-action-icon" aria-hidden="true">✓</span>Aceptar
                  </button>
                </div>
                <div className="fc-footer">
                  <p className="fc-keys" aria-hidden="true"><kbd>←</kbd> descartar <kbd>↓</kbd> saltar <kbd>→</kbd> aceptar <kbd>Z</kbd> volver</p>
                  <button type="button" className="text-button" disabled={disabled || history.length === 0} onClick={back}>Volver al anterior</button>
                </div>
              </>
            )}
          </section>
        )}

        {tab !== "review" && (
          <section id={`fc-panel-${tab}`} role="tabpanel" aria-labelledby={`fc-tab-${tab}`} className="fc-panel">
            {(tab === "accepted" ? state.accepted : state.rejected).length === 0 ? (
              <p className="fc-empty">{tab === "accepted" ? "Todavía no aceptaste ningún candidato." : "No hay candidatos descartados."}</p>
            ) : (
              <ul className="fc-grid" aria-label={tab === "accepted" ? "Aceptados" : "Descartados"}>
                {(tab === "accepted" ? state.accepted : state.rejected).map((evidence) => (
                  <li key={evidence.id} className={`fc-tile fc-tile--${tab}`}>
                    <Thumbnail evidence={evidence} size="small" />
                    <div className="fc-tile-body">
                      <strong>{siteName(evidence.finding?.url ?? "")}</strong>
                      <span className="fc-tile-score">Score {score(evidence)}</span>
                      <PageLink evidence={evidence} compact />
                    </div>
                    <button type="button" className="workspace-button workspace-button--quiet" disabled={disabled}
                      onClick={() => decide(evidence, tab === "accepted" ? "rejected" : "accepted")}>
                      {tab === "accepted" ? "Mover a descartados" : "Mover a aceptados"}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {tab === "accepted" && <p className="fc-muted">Estos candidatos entran en el informe.</p>}
            {tab === "rejected" && <p className="fc-muted">Los descartados no entran en el informe.</p>}
          </section>
        )}
      </div>
    </div>
  );
}
