import { authorizationCovers, type GitHubCatalogAction, type Investigation } from "@investia/core";

export function hasCatalogAuthorization(investigation: Investigation): boolean {
  return investigation.authorization?.granted === true &&
    investigation.actions.every((action) => authorizationCovers(investigation.authorization, action.spec.catalogId));
}

export function actionDisplayState(investigation: Investigation, action: GitHubCatalogAction, ghuntConnected: boolean | null = null): string {
  if (action.status !== "queued") return action.status;
  if (!authorizationCovers(investigation.authorization, action.spec.catalogId)) return "waiting_authorization";
  if (investigation.paused) return "paused_queue";
  if (action.spec.catalogId === "ghunt.email.v1" && ghuntConnected !== true) return ghuntConnected === false ? "waiting_google" : "unknown_google";
  if (!action.queuedByCatalog && action.approval === undefined) return "not_executable";
  // Historical unlinked Gravatar queues run only after their user-scanner result links them.
  if (action.spec.catalogId === "gravatar.email.v1" && action.sourceSeedId === undefined && action.approval === undefined) {
    return "waiting_scanner";
  }
  return "queued";
}

export function workspaceHeadline(investigation: Investigation, ghuntConnected: boolean | null = null): string {
  if (investigation.paused) return "Pausada";
  if (!hasCatalogAuthorization(investigation)) return "Esperando autorización";
  if (investigation.actions.some((action) => action.status === "claimed")) return "Acción reclamada · efecto incierto";
  const runnable = investigation.actions.some((action) => actionDisplayState(investigation, action, ghuntConnected) === "queued");
  if (!runnable && investigation.actions.some((action) => actionDisplayState(investigation, action, ghuntConnected) === "waiting_google")) return "Esperando conexión de Google";
  if (!runnable && investigation.actions.some((action) => actionDisplayState(investigation, action, ghuntConnected) === "unknown_google")) return "Conexión de Google desconocida";
  if (investigation.advancementMode !== "automatic") return "Avance manual";
  if (runnable) return "Cola automática habilitada";
  return "Sin acciones ejecutables";
}

const WORKSPACE_STATUS_LABELS: Readonly<Record<string, string>> = {
  waiting_authorization: "Esperando autorización",
  waiting_google: "Requiere login",
  unknown_google: "Conexión de Google desconocida",
  paused_queue: "En cola · pausada",
  not_executable: "En cola · no ejecutable",
  waiting_scanner: "En espera de user-scanner",
  no_information: "Sin información",
  leaf_group: "Sin acciones asociadas",
  discovered: "Semilla descubierta",
  proposed: "Propuesta",
  queued: "En cola",
  claimed: "Reclamada",
  succeeded: "Completada",
  failed: "Fallida",
  registered: "Registrado",
  not_registered: "No registrado",
  rate_limited: "Límite de consultas",
  error: "Error",
  unknown: "Desconocido",
  accepted: "Aceptada",
  rejected: "Rechazada",
  inconclusive: "Inconclusa",
};

export function workspaceStatusLabel(status: string): string {
  return WORKSPACE_STATUS_LABELS[status] ?? status;
}
