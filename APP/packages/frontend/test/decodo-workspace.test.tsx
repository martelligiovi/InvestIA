import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { findingSeedNodeId, type EvidenceAiNormalization, type EvidenceNormalizationJob, type EvidenceRecord, type GitHubCatalogAction, type Investigation, type ValidationDecision } from "@investia/core";
import { WorkspaceDetails } from "../src/components/WorkspaceDetails";
import { buildWorkspaceGraph } from "../src/pages/workspace-model";
import { WorkspacePage } from "../src/pages/WorkspacePage";

const at = "2025-01-01T00:00:00Z";
const pageSeed = { kind: "url", value: "https://example.org/candidate" } as const;
const photo = { kind: "photo", value: "https://lh3.googleusercontent.com/a-/fixture" } as const;
const decodo = {
  id: "scrape", spec: { catalogId: "decodo.url.v1", provider: "decodo", seed: pageSeed },
  sourceSeedId: findingSeedNodeId("match"), status: "queued", queuedByCatalog: true, proposedAt: at, proposalReason: "Accepted candidate",
} satisfies GitHubCatalogAction;
const facecheck: GitHubCatalogAction = {
  id: "facecheck", spec: { catalogId: "facecheck.photo.v1", provider: "facecheck", seed: photo },
  status: "succeeded", queuedByCatalog: true, proposedAt: at, proposalReason: "Profile photo",
};
const authorization = { granted: true, at, reason: "Consent", operator: "local-operator", catalogScopes: ["facecheck.photo.v1", "decodo.url.v1"] } as const;
const content = 'Page text\n<script type="text/plain">script fixture</script>\n<img onerror="">';
const finalUrl = "https://example.net/canonical";
const publicLink = "https://example.net/about";
const secondLink = "http://example.org/contact";
const privateLink = "http://127.0.0.1/local";
const page: EvidenceRecord = {
  id: "page", actionId: decodo.id, seed: pageSeed, provider: "Decodo", status: "registered", sourceId: "decodo:url", recordedAt: at,
  finding: { target: pageSeed, upstreamStatus: "Found", url: finalUrl, category: "Web page", reason: "Fixture profile", media: {}, extra: {
    title: "Fixture profile", status_code: 200, description: "Public profile description", content, content_truncated: true,
    links: [publicLink, secondLink, privateLink].join("\n"), content_format: "text",
  } },
};

function candidate(id: string, url: string): EvidenceRecord {
  return { id, actionId: facecheck.id, seed: photo, provider: "FaceCheck", status: "registered", sourceId: "facecheck:photo", recordedAt: at,
    finding: { target: photo, upstreamStatus: "Found", url, category: "Face match", reason: "Similar face", extra: { score: 90 }, media: {} } };
}

function decision(status: ValidationDecision["status"], evidenceId = "match"): ValidationDecision {
  return { id: `decision-${evidenceId}-${status}`, evidenceId, status, reason: "Reviewed", at, operator: "local-operator" };
}

function snapshot(overrides: Partial<Investigation> = {}): Investigation {
  return {
    id: "case", name: "Caso Decodo", revision: 1, createdAt: at, updatedAt: at, paused: false,
    advancementMode: "automatic", emailSeeds: [], authorization, actions: [facecheck, decodo],
    evidence: [candidate("match", pageSeed.value), candidate("other", "https://example.org/other"), candidate("third", "https://example.org/third")],
    validations: [decision("accepted")], audit: [], ...overrides,
  };
}

function withPage(): Investigation {
  const investigation = snapshot({ actions: [facecheck, { ...decodo, status: "succeeded", completedAt: at }] });
  return { ...investigation, evidence: [...investigation.evidence, page] };
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function decodoStatus(tokenConfigured: boolean) {
  return json({ tokenConfigured, tokenHint: tokenConfigured ? "••••1234" : null, apiMode: "web_data" });
}

function installWorkspaceApi(investigation: Investigation, settings: () => Response | Promise<Response>) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    calls.push(`${init?.method ?? "GET"} ${path}`);
    if (init?.method === undefined && path === "/investigations/case") return json(investigation);
    if (init?.method === undefined && path === "/settings/decodo") return settings();
    throw new Error(`Unexpected request: ${calls.at(-1)}`);
  }));
  return calls;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it("keeps the accepted FaceCheck match and its Decodo results on one branch while grouping the other leaves", () => {
  const graph = buildWorkspaceGraph(withPage());
  const group = graph.nodes.find((node) => node.id === "leaf-group:facecheck");
  expect(group?.members?.map((member) => member.id)).toEqual(["evidence:other", "evidence:third"]);
  expect(graph.nodes.find((node) => node.id === "evidence:match")).toMatchObject({ kind: "evidence", title: "FaceCheck · 90 · example.org" });
  expect(graph.edges).toEqual(expect.arrayContaining([
    expect.objectContaining({ from: "action:facecheck", to: "evidence:match" }),
    expect.objectContaining({ from: "action:facecheck", to: "leaf-group:facecheck" }),
    expect.objectContaining({ from: "evidence:match", to: "action:scrape" }),
    expect.objectContaining({ from: "action:scrape", to: "evidence:page" }),
  ]));
  expect(graph.nodes.find((node) => node.id === "action:scrape")?.title).toBe("Decodo · example.org");
  expect(graph.nodes.find((node) => node.id === "evidence:page")?.title).toBe("Decodo · Fixture profile");
  const investigation = withPage();
  const untitled = { ...page, finding: { ...page.finding!, extra: { title: "", content } } };
  const fallback = buildWorkspaceGraph({ ...investigation, evidence: [...investigation.evidence.slice(0, -1), untitled] });
  expect(fallback.nodes.find((node) => node.id === "evidence:page")?.title).toBe("Decodo · example.net");
});

