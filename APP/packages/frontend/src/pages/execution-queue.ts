import { findingSeedNodeId, gravatarFindingTargetsEmail, type EvidenceAiNormalization, type EvidenceNormalizationJob,
  type EvidenceRecord, type GitHubCatalogAction, type Investigation, type ScopedCatalogId } from "@investia/core";
import { explainNormalizationError } from "./useWorkspaceController";
import { actionTitle } from "./workspace-model";
import { actionDisplayState, workspaceStatusLabel } from "./workspace-status";

export type QueueAction = GitHubCatalogAction & {
  readonly rerun?: { readonly previousStatus: "succeeded" | "failed"; readonly fingerprint?: string };
  readonly lastRerunFailed?: true;
  readonly lastRerunFailure?: string;
};

type QueueProvenanceAction = QueueAction & { readonly sourceActionId?: string };
type QueueAuditEvent = Investigation["audit"][number] & { readonly failure?: string };
type QueueItemKind = "running" | "queued" | "waiting" | "completed" | "failed";
type RingMode = "empty" | "spinning" | "pending" | "complete_with_errors" | "complete";

export interface ExecutionQueueOptions {
  readonly ghuntConnected: boolean | null;
  readonly facecheckConfigured: boolean | null;
  readonly decodoConfigured: boolean | null;
  readonly normalizationJobs?: readonly EvidenceNormalizationJob[];
  readonly normalizations?: Readonly<Record<string, EvidenceAiNormalization>>;
}

interface QueueItem {
  readonly id: string;
  readonly targetKind: "action" | "evidence";
  readonly targetId: string;
  readonly selectable: boolean;
  readonly attemptNumber: number;
  readonly title: string;
  readonly target: string;
  readonly kind: QueueItemKind;
  readonly label: string;
  readonly executedAt?: string;
  readonly failureExplanation?: string;
}

interface ExecutionQueue {
  readonly items: readonly QueueItem[];
  readonly counts: Readonly<Record<QueueItemKind, number>>;
  readonly total: number;
  readonly ringMode: RingMode;
}

type QueueGroups = Record<QueueItemKind, QueueItem[]>;
type QueueItemDescription = Pick<QueueItem, "title" | "target">;
type QueueAttempt = Omit<QueueItem, "kind" | "label" | "failureExplanation">;
type HistoricalActionTool = { readonly pattern: RegExp; readonly title: string; readonly catalogId: ScopedCatalogId };

const TERMINAL_AUDIT_KINDS = new Set<string>(["action_succeeded", "action_rerun_succeeded", "action_failed"]);
const RERUN_UNCONFIRMED = "The replacement returned no confirmed results.";
const RERUN_CONFLICT = "Prior results changed during execution; the replacement was not applied.";

// The provenance reason can also name an upstream tool (e.g. Decodo for a FaceCheck result).
const HISTORICAL_ACTION_TOOLS: readonly HistoricalActionTool[] = [
  { pattern: /decodo/iu, title: "Decodo", catalogId: "decodo.url.v1" },
  { pattern: /gravatar/iu, title: "Perfil de Gravatar", catalogId: "gravatar.email.v1" },
  { pattern: /facecheck/iu, title: "Búsqueda facial · FaceCheck", catalogId: "facecheck.photo.v1" },
  { pattern: /maigret/iu, title: "Búsqueda de usuario · Maigret", catalogId: "maigret.username.v1" },
  { pattern: /ghunt/iu, title: "Perfil de Google · GHunt", catalogId: "ghunt.email.v1" },
  { pattern: /user[ -]scanner/iu, title: "Escaneo de correo · user-scanner", catalogId: "user-scanner.email.v1" },
];

