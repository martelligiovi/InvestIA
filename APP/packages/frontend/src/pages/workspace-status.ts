import { actionOperationalState, investigationOperationalStatus, type GitHubCatalogAction, type Investigation, type InvestigationOperationalStatus } from "@investia/core";

export { hasCatalogAuthorization } from "@investia/core";

export function actionDisplayState(investigation: Investigation, action: GitHubCatalogAction, ghuntConnected: boolean | null = null, decodoConfigured: boolean | null = null): string {
  return actionOperationalState(investigation, action, { ghuntConnected, decodoConfigured });
}

const INVESTIGATION_OPERATIONAL_STATUS_LABELS: Readonly<Record<InvestigationOperationalStatus, string>> = {
  paused: "Pausada",
  awaiting_authorization: "Esperando autorización",
  claimed_uncertain: "Acción reclamada · efecto incierto",
  awaiting_google_connection: "Esperando conexión de Google",
  google_connection_unknown: "Conexión de Google desconocida",
  manual_queue: "Avance manual",
  automatic_queue: "Cola automática habilitada",
  no_executable_actions: "Sin acciones ejecutables",
};

export function investigationOperationalStatusLabel(status: InvestigationOperationalStatus): string {
  return INVESTIGATION_OPERATIONAL_STATUS_LABELS[status];
}

export function workspaceHeadline(investigation: Investigation, ghuntConnected: boolean | null = null, decodoConfigured: boolean | null = null): string {
  return investigationOperationalStatusLabel(investigationOperationalStatus(investigation, { ghuntConnected, decodoConfigured }));
}

const WORKSPACE_STATUS_LABELS: Readonly<Record<string, string>> = {
  waiting_authorization: "Esperando autorización",
  waiting_google: "Requiere login",
  unknown_google: "Conexión de Google desconocida",
  waiting_facecheck_acceptance: "Requiere aceptar la coincidencia",
  waiting_decodo_token: "Requiere token de Decodo",
  unknown_decodo_token: "Token de Decodo sin confirmar",
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