it("omits the discarded-only group when accepted FaceCheck candidates already branch to Decodo", async () => {
  const secondScrape = { ...decodo, id: "scrape-other", sourceSeedId: findingSeedNodeId("other"),
    spec: { ...decodo.spec, seed: { kind: "url" as const, value: "https://example.org/other" } } };
  const investigation = snapshot({ actions: [facecheck, decodo, secondScrape],
    validations: [decision("accepted"), decision("accepted", "other"), decision("rejected", "third")] });
  const graph = buildWorkspaceGraph(investigation);
  expect(graph.nodes.filter((node) => node.kind === "leaf-group")).toEqual([]);
  expect(graph.nodes.filter((node) => node.evidence?.actionId === facecheck.id).map((node) => node.id))
    .toEqual(["evidence:match", "evidence:other"]);
  expect(graph.edges.map(({ from, to }) => [from, to])).toEqual([
    ["evidence:match", "action:scrape"], ["evidence:other", "action:scrape-other"],
    ["action:facecheck", "evidence:match"], ["action:facecheck", "evidence:other"],
  ]);

  const calls = installWorkspaceApi(investigation, () => decodoStatus(false));
  render(<WorkspacePage id="case" />);
  const canvas = within(await screen.findByRole("group", { name: /grafo factual/i }));
  expect(canvas.queryByRole("button", { name: /Grupo de semillas:|Evidencia: third\./ })).not.toBeInTheDocument();
  for (const name of [/Acción: facecheck\./, /Evidencia: match\./, /Evidencia: other\./]) {
    fireEvent.click(canvas.getByRole("button", { name }));
    fireEvent.click(screen.getByRole("button", { name: "Revisar candidatos · todo revisado" }));
    const review = within(screen.getByRole("dialog", { name: /Revisar candidatos de FaceCheck/ }));
    fireEvent.click(review.getByRole("tab", { name: "Descartados (1)" }));
    expect(review.getAllByRole("listitem")).toHaveLength(1);
    fireEvent.click(review.getByRole("button", { name: "Cerrar revisión" }));
  }
  expect(calls.every((call) => call.startsWith("GET "))).toBe(true);
});

it("keeps the no-acceptance group connected after the only Decodo parent is rejected", async () => {
  const investigation = snapshot({ validations: [decision("accepted"), decision("rejected"),
    decision("rejected", "other"), decision("rejected", "third")] });
  const graph = buildWorkspaceGraph(investigation);
  const group = graph.nodes.find((node) => node.id === "leaf-group:facecheck");
  const producer = graph.nodes.find((node) => node.id === "action:facecheck")!;
  expect(group).toMatchObject({ title: "Ningún candidato aceptado", members: [], x: producer.x + 402 });
  expect(graph.edges.filter(({ to }) => to === group?.id)).toEqual([
    expect.objectContaining({ from: producer.id, to: group?.id }),
  ]);
  expect(graph.edges).toContainEqual(expect.objectContaining({ from: "evidence:match", to: "action:scrape" }));

  const calls = installWorkspaceApi(investigation, () => decodoStatus(true));
  render(<WorkspacePage id="case" />);
  const canvas = within(await screen.findByRole("group", { name: /grafo factual/i }));
  fireEvent.click(canvas.getByRole("button", { name: /Ningún candidato aceptado/ }));
  fireEvent.click(screen.getByRole("button", { name: "Revisar candidatos · todo revisado" }));
  const review = within(screen.getByRole("dialog", { name: /Revisar candidatos de FaceCheck/ }));
  fireEvent.click(review.getByRole("tab", { name: "Descartados (3)" }));
  expect(review.getAllByRole("listitem")).toHaveLength(3);
  expect(calls.every((call) => call.startsWith("GET "))).toBe(true);
});

it("shows public page metadata and safe links, and renders scraped markup only as text", () => {
  const investigation = withPage();
  const node = buildWorkspaceGraph(investigation).nodes.find((item) => item.id === "evidence:page")!;
  render(<WorkspaceDetails investigation={investigation} node={node} disabled={false} onValidate={vi.fn()} />);
  const section = within(screen.getByRole("region", { name: "Página recopilada por Decodo" }));
  expect(section.getByText("Fixture profile")).toBeInTheDocument();
  const links = section.getAllByRole("link");
  expect(links.map((link) => link.getAttribute("href"))).toEqual([finalUrl, publicLink, secondLink]);
  for (const link of links) {
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  }
  expect(section.getByText("200")).toBeInTheDocument();
  expect(section.getByText("Public profile description")).toBeInTheDocument();
  expect(section.getByText(/contenido.*truncado/i)).toBeInTheDocument();
  const text = section.getByLabelText("Texto recopilado");
  expect(text.textContent).toBe(content);
  expect(text.children).toHaveLength(0);
  const detail = screen.getByRole("complementary");
  expect(detail.querySelector("script, img")).toBeNull();
  expect(within(detail).getByText("URL", { selector: "dd" })).toBeInTheDocument();
  expect(within(detail).queryByText("content", { selector: "dt" })).not.toBeInTheDocument();
  expect(within(detail).queryByText("links", { selector: "dt" })).not.toBeInTheDocument();
});