const FAILURE_EXPLANATIONS = new Map<string, string>([
  ["A valid public HTTP URL seed is required", "Decodo necesita una URL pública y válida para consultar la página."],
  ["Decodo settings could not be loaded", "No se pudo cargar la configuración de Decodo."],
  ["Decodo API mode is invalid", "El modo de API de Decodo no es válido. Revisá la configuración."],
  ["Decodo API token is not configured", "Falta configurar el token de Decodo."],
  ["Decodo API token contains control characters", "El token de Decodo contiene caracteres no permitidos."],
  ["Decodo API token contains whitespace", "El token de Decodo contiene espacios."],
  ["Decodo API credentials were rejected", "Decodo rechazó el token. Revisá que sea válido para el modo de API elegido."],
  ["Decodo API rate limit or quota exceeded", "Se alcanzó el límite de consultas de Decodo o se agotó la cuota."],
  ["Decodo API rejected the scrape request", "Decodo rechazó la solicitud para consultar la página."],
  ["Decodo request timed out", "Decodo tardó demasiado en responder y se agotó el tiempo de espera."],
  ["Decodo request failed", "No se pudo completar la consulta a Decodo."],
  ["Decodo scrape blocked by anti-bot protection (999)", "La protección contra bots de la página bloqueó la consulta (código 999)."],
  ["Decodo target requires login", "La página requiere iniciar sesión para ver su contenido."],
  ["Decodo returned empty page content", "Decodo no encontró contenido para mostrar en la página."],
  ["Unexpected Decodo response", "Decodo devolvió una respuesta inesperada que no se pudo usar."],
  ["Unexpected Decodo response (invalid JSON)", "No se pudo leer la respuesta de Decodo: el formato no era válido."],
  ["Unexpected Decodo response (missing results)", "La respuesta de Decodo no incluía resultados."],
  ["Unexpected Decodo response (missing status)", "Decodo no informó el estado de la consulta."],
  ["Unexpected Decodo response (missing text content)", "La respuesta de Decodo no incluía el texto de la página."],
  [RERUN_UNCONFIRMED, "La reejecución no devolvió resultados confirmados."],
  [RERUN_CONFLICT, "Los resultados anteriores cambiaron durante la reejecución y no se reemplazaron."],
]);

export function explainActionFailure(rawFailure: string | undefined, catalogId?: string): string {
  // Match only public messages. Never echo arbitrary provider text, even if it was marked public.
  const message = rawFailure !== undefined && rawFailure.length <= 256
    ? rawFailure.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " ").trim()
    : "";
  const explanation = FAILURE_EXPLANATIONS.get(message);
  if (explanation !== undefined) return explanation;

  const serviceStatus = /^Decodo service failure \(HTTP ([5-9]\d{2})\)$/u.exec(message)?.[1];
  if (serviceStatus === "612" || serviceStatus === "613") return `Decodo no pudo obtener el contenido de la página (código ${serviceStatus}).`;
  if (serviceStatus !== undefined) return `El servicio de Decodo devolvió un error (código ${serviceStatus}).`;
  const targetStatus = /^Decodo target returned HTTP ([1-5]\d{2})$/u.exec(message)?.[1];
  if (targetStatus !== undefined) return `La página respondió con un error (HTTP ${targetStatus}).`;
  const requestStatus = /^Decodo request failed \(HTTP ([1-4]\d{2})\)$/u.exec(message)?.[1];
  if (requestStatus !== undefined) return `No se pudo completar la consulta a Decodo (HTTP ${requestStatus}).`;

  return catalogId === "decodo.url.v1"
    ? "Decodo no pudo completar la consulta y no hay un motivo específico registrado."
    : "La acción no pudo completarse y no hay un motivo específico registrado.";
}

function pendingRerunDescendants(actions: readonly QueueProvenanceAction[], evidence: Investigation["evidence"]): ReadonlySet<string> {
  const producerBySeed = new Map(evidence.map((record) => [findingSeedNodeId(record.id), record.actionId]));
  const childrenByAction = new Map<string, string[]>();
  function link(parentId: string | undefined, childId: string) {
    if (parentId === undefined || parentId === childId) return;
    const children = childrenByAction.get(parentId);
    if (children === undefined) childrenByAction.set(parentId, [childId]);
    else children.push(childId);
  }
  for (const action of actions) {
    link(action.sourceActionId, action.id);
    if (action.sourceSeedId !== undefined) link(producerBySeed.get(action.sourceSeedId), action.id);
  }

  const blocked = new Set<string>();
  function addChildren(id: string) {
    for (const child of childrenByAction.get(id) ?? []) blocked.add(child);
  }
  for (const action of actions) {
    if (action.rerun !== undefined && (action.status === "queued" || action.status === "claimed")) addChildren(action.id);
  }
  // Set iteration also visits new descendants and terminates on cyclic links.
  for (const child of blocked) addChildren(child);
  return blocked;
}

