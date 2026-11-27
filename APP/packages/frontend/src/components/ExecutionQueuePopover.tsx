import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { Investigation } from "@investia/core";
import { buildExecutionQueue, type ExecutionQueueOptions } from "../pages/execution-queue";

interface ExecutionQueuePopoverProps extends ExecutionQueueOptions {
  readonly investigation: Investigation;
  readonly onSelectAction: (actionId: string) => void;
}

type Queue = ReturnType<typeof buildExecutionQueue>;
type QueueItem = Queue["items"][number];

function QueueRing({ ringMode, total, settled, counts }: Queue) {
  const done = ringMode === "complete" || ringMode === "complete_with_errors";
  return (
    <svg className="queue-ring" data-mode={ringMode} width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
      <circle className="queue-ring-track" cx="11" cy="11" r="8.75" />
      {settled > 0 && <circle className="queue-ring-progress" cx="11" cy="11" r="8.75" pathLength="100"
        strokeDasharray="100" strokeDashoffset={100 - settled / total * 100} transform="rotate(-90 11 11)" />}
      {ringMode === "spinning" && <circle className="queue-ring-sweep" cx="11" cy="11" r="8.75" pathLength="100" strokeDasharray="28 72" />}
      {ringMode === "progress_active" && <circle className="queue-ring-sweep queue-ring-sweep--inner" cx="11" cy="11" r="5" pathLength="100" strokeDasharray="30 70" />}
      {done && <path className="queue-ring-check" d="m7.4 11.1 2.4 2.5 4.9-5.2" />}
      {counts.failed > 0 && <circle className="queue-ring-alert" cx="18.5" cy="4" r="2.75" />}
    </svg>
  );
}

function countSummary({ running, queued, waiting, completed, failed }: Queue["counts"]): string {
  return [running && `${running} en ejecución`, queued && `${queued} en cola`, waiting && `${waiting} en espera`,
    completed && `${completed} ${completed === 1 ? "completa" : "completas"}`,
    failed && `${failed} ${failed === 1 ? "fallida" : "fallidas"}`].filter(Boolean).join(" · ");
}

function QueueItemRow({
  item,
  errorIdPrefix,
  onSelect,
}: {
  readonly item: QueueItem;
  readonly errorIdPrefix: string;
  readonly onSelect: (actionId: string) => void;
}) {
  const errorId = item.failureExplanation === undefined ? undefined : `${errorIdPrefix}-error-${item.actionId}`;
  return (
    <li className="queue-item" data-kind={item.kind}>
      <button type="button" className="queue-item-button" onClick={() => onSelect(item.actionId)} aria-describedby={errorId}>
        <span className="queue-item-heading">
          <span className="queue-item-title">{item.title}</span>
          <span className="queue-item-label">
            {item.kind === "completed" && <span className="queue-item-check" aria-hidden="true">✓ </span>}{item.label}
          </span>
        </span>
        <span className="queue-item-target">{item.target}</span>
      </button>
      {item.kind === "running" && <div className="queue-item-loading" role="progressbar" aria-label={item.label} />}
      {errorId !== undefined && <p id={errorId} className="queue-item-error">{item.failureExplanation}</p>}
    </li>
  );
}