it("explains all queued Decodo blockers and links to the source page and token settings", async () => {
  installWorkspaceApi(snapshot({ authorization: { ...authorization, granted: false },
    validations: [decision("accepted"), decision("rejected")] }), () => decodoStatus(false));
  render(<WorkspacePage id="case" />);
  const graph = await screen.findByRole("group", { name: /grafo factual/i });
  fireEvent.click(within(graph).getByRole("button", { name: /Acción: scrape\./i }));
  const detail = within(screen.getByRole("complementary"));
  expect(detail.getByRole("link", { name: pageSeed.value })).toHaveAttribute("rel", "noopener noreferrer");
  expect(detail.getByText("El expediente requiere autorización para ejecutar Decodo.")).toBeInTheDocument();
  expect(detail.getByText(/FaceCheck.*ya no está aceptada/i)).toBeInTheDocument();
  expect(await detail.findByRole("link", { name: "Configurar Decodo" })).toHaveAttribute("href", "#/ajustes");
});

it("queues one candidate or all eligible accepted candidates from a FaceCheck leaf group", async () => {
  const evidence = [
    candidate("match", "https://www.linkedin.com/in/example"), candidate("other", "https://github.com/example"),
    candidate("third", "https://www.instagram.com/example"), candidate("unsafe", privateLink),
    candidate("pending", "https://example.net/pending"), candidate("rejected", "https://example.com/rejected"),
  ];
  let current = snapshot({ actions: [facecheck], evidence,
    authorization: { ...authorization, catalogScopes: ["facecheck.photo.v1"] },
    validations: [...evidence.slice(0, 4).map(({ id }) => decision("accepted", id)), decision("rejected", "rejected")],
  });
  const posts: string[] = [];
  let releaseBatch!: () => void;
  const firstBatchRequest = new Promise<void>((resolve) => { releaseBatch = resolve; });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === undefined && path === "/investigations/case") return json(current);
    if (init?.method === undefined && path === "/settings/decodo") return decodoStatus(false);
    const match = /^\/investigations\/case\/evidence\/([^/]+)\/decodo$/.exec(path);
    if (init?.method === "POST" && match) {
      const id = match[1]!;
      posts.push(id);
      expect(init.body).toBeUndefined();
      if (id === "other") await firstBatchRequest;
      const url = evidence.find((item) => item.id === id)!.finding!.url;
      current = { ...current, revision: current.revision + 1, actions: [...current.actions, {
        ...decodo, id: `scrape-${id}`, sourceSeedId: findingSeedNodeId(id), spec: { ...decodo.spec, seed: { kind: "url", value: url } },
      }] };
      return json(current);
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${path}`);
  }));
  render(<WorkspacePage id="case" />);
  const graph = await screen.findByRole("group", { name: /grafo factual/i });
  fireEvent.click(within(graph).getByRole("button", { name: /Grupo de semillas:.*aceptados/i }));
  const detail = within(screen.getByRole("complementary"));
  const linkedin = "FaceCheck · 90 · www.linkedin.com";
  expect(detail.getByRole("button", { name: `Ver resultado: ${linkedin}` })).toBeEnabled();
  expect(detail.getByRole("button", { name: /Ver resultado: .*example\.net/ })).toBeEnabled();
  expect(detail.getAllByRole("button", { name: /^Aplicar Decodo a FaceCheck/ })).toHaveLength(3);
  expect(detail.queryByRole("button", { name: /^Aplicar Decodo a .*?(example\.net|example\.com|127\.0\.0\.1)/ })).not.toBeInTheDocument();
  expect(detail.getByRole("button", { name: "Aplicar Decodo a aceptados (3)" })).toBeEnabled();
  expect(detail.queryByText(/autorización.*Decodo/i)).not.toBeInTheDocument();
  expect(await detail.findByRole("link", { name: "Configurar Decodo" })).toHaveAttribute("href", "#/ajustes");

  await act(async () => { fireEvent.click(detail.getByRole("button", { name: `Aplicar Decodo a ${linkedin}` })); });
  expect(posts).toEqual(["match"]);
  expect(detail.queryByRole("button", { name: `Aplicar Decodo a ${linkedin}` })).not.toBeInTheDocument();
  expect(within(graph).getByRole("button", { name: /Acción: scrape-match\./ })).toBeInTheDocument();
  const batch = detail.getByRole("button", { name: "Aplicar Decodo a aceptados (2)" });
  await act(async () => { fireEvent.click(batch); });
  expect(posts).toEqual(["match", "other"]);
  expect(batch).toBeDisabled();
  await act(async () => { releaseBatch(); });
  expect(posts).toEqual(["match", "other", "third"]);
  expect(detail.queryByRole("button", { name: /^Aplicar Decodo/ })).not.toBeInTheDocument();
});

it("queues Decodo from a single accepted candidate without a reason, then refreshes and polls its branch", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("CSS", { escape: (value: string) => value.replaceAll(":", "\\:") });
  let current = snapshot({ actions: [facecheck] });
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    calls.push(`${init?.method ?? "GET"} ${path}`);
    if (init?.method === undefined && path === "/investigations/case") return json(current);
    if (init?.method === undefined && path === "/settings/decodo") return decodoStatus(true);
    if (init?.method === "POST" && path === "/investigations/case/evidence/match/decodo") {
      expect(init.body).toBeUndefined();
      current = { ...current, revision: 2, actions: [facecheck, decodo] };
      return json(current);
    }
    throw new Error(`Unexpected request: ${calls.at(-1)}`);
  }));
  await act(async () => { render(<WorkspacePage id="case" />); });
  const graph = within(screen.getByRole("group", { name: /grafo factual/i }));
  fireEvent.click(graph.getByRole("button", { name: /Grupo de semillas:.*aceptad/i }));
  const detail = within(screen.getByRole("complementary"));
  expect(detail.getByRole("button", { name: "Aplicar Decodo" })).toBeEnabled();
  const match = within(detail.getAllByRole("listitem")[0]!);
  fireEvent.click(match.getByRole("button", { name: "Ver resultado: FaceCheck · 90 · example.org" }));
  const evidenceDetail = within(screen.getByRole("complementary"));
  const queue = within(evidenceDetail.getByRole("region", { name: "Acción de Decodo" })).getByRole("button", { name: "Aplicar scraping con Decodo" });
  expect(evidenceDetail.getByRole("textbox", { name: "Motivo de validación" })).toHaveValue("");
  await act(async () => { fireEvent.click(queue); });
  expect(calls.filter((call) => call.startsWith("POST "))).toEqual(["POST /investigations/case/evidence/match/decodo"]);
  expect(calls.filter((call) => call === "GET /investigations/case")).toHaveLength(2);
  expect(graph.getByRole("button", { name: /Evidencia: match\./ })).toBeInTheDocument();
  expect(graph.getByRole("button", { name: /Acción: scrape\./ })).toBeInTheDocument();
  expect(within(screen.getByRole("complementary")).queryByRole("region", { name: "Acción de Decodo" })).not.toBeInTheDocument();
  current = { ...withPage(), revision: 3 };
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  expect(calls.filter((call) => call === "GET /investigations/case")).toHaveLength(3);
  expect(graph.getByRole("button", { name: /Evidencia: page\. Decodo/ })).toBeInTheDocument();
  expect(calls.filter((call) => call.startsWith("POST "))).toHaveLength(1);
});

it("keeps inline manual dispatch available for an authorized legacy queue including Decodo", async () => {
  const seed = { kind: "email", value: "fixture@example.org" } as const;
  const scanner: GitHubCatalogAction = {
    id: "scanner", spec: { catalogId: "user-scanner.email.v1", provider: "user-scanner", seed },
    status: "queued", queuedByCatalog: true, proposedAt: at, proposalReason: "Email seed",
  };
  let current = snapshot({ advancementMode: "manual", emailSeeds: [seed], actions: [facecheck, scanner, decodo],
    authorization: { ...authorization, catalogScopes: ["facecheck.photo.v1", "user-scanner.email.v1"] } });
  const runNext = vi.fn(() => {
    const completed = { ...current.actions.find((action) => action.status === "queued")!, status: "succeeded" as const, completedAt: at };
    current = { ...current, revision: current.revision + 1, actions: current.actions.map((action) => action.id === completed.id ? completed : action) };
    return json({ action: completed });
  });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === undefined && path === "/investigations/case") return json(current);
    if (init?.method === undefined && path === "/settings/decodo") return decodoStatus(true);
    if (init?.method === "POST" && path === "/investigations/case/actions/run") return runNext();
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${path}`);
  }));
  render(<WorkspacePage id="case" />);
  const dispatch = await screen.findByRole("button", { name: "Ejecutar siguiente acción en cola" });
  expect(dispatch).toBeEnabled();
  expect(runNext).not.toHaveBeenCalled();
  await act(async () => { fireEvent.click(dispatch); });
  expect(runNext).toHaveBeenCalledTimes(1);
  expect(dispatch).toBeEnabled();
  await act(async () => { fireEvent.click(dispatch); });
  expect(runNext).toHaveBeenCalledTimes(2);
  expect(dispatch).not.toBeInTheDocument();
});