function waitingReason(investigation: Investigation, action: QueueAction, options: ExecutionQueueOptions, blockedByRerun: boolean): string | null {
  if (blockedByRerun) return "Esperando reejecución previa";
  if (action.status === "proposed") {
    return action.spec.catalogId === "gravatar.email.v1" ? "Espera tu aprobación" : "Propuesta histórica · no ejecutable";
  }
  const state = actionDisplayState(investigation, action, options.ghuntConnected, options.decodoConfigured);
  if (state === "waiting_google") return "Requiere iniciar sesión en Google";
  if (state === "waiting_scanner") {
    // Matches composed claimNextAction: a rerun of an already-completed unlinked Gravatar action is directly claimable.
    if (action.rerun !== undefined) return null;
    // The backend reconciles a historical unlinked Gravatar entry before it looks for the next claim.
    const email = action.spec.seed.value;
    const scanners = new Set(investigation.actions.filter((candidate) => candidate.status === "succeeded" &&
      candidate.spec.catalogId === "user-scanner.email.v1" && candidate.spec.seed.value === email).map(({ id }) => id));
    if (scanners.size === 0) return workspaceStatusLabel(state);
    const canLink = investigation.evidence.some((record) => scanners.has(record.actionId) && record.status === "registered" &&
      record.provider.trim().toLowerCase() === "gravatar" && record.finding !== undefined && gravatarFindingTargetsEmail(record.finding.target, email));
    return canLink ? null : "Espera tu aprobación";
  }
  if (state !== "queued") return workspaceStatusLabel(state);
  if (action.spec.catalogId === "facecheck.photo.v1" && options.facecheckConfigured !== true) {
    return options.facecheckConfigured === false ? "Requiere token de FaceCheck" : "Token de FaceCheck sin confirmar";
  }
  return null;
}

function describeAction(action: QueueAction): QueueItemDescription {
  const { catalogId, seed } = action.spec;
  switch (catalogId) {
    case "user-scanner.email.v1": return { title: "Escaneo de correo · user-scanner", target: seed.value };
    case "ghunt.email.v1": return { title: "Perfil de Google · GHunt", target: seed.value };
    case "gravatar.email.v1": return { title: "Perfil de Gravatar", target: seed.value };
    case "maigret.username.v1": return { title: "Búsqueda de usuario · Maigret", target: seed.value };
    case "facecheck.photo.v1": return { title: actionTitle(action), target: "Foto de perfil de Google" };
    case "decodo.url.v1": {
      let target = "Página pública";
      try {
        const { pathname } = new URL(seed.value);
        if (pathname !== "/") target = pathname.length <= 80 ? pathname : `${pathname.slice(0, 79)}…`;
      } catch { target = "Enlace sin confirmar"; }
      return { title: actionTitle(action), target };
    }
    default: return { title: actionTitle(action), target: seed.value };
  }
}

function formatAttemptTitle(baseTitle: string, attemptNumber: number): string {
  return attemptNumber <= 1 ? baseTitle : `Reintento ${attemptNumber} de ${baseTitle}`;
}

function completedLabel(attemptNumber: number): string {
  return attemptNumber === 1 ? "Completo" : `Completo · intento ${attemptNumber}`;
}

function failedLabel(attemptNumber: number): string {
  return attemptNumber === 1 ? "Falló" : "Reintento fallido";
}

const ISO_DATE_PREFIX = /^(\d{4})-(\d{2})-(\d{2})(?:[T ]|$)/u;

