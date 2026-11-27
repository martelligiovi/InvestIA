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

export type DecodoUnexpectedReason =
  | "invalid_json"
  | "non_object_json"
  | "missing_results"
  | "missing_status"
  | "missing_text_content"
  | "invalid_finding";

export interface DecodoDiagnosticEvent {
  readonly apiMode: DecodoApiMode;
  readonly headless: boolean;
  readonly httpStatus: number;
  readonly responseContentType: string;
  readonly reason: DecodoUnexpectedReason;
  readonly hasResults?: boolean;
  readonly resultsCount?: number;
  readonly rootStatus?: number;
  readonly rootStatusType?: string;
  readonly resultStatus?: number;
  readonly resultStatusType?: string;
  readonly contentType?: string;
  readonly rootKnownFields?: readonly string[];
  readonly resultKnownFields?: readonly string[];
}

export interface DecodoAdapterOptions {
  readonly settings: () => Promise<DecodoSettings>;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly onDiagnostic?: (event: DecodoDiagnosticEvent) => void;
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
  unexpectedJson: "Unexpected Decodo response (invalid JSON)",
  unexpectedEnvelope: "Unexpected Decodo response (missing results)",
  unexpectedStatus: "Unexpected Decodo response (missing status)",
  unexpectedContent: "Unexpected Decodo response (missing text content)",
  blocked: "Decodo scrape blocked by anti-bot protection (999)",
  login: "Decodo target requires login",
  empty: "Decodo returned empty page content",
} as const;
const PUBLIC_FAILURES = new Set<string>(Object.values(FAILURE));
const KNOWN_DIAGNOSTIC_KEYS = [
  "results", "status_code", "status", "error", "message", "task_id", "job_id", "content", "url", "success",
] as const;

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

function valueKind(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function knownFields(value: Record<string, unknown>): readonly string[] {
  return KNOWN_DIAGNOSTIC_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(value, key));
}

const KNOWN_MIME_TYPES = new Set([
  "application/json",
  "application/problem+json",
  "text/html",
  "text/plain",
  "text/xml",
  "application/xml",
  "application/octet-stream",
]);

function safeMimeType(header: string | null): string {
  if (!header) return "missing";
  const mime = header.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!mime) return "missing";
  return KNOWN_MIME_TYPES.has(mime) ? mime : "other";
}

function parseNumericStatus(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 999) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^[1-9][0-9]{2}$/.test(trimmed)) return Number(trimmed);
  }
  return undefined;
}

type ScrapeOutcome =
  | { readonly kind: "ok"; readonly content: string; readonly status: number; readonly url: unknown; readonly taskId: unknown; readonly httpStatus: number; readonly responseContentType: string }
  | { readonly kind: "blocked" }
  | { readonly kind: "serviceFailure"; readonly status: 612 | 613 };