it.each([
  ["the token is missing", snapshot(), false],
  ["the old grant is unscoped", snapshot({ authorization: { ...authorization, catalogScopes: [] } }), true],
  ["the grant covers only User Scanner", snapshot({ authorization: { ...authorization, catalogScopes: ["user-scanner.email.v1"] } }), true],
  ["the operator rejected the previously accepted match", snapshot({ validations: [decision("accepted"), decision("rejected")] }), true],
] as const)("does not poll queued Decodo when %s", async (_reason, investigation, configured) => {
  vi.useFakeTimers();
  const calls = installWorkspaceApi(investigation, () => decodoStatus(configured));
  await act(async () => { render(<WorkspacePage id="case" />); });
  expect(screen.getByRole("heading", { name: "Caso Decodo" })).toBeInTheDocument();
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
  expect(calls.filter((call) => call === "GET /investigations/case")).toHaveLength(1);
  expect(calls).toContain("GET /settings/decodo");
  expect(calls.every((call) => call.startsWith("GET "))).toBe(true);
});

it.each([
  ["missing", undefined],
  ["revoked", { ...authorization, granted: false }],
] as const)("blocks automatic polling until %s authorization is granted inline", async (_reason, blockedGrant) => {
  vi.useFakeTimers();
  let current = snapshot({ authorization: blockedGrant });
  const calls: string[] = [];
  let releaseGrant!: () => void;
  const pendingGrant = new Promise<void>((resolve) => { releaseGrant = resolve; });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = `${init?.method ?? "GET"} ${String(input)}`;
    calls.push(request);
    if (request === "GET /investigations/case") return json(current);
    if (request === "GET /settings/decodo") return decodoStatus(true);
    if (request === "POST /investigations/case/authorization") {
      expect(JSON.parse(String(init?.body))).toEqual({ granted: true,
        reason: "Autorización del expediente confirmada para ejecutar las herramientas configuradas." });
      await pendingGrant;
      current = snapshot({ revision: 2 });
      return json(current);
    }
    throw new Error(`Unexpected request: ${request}`);
  }));
  await act(async () => { render(<WorkspacePage id="case" />); });
  const warning = screen.getByRole("status");
  expect(warning).toHaveTextContent(/Esperando autorización: 1 acción en cola bloqueada/);
  expect(warning.closest(".workspace-claimed-warning")).toHaveTextContent(/semillas actuales y futuras.*user-scanner.*FaceCheck.*Decodo/i);
  const authorize = screen.getByRole("button", { name: "Autorizar expediente" });
  expect(authorize).toBeEnabled();
  expect(screen.queryByLabelText("Motivo de autorización")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Ejecutar siguiente/ })).not.toBeInTheDocument();
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
  expect(calls).toEqual(["GET /investigations/case", "GET /investigations/case/normalizations", "GET /settings/decodo"]);
  expect(current.revision).toBe(1);
  await act(async () => { fireEvent.click(authorize); });
  expect(authorize).toBeDisabled();
  await act(async () => { releaseGrant(); });
  expect(authorize).not.toBeInTheDocument();
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  expect(calls.slice(3)).toEqual(["POST /investigations/case/authorization", "GET /investigations/case",
    "GET /investigations/case/normalizations", "GET /investigations/case"]);
});