export function ExecutionQueuePopover({ investigation, ghuntConnected, facecheckConfigured, decodoConfigured, onSelectAction }: ExecutionQueuePopoverProps) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const triggerRef = useRef<HTMLElement>(null);
  const errorIdPrefix = useId();
  const completedListId = useId();
  const failedListId = useId();
  const [completedOpen, setCompletedOpen] = useState(false);
  const [failedOpen, setFailedOpen] = useState(false);

  useEffect(() => {
    setCompletedOpen(false);
    setFailedOpen(false);
  }, [investigation.id]);

  const queue = useMemo(() => buildExecutionQueue(investigation, { ghuntConnected, facecheckConfigured, decodoConfigured }),
    [investigation, ghuntConnected, facecheckConfigured, decodoConfigured]);

  const activeItems = useMemo(
    () => queue.items.filter((item) => item.kind === "running" || item.kind === "queued" || item.kind === "waiting"),
    [queue.items],
  );
  const completedItems = useMemo(
    () => queue.items.filter((item) => item.kind === "completed"),
    [queue.items],
  );
  const failedItems = useMemo(
    () => queue.items.filter((item) => item.kind === "failed"),
    [queue.items],
  );

  function selectAction(actionId: string) {
    onSelectAction(actionId);
    setCompletedOpen(false);
    setFailedOpen(false);
    if (detailsRef.current !== null) detailsRef.current.open = false;
    triggerRef.current?.focus({ preventScroll: true });
  }

  return (
    <details
      ref={detailsRef}
      className="workspace-queue-disclosure workspace-disclosure"
      onToggle={(event) => {
        if (!event.currentTarget.open) {
          setCompletedOpen(false);
          setFailedOpen(false);
        }
      }}
    >
      <summary ref={triggerRef} className="workspace-queue-trigger">
        <QueueRing {...queue} />
        <span>Cola</span>
        {queue.percent !== null && <span className="queue-trigger-progress">{queue.ringMode === "spinning" ? "En curso" : `${queue.percent}%`}</span>}
        {queue.counts.failed > 0 && <span className="queue-trigger-errors">{queue.counts.failed} <span className="sr-only">{queue.counts.failed === 1 ? "fallida" : "fallidas"}</span></span>}
      </summary>
      <div className="workspace-popover workspace-queue-panel" role="region" aria-label="Cola de ejecución">
        <header className="queue-panel-header">
          <h2>Cola de ejecución</h2>
          {queue.total > 0 && <p className="queue-panel-counts">{countSummary(queue.counts)}</p>}
          <p className="queue-panel-note">Las etapas siguientes se suman al desbloquearse nuevos hallazgos.</p>
        </header>
        {queue.total === 0 ? <p className="queue-panel-empty">Todavía no hay acciones en cola.</p> : (
          <div className="queue-sections">
            {activeItems.length > 0 && (
              <ol className="queue-items" role="list">
                {activeItems.map((item) => <QueueItemRow key={item.actionId} item={item} errorIdPrefix={errorIdPrefix} onSelect={selectAction} />)}
              </ol>
            )}
            {completedItems.length > 0 && (
              <div className="queue-group queue-group--completed" data-open={completedOpen}>
                <button
                  type="button"
                  className="queue-group-toggle"
                  aria-expanded={completedOpen}
                  aria-controls={completedListId}
                  onClick={() => setCompletedOpen((open) => !open)}
                >
                  <span className="queue-group-title">
                    <span className="queue-item-check" aria-hidden="true">✓</span>
                    <span>Completadas</span>
                  </span>
                  <span className="queue-group-meta">
                    <span className="queue-group-count">{completedItems.length}</span>
                    <span className="queue-group-chevron" aria-hidden="true">v</span>
                  </span>
                </button>
                <ol id={completedListId} className="queue-items queue-group-items" role="list" hidden={!completedOpen}>
                  {completedItems.map((item) => <QueueItemRow key={item.actionId} item={item} errorIdPrefix={errorIdPrefix} onSelect={selectAction} />)}
                </ol>
              </div>
            )}
            {failedItems.length > 0 && (
              <div className="queue-group queue-group--failed" data-open={failedOpen}>
                <button
                  type="button"
                  className="queue-group-toggle"
                  aria-expanded={failedOpen}
                  aria-controls={failedListId}
                  onClick={() => setFailedOpen((open) => !open)}
                >
                  <span className="queue-group-title">
                    <span className="queue-group-alert-dot" aria-hidden="true" />
                    <span>Errores</span>
                  </span>
                  <span className="queue-group-meta">
                    <span className="queue-group-count">{failedItems.length}</span>
                    <span className="queue-group-chevron" aria-hidden="true">v</span>
                  </span>
                </button>
                <ol id={failedListId} className="queue-items queue-group-items" role="list" hidden={!failedOpen}>
                  {failedItems.map((item) => <QueueItemRow key={item.actionId} item={item} errorIdPrefix={errorIdPrefix} onSelect={selectAction} />)}
                </ol>
              </div>
            )}
          </div>
        )}
      </div>
    </details>
  );
}