function parseValidTimestamp(iso: string | undefined): Date | undefined {
  if (!iso) return undefined;
  const match = ISO_DATE_PREFIX.exec(iso.trim());
  if (match !== null) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const calendar = new Date(Date.UTC(year, month - 1, day));
    if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) {
      return undefined;
    }
  }
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export function formatQueueTimestamp(iso: string | undefined, now = new Date()): string | undefined {
  const date = parseValidTimestamp(iso);
  if (date === undefined) return undefined;

  const pad = (value: number) => String(value).padStart(2, "0");
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const year = date.getFullYear();
  const month = date.getMonth();
  const day = date.getDate();
  const sameYear = year === now.getFullYear();
  if (sameYear && month === now.getMonth() && day === now.getDate()) return time;

  const dayAndMonth = `${pad(day)}/${pad(month + 1)}`;
  return sameYear ? `${dayAndMonth} ${time}` : `${dayAndMonth}/${String(year).padStart(4, "0")} ${time}`;
}

function queuedLabel(position: number): string {
  return position === 1 ? "Siguiente" : `En cola · #${position}`;
}

type IndexedAuditEvent = { readonly event: QueueAuditEvent; readonly auditIndex: number };

function terminalEventsByAction(audit: readonly QueueAuditEvent[]): ReadonlyMap<string, readonly IndexedAuditEvent[]> {
  const eventsByAction = new Map<string, IndexedAuditEvent[]>();
  audit.forEach((event, auditIndex) => {
    if (event.actionId === undefined || !TERMINAL_AUDIT_KINDS.has(event.kind)) return;
    const entry = { event, auditIndex };
    const events = eventsByAction.get(event.actionId);
    if (events === undefined) eventsByAction.set(event.actionId, [entry]);
    else events.push(entry);
  });
  return eventsByAction;
}

function rerunAuditFailure(reason: string): string | undefined {
  return reason === RERUN_CONFLICT || reason === RERUN_UNCONFIRMED ? reason : undefined;
}

function appendTerminalActionAttempt(
  groups: QueueGroups,
  orderById: Map<string, number>,
  item: QueueAttempt,
  orderKey: number,
  status: "succeeded" | "failed",
  failure?: string,
  catalogId?: string,
): void {
  orderById.set(item.id, orderKey);
  if (status === "succeeded") groups.completed.push({ ...item, kind: "completed", label: completedLabel(item.attemptNumber) });
  else groups.failed.push({ ...item, kind: "failed", label: failedLabel(item.attemptNumber),
    failureExplanation: explainActionFailure(failure, catalogId) });
}

function appendPrunedActionAttempts(
  groups: QueueGroups,
  orderById: Map<string, number>,
  audit: readonly QueueAuditEvent[],
  currentActionIds: ReadonlySet<string>,
): void {
  const toolsByAction = new Map<string, HistoricalActionTool>();
  for (const { actionId, actor, evidenceId, kind, reason } of audit) {
    if (actionId === undefined || currentActionIds.has(actionId) || toolsByAction.has(actionId)) continue;
    if (kind !== "action_queued" && kind !== "action_proposed") continue;
    // Manual Decodo requests are the only operator action_queued events linked to an evidenceId.
    const tool = kind === "action_queued" && actor === "operator" && evidenceId !== undefined
      ? HISTORICAL_ACTION_TOOLS[0]
      : HISTORICAL_ACTION_TOOLS.find(({ pattern }) => pattern.test(reason));
    if (tool !== undefined) toolsByAction.set(actionId, tool);
  }

  const attemptsByAction = new Map<string, number>();
  audit.forEach((event, auditIndex) => {
    const { actionId } = event;
    if (actionId === undefined || currentActionIds.has(actionId) || !TERMINAL_AUDIT_KINDS.has(event.kind)) return;
    const attempt = (attemptsByAction.get(actionId) ?? 0) + 1;
    attemptsByAction.set(actionId, attempt);
    const tool = toolsByAction.get(actionId);
    const item: QueueAttempt = {
      id: `action-pruned:${actionId}:attempt:${attempt}`, targetKind: "action", targetId: actionId, selectable: false,
      attemptNumber: attempt, title: formatAttemptTitle(tool?.title ?? "Acción histórica", attempt),
      target: "Acción reemplazada", executedAt: event.at,
    };
    if (event.kind === "action_failed") {
      appendTerminalActionAttempt(groups, orderById, item, auditIndex, "failed", event.failure ?? rerunAuditFailure(event.reason), tool?.catalogId);
    } else appendTerminalActionAttempt(groups, orderById, item, auditIndex, "succeeded");
  });
}

