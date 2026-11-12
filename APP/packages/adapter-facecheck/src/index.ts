import { isGooglePhotoUrl, type PhotoSeed } from "../../core/src/domain/seed.ts";
import { isScannerFinding, type ScannerObservation } from "../../core/src/domain/observation.ts";
import type { SeedBox } from "../../core/src/domain/seed-box.ts";

export const FACECHECK_SITE = "https://facecheck.id";

/** Read per run so a token or testing-mode change applies to the next search. */
export interface FacecheckSettings {
  readonly token: string;
  /** Demo search: only the first 100,000 faces, no credits deducted, results of little value. */
  readonly testingMode: boolean;
}

export interface FacecheckBoxOptions {
  readonly settings: () => Promise<FacecheckSettings | undefined>;
  readonly fetch?: typeof fetch;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly pollIntervalMs?: number;
  /** Bounds the whole search: polls are pollIntervalMs apart. */
  readonly maxPolls?: number;
  readonly requestTimeoutMs?: number;
  readonly maxCandidates?: number;
  readonly maxPhotoBytes?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_MAX_POLLS = 900;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_CANDIDATES = 20;
const DEFAULT_MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const MAX_THUMBNAIL_LENGTH = 256 * 1024;
const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const DATA_IMAGE = /^data:image\/(?:webp|jpeg|png);base64,[A-Za-z0-9+/]+={0,2}$/;
/** The live API puts a space after the comma: `data:image/webp;base64, UklGR…`. */
const DATA_IMAGE_PREFIX = /^(data:image\/(?:webp|jpeg|png);base64,)\s+/;
const BARE_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

const PHOTO_DOWNLOAD_ATTEMPTS = 3;
const PHOTO_RETRY_DELAY_MS = 1_000;

class PhotoDownloadError extends Error {
  readonly reason: string;
  readonly retryable: boolean;
  constructor(reason: string, retryable: boolean) {
    super(reason);
    this.reason = reason;
    this.retryable = retryable;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Upstream error text is persisted as the action failure: one bounded line, no control characters, never the token. */
function upstreamText(value: unknown, token: string): string {
  if (typeof value !== "string") return "";
  return value.split(token).join("[token]").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
}

/** Reads at most `limit` bytes; a longer body is refused without buffering the rest. */
async function boundedBytes(response: Response, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > limit) throw new Error("photo too large");
  const reader = response.body?.getReader();
  if (reader === undefined) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new Error("photo too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function sourceUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.username === "" && url.password === "" ? url.href : undefined;
  } catch { return undefined; }
}

function thumbnail(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > MAX_THUMBNAIL_LENGTH) return undefined;
  const image = value.replace(DATA_IMAGE_PREFIX, "$1");
  if (DATA_IMAGE.test(image)) return image;
  return BARE_BASE64.test(image) ? `data:image/webp;base64,${image}` : undefined;
}

/** The live API sends `url` as a string; the published Swagger describes it as `{ value }`. */
function itemUrl(value: unknown): string | undefined {
  return sourceUrl(typeof value === "string" ? value : record(value)?.value);
}

async function withTimeout<T>(timeoutMs: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await operation(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

export function createFacecheckBox(options: FacecheckBoxOptions): SeedBox<PhotoSeed, ScannerObservation> {
  const fetcher = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((done) => setTimeout(done, milliseconds)));
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const maxPhotoBytes = options.maxPhotoBytes ?? DEFAULT_MAX_PHOTO_BYTES;

  /** One download attempt; a failure names its reason and whether another attempt may help. */
  async function downloadOnce(url: string): Promise<Blob> {
    let timedOut = false;
    try {
      return await withTimeout(timeoutMs, async (signal) => {
        signal.addEventListener("abort", () => { timedOut = true; });
        let response: Response;
        try {
          response = await fetcher(url, { signal, redirect: "error" });
        } catch {
          throw new PhotoDownloadError(timedOut ? "timed out" : "network error", true);
        }
        if (!response.ok) throw new PhotoDownloadError(`HTTP ${response.status}`, response.status === 429 || response.status >= 500);
        const type = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
        if (!PHOTO_TYPES.includes(type)) throw new PhotoDownloadError(`unsupported type ${type.replace(/[^a-z0-9.+/-]/g, "").slice(0, 60) || "unknown"}`, false);
        const bytes = await boundedBytes(response, maxPhotoBytes);
        if (bytes.byteLength === 0) throw new PhotoDownloadError("empty", false);
        return new Blob([bytes], { type });
      });
    } catch (error) {
      if (error instanceof PhotoDownloadError) throw error;
      if (error instanceof Error && error.message === "photo too large") throw new PhotoDownloadError("too large", false);
      throw new PhotoDownloadError(timedOut ? "timed out" : "network error", true);
    }
  }

  /** The download costs no credits, so transient failures are retried before anything is uploaded. */
  async function downloadPhoto(url: string): Promise<Blob> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await downloadOnce(url);
      } catch (error) {
        const failure = error as PhotoDownloadError;
        if (!failure.retryable || attempt + 1 >= PHOTO_DOWNLOAD_ATTEMPTS) {
          throw new Error(`FaceCheck could not download the profile photo (${failure.reason})`);
        }
        await sleep(PHOTO_RETRY_DELAY_MS * (attempt + 1));
      }
    }
  }

  /** FaceCheck answers errors as JSON `{ error, code }`, sometimes with HTTP 200. */
  async function call(path: string, token: string, body: FormData | string): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { Accept: "application/json", Authorization: token };
    if (typeof body === "string") headers["Content-Type"] = "application/json";
    let status = 0;
    let payload: Record<string, unknown> | undefined;
    try {
      await withTimeout(timeoutMs, async (signal) => {
        const response = await fetcher(`${FACECHECK_SITE}${path}`, { method: "POST", headers, body, signal });
        status = response.status;
        payload = record(await response.json().catch(() => undefined));
      });
    } catch {
      throw new Error("FaceCheck request failed");
    }
    const error = upstreamText(payload?.error, token);
    if (error !== "") throw new Error(`FaceCheck: ${error} (${upstreamText(payload?.code, token)})`);
    if (payload === undefined || status < 200 || status >= 300) throw new Error(`FaceCheck request failed with HTTP ${status}`);
    return payload;
  }

  return {
    id: "facecheck:photo", inputKind: "photo",
    async execute(input) {
      if (!input || input.kind !== "photo" || !isGooglePhotoUrl(input.value) || Object.keys(input).some((key) => key !== "kind" && key !== "value")) {
        throw new Error("A Google profile photo seed is required");
      }
      const seed: PhotoSeed = { kind: "photo", value: input.value };
      const settings = await options.settings();
      const token = settings?.token.trim() ?? "";
      if (settings === undefined || token === "") throw new Error("FaceCheck API token is not configured");

      const form = new FormData();
      form.append("images", await downloadPhoto(seed.value), "profile-photo");
      const uploaded = await call("/api/upload_pic", token, form);
      if (typeof uploaded.id_search !== "string" || uploaded.id_search.trim() === "") throw new Error("Invalid FaceCheck upload response");

      const search = JSON.stringify({ id_search: uploaded.id_search, with_progress: true, status_only: false, demo: settings.testingMode });
      let output: Record<string, unknown> | undefined;
      for (let poll = 0; poll < (options.maxPolls ?? DEFAULT_MAX_POLLS) && output === undefined; poll++) {
        if (poll > 0) await sleep(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
        output = record((await call("/api/search", token, search)).output);
      }
      if (output === undefined) throw new Error("FaceCheck search did not finish in time");

      const candidates = (Array.isArray(output.items) ? output.items : []).flatMap((value) => {
        const item = record(value);
        const url = itemUrl(item?.url);
        const image = thumbnail(item?.base64);
        const score = item?.score;
        if (url === undefined || image === undefined || typeof score !== "number" || !Number.isFinite(score)) return [];
        const group = typeof item?.group === "number" && Number.isSafeInteger(item.group) ? { group: item.group } : {};
        return [{ url, image, score, group }];
      }).sort((left, right) => right.score - left.score).slice(0, options.maxCandidates ?? DEFAULT_MAX_CANDIDATES);

      return candidates.map(({ url, image, score, group }): ScannerObservation => {
        const finding = {
          target: seed, upstreamStatus: "Found" as const, url, category: "Face match", reason: "",
          extra: { source: "facecheck", score, ...group, testing_mode: settings.testingMode }, media: { thumbnail: image },
        };
        if (!isScannerFinding(finding)) throw new Error("Invalid FaceCheck candidate");
        return { kind: "scanner_finding", seed, provider: "FaceCheck", status: "registered", finding };
      });
    },
  };
}
