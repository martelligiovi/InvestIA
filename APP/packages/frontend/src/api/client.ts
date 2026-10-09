import type {
  GitHubCatalogAction,
  Investigation,
  InvestigationSummary,
  ValidationStatus,
} from "@investia/core";

export interface ProjectionReconciliationOutcome {
  readonly id: string;
  readonly revision: number | null;
  readonly status: "applied" | "stale" | "failed";
}

export interface ProjectionReconciliation {
  readonly outcomes: readonly ProjectionReconciliationOutcome[];
}

interface ApiErrorEnvelope {
  readonly error?: unknown;
  readonly message?: unknown;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function pathPart(value: string): string {
  return encodeURIComponent(value);
}

export class InvestigationApiClient {
  constructor(private readonly fetcher: typeof fetch = fetch.bind(globalThis)) {}

  async createInvestigation(
    name?: string,
    intention?: string,
    advancementMode?: Investigation["advancementMode"],
  ): Promise<Investigation> {
    return this.post<Investigation>(
      "/investigations",
      name === undefined && intention === undefined && advancementMode === undefined
        ? undefined : { name, intention, advancementMode },
    );
  }

  async listInvestigations(): Promise<InvestigationSummary[]> {
    return this.requestJson<InvestigationSummary[]>("/investigations");
  }

  async getInvestigation(id: string): Promise<Investigation> {
    return this.requestJson<Investigation>(`/investigations/${pathPart(id)}`);
  }

  async addEmailSeed(id: string, email: string, reason: string): Promise<Investigation> {
    return this.post<Investigation>(`/investigations/${pathPart(id)}/emails`, { email, reason });
  }

  async proposeGitHubAction(id: string, email: string, reason: string): Promise<GitHubCatalogAction> {
    return this.post<GitHubCatalogAction>(
      `/investigations/${pathPart(id)}/actions/proposals`,
      { email, reason },
    );
  }

  async setAuthorization(id: string, granted: boolean, reason: string): Promise<Investigation> {
    return this.post<Investigation>(`/investigations/${pathPart(id)}/authorization`, { granted, reason });
  }

  async approveAction(id: string, actionId: string, reason: string): Promise<GitHubCatalogAction> {
    return this.post<GitHubCatalogAction>(
      `/investigations/${pathPart(id)}/actions/${pathPart(actionId)}/approval`,
      { reason },
    );
  }

  async runNextAction(id: string): Promise<{ readonly action: GitHubCatalogAction | null }> {
    return this.post(`/investigations/${pathPart(id)}/actions/run`);
  }

  async validateEvidence(
    id: string,
    evidenceId: string,
    status: ValidationStatus,
    reason: string,
  ): Promise<Investigation> {
    return this.post<Investigation>(
      `/investigations/${pathPart(id)}/evidence/${pathPart(evidenceId)}/validation`,
      { status, reason },
    );
  }

  async rejectEvidence(id: string, evidenceId: string, reason: string): Promise<Investigation> {
    return this.post<Investigation>(
      `/investigations/${pathPart(id)}/evidence/${pathPart(evidenceId)}/rejection`,
      { reason },
    );
  }

  async pauseInvestigation(id: string, reason: string): Promise<Investigation> {
    return this.post<Investigation>(`/investigations/${pathPart(id)}/pause`, { reason });
  }

  async resumeInvestigation(id: string, reason: string): Promise<Investigation> {
    return this.post<Investigation>(`/investigations/${pathPart(id)}/resume`, { reason });
  }

  async reconcileProjections(): Promise<ProjectionReconciliation> {
    return this.post<ProjectionReconciliation>("/investigations/projections/reconcile");
  }

  async getReport(id: string): Promise<string> {
    const response = await this.fetcher(`/investigations/${pathPart(id)}/report`, {
      method: "GET",
      headers: { Accept: "text/markdown, text/plain;q=0.9" },
    });
    await this.throwForError(response);
    return response.text();
  }

  private async post<T>(path: string, body?: unknown): Promise<T> {
    const init: RequestInit = { method: "POST" };
    if (body !== undefined) {
      init.headers = { "Content-Type": "application/json", Accept: "application/json" };
      init.body = JSON.stringify(body);
    }
    return this.requestJson<T>(path, init);
  }

  private async requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetcher(path, {
      ...init,
      headers: { Accept: "application/json", ...init.headers },
    });
    await this.throwForError(response);
    return (await response.json()) as T;
  }

  private async throwForError(response: Response): Promise<void> {
    if (response.ok) return;

    let payload: unknown;
    try {
      payload = (await response.json()) as ApiErrorEnvelope;
    } catch {
      payload = undefined;
    }

    const envelope = isRecord(payload) ? payload : undefined;
    const code = typeof envelope?.error === "string" ? envelope.error : "HTTP_ERROR";
    const message = typeof envelope?.message === "string"
      ? envelope.message
      : response.statusText || `HTTP ${response.status}`;
    throw new ApiError(response.status, code, message);
  }
}