function appendActionAttempts(
  groups: QueueGroups,
  orderById: Map<string, number>,
  investigation: Investigation,
  options: ExecutionQueueOptions,
): void {
  const actions: readonly QueueProvenanceAction[] = investigation.actions;
  const blocked = pendingRerunDescendants(actions, investigation.evidence);
  const eventsByAction = terminalEventsByAction(investigation.audit);
  let legacyOrder = -1_000_000;
  for (const action of actions) {
    const base = describeAction(action);
    const itemFor = (attemptNumber: number) => ({
      id: `action:${action.id}:attempt:${attemptNumber}`, targetKind: "action" as const, targetId: action.id,
      selectable: true, attemptNumber, title: formatAttemptTitle(base.title, attemptNumber), target: base.target,
    });
    const addTerminal = (attemptNumber: number, orderKey: number, status: "succeeded" | "failed", failure?: string, executedAt?: string) => {
      appendTerminalActionAttempt(groups, orderById, { ...itemFor(attemptNumber), executedAt }, orderKey, status, failure, action.spec.catalogId);
    };
    const events = eventsByAction.get(action.id) ?? [];
    let nextAttempt = events.length + 1;
    if (events.length > 0) {
      let lastFailedIndex = events.length - 1;
      for (; lastFailedIndex >= 0; lastFailedIndex -= 1) {
        if (events[lastFailedIndex]?.event.kind === "action_failed") break;
      }
      events.forEach(({ event, auditIndex }, index) => {
        const attempt = index + 1;
        if (event.kind !== "action_failed") {
          addTerminal(attempt, auditIndex, "succeeded", undefined, event.at);
          return;
        }
        const failure = event.failure
          ?? (attempt === 1 && (action.status === "failed" || action.rerun?.previousStatus === "failed") ? action.failure : undefined)
          ?? (index === lastFailedIndex && action.lastRerunFailed ? action.lastRerunFailure : undefined)
          ?? rerunAuditFailure(event.reason);
        addTerminal(attempt, auditIndex, "failed", failure, event.at);
      });
    } else if (action.status === "succeeded" || action.status === "failed") {
      addTerminal(1, legacyOrder++, action.status, action.failure, action.completedAt);
      if (action.lastRerunFailed) addTerminal(2, legacyOrder++, "failed", action.lastRerunFailure);
    } else if (action.rerun !== undefined) {
      addTerminal(1, legacyOrder++, action.rerun.previousStatus, action.failure, action.completedAt);
      nextAttempt = 2;
    }

    const item = itemFor(nextAttempt);
    if (action.status === "claimed") {
      groups.running.push({ ...item, kind: "running", label: nextAttempt === 1 ? "En ejecución" : "Reejecutando" });
    } else if (action.status === "queued" || action.status === "proposed") {
      const reason = waitingReason(investigation, action, options, blocked.has(action.id));
      if (reason !== null) groups.waiting.push({ ...item, kind: "waiting", label: reason });
      else groups.queued.push({ ...item, kind: "queued", label: queuedLabel(groups.queued.length + 1) });
    }
  }
  appendPrunedActionAttempts(groups, orderById, investigation.audit, new Set(actions.map(({ id }) => id)));
}

function describeNormalization(evidence: (EvidenceRecord & { readonly metadata?: { readonly pageUrl?: string } }) | undefined): QueueItemDescription {
  const title = "Normalización con IA";
  if (evidence === undefined) return { title, target: "Página reemplazada" };
  for (const value of [evidence.finding?.target.value, evidence.metadata?.pageUrl]) {
    if (value === undefined) continue;
    try {
      const url = new URL(value);
      if (url.protocol === "https:" || url.protocol === "http:") return { title: `${title} · ${url.host}`, target: url.pathname };
    } catch { /* Try the other URL before displaying a generic label. */ }
  }
  return { title, target: "Página de Decodo" };
}

