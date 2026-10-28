import { stripModelReasoning, type AiChatMessage, type AiReportSettings } from "@investia/core";

export interface FreeChatModel {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly reasoning: boolean;
}

export interface FreeChatModelList {
  readonly models: readonly FreeChatModel[];
  /** "fallback" means the live NVIDIA catalog was unreachable and a bundled snapshot is shown. */
  readonly source: "live" | "fallback";
}

export interface NvidiaBuildGateway {
  listFreeChatModels(): Promise<FreeChatModelList>;
  complete(apiKey: string, settings: AiReportSettings, messages: readonly AiChatMessage[]): Promise<string>;
}

export type NvidiaProviderErrorKind =
  | "unauthorized" | "rate_limited" | "rejected" | "unavailable" | "invalid_response" | "timeout" | "truncated";

/** Carries only a classification; provider bodies and request details are never retained. */
export class NvidiaProviderError extends Error {
  readonly kind: NvidiaProviderErrorKind;

  constructor(kind: NvidiaProviderErrorKind) {
    super(`NVIDIA Build request failed: ${kind}`);
    this.name = "NvidiaProviderError";
    this.kind = kind;
  }
}

export interface NvidiaBuildGatewayOptions {
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly catalogTtlMs?: number;
  /** Aborts when neither answer nor reasoning tokens arrive in time, typically a saturated free endpoint. */
  readonly firstTokenTimeoutMs?: number;
  readonly completionTimeoutMs?: number;
}

const CATALOG_URL = "https://api.ngc.nvidia.com/v2/search/catalog/resources/ENDPOINT";
const HOSTED_MODELS_URL = "https://integrate.api.nvidia.com/v1/models";
const CHAT_COMPLETIONS_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
/** build.nvidia.com labels its "Free Endpoint" filter with this NIM type. */
const FREE_ENDPOINT_FILTER = { field: "nimType", value: "nim_type_preview" } as const;
const CATALOG_TIMEOUT_MS = 10_000;

/** Snapshot of build.nvidia.com Free Endpoint chat models (2026-10-28), shown only when the catalog is unreachable. */
export const FALLBACK_FREE_CHAT_MODELS: readonly FreeChatModel[] = [
  { id: "deepseek-ai/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", description: "Fast DeepSeek mixture-of-experts chat model.", reasoning: false },
  { id: "google/gemma-4-31b-it", name: "Gemma 4 31B IT", description: "Google Gemma 4 instruction-tuned chat model.", reasoning: true },
  { id: "meta/muse-glimmer-30b", name: "Muse Glimmer 30B", description: "Meta multimodal chat and reasoning model.", reasoning: true },
  { id: "minimaxai/minimax-m3.1-flash", name: "MiniMax M3.1 Flash", description: "MiniMax chat, coding and reasoning model.", reasoning: true },
  { id: "nvidia/nemotron-3-ultra-550b-a55b", name: "Nemotron 3 Ultra 550B", description: "NVIDIA frontier long-context reasoning model.", reasoning: true },
  { id: "nvidia/nemotron-3.5-lightning-30b-a3b", name: "Nemotron 3.5 Lightning 30B", description: "NVIDIA efficient open chat model.", reasoning: false },
  { id: "nvidia/nemotron-3.5-super-vl-120b-a12b", name: "Nemotron 3.5 Super VL 120B", description: "NVIDIA multimodal long-context reasoning model.", reasoning: true },
  { id: "openai/gpt-oss-20b", name: "gpt-oss-20b", description: "OpenAI open-weight reasoning model.", reasoning: true },
  { id: "poolside/laguna-xs-2.1", name: "Laguna XS 2.1", description: "Poolside agentic chat and reasoning model.", reasoning: true },
  { id: "stepfun-ai/step-5-preview", name: "Step 5 Preview", description: "StepFun multimodal reasoning model.", reasoning: true },
];