function timedOut(signal: AbortSignal | undefined, error: unknown): boolean {
  return signal?.aborted === true || (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"));
}

function checkHttpStatus(status: number): never {
  if (!Number.isInteger(status) || status < 100 || status > 999) throw new Error(FAILURE.request);
  if (status === 401 || status === 403) throw new Error(FAILURE.credentials);
  if (status === 429) throw new Error(FAILURE.rateLimit);
  if (status === 400 || status === 422) throw new Error(FAILURE.rejected);
  if (status === 524) throw new Error(FAILURE.timeout);
  if (status >= 500) throw new Error(`Decodo service failure (HTTP ${status})`);
  throw new Error(`Decodo request failed (HTTP ${status})`);
}

export function createDecodoAdapter(options: DecodoAdapterOptions): SeedBox<UrlSeed, ScannerObservation> {
  const fetcher = options.fetch ?? fetch;
  const emitDiagnostic = (event: DecodoDiagnosticEvent) => {
    try {
      if (options.onDiagnostic !== undefined) {
        void Promise.resolve(options.onDiagnostic(event)).catch(() => undefined);
      } else {
        console.error("[decodo]", JSON.stringify(event));
      }
    } catch {
      // Never let diagnostic reporting override scrape error handling.
    }
  };

  async function scrape(
    targetUrl: string,
    apiMode: DecodoApiMode,
    api: typeof API[DecodoApiMode],
    token: string,
    headless: boolean,
  ): Promise<ScrapeOutcome> {
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
    const responseContentType = safeMimeType(response.headers?.get("content-type") ?? null);
    if (response.status === 999 || !response.ok) {
      // Do not read or retain an upstream error body, and release its connection.
      void response.body?.cancel().catch(() => undefined);
      if (response.status === 999) return { kind: "blocked" };
      if (response.status === 612 || response.status === 613) return { kind: "serviceFailure", status: response.status };
      checkHttpStatus(response.status);
    }

    let rawPayload: unknown;
    try {
      rawPayload = await response.json();
    } catch (error) {
      if (timedOut(signal, error)) throw new Error(FAILURE.timeout);
      emitDiagnostic({ apiMode, headless, httpStatus: response.status, responseContentType, reason: "invalid_json" });
      throw new Error(FAILURE.unexpectedJson);
    }
    const payload = record(rawPayload);
    if (payload === undefined) {
      emitDiagnostic({ apiMode, headless, httpStatus: response.status, responseContentType, reason: "non_object_json" });
      throw new Error(FAILURE.unexpectedJson);
    }

    const rootStatus = parseNumericStatus(payload.status_code) ?? parseNumericStatus(payload.status);
    if (rootStatus === 999) return { kind: "blocked" };
    if (rootStatus === 612 || rootStatus === 613) return { kind: "serviceFailure", status: rootStatus };
    if (rootStatus === 524) throw new Error(FAILURE.timeout);
    if (rootStatus !== undefined && (rootStatus < 200 || rootStatus >= 300)) checkHttpStatus(rootStatus);

    const hasResults = Array.isArray(payload.results);
    const resultsCount = hasResults ? (payload.results as unknown[]).length : 0;
    const result = hasResults ? record((payload.results as unknown[])[0]) : undefined;
    if (result === undefined) {
      emitDiagnostic({
        apiMode, headless, httpStatus: response.status, responseContentType, reason: "missing_results",
        hasResults, resultsCount,
        ...(rootStatus === undefined ? {} : { rootStatus }),
        rootStatusType: valueKind(payload.status_code),
        rootKnownFields: knownFields(payload),
      });
      throw new Error(FAILURE.unexpectedEnvelope);
    }

    const status = parseNumericStatus(result.status_code) ?? parseNumericStatus(result.status);
    if (status === 999) return { kind: "blocked" };
    if (status === 612 || status === 613) return { kind: "serviceFailure", status };
    if (status === undefined) {
      emitDiagnostic({
        apiMode, headless, httpStatus: response.status, responseContentType, reason: "missing_status",
        hasResults, resultsCount,
        resultStatusType: valueKind(result.status_code),
        resultKnownFields: knownFields(result),
      });
      throw new Error(FAILURE.unexpectedStatus);
    }
    if (status === 524) throw new Error(FAILURE.timeout);
    if (status >= 600) checkHttpStatus(status);
    if (status < 200 || status >= 300) throw new Error(`Decodo target returned HTTP ${status}`);
    if (typeof result.content !== "string") {
      emitDiagnostic({
        apiMode, headless, httpStatus: response.status, responseContentType, reason: "missing_text_content",
        hasResults, resultsCount, resultStatus: status,
        contentType: valueKind(result.content),
        resultKnownFields: knownFields(result),
      });
      throw new Error(FAILURE.unexpectedContent);
    }
    return { kind: "ok", content: result.content, status, url: result.url, taskId: result.task_id, httpStatus: response.status, responseContentType };
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
        const result = await scrape(seed.value, apiMode, api, token, headless);
        if (result.kind === "blocked") return { state: "blocked" } as const;
        if (result.kind === "serviceFailure") return { state: "serviceFailure", status: result.status } as const;
        const resultUrl = safePageUrl(result.url) ?? safePageUrl(seed.value)!;
        const page = extractPage(result.content, resultUrl, seed.value);
        const finalUrl = page.canonical ?? resultUrl;
        if (isLoginGate(page, resultUrl, finalUrl)) return { state: "login" } as const;
        if (!page.content) return { state: "empty" } as const;
        return { state: "found", result, page, finalUrl, headless } as const;
      };

      const first = await attempt(true);
      const outcome = first.state === "found" ? first : await attempt(false);
      if (outcome.state !== "found") {
        if (outcome.state === "serviceFailure") checkHttpStatus(outcome.status);
        const state = first.state === "login" && outcome.state === "blocked" ? "login" : outcome.state;
        throw new Error(FAILURE[state]);
      }
      const { result, page, finalUrl, headless } = outcome;

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
      if (!isScannerFinding(finding)) {
        emitDiagnostic({
          apiMode, headless, httpStatus: result.httpStatus, responseContentType: result.responseContentType,
          reason: "invalid_finding", resultStatus: result.status,
        });
        throw new Error(FAILURE.unexpected);
      }
      return [{ kind: "scanner_finding", seed, provider: "Decodo", status: "registered", finding }];
    },
  };
}