it("polls Decodo under a pre-Decodo scoped grant once the token is confirmed, without renewal or browser dispatch", async () => {
  vi.useFakeTimers();
  let resolveSettings!: (response: Response) => void;
  const pendingSettings = new Promise<Response>((resolve) => { resolveSettings = resolve; });
  const calls = installWorkspaceApi(snapshot({ authorization: { ...authorization, catalogScopes: ["facecheck.photo.v1"] } }), () => pendingSettings);
  await act(async () => { render(<WorkspacePage id="case" />); });
  const graph = within(screen.getByRole("group", { name: /grafo factual/i }));
  expect(screen.queryByText("Esperando autorización")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Autorizar expediente" })).not.toBeInTheDocument();
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(calls.filter((call) => call === "GET /investigations/case")).toHaveLength(1);

  await act(async () => { resolveSettings(decodoStatus(true)); });
  expect(graph.getByRole("button", { name: /Acción: scrape\..*Estado: En cola\./ })).toBeInTheDocument();
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  expect(calls.filter((call) => call === "GET /investigations/case")).toHaveLength(2);
  expect(calls).toContain("GET /settings/decodo");
  expect(calls.every((call) => call.startsWith("GET "))).toBe(true);
  fireEvent.click(graph.getByRole("button", { name: /Acción: scrape\./ }));
  expect(within(screen.getByRole("complementary")).queryByText(/renovar la autorización|requiere autorización para ejecutar Decodo/)).not.toBeInTheDocument();
});

it("keeps the discarded stack connected when the only Decodo branch has a rejected parent", () => {
  const graph = buildWorkspaceGraph(snapshot({ validations: [
    decision("accepted"), decision("rejected", "other"),
    decision("rejected", "third"), decision("rejected"),
  ] }));
  const group = graph.nodes.find(({ id }) => id === "leaf-group:facecheck");
  expect(group).toMatchObject({ title: "Ningún candidato aceptado", members: [] });
  expect(graph.edges.filter(({ to }) => to === group?.id)).toEqual([
    expect.objectContaining({ from: "action:facecheck" }),
  ]);
});

it("keeps existing scanner stack branch order with linked Gravatar work", () => {
  const email = { kind: "email", value: "fixture@example.org" } as const;
  const scanner: GitHubCatalogAction = {
    id: "scanner", spec: { catalogId: "user-scanner.email.v1", provider: "user-scanner", seed: email },
    status: "succeeded", queuedByCatalog: true, proposedAt: at, proposalReason: "Email seed",
  };
  const profile: GitHubCatalogAction = {
    ...scanner, id: "profile", status: "queued", sourceSeedId: findingSeedNodeId("c"),
    spec: { catalogId: "gravatar.email.v1", provider: "gravatar", seed: email },
  };
  const evidence: EvidenceRecord[] = ["a", "b", "c"].map((id) => ({
    id, actionId: scanner.id, seed: email, provider: "Scanner", status: "registered",
    sourceId: "user-scanner:email", recordedAt: at,
  }));
  const graph = buildWorkspaceGraph(snapshot({
    actions: [scanner, profile], emailSeeds: [email], evidence, validations: [],
  }));
  expect(graph.edges.filter(({ from }) => from === "action:scanner").map(({ to }) => to))
    .toEqual(["leaf-group:scanner", "evidence:c"]);
});

const normalizedPageFixture: EvidenceAiNormalization = {
  evidenceId: page.id,
  model: "nvidia/nemotron-3.5-super-vl-120b-a12b",
  generatedAt: "2026-02-03T14:30:00.000Z",
  sourceContentHash: "c".repeat(64),
  data: {
    summary: 'Public profile summary <script>alert("xss")</script>',
    entityName: "Ana Ejemplo",
    handles: ["@anaejemplo"],
    rolesOrOccupations: ["Principal Engineer"],
    organizations: ["Example Corp"],
    education: ["Universidad de Buenos Aires"],
    locationsMentioned: ["Buenos Aires"],
    topicsOrInterests: ["Distributed systems"],
    notableFacts: ["Published security research"],
    relatedUrls: ["https://github.com/anaejemplo", privateLink],
    limitations: ["Truncated source text"],
  },
};

const queuedPageJob: EvidenceNormalizationJob = {
  id: "job-1", investigationId: "case", evidenceId: page.id, attemptNumber: 1, status: "queued", createdAt: at,
};

it("queues a Decodo page and polls until its normalization completes without altering raw evidence", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("CSS", { escape: (value: string) => value.replaceAll(":", "\\:") });
  const calls: string[] = [];
  let releaseNormalize!: (response: Response) => void;
  const pendingNormalize = new Promise<Response>((resolve) => { releaseNormalize = resolve; });
  let releasePoll!: (response: Response) => void;
  const pendingPoll = new Promise<Response>((resolve) => { releasePoll = resolve; });
  let reads = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const request = `${init?.method ?? "GET"} ${path}`;
    calls.push(request);
    if (init?.method === undefined && path === "/investigations/case") return json(withPage());
    if (init?.method === undefined && path === "/settings/decodo") return decodoStatus(true);
    if (init?.method === undefined && path === "/investigations/case/normalizations") {
      reads += 1;
      if (reads === 1) return json({ normalizations: [], jobs: [] });
      if (reads === 2) return pendingPoll;
      return json({ normalizations: [normalizedPageFixture], jobs: [{ ...queuedPageJob, status: "succeeded" }] });
    }
    if (init?.method === "POST" && path === "/investigations/case/evidence/page/normalize/queue") {
      expect(init.body).toBeUndefined();
      return pendingNormalize;
    }
    throw new Error(`Unexpected request: ${request}`);
  }));

  await act(async () => { render(<WorkspacePage id="case" />); });
  const graph = screen.getByRole("group", { name: /grafo factual/i });
  fireEvent.click(within(graph).getByRole("button", { name: /Evidencia: page\. Decodo/ }));

  const detail = screen.getByRole("complementary");
  const rawSection = within(within(detail).getByRole("region", { name: "Página recopilada por Decodo" }));
  const aiSection = within(within(detail).getByRole("region", { name: "Resumen estructurado (asistido por IA)" }));

  expect(calls.filter((call) => call.startsWith("POST "))).toEqual([]);
  expect(calls).toContain("GET /investigations/case/normalizations");
  const normalizeBtn = aiSection.getByRole("button", { name: "Normalizar con IA" });
  expect(normalizeBtn).toBeEnabled();
  expect(aiSection.queryByLabelText("JSON normalizado por IA")).not.toBeInTheDocument();

  await act(async () => { fireEvent.click(normalizeBtn); });
  expect(aiSection.getByRole("button", { name: "Encolando normalización…" })).toBeDisabled();
  expect(calls.filter((call) => call.startsWith("POST "))).toEqual(["POST /investigations/case/evidence/page/normalize/queue"]);

  await act(async () => { releaseNormalize(json({ job: queuedPageJob, created: true }, 202)); });
  expect(aiSection.getByRole("button", { name: "En cola para normalizar con IA" })).toBeDisabled();
  await act(async () => { await vi.advanceTimersByTimeAsync(4_500); });
  expect(reads).toBe(2);
  expect(screen.getByRole("button", { name: "Obtener informe" })).toBeEnabled();
  await act(async () => { releasePoll(json({ normalizations: [], jobs: [{ ...queuedPageJob, status: "running" }] })); });
  expect(aiSection.getByRole("button", { name: "Normalizando con IA…" })).toBeDisabled();
  await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
  expect(aiSection.getByRole("button", { name: "Volver a normalizar con IA" })).toBeEnabled();
  await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
  expect(reads).toBe(3);
  expect(aiSection.getByText("nvidia/nemotron-3.5-super-vl-120b-a12b")).toBeInTheDocument();
  expect(aiSection.getByText("Ana Ejemplo")).toBeInTheDocument();
  expect(aiSection.getByText('Public profile summary <script>alert("xss")</script>')).toBeInTheDocument();
  expect(aiSection.getByText("@anaejemplo")).toBeInTheDocument();
  expect(aiSection.getByText("Principal Engineer")).toBeInTheDocument();
  expect(aiSection.getByText("Example Corp")).toBeInTheDocument();
  expect(aiSection.getByText("Universidad de Buenos Aires")).toBeInTheDocument();
  expect(aiSection.getByText("Buenos Aires")).toBeInTheDocument();
  expect(aiSection.getByText("Distributed systems")).toBeInTheDocument();
  expect(aiSection.getByText("Published security research")).toBeInTheDocument();
  expect(aiSection.getByText("Truncated source text")).toBeInTheDocument();

  const relatedLinks = aiSection.getAllByRole("link");
  expect(relatedLinks.map((link) => link.getAttribute("href"))).toEqual(["https://github.com/anaejemplo"]);
  expect(relatedLinks[0]).toHaveAttribute("target", "_blank");
  expect(relatedLinks[0]).toHaveAttribute("rel", "noopener noreferrer");
  expect(aiSection.getByText(privateLink).tagName).toBe("SPAN");

  const jsonPre = aiSection.getByLabelText("JSON normalizado por IA");
  expect(jsonPre.tagName).toBe("PRE");
  expect(jsonPre.children).toHaveLength(0);
  expect(JSON.parse(jsonPre.textContent ?? "")).toEqual(normalizedPageFixture.data);
  expect(detail.querySelector("script")).toBeNull();

  expect(rawSection.getByText("Fixture profile")).toBeInTheDocument();
  expect(rawSection.getByLabelText("Texto recopilado").textContent).toBe(content);
});

