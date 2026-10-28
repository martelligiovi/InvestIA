import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_AI_REPORT_SETTINGS } from "@investia/core";
import {
  createNvidiaBuildGateway,
  FALLBACK_FREE_CHAT_MODELS,
  NvidiaProviderError,
} from "../src/nvidia-build.ts";

const SECRET = "nvapi-secret-key-0123456789";

function resource(name: string, publisher: string, general: string[], description = `${name} description`) {
  return {
    resourceId: `org/${name}`,
    name,
    displayName: name.toUpperCase(),
    description,
    labels: [{ key: "general", values: general }, { key: "publisher", values: [publisher] }],
  };
}

const catalog = {
  results: [
    { groupValue: "_scored", resources: [resource("deepseek-v4.1-flash", "deepseek-ai", ["chat", "Free Endpoint"])] },
    {
      groupValue: "ENDPOINT",
      resources: [
        resource("deepseek-v4.1-flash", "deepseek-ai", ["chat", "Free Endpoint"]),
        resource("gpt-oss-20b", "openai", ["Chat", "reasoning", "Free Endpoint"]),
        resource("glm-5-3-flash", "z-ai", ["Chat", "Reasoning", "Free Endpoint"]),
        resource("nemotron-3_5-embed-1b", "nvidia", ["Text-to-Embedding", "Free Endpoint"]),
        resource("partner-only", "acme", ["chat", "Partner Endpoint"]),
        resource("not-hosted", "acme", ["chat", "Free Endpoint"]),
      ],
    },
  ],
};
const hosted = {
  data: ["deepseek-ai/deepseek-v4.1-flash", "openai/gpt-oss-20b", "z-ai/glm-5.3-flash", "nvidia/nemotron-3_5-embed-1b", "acme/partner-only"]
    .map((id) => ({ id })),
};

interface Call { readonly url: string; readonly init?: RequestInit }

function fakeFetch(responder: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return responder(url, init);
  }) as typeof fetch;
  return { calls, fetcher };
}

function catalogResponder(url: string): Response {
  if (url.startsWith("https://api.ngc.nvidia.com/v2/search/catalog/resources/ENDPOINT")) return Response.json(catalog);
  if (url === "https://integrate.api.nvidia.com/v1/models") return Response.json(hosted);
  return new Response("unexpected", { status: 500 });
}

test("lists only hosted Free Endpoint chat models from the live catalog", async () => {
  const { calls, fetcher } = fakeFetch(catalogResponder);
  const gateway = createNvidiaBuildGateway({ fetch: fetcher });
  const result = await gateway.listFreeChatModels();
  assert.equal(result.source, "live");
  assert.deepEqual(result.models, [
    { id: "deepseek-ai/deepseek-v4.1-flash", name: "DEEPSEEK-V4.1-FLASH", description: "deepseek-v4.1-flash description", reasoning: false },
    { id: "z-ai/glm-5.3-flash", name: "GLM-5-3-FLASH", description: "glm-5-3-flash description", reasoning: true },
    { id: "openai/gpt-oss-20b", name: "GPT-OSS-20B", description: "gpt-oss-20b description", reasoning: true },
  ]);
  const query = JSON.parse(new URL(calls[0]!.url).searchParams.get("q")!);
  assert.deepEqual(query.filters, [{ field: "nimType", value: "nim_type_preview" }]);
  assert.ok(calls.every((call) => !JSON.stringify(call.init?.headers ?? {}).includes("nvapi")));
});

test("caches the live catalog and falls back to a static list when it is unreachable", async () => {
  let now = 0;
  let catalogUp = true;
  const { calls, fetcher } = fakeFetch((url) => catalogUp ? catalogResponder(url) : new Response("down", { status: 503 }));
  const gateway = createNvidiaBuildGateway({ fetch: fetcher, now: () => now });
  await gateway.listFreeChatModels();
  await gateway.listFreeChatModels();
  assert.equal(calls.length, 2);
  catalogUp = false;
  now = 11 * 60_000;
  const fallback = await gateway.listFreeChatModels();
  assert.equal(fallback.source, "fallback");
  assert.deepEqual(fallback.models, FALLBACK_FREE_CHAT_MODELS);
  assert.ok(FALLBACK_FREE_CHAT_MODELS.some((model) => model.id === DEFAULT_AI_REPORT_SETTINGS.model));
});

test("sends the configured chat request and strips model reasoning", async () => {
  const { calls, fetcher } = fakeFetch(() => Response.json({
    choices: [{ message: { role: "assistant", content: "<think>pasos</think>\n## Resumen\nHipótesis." } }],
  }));
  const gateway = createNvidiaBuildGateway({ fetch: fetcher });
  const messages = [{ role: "system" as const, content: "prompt" }, { role: "user" as const, content: "datos" }];
  const content = await gateway.complete(SECRET, { ...DEFAULT_AI_REPORT_SETTINGS, model: "openai/gpt-oss-20b", reasoningEffort: "high" }, messages);
  assert.equal(content, "## Resumen\nHipótesis.");
  assert.equal(calls[0]!.url, "https://integrate.api.nvidia.com/v1/chat/completions");
  assert.equal(calls[0]!.init?.method, "POST");
  assert.deepEqual(calls[0]!.init?.headers, {
    Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json", Accept: "application/json",
  });
  assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), {
    model: "openai/gpt-oss-20b", messages, temperature: 0.6, top_p: 0.95, max_tokens: 4096, stream: false, reasoning_effort: "high",
  });

  await gateway.complete(SECRET, DEFAULT_AI_REPORT_SETTINGS, messages);
  assert.equal("reasoning_effort" in JSON.parse(String(calls[1]!.init?.body)), false);
});

test("maps provider failures to safe errors without echoing the key or provider body", async () => {
  for (const [status, kind] of [[401, "unauthorized"], [403, "unauthorized"], [429, "rate_limited"], [400, "rejected"], [404, "rejected"], [422, "rejected"], [500, "unavailable"]] as const) {
    const { fetcher } = fakeFetch(() => new Response(`echo ${SECRET} body`, { status }));
    const error = await createNvidiaBuildGateway({ fetch: fetcher }).complete(SECRET, DEFAULT_AI_REPORT_SETTINGS, []).catch((caught: unknown) => caught);
    assert.ok(error instanceof NvidiaProviderError, String(status));
    assert.equal(error.kind, kind);
    assert.doesNotMatch(error.message, /nvapi|body/);
  }
  for (const body of [{}, { choices: [] }, { choices: [{ message: { content: "  " } }] }, { choices: [{ message: { content: "<think>x</think>" } }] }]) {
    const { fetcher } = fakeFetch(() => Response.json(body));
    const error = await createNvidiaBuildGateway({ fetch: fetcher }).complete(SECRET, DEFAULT_AI_REPORT_SETTINGS, []).catch((caught: unknown) => caught);
    assert.ok(error instanceof NvidiaProviderError);
    assert.equal(error.kind, "invalid_response");
  }
  const { fetcher } = fakeFetch(() => { throw new TypeError(`connect failed ${SECRET}`); });
  const error = await createNvidiaBuildGateway({ fetch: fetcher }).complete(SECRET, DEFAULT_AI_REPORT_SETTINGS, []).catch((caught: unknown) => caught);
  assert.ok(error instanceof NvidiaProviderError);
  assert.equal(error.kind, "unavailable");
  assert.doesNotMatch(error.message, /nvapi/);
});
