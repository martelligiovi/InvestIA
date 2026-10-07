const WORKSPACE_STATUS_LABELS: Readonly<Record<string, string>> = {
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
