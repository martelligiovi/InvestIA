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
const FAILURE = {
  invalidSeed: "A valid public HTTP URL seed is required",
  settings: "Decodo settings could not be loaded",
  invalidMode: "Decodo API mode is invalid",
  missingToken: "Decodo API token is not configured",
  tokenControls: "Decodo API token contains control characters",
  tokenWhitespace: "Decodo API token contains whitespace",
  credentials: "Decodo API credentials were rejected",
  rateLimit: "Decodo API rate limit or quota exceeded",
  rejected: "Decodo API rejected the scrape request",
  timeout: "Decodo request timed out",
  request: "Decodo request failed",
  unexpected: "Unexpected Decodo response",
  blocked: "Decodo scrape blocked by anti-bot protection (999)",
  login: "Decodo target requires login",
  empty: "Decodo returned empty page content",
} as const;
const PUBLIC_FAILURES = new Set<string>(Object.values(FAILURE));
const BLOCKED = Symbol("Decodo status 999");

export function isPublicDecodoFailure(message: string): boolean {
  return PUBLIC_FAILURES.has(message) ||
    /^Decodo (?:target returned HTTP [1-5][0-9]{2}|service failure \(HTTP [5-9][0-9]{2}\)|request failed \(HTTP [1-4][0-9]{2}\))$/.test(message);
}

export function normalizeDecodoToken(value: unknown, mode?: DecodoApiMode): { token: string } | { failure: string } {
  if (typeof value !== "string") return { failure: FAILURE.missingToken };
  if (/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(value)) return { failure: FAILURE.tokenControls };
  const token = value.trim().replace(mode === undefined ? /^(?:Bearer|Basic) +/i : API[mode].prefix, "");
  if (!token || /^(?:Bearer|Basic)$/i.test(token)) return { failure: FAILURE.missingToken };
  if (/\s/.test(token)) return { failure: FAILURE.tokenWhitespace };
  return { token };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function timedOut(signal: AbortSignal | undefined, error: unknown): boolean {
  return signal?.aborted === true || (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"));
}

function checkHttpStatus(status: number): void {
  if (status >= 200 && status < 300) return;
  if (status === 401 || status === 403) throw new Error(FAILURE.credentials);
  if (status === 429) throw new Error(FAILURE.rateLimit);
  if (status === 400 || status === 422) throw new Error(FAILURE.rejected);
  if (status === 524) throw new Error(FAILURE.timeout);
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
        body: JSON.stringify({ url: targetUrl, ...(headless ? { headless: "html" } : {}) }),
      });
    } catch (error) {
      throw new Error(timedOut(signal, error) ? FAILURE.timeout : FAILURE.request);
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
      throw new Error(timedOut(signal, error) ? FAILURE.timeout : FAILURE.unexpected);
    }
    const result = Array.isArray(payload?.results) ? record(payload.results[0]) : undefined;
    const status = result?.status_code;
    if (status === 999) return BLOCKED;
    if (result === undefined || typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 599) {
      if (status === 612 || status === 613) checkHttpStatus(status);
      throw new Error(FAILURE.unexpected);
    }
    if (status === 524) throw new Error(FAILURE.timeout);
    if (status < 200 || status >= 300) throw new Error(`Decodo target returned HTTP ${status}`);
    if (typeof result.content !== "string") throw new Error(FAILURE.unexpected);
    return { content: result.content, status, url: result.url, taskId: result.task_id };
  }

  return {
    id: "decodo:url", inputKind: "url",
    async execute(input) {
      if (input?.kind !== "url" || !isSafePublicHttpUrl(input.value)) throw new Error(FAILURE.invalidSeed);
      const seed: UrlSeed = { kind: "url", value: input.value };
      let settings: DecodoSettings;
      try {
        settings = await options.settings();
      } catch {
        throw new Error(FAILURE.settings);
      }
      const { apiMode, token: rawToken } = settings;
      if (!isDecodoApiMode(apiMode)) throw new Error(FAILURE.invalidMode);
      const credential = normalizeDecodoToken(rawToken, apiMode);
      if ("failure" in credential) throw new Error(credential.failure);
      const { token } = credential;
      const api = API[apiMode];

      const attempt = async (headless: boolean) => {
        const result = await scrape(seed.value, api, token, headless);
        if (result === BLOCKED) return { state: "blocked" } as const;
        const resultUrl = safePageUrl(result.url) ?? safePageUrl(seed.value)!;
        const page = extractPage(result.content, resultUrl, seed.value);
        const finalUrl = page.canonical ?? resultUrl;
        if (isLoginGate(page, resultUrl, finalUrl)) return { state: "login" } as const;
        if (!page.content) return { state: "empty" } as const;
        return { state: "found", result, page, finalUrl } as const;
      };

      const first = await attempt(true);
      const outcome = first.state === "found" ? first : await attempt(false);
      if (outcome.state !== "found") {
        const state = first.state === "login" && outcome.state === "blocked" ? "login" : outcome.state;
        throw new Error(FAILURE[state]);
      }
      const { result, page, finalUrl } = outcome;

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
      if (!isScannerFinding(finding)) throw new Error(FAILURE.unexpected);
      return [{ kind: "scanner_finding", seed, provider: "Decodo", status: "registered", finding }];
    },
  };
}