it("loads persisted AI normalizations via GET when opening a case with Decodo page evidence", async () => {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const request = `${init?.method ?? "GET"} ${path}`;
    calls.push(request);
    if (init?.method === undefined && path === "/investigations/case") return json(withPage());
    if (init?.method === undefined && path === "/settings/decodo") return decodoStatus(true);
    if (init?.method === undefined && path === "/investigations/case/normalizations") {
      return json({ normalizations: [normalizedPageFixture] });
    }
    throw new Error(`Unexpected request: ${request}`);
  }));

  render(<WorkspacePage id="case" />);
  const graph = await screen.findByRole("group", { name: /grafo factual/i });
  fireEvent.click(within(graph).getByRole("button", { name: /Evidencia: page\. Decodo/ }));

  const aiSection = within(screen.getByRole("region", { name: "Resumen estructurado (asistido por IA)" }));
  expect(await aiSection.findByRole("button", { name: "Volver a normalizar con IA" })).toBeEnabled();
  expect(aiSection.getByText("Ana Ejemplo")).toBeInTheDocument();
  expect(JSON.parse(aiSection.getByLabelText("JSON normalizado por IA").textContent ?? "")).toEqual(normalizedPageFixture.data);
  expect(calls.filter((call) => call.startsWith("POST "))).toEqual([]);
});

