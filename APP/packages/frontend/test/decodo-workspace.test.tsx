import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { findingSeedNodeId, type EvidenceRecord, type GitHubCatalogAction, type Investigation, type ValidationDecision } from "@investia/core";
import { WorkspaceDetails } from "../src/components/WorkspaceDetails";
import { buildWorkspaceGraph } from "../src/pages/workspace-model";
import { WorkspacePage } from "../src/pages/WorkspacePage";

const at = "2025-01-01T00:00:00Z";
const pageSeed = { kind: "url", value: "https://example.org/candidate" } as const;
const photo = { kind: "photo", value: "https://lh3.googleusercontent.com/a-/fixture" } as const;
const decodo: GitHubCatalogAction = {
  id: "scrape", spec: { catalogId: "decodo.url.v1", provider: "decodo", seed: pageSeed },
  sourceSeedId: findingSeedNodeId("match"), status: "queued", queuedByCatalog: true, proposedAt: at, proposalReason: "Accepted candidate",
};
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

function decision(status: ValidationDecision["status"]): ValidationDecision {
  return { id: `decision-${status}`, evidenceId: "match", status, reason: "Reviewed", at, operator: "local-operator" };
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

function json(value: unknown) {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
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
  installWorkspaceApi(snapshot({ authorization: { ...authorization, catalogScopes: ["facecheck.photo.v1"] },
    validations: [decision("accepted"), decision("rejected")] }), () => decodoStatus(false));
  render(<WorkspacePage id="case" />);
  const graph = await screen.findByRole("group", { name: /grafo factual/i });
  fireEvent.click(within(graph).getByRole("button", { name: /Acción: scrape\./i }));
  const detail = within(screen.getByRole("complementary"));
  expect(detail.getByRole("link", { name: pageSeed.value })).toHaveAttribute("rel", "noopener noreferrer");
  expect(detail.getByText(/renovar la autorización.*Decodo/i)).toBeInTheDocument();
  expect(detail.getByText(/FaceCheck.*ya no está aceptada/i)).toBeInTheDocument();
  expect(await detail.findByRole("link", { name: "Configurar Decodo" })).toHaveAttribute("href", "#/ajustes");
});

it.each([
  ["the token is missing", snapshot(), false],
  ["the old grant does not cover Decodo", snapshot({ authorization: { ...authorization, catalogScopes: ["facecheck.photo.v1"] } }), true],
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

it("polls eligible automatic Decodo work only after confirming configuration, without dispatching from the browser", async () => {
  vi.useFakeTimers();
  let resolveSettings!: (response: Response) => void;
  const pendingSettings = new Promise<Response>((resolve) => { resolveSettings = resolve; });
  const calls = installWorkspaceApi(snapshot(), () => pendingSettings);
  await act(async () => { render(<WorkspacePage id="case" />); });
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(calls.filter((call) => call === "GET /investigations/case")).toHaveLength(1);

  await act(async () => { resolveSettings(decodoStatus(true)); });
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  expect(calls.filter((call) => call === "GET /investigations/case")).toHaveLength(2);
  expect(calls).toContain("GET /settings/decodo");
  expect(calls.every((call) => call.startsWith("GET "))).toBe(true);
});