interface CatalogResource {
  readonly name: string;
  readonly displayName: string;
  readonly description: string;
  readonly general: readonly string[];
  readonly publisher: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function labelValues(resource: Record<string, unknown>, key: string): string[] {
  if (!Array.isArray(resource.labels)) return [];
  const label = resource.labels.find((item) => isRecord(item) && item.key === key);
  return isRecord(label) && Array.isArray(label.values) ? label.values.filter((value) => typeof value === "string") : [];
}

function catalogResources(payload: unknown): CatalogResource[] {
  if (!isRecord(payload) || !Array.isArray(payload.results)) throw new Error("Unexpected catalog payload");
  const resources: CatalogResource[] = [];
  for (const group of payload.results) {
    if (!isRecord(group) || !Array.isArray(group.resources)) continue;
    for (const item of group.resources) {
      if (!isRecord(item) || typeof item.name !== "string") continue;
      const publisher = labelValues(item, "publisher")[0];
      if (publisher === undefined) continue;
      resources.push({
        name: item.name,
        displayName: typeof item.displayName === "string" ? item.displayName : item.name,
        description: typeof item.description === "string" ? item.description : "",
        general: labelValues(item, "general").map((value) => value.toLowerCase()),
        publisher,
      });
    }
  }
  return resources;
}

/** Catalog slugs and API ids differ in separators (glm-5-3-flash vs glm-5.3-flash). */
function modelKey(id: string): string {
  return id.toLowerCase().replace(/[._]/g, "-");
}

async function getJson(fetcher: typeof fetch, url: string): Promise<unknown> {
  const response = await fetcher(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Catalog request failed with ${response.status}`);
  return response.json();
}

interface StreamedAnswer {
  readonly content: string;
  readonly finishReason: string | null;
}

function firstChoice(payload: unknown): Record<string, unknown> | undefined {
  const choice = isRecord(payload) && Array.isArray(payload.choices) ? payload.choices[0] : undefined;
  return isRecord(choice) ? choice : undefined;
}

async function readJsonAnswer(response: Response): Promise<StreamedAnswer> {
  const choice = firstChoice(await response.json());
  const content = isRecord(choice?.message) ? choice.message.content : undefined;
  return {
    content: typeof content === "string" ? content : "",
    finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : null,
  };
}

/** Reads OpenAI-style server-sent events; reasoning deltas count as activity but never reach the answer. */
async function readEventStream(response: Response, deadline: Promise<never>, onActivity: () => void): Promise<StreamedAnswer> {
  if (response.body === null) throw new NvidiaProviderError("invalid_response");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let finishReason: string | null = null;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) return { content, finishReason };
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") return { content, finishReason };
        let event: unknown;
        try {
          event = JSON.parse(data);
        } catch {
          continue;
        }
        const choice = firstChoice(event);
        if (choice === undefined) continue;
        const delta = isRecord(choice.delta) ? choice.delta : {};
        if (typeof delta.content === "string" && delta.content.length > 0) {
          content += delta.content;
          onActivity();
        }
        if ([delta.reasoning_content, delta.reasoning].some((value) => typeof value === "string" && value.length > 0)) onActivity();
        if (typeof choice.finish_reason === "string") finishReason = choice.finish_reason;
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
}

function errorKind(status: number): NvidiaProviderErrorKind {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 429) return "rate_limited";
  if (status === 400 || status === 404 || status === 422) return "rejected";
  return "unavailable";
}

export function createNvidiaBuildGateway(options: NvidiaBuildGatewayOptions = {}): NvidiaBuildGateway {
  const fetcher = options.fetch ?? fetch.bind(globalThis);
  const now = options.now ?? Date.now;
  const ttl = options.catalogTtlMs ?? 10 * 60_000;
  const firstTokenTimeoutMs = options.firstTokenTimeoutMs ?? 90_000;
  const completionTimeoutMs = options.completionTimeoutMs ?? 10 * 60_000;
  let cached: { readonly at: number; readonly models: readonly FreeChatModel[] } | undefined;

  async function loadLiveModels(): Promise<FreeChatModel[]> {
    const query = JSON.stringify({ query: "", filters: [FREE_ENDPOINT_FILTER], page: 0, pageSize: 500 });
    const [catalog, hosted] = await Promise.all([
      getJson(fetcher, `${CATALOG_URL}?${new URLSearchParams({ q: query })}`),
      getJson(fetcher, HOSTED_MODELS_URL),
    ]);
    if (!isRecord(hosted) || !Array.isArray(hosted.data)) throw new Error("Unexpected hosted model payload");
    const hostedIds = new Map<string, string>();
    for (const item of hosted.data) {
      if (isRecord(item) && typeof item.id === "string") hostedIds.set(modelKey(item.id), item.id);
    }
    const models = new Map<string, FreeChatModel>();
    for (const resource of catalogResources(catalog)) {
      if (!resource.general.includes("chat") || !resource.general.includes("free endpoint")) continue;
      const id = hostedIds.get(modelKey(`${resource.publisher}/${resource.name}`));
      if (id === undefined || models.has(id)) continue;
      models.set(id, {
        id,
        name: resource.displayName,
        description: resource.description,
        reasoning: resource.general.includes("reasoning"),
      });
    }
    if (models.size === 0) throw new Error("No free chat models listed");
    return [...models.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  return {
    async listFreeChatModels() {
      if (cached !== undefined && now() - cached.at < ttl) return { models: cached.models, source: "live" };
      try {
        const models = await loadLiveModels();
        cached = { at: now(), models };
        return { models, source: "live" };
      } catch {
        return { models: FALLBACK_FREE_CHAT_MODELS, source: "fallback" };
      }
    },

    async complete(apiKey, settings, messages) {
      // Streaming exposes queued free endpoints: a model that never starts answering fails fast instead of
      // holding the request until the overall deadline.
      const controller = new AbortController();
      let timedOut = false;
      let rejectDeadline: (error: NvidiaProviderError) => void = () => undefined;
      const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
      deadline.catch(() => undefined);
      const expire = () => {
        timedOut = true;
        controller.abort();
        rejectDeadline(new NvidiaProviderError("timeout"));
      };
      let firstTokenTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(expire, firstTokenTimeoutMs);
      const totalTimer = setTimeout(expire, completionTimeoutMs);
      const onActivity = () => {
        clearTimeout(firstTokenTimer);
        firstTokenTimer = undefined;
      };
      try {
        let response: Response;
        try {
          response = await Promise.race([fetcher(CHAT_COMPLETIONS_URL, {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "text/event-stream, application/json" },
            body: JSON.stringify({
              model: settings.model,
              messages,
              temperature: settings.temperature,
              top_p: settings.topP,
              max_tokens: settings.maxTokens,
              stream: true,
              ...(settings.reasoningEffort === "default" ? {} : { reasoning_effort: settings.reasoningEffort }),
            }),
            signal: controller.signal,
          }), deadline]);
        } catch (error) {
          if (error instanceof NvidiaProviderError) throw error;
          throw new NvidiaProviderError(timedOut ? "timeout" : "unavailable");
        }
        if (!response.ok) throw new NvidiaProviderError(errorKind(response.status));
        let answer: StreamedAnswer;
        try {
          answer = (response.headers.get("content-type") ?? "").includes("text/event-stream")
            ? await readEventStream(response, deadline, onActivity)
            : await readJsonAnswer(response);
        } catch (error) {
          if (error instanceof NvidiaProviderError) throw error;
          throw new NvidiaProviderError(timedOut ? "timeout" : "invalid_response");
        }
        const narrative = stripModelReasoning(answer.content);
        if (narrative.length === 0) throw new NvidiaProviderError(answer.finishReason === "length" ? "truncated" : "invalid_response");
        return narrative;
      } finally {
        clearTimeout(firstTokenTimer);
        clearTimeout(totalTimer);
      }
    },
  };
}