it.each([
  ["AI_NOT_CONFIGURED", 409, "Falta la API key de NVIDIA Build. Cargala en Ajustes de IA.", true],
  ["AI_PROVIDER_INVALID_RESPONSE", 502, "NVIDIA Build devolvió una respuesta que no es JSON válido. Probá otro modelo o intentá de nuevo.", false],
] as const)("displays a clear Spanish alert when evidence normalization fails with %s", async (code, status, expectedMessage, expectsSettingsLink) => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === undefined && path === "/investigations/case") return json(withPage());
    if (init?.method === undefined && path === "/settings/decodo") return decodoStatus(true);
    if (init?.method === undefined && path === "/investigations/case/normalizations") return json({ normalizations: [] });
    if (init?.method === "POST" && path === "/investigations/case/evidence/page/normalize/queue") {
      return json({ error: code, message: "provider detail" }, status);
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${path}`);
  }));

  render(<WorkspacePage id="case" />);
  const graph = await screen.findByRole("group", { name: /grafo factual/i });
  fireEvent.click(within(graph).getByRole("button", { name: /Evidencia: page\. Decodo/ }));

  const aiSection = within(screen.getByRole("region", { name: "Resumen estructurado (asistido por IA)" }));
  await act(async () => { fireEvent.click(aiSection.getByRole("button", { name: "Normalizar con IA" })); });

  const alert = await aiSection.findByRole("alert");
  expect(alert).toHaveTextContent(expectedMessage);
  if (expectsSettingsLink) {
    expect(within(alert).getByRole("link", { name: "Ajustes de IA" })).toHaveAttribute("href", "#/ajustes");
  } else {
    expect(within(alert).queryByRole("link", { name: "Ajustes de IA" })).not.toBeInTheDocument();
  }
  expect(aiSection.getByRole("button", { name: "Normalizar con IA" })).toBeEnabled();
  expect(screen.getByRole("region", { name: "Página recopilada por Decodo" })).toBeInTheDocument();
});

function withTwoPages(): Investigation {
  const secondSeed = { kind: "url", value: "https://example.org/other" } as const;
  const secondAction: GitHubCatalogAction = {
    id: "scrape-2", spec: { catalogId: "decodo.url.v1", provider: "decodo", seed: secondSeed },
    sourceSeedId: findingSeedNodeId("other"), status: "succeeded", queuedByCatalog: true,
    proposedAt: at, completedAt: at, proposalReason: "Accepted candidate",
  };
  const secondPage: EvidenceRecord = {
    ...page,
    id: "page-2",
    actionId: secondAction.id,
    seed: secondSeed,
    finding: { ...page.finding!, target: secondSeed, url: secondSeed.value, extra: { ...page.finding!.extra, title: "Second profile" } },
  };
  const investigation = withPage();
  return {
    ...investigation,
    actions: [...investigation.actions, secondAction],
    validations: [decision("accepted", "match"), decision("accepted", "other")],
    evidence: [...investigation.evidence, secondPage],
  };
}

it("scopes the latest job failure to its node, preferring enqueue errors until a retry", async () => {
  const failed = { ...queuedPageJob, status: "failed", errorCode: "JOB_INTERRUPTED" };
  const retried = { ...queuedPageJob, id: "retry", attemptNumber: 2 };
  let posts = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === undefined && path === "/investigations/case") return json(withTwoPages());
    if (init?.method === undefined && path === "/settings/decodo") return decodoStatus(true);
    if (init?.method === undefined && path === "/investigations/case/normalizations") return json({ normalizations: [], jobs: [failed] });
    if (init?.method === "POST" && path === "/investigations/case/evidence/page/normalize/queue") {
      posts += 1;
      return posts === 1 ? json({ error: "AI_NOT_CONFIGURED", message: "Missing key" }, 409)
        : json({ job: retried, created: true }, 202);
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${path}`);
  }));

  render(<WorkspacePage id="case" />);
  const graph = await screen.findByRole("group", { name: /grafo factual/i });
  fireEvent.click(within(graph).getByRole("button", { name: /Evidencia: page\. Decodo/ }));

  const firstAiSection = within(screen.getByRole("region", { name: "Resumen estructurado (asistido por IA)" }));
  expect(await firstAiSection.findByRole("alert")).toHaveTextContent("La normalización se interrumpió al reiniciarse el servicio. Podés volver a intentarlo.");
  await act(async () => { fireEvent.click(firstAiSection.getByRole("button", { name: "Normalizar con IA" })); });
  expect(firstAiSection.getByRole("alert")).toHaveTextContent("Falta la API key de NVIDIA Build. Cargala en Ajustes de IA.");

  fireEvent.click(within(graph).getByRole("button", { name: /Evidencia: page-2\. Decodo/ }));
  const secondAiSection = within(screen.getByRole("region", { name: "Resumen estructurado (asistido por IA)" }));
  expect(secondAiSection.queryByRole("alert")).not.toBeInTheDocument();
  fireEvent.click(within(graph).getByRole("button", { name: /Evidencia: page\. Decodo/ }));
  const retrySection = within(screen.getByRole("region", { name: "Resumen estructurado (asistido por IA)" }));
  await act(async () => { fireEvent.click(retrySection.getByRole("button", { name: "Normalizar con IA" })); });
  expect(retrySection.getByRole("button", { name: "En cola para normalizar con IA" })).toBeDisabled();
  expect(retrySection.queryByRole("alert")).not.toBeInTheDocument();
  expect(posts).toBe(2);
});

