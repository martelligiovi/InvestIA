import type {
  AiReportSettings,
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

export interface AiSettingsView {
  readonly apiKeyConfigured: boolean;
  /** Masked hint of the stored key; the key itself is never returned. */
  readonly apiKeyHint: string | null;
  readonly settings: AiReportSettings;
  readonly defaults: AiReportSettings;
}

export interface AiSettingsUpdate {
  readonly apiKey?: string;
  readonly settings?: Partial<AiReportSettings>;
}

export interface AiModelOption {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly reasoning: boolean;
}

export interface AiModelList {
  readonly models: readonly AiModelOption[];
  readonly source: "live" | "fallback";
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

  async addUsernameSeed(id: string, username: string, reason: string): Promise<Investigation> {
    return this.post<Investigation>(`/investigations/${pathPart(id)}/usernames`, { username, reason });
  }

  async decideUsernameProposal(id: string, username: string, decision: "accepted" | "rejected", reason: string): Promise<Investigation> {
    return this.post<Investigation>(`/investigations/${pathPart(id)}/usernames/decisions`, { username, decision, reason });
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
    return this.requestMarkdown(`/investigations/${pathPart(id)}/report`, "GET");
  }

  async generateAiReport(id: string): Promise<string> {
    return this.requestMarkdown(`/investigations/${pathPart(id)}/report/ai`, "POST");
  }

  async getAiSettings(): Promise<AiSettingsView> {
    return this.requestJson<AiSettingsView>("/settings/ai");
  }

  async saveAiSettings(update: AiSettingsUpdate): Promise<AiSettingsView> {
    return this.send<AiSettingsView>("PUT", "/settings/ai", update);
  }

  async removeAiApiKey(): Promise<AiSettingsView> {
    return this.send<AiSettingsView>("DELETE", "/settings/ai/api-key");
  }

  async listAiModels(): Promise<AiModelList> {
    return this.requestJson<AiModelList>("/settings/ai/models");
  }

  private async requestMarkdown(path: string, method: "GET" | "POST"): Promise<string> {
    const response = await this.fetcher(path, {
      method,
      headers: { Accept: "text/markdown, text/plain;q=0.9" },
    });
    await this.throwForError(response);
    return response.text();
  }

  private async post<T>(path: string, body?: unknown): Promise<T> {
    return this.send<T>("POST", path, body);
  }

  private async send<T>(method: "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
    const init: RequestInit = { method };
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
