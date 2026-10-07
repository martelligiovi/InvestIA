import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Investigation } from "@investia/core";
import { ApiError, InvestigationApiClient } from "../api/client";

export type WorkspaceLoadPhase = "loading" | "ready" | "error" | "not-found";

export interface WorkspaceController {
  readonly investigation: Investigation | null;
  readonly phase: WorkspaceLoadPhase;
  readonly loadError: string;
  readonly operationError: string;
  readonly busy: boolean;
  readonly stale: boolean;
  readonly report: string | null;
  readonly reportRevision: number | null;
  readonly reportError: string;
  readonly reportLoading: boolean;
  readonly refresh: () => Promise<boolean>;
  readonly retryLoad: () => Promise<void>;
  readonly mutate: (operation: (api: InvestigationApiClient, id: string) => Promise<unknown>, dispatch?: boolean) => Promise<boolean>;
  readonly loadReport: () => Promise<void>;
}

function messageFor(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== "") return error.message;
  return "Ocurrió un error inesperado.";
}

function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

export function useWorkspaceController(id: string): WorkspaceController {
  const api = useMemo(() => new InvestigationApiClient(), []);
  const [investigation, setInvestigation] = useState<Investigation | null>(null);
  const [investigationId, setInvestigationId] = useState<string | null>(null);
  const [phase, setPhase] = useState<WorkspaceLoadPhase>("loading");
  const [loadError, setLoadError] = useState("");
  const [operationError, setOperationError] = useState("");
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const [report, setReport] = useState<string | null>(null);
  const [reportRevision, setReportRevision] = useState<number | null>(null);
  const [reportError, setReportError] = useState("");
  const [reportLoading, setReportLoading] = useState(false);
  const lock = useRef(false);
  const currentId = useRef(id);
  const generation = useRef(0);
  const mounted = useRef(false);
  const investigationRef = useRef<Investigation | null>(null);
  currentId.current = id;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const isCurrent = useCallback((targetId: string, targetGeneration: number): boolean => (
    mounted.current && currentId.current === targetId && generation.current === targetGeneration
  ), []);

  const readLatest = useCallback(async (targetGeneration: number): Promise<Investigation> => {
    const result = await api.getInvestigation(id);
    if (isCurrent(id, targetGeneration)) {
      const previous = investigationRef.current;
      if (previous?.id === id && previous.revision !== result.revision) {
        setReport(null);
        setReportRevision(null);
      }
      investigationRef.current = result;
      setInvestigation(result);
      setInvestigationId(id);
      setPhase("ready");
      setLoadError("");
      setStale(false);
    }
    return result;
  }, [api, id, isCurrent]);

  useEffect(() => {
    const activeGeneration = generation.current + 1;
    generation.current = activeGeneration;
    lock.current = false;
    investigationRef.current = null;
    setInvestigation(null);
    setInvestigationId(null);
    setPhase("loading");
    setLoadError("");
    setOperationError("");
    setBusy(false);
    setStale(false);
    setReport(null);
    setReportRevision(null);
    setReportError("");
    setReportLoading(false);
    void readLatest(activeGeneration).catch((error: unknown) => {
      if (!isCurrent(id, activeGeneration)) return;
      if (isNotFound(error)) {
        setInvestigation(null);
        investigationRef.current = null;
        setInvestigationId(id);
        setPhase("not-found");
      } else {
        setPhase("error");
        setLoadError(messageFor(error));
      }
    });
    return () => {
      if (generation.current === activeGeneration) generation.current += 1;
    };
  }, [id, isCurrent, readLatest]);

  const takeLock = useCallback((targetGeneration: number): boolean => {
    if (!isCurrent(id, targetGeneration) || lock.current) return false;
    lock.current = true;
    setBusy(true);
    return true;
  }, [id, isCurrent]);

  const releaseLock = useCallback((targetGeneration: number) => {
    if (!isCurrent(id, targetGeneration)) return;
    lock.current = false;
    setBusy(false);
  }, [id, isCurrent]);

  const refresh = useCallback(async (): Promise<boolean> => {
    const activeGeneration = generation.current;
    if (!takeLock(activeGeneration)) return false;
    setOperationError("");
    try {
      await readLatest(activeGeneration);
      return isCurrent(id, activeGeneration);
    } catch (error) {
      if (!isCurrent(id, activeGeneration)) return false;
      if (isNotFound(error)) {
        setInvestigation(null);
        investigationRef.current = null;
        setInvestigationId(id);
        setPhase("not-found");
        setReport(null);
        setReportRevision(null);
      } else {
        setStale(true);
        setOperationError(`No se pudo actualizar el expediente: ${messageFor(error)}`);
      }
      return false;
    } finally {
      releaseLock(activeGeneration);
    }
  }, [id, isCurrent, readLatest, releaseLock, takeLock]);

  const retryLoad = useCallback(async () => {
    const activeGeneration = generation.current;
    if (!takeLock(activeGeneration)) return;
    setPhase("loading");
    setLoadError("");
    setOperationError("");
    try {
      await readLatest(activeGeneration);
    } catch (error) {
      if (!isCurrent(id, activeGeneration)) return;
      if (isNotFound(error)) {
        setInvestigation(null);
        investigationRef.current = null;
        setInvestigationId(id);
        setPhase("not-found");
      } else {
        setPhase("error");
        setLoadError(messageFor(error));
      }
    } finally {
      releaseLock(activeGeneration);
    }
  }, [id, isCurrent, readLatest, releaseLock, takeLock]);

  const mutate = useCallback(async (
    operation: (client: InvestigationApiClient, investigationId: string) => Promise<unknown>,
    dispatch = false,
  ): Promise<boolean> => {
    const activeGeneration = generation.current;
    if (investigationId !== id || stale || !takeLock(activeGeneration)) return false;
    setOperationError("");
    setReport(null);
    setReportRevision(null);
    setReportError("");

    let mutationError: unknown;
    try {
      await operation(api, id);
    } catch (error) {
      mutationError = error;
    }
    if (!isCurrent(id, activeGeneration)) return false;

    let refreshError: unknown;
    try {
      await readLatest(activeGeneration);
    } catch (error) {
      refreshError = error;
      if (isCurrent(id, activeGeneration)) {
        if (isNotFound(error)) {
          setInvestigation(null);
          investigationRef.current = null;
          setInvestigationId(id);
          setPhase("not-found");
          setReport(null);
          setReportRevision(null);
        } else {
          setStale(true);
        }
      }
    }
    if (!isCurrent(id, activeGeneration)) return false;

    if (mutationError !== undefined && refreshError !== undefined) {
      const dispatchWarning = dispatch ? " El resultado del despacho es desconocido; no lo reintentes." : "";
      setOperationError(`No se pudo confirmar la operación: ${messageFor(mutationError)}. Tampoco se pudo actualizar el expediente: ${messageFor(refreshError)}. El estado del cambio es desconocido y los controles quedan bloqueados hasta actualizar.${dispatchWarning}`);
    } else if (mutationError !== undefined) {
      const uncertainDispatch = dispatch
        ? " Se volvió a consultar el expediente; no se reintentó el despacho. Si quedó reclamada, su efecto externo es desconocido."
        : " Se volvió a consultar el expediente antes de habilitar controles.";
      setOperationError(`No se pudo confirmar la operación: ${messageFor(mutationError)}.${uncertainDispatch}`);
    } else if (refreshError !== undefined) {
      setOperationError(`La operación pudo guardarse, pero no se pudo actualizar el expediente: ${messageFor(refreshError)}. Su estado actual es desconocido y los controles quedan bloqueados hasta actualizar.`);
    }

    releaseLock(activeGeneration);
    return mutationError === undefined && refreshError === undefined;
  }, [api, id, investigationId, isCurrent, readLatest, releaseLock, stale, takeLock]);

  const loadReport = useCallback(async () => {
    const activeGeneration = generation.current;
    if (investigationId !== id || stale || !takeLock(activeGeneration)) return;
    const boundRevision = investigationRef.current?.revision;
    setReportError("");
    setReportLoading(true);
    try {
      const content = await api.getReport(id);
      if (!isCurrent(id, activeGeneration)) return;
      if (boundRevision === undefined || investigationRef.current?.revision !== boundRevision) {
        setReport(null);
        setReportRevision(null);
        setReportError("La revisión del expediente cambió; actualizá el informe antes de descargarlo.");
        return;
      }
      setReport(content);
      setReportRevision(boundRevision);
    } catch (error) {
      if (isCurrent(id, activeGeneration)) setReportError(`No se pudo obtener el informe: ${messageFor(error)}`);
    } finally {
      if (isCurrent(id, activeGeneration)) setReportLoading(false);
      releaseLock(activeGeneration);
    }
  }, [api, id, investigationId, isCurrent, releaseLock, stale, takeLock]);

  useEffect(() => {
    if (investigationId !== id || investigation === null || stale || phase !== "ready" ||
      !investigation.actions.some((action) => action.status === "claimed")) return;
    const activeGeneration = generation.current;
    const timer = window.setInterval(() => {
      if (!takeLock(activeGeneration)) return;
      void readLatest(activeGeneration).catch((error: unknown) => {
        if (isCurrent(id, activeGeneration)) {
          setStale(true);
          setOperationError(`No se pudo actualizar la acción reclamada: ${messageFor(error)}`);
        }
      }).finally(() => releaseLock(activeGeneration));
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [id, investigation, investigationId, isCurrent, phase, readLatest, releaseLock, stale, takeLock]);

  const visibleInvestigation = investigationId === id ? investigation : null;
  const visiblePhase = visibleInvestigation === null && phase === "ready" ? "loading" : phase;

  return {
    investigation: visibleInvestigation,
    phase: visiblePhase,
    loadError,
    operationError,
    busy,
    stale,
    report,
    reportRevision,
    reportError,
    reportLoading,
    refresh,
    retryLoad,
    mutate,
    loadReport,
  };
}
