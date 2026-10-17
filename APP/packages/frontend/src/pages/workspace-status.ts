import type { GitHubCatalogAction, Investigation } from "@investia/core";

export function hasCatalogAuthorization(investigation: Investigation): boolean {
  return investigation.authorization?.granted === true &&
    (!investigation.actions.some((action) => action.spec.catalogId === "user-scanner.email.v1") ||
      investigation.authorization.catalogScope === "user-scanner.email.v1");
}

export function actionDisplayState(investigation: Investigation, action: GitHubCatalogAction): string {
  if (action.status !== "queued") return action.status;
  if (investigation.authorization?.granted !== true ||
    (action.spec.catalogId === "user-scanner.email.v1" && investigation.authorization.catalogScope !== "user-scanner.email.v1")) return "waiting_authorization";
  if (investigation.paused) return "paused_queue";
  if (!action.queuedByCatalog && action.approval === undefined) return "not_executable";
  return "queued";
}

export function workspaceHeadline(investigation: Investigation): string {
  if (investigation.paused) return "Pausada";
  if (!hasCatalogAuthorization(investigation)) return "Esperando autorización";
  if (investigation.actions.some((action) => action.status === "claimed")) return "Acción reclamada · efecto incierto";
  if (investigation.advancementMode !== "automatic") return "Avance manual";
  if (investigation.actions.some((action) => actionDisplayState(investigation, action) === "queued")) return "Cola automática habilitada";
  return "Sin acciones ejecutables";
}

const WORKSPACE_STATUS_LABELS: Readonly<Record<string, string>> = {
  waiting_authorization: "Esperando autorización",
  paused_queue: "En cola · pausada",
  not_executable: "En cola · no ejecutable",
  no_information: "Sin información",
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
