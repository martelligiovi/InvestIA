import type { InvestigationService } from "@investia/core";

interface AutomaticRunnerOptions {
  readonly intervalMs?: number;
  readonly maxActionsPerSweep?: number;
  readonly onError?: (error: unknown) => void;
  /** Downstream projection only; its failure must never retry an external action. */
  readonly afterDispatch?: (id: string) => Promise<void>;
}

type RunnerService = Pick<InvestigationService, "listInvestigations" | "loadInvestigation" | "executeNextAction">;

/**
 * Backend-owned, single-flight bounded sweeps. Enumeration resumes queued work after restart;
 * claimed/terminal work is never retried. The store rechecks all gates in its atomic claim.
 * No timer is scheduled until a sweep ends, including on errors (no overlapping/retry spin).
 */
export class AutomaticInvestigationRunner {
  private readonly service: RunnerService;
  private readonly options: AutomaticRunnerOptions;
  private readonly intervalMs: number;
  private readonly limit: number;
  private timer?: ReturnType<typeof setTimeout>;
  private inFlight?: Promise<void>;
  private stopped = false;
  private started = false;
  private cursor = 0;

  constructor(service: RunnerService, options: AutomaticRunnerOptions = {}) {
    this.service = service;
    this.options = options;
    this.intervalMs = options.intervalMs ?? 1_000;
    this.limit = options.maxActionsPerSweep ?? 16;
    if (!Number.isSafeInteger(this.intervalMs) || this.intervalMs < 1 ||
      !Number.isSafeInteger(this.limit) || this.limit < 1) throw new Error("Invalid automatic runner bounds");
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
    this.inFlight ??= this.sweep().catch((error: unknown) => this.report(error)).finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    await this.inFlight;
  }

  private report(error: unknown): void {
    // Observers cannot turn error reporting into an unhandled worker rejection.
    try { this.options.onError?.(error); } catch { /* diagnostic hook only */ }
  }

  private async sweep(): Promise<void> {
    const summaries = await this.service.listInvestigations();
    let attempts = 0;
    const start = this.cursor % Math.max(1, summaries.length);
    for (let offset = 0; offset < summaries.length && !this.stopped && attempts < this.limit; offset++) {
      const index = (start + offset) % summaries.length;
      const id = summaries[index]!.id;
      // Rotate the starting case to avoid starvation when one case fills the bound.
      this.cursor = index + 1;
      try {
        const current = await this.service.loadInvestigation(id);
        if (current?.advancementMode !== "automatic" || current.paused || current.authorization?.granted !== true) continue;
        while (!this.stopped && attempts < this.limit) {
          attempts++;
          const action = await this.service.executeNextAction(id, true);
          if (action === undefined) break;
          try { await this.options.afterDispatch?.(id); } catch (error) { this.report(error); }
        }
      } catch (error) {
        this.report(error);
        // A failed claim/completion has an uncertain outcome. Move on, never retry it here.
      }
    }
  }
}
