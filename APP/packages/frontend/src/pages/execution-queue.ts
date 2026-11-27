import { findingSeedNodeId, gravatarFindingTargetsEmail, type GitHubCatalogAction, type Investigation } from "@investia/core";
import { actionTitle } from "./workspace-model";
import { actionDisplayState, workspaceStatusLabel } from "./workspace-status";

export type QueueAction = GitHubCatalogAction & {
  readonly rerun?: { readonly previousStatus: "succeeded" | "failed" };
  readonly lastRerunFailed?: true;
  readonly lastRerunFailure?: string;
};

type QueueProvenanceAction = QueueAction & { readonly sourceActionId?: string };
type QueueItemKind = "running" | "queued" | "waiting" | "completed" | "failed";
type RingMode = "empty" | "spinning" | "progress_active" | "progress" | "complete_with_errors" | "complete";

export interface ExecutionQueueOptions {
  readonly ghuntConnected: boolean | null;
  readonly facecheckConfigured: boolean | null;
  readonly decodoConfigured: boolean | null;
}

interface QueueItem {
  readonly actionId: string;
  readonly title: string;
  readonly target: string;
  readonly kind: QueueItemKind;
  readonly label: string;
  readonly failureExplanation?: string;
}

interface ExecutionQueue {
  readonly items: readonly QueueItem[];
  readonly counts: Readonly<Record<QueueItemKind, number>>;
  readonly total: number;
  readonly settled: number;
  readonly percent: number | null;
  readonly ringMode: RingMode;
}

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
  ["The replacement returned no confirmed results.", "La reejecución no devolvió resultados confirmados."],
  ["Prior results changed during execution; the replacement was not applied.", "Los resultados anteriores cambiaron durante la reejecución y no se reemplazaron."],
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

function describeAction(action: QueueAction): Pick<QueueItem, "title" | "target"> {
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

export function buildExecutionQueue(investigation: Investigation, options: ExecutionQueueOptions): ExecutionQueue {
  const actions: readonly QueueProvenanceAction[] = investigation.actions;
  const blocked = pendingRerunDescendants(actions, investigation.evidence);
  const groups: Record<QueueItemKind, QueueItem[]> = { running: [], queued: [], waiting: [], completed: [], failed: [] };
  for (const action of actions) {
    const item = { actionId: action.id, ...describeAction(action) };
    if (action.status === "claimed") {
      groups.running.push({ ...item, kind: "running", label: action.rerun === undefined ? "En ejecución" : "Reejecutando" });
    } else if (action.status === "queued" || action.status === "proposed") {
      const reason = waitingReason(investigation, action, options, blocked.has(action.id));
      if (reason !== null) groups.waiting.push({ ...item, kind: "waiting", label: reason });
      else {
        const position = groups.queued.length + 1;
        groups.queued.push({ ...item, kind: "queued", label: position === 1 ? "Siguiente" : `En cola · #${position}` });
      }
    } else if (action.status === "failed" || action.lastRerunFailed === true) {
      const failure = action.lastRerunFailed === true ? action.lastRerunFailure ?? action.failure : action.failure;
      groups.failed.push({ ...item, kind: "failed",
        label: action.status === "failed" ? "Falló" : "Reejecución fallida · se conservó el resultado anterior",
        failureExplanation: explainActionFailure(failure, action.spec.catalogId) });
    } else {
      groups.completed.push({ ...item, kind: "completed", label: "Completo" });
    }
  }

  const items = [...groups.running, ...groups.queued, ...groups.waiting, ...groups.completed, ...groups.failed];
  const counts = { running: groups.running.length, queued: groups.queued.length, waiting: groups.waiting.length,
    completed: groups.completed.length, failed: groups.failed.length };
  const total = items.length;
  const settled = counts.completed + counts.failed;
  const percent = total === 0 ? null : settled === total ? 100 : Math.min(99, Math.round(settled / total * 100));
  const ringMode: RingMode = total === 0 ? "empty"
    : settled === total ? (counts.failed > 0 ? "complete_with_errors" : "complete")
    : counts.running === 0 ? "progress"
    : settled === 0 ? "spinning" : "progress_active";
  return { items, counts, total, settled, percent, ringMode };
}
