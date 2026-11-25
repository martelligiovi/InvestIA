import { isSafePublicHttpUrl, isScannerFinding, type ScannerObservation, type SeedBox, type UrlSeed } from "../../core/src/index.ts";
import { extractPage, isLoginGate, scalar, safePageUrl } from "./extract.ts";

export const DECODO_API_MODES = ["web_data", "scraping_v2"] as const;
export type DecodoApiMode = typeof DECODO_API_MODES[number];

export function isDecodoApiMode(value: unknown): value is DecodoApiMode {
  return DECODO_API_MODES.some((mode) => mode === value);
}

export interface DecodoSettings {
  readonly token: string | undefined;
  readonly apiMode: DecodoApiMode;
}

export interface DecodoAdapterOptions {
  readonly settings: () => Promise<DecodoSettings>;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

const API = {
  web_data: { endpoint: "https://data.decodo.com/v1/scrape", scheme: "Bearer", prefix: /^Bearer +/i },
  scraping_v2: { endpoint: "https://scraper-api.decodo.com/v2/scrape", scheme: "Basic", prefix: /^Basic +/i },
} as const;
const TIMEOUT_MESSAGE = "Decodo request timed out";
const UNEXPECTED_RESPONSE = "Unexpected Decodo response";
const BLOCKED = Symbol("Decodo status 999");

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function timedOut(signal: AbortSignal | undefined, error: unknown): boolean {
  return signal?.aborted === true || (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"));
}

function checkHttpStatus(status: number): void {
  if (status >= 200 && status < 300) return;
  if (status === 401 || status === 403) throw new Error("Decodo API credentials were rejected");
  if (status === 429) throw new Error("Decodo API rate limit or quota exceeded");
  if (status === 400 || status === 422) throw new Error("Decodo API rejected the scrape request");
  if (status === 524) throw new Error(TIMEOUT_MESSAGE);
  if (status >= 500) throw new Error(`Decodo service failure (HTTP ${status})`);
  throw new Error(`Decodo request failed (HTTP ${status})`);
}

export function createDecodoAdapter(options: DecodoAdapterOptions): SeedBox<UrlSeed, ScannerObservation> {
  const fetcher = options.fetch ?? fetch;

  async function scrape(targetUrl: string, api: typeof API[DecodoApiMode], token: string, headless: boolean) {
    let signal: AbortSignal | undefined;
    let response: Response;
    try {
      signal = AbortSignal.timeout(options.timeoutMs ?? 155_000);
      response = await fetcher(api.endpoint, {
        method: "POST", redirect: "error", signal,
        headers: { Authorization: `${api.scheme} ${token}`, Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ url: targetUrl, ...(headless ? { headless: "html" } : {}), markdown: true }),
      });
    } catch (error) {
      throw new Error(timedOut(signal, error) ? TIMEOUT_MESSAGE : "Decodo request failed");
    }
    if (response.status === 999 || !response.ok) {
      // Do not read or retain an upstream error body, and release its connection.
      void response.body?.cancel().catch(() => undefined);
      if (response.status === 999) return BLOCKED;
      checkHttpStatus(response.status);
    }

    let payload: Record<string, unknown> | undefined;
    try {
      payload = record(await response.json());
    } catch (error) {
      throw new Error(timedOut(signal, error) ? TIMEOUT_MESSAGE : UNEXPECTED_RESPONSE);
    }
    const result = Array.isArray(payload?.results) ? record(payload.results[0]) : undefined;
    const status = result?.status_code;
    if (status === 999) return BLOCKED;
    if (result === undefined || typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 599) {
      if (status === 612 || status === 613) checkHttpStatus(status);
      throw new Error(UNEXPECTED_RESPONSE);
    }
    if (status === 524) throw new Error(TIMEOUT_MESSAGE);
    if (status < 200 || status >= 300) throw new Error(`Decodo target returned HTTP ${status}`);
    if (typeof result.content !== "string") throw new Error(UNEXPECTED_RESPONSE);
    return { content: result.content, status, url: result.url, taskId: result.task_id };
  }

  return {
    id: "decodo:url", inputKind: "url",
    async execute(input) {
      if (input?.kind !== "url" || !isSafePublicHttpUrl(input.value)) throw new Error("A valid public HTTP URL seed is required");
      const seed: UrlSeed = { kind: "url", value: input.value };
      let settings: DecodoSettings;
      try {
        settings = await options.settings();
      } catch {
        throw new Error("Decodo settings could not be loaded");
      }
      const { apiMode, token: rawToken } = settings;
      if (!isDecodoApiMode(apiMode)) throw new Error("Decodo API mode is invalid");
      if (typeof rawToken !== "string") throw new Error("Decodo API token is not configured");
      if (/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(rawToken)) throw new Error("Decodo API token contains control characters");
      const api = API[apiMode];
      const token = rawToken.trimStart().replace(api.prefix, "").trim();
      if (!token) throw new Error("Decodo API token is not configured");

      let result = await scrape(seed.value, api, token, true);
      if (result === BLOCKED) result = await scrape(seed.value, api, token, false);
      if (result === BLOCKED) throw new Error("Decodo scrape blocked by anti-bot protection (999)");
      const resultUrl = safePageUrl(result.url) ?? safePageUrl(seed.value)!;
      const page = extractPage(result.content, resultUrl, seed.value);
      const finalUrl = page.canonical ?? resultUrl;
      if (isLoginGate(page, resultUrl, finalUrl)) throw new Error("Decodo target requires login");
      if (!page.content) throw new Error("Decodo returned empty page content");

      const taskId = typeof result.taskId === "string" ? scalar(result.taskId, 240) : "";
      const finding = {
        target: seed, upstreamStatus: "Found" as const, url: finalUrl, category: "Web page",
        reason: page.title || new URL(finalUrl).hostname, media: {}, extra: {
          source: "decodo", api_mode: apiMode, status_code: result.status, content_format: page.format,
          content_length: page.contentLength, content_truncated: page.content.length < page.contentLength, content: page.content,
          ...(page.title ? { title: page.title } : {}), ...(page.description ? { description: page.description } : {}),
          ...(page.preview ? { preview: page.preview } : {}), ...(taskId ? { task_id: taskId } : {}),
          ...(page.links.length ? { links: page.links.join("\n"), extracted_links_count: page.links.length } : {}),
        },
      };
      if (!isScannerFinding(finding)) throw new Error(UNEXPECTED_RESPONSE);
      return [{ kind: "scanner_finding", seed, provider: "Decodo", status: "registered", finding }];
    },
  };
}