function appendNormalizationAttempts(groups: QueueGroups, investigation: Investigation, options: ExecutionQueueOptions): void {
  const evidenceById = new Map(investigation.evidence.map((evidence) => [evidence.id, evidence]));
  const jobs = options.normalizationJobs ?? [];
  const recordedFirstAttempts = new Set(jobs.filter((job) => job.attemptNumber === 1).map((job) => job.evidenceId));
  const legacyCompletedIds = new Set<string>(Object.values(options.normalizations ?? {}).map(({ evidenceId }) => evidenceId));
  for (const job of jobs) {
    if (job.attemptNumber > 1 && !recordedFirstAttempts.has(job.evidenceId)) legacyCompletedIds.add(job.evidenceId);
  }
  const itemFor = (id: string, targetId: string, attemptNumber: number) => {
    const evidence = evidenceById.get(targetId);
    const { title, target } = describeNormalization(evidence);
    return { id, targetId, targetKind: "evidence" as const, selectable: evidence !== undefined, attemptNumber,
      title: formatAttemptTitle(title, attemptNumber), target };
  };
  for (const evidenceId of legacyCompletedIds) {
    if (recordedFirstAttempts.has(evidenceId)) continue;
    const item = itemFor(`norm-legacy:${evidenceId}:attempt:1`, evidenceId, 1);
    groups.completed.push({ ...item, kind: "completed", label: completedLabel(1), executedAt: options.normalizations?.[evidenceId]?.generatedAt });
  }

  let queuePosition = 0;
  for (const job of jobs) {
    const { evidenceId, attemptNumber } = job;
    const item = itemFor(`norm:${job.id}`, evidenceId, attemptNumber);
    const executedAt = job.completedAt ?? job.startedAt ?? job.createdAt;
    switch (job.status) {
      case "running":
        groups.running.push({ ...item, kind: "running", label: attemptNumber === 1 ? "En ejecución" : "Reintentando" });
        break;
      case "queued":
        groups.queued.push({ ...item, kind: "queued", label: queuedLabel(++queuePosition) });
        break;
      case "succeeded":
        groups.completed.push({ ...item, kind: "completed", label: completedLabel(attemptNumber), executedAt });
        break;
      case "failed":
        groups.failed.push({ ...item, kind: "failed", label: failedLabel(attemptNumber), executedAt,
          failureExplanation: explainNormalizationError(job.errorCode) });
        break;
    }
  }
}

function newestFirst(items: readonly QueueItem[], orderById: ReadonlyMap<string, number>, normOffset: number): QueueItem[] {
  return items.map((item, index) => {
    const parsed = parseValidTimestamp(item.executedAt);
    const orderKey = orderById.get(item.id) ?? (normOffset + index);
    return { item, orderKey, timestamp: parsed === undefined ? -Infinity : parsed.getTime() };
  }).sort((a, b) => a.timestamp === b.timestamp ? b.orderKey - a.orderKey : b.timestamp - a.timestamp)
    .map(({ item }) => item);
}

export function buildExecutionQueue(investigation: Investigation, options: ExecutionQueueOptions): ExecutionQueue {
  const groups: QueueGroups = { running: [], queued: [], waiting: [], completed: [], failed: [] };
  const orderById = new Map<string, number>();
  appendActionAttempts(groups, orderById, investigation, options);
  appendNormalizationAttempts(groups, investigation, options);
  const normOffset = investigation.audit.length + 1_000_000;
  const items = [
    ...groups.running,
    ...groups.queued,
    ...groups.waiting,
    ...newestFirst(groups.completed, orderById, normOffset),
    ...newestFirst(groups.failed, orderById, normOffset),
  ];
  const counts = { running: groups.running.length, queued: groups.queued.length, waiting: groups.waiting.length,
    completed: groups.completed.length, failed: groups.failed.length };
  const total = items.length;
  const ringMode: RingMode = total === 0 ? "empty"
    : counts.running > 0 ? "spinning"
    : counts.queued > 0 || counts.waiting > 0 ? "pending"
    : counts.failed > 0 ? "complete_with_errors" : "complete";
  return { items, counts, total, ringMode };
}
