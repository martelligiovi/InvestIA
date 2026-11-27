import {
  buildEvidenceNormalizationMessages,
  decodoSourceContentHash,
  parseEvidenceNormalization,
  type EvidenceNormalizationJob,
  type EvidenceRecord,
  type InvestigationService,
  type NormalizationJobErrorCode,
  type NormalizedPageData,
} from "@investia/core";
import type { AiSettingsStore } from "./ai-settings-store.ts";
import type { EvidenceNormalizationJobStore } from "./evidence-normalization-job-store.ts";
import type { EvidenceNormalizationStore } from "./evidence-normalization-store.ts";
import { NvidiaProviderError, type NvidiaBuildGateway, type NvidiaProviderErrorKind } from "./nvidia-build.ts";

export const NVIDIA_PROVIDER_ERROR_CODES = {
  unauthorized: "AI_PROVIDER_UNAUTHORIZED",
  rate_limited: "AI_PROVIDER_RATE_LIMITED",
  rejected: "AI_PROVIDER_REJECTED",
  timeout: "AI_PROVIDER_TIMEOUT",
  truncated: "AI_PROVIDER_TRUNCATED",
  unavailable: "AI_PROVIDER_UNAVAILABLE",
  invalid_response: "AI_PROVIDER_UNAVAILABLE",
} as const satisfies Record<NvidiaProviderErrorKind, NormalizationJobErrorCode>;

export function isDecodoNormalizationEvidence(evidence: EvidenceRecord): boolean {
  return evidence.sourceId === "decodo:url" && evidence.finding?.target.kind === "url";
}

export interface EvidenceNormalizationRunnerDependencies {
  readonly service: Pick<InvestigationService, "loadInvestigation">;
  readonly jobs: EvidenceNormalizationJobStore;
  readonly settings: AiSettingsStore;
  readonly gateway: NvidiaBuildGateway;
  readonly normalizations: EvidenceNormalizationStore;
  readonly clock: () => string;
}

export interface EvidenceNormalizationRunnerOptions {
  readonly intervalMs?: number;
  readonly maxJobsPerSweep?: number;
  readonly onError?: (error: unknown) => void;
}

/** One backend worker processes the persisted queue in bounded, non-overlapping sweeps. */
export class EvidenceNormalizationRunner {
  private readonly dependencies: EvidenceNormalizationRunnerDependencies;
  private readonly options: EvidenceNormalizationRunnerOptions;
  private readonly intervalMs: number;
  private readonly limit: number;
  private timer?: ReturnType<typeof setTimeout>;
  private inFlight?: Promise<void>;
  private recovered?: Promise<void>;
  private pendingFailure?: { jobId: string; errorCode: NormalizationJobErrorCode };
  private started = false;
  private stopped = false;

  constructor(dependencies: EvidenceNormalizationRunnerDependencies, options: EvidenceNormalizationRunnerOptions = {}) {
    this.dependencies = dependencies;
    this.options = options;
    this.intervalMs = options.intervalMs ?? 1_000;
    this.limit = options.maxJobsPerSweep ?? 16;
    if (!Number.isSafeInteger(this.intervalMs) || this.intervalMs < 1 ||
      !Number.isSafeInteger(this.limit) || this.limit < 1) throw new Error("Invalid normalization runner bounds");
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    const tick = async () => {
      await this.drain();
      if (!this.stopped) this.timer = setTimeout(() => { void tick(); }, this.intervalMs);
    };
    void tick();
  }

  drain(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.inFlight ??= Promise.resolve().then(() => this.sweep())
      .catch((error: unknown) => this.report(error)).finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    await this.inFlight;
  }

  private report(error: unknown): void {
    try { this.options.onError?.(error); } catch { /* diagnostic hook only */ }
  }

  private recover(): Promise<void> {
    this.recovered ??= Promise.resolve().then(async () => {
      await this.dependencies.jobs.failOrphanedRunning();
    }).catch((error: unknown) => {
      this.recovered = undefined;
      throw error;
    });
    return this.recovered;
  }

  private async sweep(): Promise<void> {
    if (this.stopped) return;
    await this.recover();
    if (this.pendingFailure !== undefined) await this.persistFailure();
    for (let count = 0; count < this.limit && !this.stopped; count++) {
      let job: EvidenceNormalizationJob | undefined;
      try {
        job = await this.dependencies.jobs.claimNext();
      } catch (error) {
        // A lost COMMIT acknowledgement could have left a row running; re-run orphan recovery before claiming again.
        this.recovered = undefined;
        throw error;
      }
      if (job === undefined) break;
      let errorCode: NormalizationJobErrorCode | undefined;
      try {
        errorCode = await this.normalize(job);
        if (errorCode === undefined) await this.dependencies.jobs.complete(job.id);
      } catch (error) {
        this.report(error);
        errorCode = "INTERNAL_ERROR";
      }
      if (errorCode !== undefined) {
        this.pendingFailure = { jobId: job.id, errorCode };
        await this.persistFailure();
      }
    }
  }

  private async persistFailure(): Promise<void> {
    const failure = this.pendingFailure;
    if (failure === undefined) return;
    // On a database error, retry only the status write before claiming again, never the provider call.
    await this.dependencies.jobs.fail(failure.jobId, failure.errorCode);
    this.pendingFailure = undefined;
  }

  private async loadEvidence(job: EvidenceNormalizationJob): Promise<EvidenceRecord | undefined> {
    const investigation = await this.dependencies.service.loadInvestigation(job.investigationId);
    return investigation?.evidence.find((item) => item.id === job.evidenceId && isDecodoNormalizationEvidence(item));
  }

  private async normalize(job: EvidenceNormalizationJob): Promise<NormalizationJobErrorCode | undefined> {
    const { settings, gateway, normalizations, clock } = this.dependencies;
    const evidence = await this.loadEvidence(job);
    if (evidence === undefined) return "EVIDENCE_UNAVAILABLE";
    const sourceContentHash = decodoSourceContentHash(evidence);
    const configuration = await settings.load();
    if (configuration?.apiKey == null) return "AI_NOT_CONFIGURED";
    const messages = buildEvidenceNormalizationMessages(evidence);
    let raw: string;
    try {
      raw = await gateway.complete(configuration.apiKey, configuration.settings, messages);
    } catch (error) {
      if (error instanceof NvidiaProviderError) return NVIDIA_PROVIDER_ERROR_CODES[error.kind];
      throw error;
    }
    let data: NormalizedPageData;
    try {
      data = parseEvidenceNormalization(raw);
    } catch {
      return "AI_PROVIDER_INVALID_RESPONSE";
    }
    const generatedAt = clock();
    const current = await this.loadEvidence(job);
    if (current === undefined || decodoSourceContentHash(current) !== sourceContentHash) return "EVIDENCE_UNAVAILABLE";
    await normalizations.save(job.investigationId, {
      evidenceId: job.evidenceId,
      model: configuration.settings.model,
      generatedAt,
      sourceContentHash,
      data,
    });
    return undefined;
  }
}
