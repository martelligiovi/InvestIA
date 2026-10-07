import { describe, expect, it, vi } from "vitest";
import { ApiError, InvestigationApiClient } from "../src/api/client";

type CapturedCall = { input: RequestInfo | URL; init?: RequestInit };

function clientWith(responseBody: unknown, status = 200) {
  const calls: CapturedCall[] = [];
  const fetcher: typeof fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    if (typeof responseBody === "string") {
      return new Response(responseBody, { status, headers: { "content-type": "text/markdown; charset=utf-8" } });
    }
    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
  return { api: new InvestigationApiClient(fetcher), calls };
}

function bodyOf(call: CapturedCall): unknown {
  return call.init?.body === undefined ? undefined : JSON.parse(String(call.init.body));
}

describe("InvestigationApiClient", () => {
  it("creates bodylessly for legacy-compatible creation and sends a name when supplied", async () => {
    const { api, calls } = clientWith({ id: "i-1" });
    await api.createInvestigation();
    await api.createInvestigation("  Estudio editorial  ");

    expect(calls.map(({ input }) => String(input))).toEqual(["/investigations", "/investigations"]);
    expect(calls.map(bodyOf)).toEqual([undefined, { name: "  Estudio editorial  " }]);
    expect(calls.every(({ init }) => init?.method === "POST")).toBe(true);
  });

  it("lists and loads investigations using relative API paths", async () => {
    const { api, calls } = clientWith([]);
    await api.listInvestigations();
    await api.getInvestigation("case 42");

    expect(calls.map(({ input }) => String(input))).toEqual([
      "/investigations",
      "/investigations/case%2042",
    ]);
  });

  it("maps every persisted-action endpoint to the backend request contract", async () => {
    const { api, calls } = clientWith({});
    await api.addEmailSeed("i/1", "persona@example.test", "Semilla aportada por el operador");
    await api.proposeGitHubAction("i/1", "persona@example.test", "Buscar perfil público");
    await api.setAuthorization("i/1", true, "Autorización explícita");
    await api.approveAction("i/1", "a/2", "Aprobación explícita");
    await api.runNextAction("i/1");
    await api.validateEvidence("i/1", "e/3", "accepted", "Coincide con la fuente");
    await api.rejectEvidence("i/1", "e/3", "No corresponde");
    await api.pauseInvestigation("i/1", "Revisión manual");
    await api.resumeInvestigation("i/1", "Revisión terminada");
    await api.reconcileProjections();

    expect(calls.map(({ input, init }) => [String(input), init?.method, bodyOf({ input, init })])).toEqual([
      ["/investigations/i%2F1/emails", "POST", { email: "persona@example.test", reason: "Semilla aportada por el operador" }],
      ["/investigations/i%2F1/actions/proposals", "POST", { email: "persona@example.test", reason: "Buscar perfil público" }],
      ["/investigations/i%2F1/authorization", "POST", { granted: true, reason: "Autorización explícita" }],
      ["/investigations/i%2F1/actions/a%2F2/approval", "POST", { reason: "Aprobación explícita" }],
      ["/investigations/i%2F1/actions/run", "POST", undefined],
      ["/investigations/i%2F1/evidence/e%2F3/validation", "POST", { status: "accepted", reason: "Coincide con la fuente" }],
      ["/investigations/i%2F1/evidence/e%2F3/rejection", "POST", { reason: "No corresponde" }],
      ["/investigations/i%2F1/pause", "POST", { reason: "Revisión manual" }],
      ["/investigations/i%2F1/resume", "POST", { reason: "Revisión terminada" }],
      ["/investigations/projections/reconcile", "POST", undefined],
    ]);
  });

  it("uses the global receiver for default JSON and Markdown fetch calls", async () => {
    const calls: CapturedCall[] = [];
    vi.stubGlobal("fetch", function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      calls.push({ input, init });
      return Promise.resolve(input.toString().endsWith("/report")
        ? new Response("# Report")
        : new Response("[]", { headers: { "content-type": "application/json" } }));
    });

    try {
      const api = new InvestigationApiClient();
      const results = await Promise.allSettled([
        api.listInvestigations(),
        api.getReport("id-1"),
      ]);
      expect(results).toEqual([
        { status: "fulfilled", value: [] },
        { status: "fulfilled", value: "# Report" },
      ]);
      expect(calls.map(({ input }) => String(input))).toEqual([
        "/investigations",
        "/investigations/id-1/report",
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("returns reports as plain text without attempting JSON parsing", async () => {
    const markdown = "# Informe\n\nContenido factual.";
    const { api, calls } = clientWith(markdown);

    await expect(api.getReport("id-1")).resolves.toBe(markdown);
    expect(calls[0]?.input).toBe("/investigations/id-1/report");
    expect(calls[0]?.init?.method).toBe("GET");
  });

  it("surfaces typed API errors from the backend JSON envelope", async () => {
    const { api } = clientWith({ error: "NOT_FOUND", message: "Investigation not found" }, 404);

    await expect(api.getInvestigation("missing")).rejects.toMatchObject({
      name: "ApiError",
      status: 404,
      code: "NOT_FOUND",
      message: "Investigation not found",
    } satisfies Partial<ApiError>);
  });

  it("provides a typed fallback for malformed error responses", async () => {
    const fetcher: typeof fetch = async () => new Response("unavailable", { status: 502 });
    const api = new InvestigationApiClient(fetcher);

    await expect(api.listInvestigations()).rejects.toMatchObject({
      name: "ApiError",
      status: 502,
      code: "HTTP_ERROR",
    });
  });
});