it("enqueues two Decodo pages while the first request is in flight, without allowing duplicate enqueues", async () => {
  vi.useFakeTimers();
  const posts: string[] = [];
  let finishFirst!: (response: Response) => void;
  const firstEnqueue = new Promise<Response>((resolve) => { finishFirst = resolve; });
  let finishRead!: (response: Response) => void;
  const initialRead = new Promise<Response>((resolve) => { finishRead = resolve; });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === undefined && path === "/investigations/case") return json(withTwoPages());
    if (init?.method === undefined && path === "/settings/decodo") return decodoStatus(true);
    if (init?.method === undefined && path === "/investigations/case/normalizations") return initialRead;
    const match = /^\/investigations\/case\/evidence\/([^/]+)\/normalize\/queue$/u.exec(path);
    if (init?.method === "POST" && match?.[1] !== undefined) {
      const evidenceId = match[1];
      posts.push(evidenceId);
      return evidenceId === page.id ? firstEnqueue
        : json({ job: { ...queuedPageJob, id: "job-2", evidenceId }, created: true }, 202);
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${path}`);
  }));
  await act(async () => { render(<WorkspacePage id="case" />); });
  const graph = within(screen.getByRole("group", { name: /grafo factual/i }));
  const first = graph.getByRole("button", { name: /Evidencia: page\. Decodo/ });
  const second = graph.getByRole("button", { name: /Evidencia: page-2\. Decodo/ });
  const normalize = () => screen.getByRole("button", { name: "Normalizar con IA" });
  const queued = () => screen.getByRole("button", { name: "En cola para normalizar con IA" });

  fireEvent.click(first);
  fireEvent.click(normalize());
  const enqueuing = screen.getByRole("button", { name: "Encolando normalización…" });
  expect(enqueuing).toBeDisabled();
  fireEvent.click(enqueuing);
  expect(screen.getByRole("button", { name: "Obtener informe" })).toBeEnabled();
  fireEvent.click(second);
  expect(normalize()).toBeEnabled();
  await act(async () => { fireEvent.click(normalize()); });
  expect(queued()).toBeDisabled();
  fireEvent.click(queued());
  expect(posts).toEqual(["page", "page-2"]);

  await act(async () => { finishFirst(json({ job: queuedPageJob, created: true }, 202)); });
  await act(async () => { finishRead(json({ normalizations: [], jobs: [] })); });
  fireEvent.click(first);
  expect(queued()).toBeDisabled();
  fireEvent.click(second);
  expect(queued()).toBeDisabled();
  expect(posts).toEqual(["page", "page-2"]);

  fireEvent.click(screen.getByText("Cola", { exact: true }).closest("summary")!);
  const rows = within(screen.getByRole("region", { name: "Cola de ejecución" })).getAllByRole("listitem");
  expect(rows).toHaveLength(2);
  expect(within(rows[0]!).getByText("Siguiente")).toBeVisible();
  expect(within(rows[0]!).getByText("/candidate")).toBeVisible();
  expect(within(rows[1]!).getByText("En cola · #2")).toBeVisible();
  expect(within(rows[1]!).getByText("/other")).toBeVisible();
});
