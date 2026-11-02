import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Investigation } from "@investia/core";
import { buildWorkspaceGraph, workspaceGraphPage } from "../src/pages/workspace-model";
import { WorkspaceDetails } from "../src/components/WorkspaceDetails";

const at = "2025-01-01T00:00:00Z";
const seed = { kind: "email" as const, value: "root@example.test" };
function snapshot(): Investigation {
  return {
    id: "case", revision: 1, createdAt: at, updatedAt: at, paused: false,
    emailSeeds: [seed], validations: [], audit: [],
    actions: ["scan", "gravatar"].map((id) => ({ id,
      spec: id === "scan"
        ? { catalogId: "user-scanner.email.v1" as const, provider: "user-scanner" as const, seed }
        : { catalogId: "gravatar.email.v1" as const, provider: "gravatar" as const, seed },
      status: "succeeded" as const, proposedAt: at, proposalReason: "Test", queuedByCatalog: true,
    })),
    evidence: [0, 1].map((i) => ({ id: `scan-${i}`, actionId: "scan", seed, provider: "Example",
      status: "registered" as const, sourceId: "user-scanner:email", recordedAt: at })),
  };
}
function profile() {
  return { id: "profile", actionId: "gravatar", seed, provider: "Gravatar",
    status: "registered" as const, sourceId: "gravatar:email", recordedAt: at,
    finding: { target: seed, upstreamStatus: "Found" as const, reason: "", category: "Profile",
      url: "https://gravatar.com/example", extra: { display_name: "Example Name", location: "Argentina",
        description: "Public bio", job_title: "Developer", company: "Example Ltd", pronouns: "they/them",
        username: "example", source: "gravatar public profile" },
      media: { avatar: "https://example.test/avatar.jpg" } },
  };
}
afterEach(cleanup);

it.each([false, true])("aligns each action with its own outputs regardless of evidence order (%s)", (reverse) => {
  const base = snapshot();
  const evidence = [...base.evidence, { ...base.evidence[0]!, id: "single", actionId: "gravatar" }];
  const graph = buildWorkspaceGraph({ ...base, evidence: reverse ? evidence.reverse() : evidence });
  for (const action of base.actions) {
    const node = graph.nodes.find((n) => n.id === `action:${action.id}`)!;
    const edges = graph.edges.filter((e) => e.from === node.id);
    expect(edges).toHaveLength(1);
    const output = graph.nodes.find((n) => n.id === edges[0]!.to)!;
    expect(output.y).toBe(node.y);
    expect(output.members?.every((m) => m.evidence?.actionId === action.id) ?? output.evidence?.actionId === action.id).toBe(true);
  }
  expect(graph.edges.some((e) => e.from.startsWith("evidence:") || e.from.startsWith("leaf-group:"))).toBe(false);
});

it("turns every available Gravatar profile value into a distinct seed without mutating evidence", () => {
  const base = snapshot();
  const investigation = { ...base, evidence: [...base.evidence, profile()] };
  const before = JSON.stringify(investigation);
  const graph = buildWorkspaceGraph(investigation);
  const group = graph.nodes.find((n) => n.id === "leaf-group:gravatar")!;
  expect(group).toBeDefined();
  expect(group.members?.map((n) => n.seedValue)).toEqual([
    "Example Name", "example", "Argentina", "Public bio", "Developer", "Example Ltd", "they/them",
    "https://gravatar.com/example", "https://example.test/avatar.jpg",
  ]);
  expect(new Set(group.members?.map((n) => n.id)).size).toBe(9);
  expect(group.members?.every((n) => n.evidence?.id === "profile")).toBe(true);
  const selected = group.members![0]!;
  render(<WorkspaceDetails investigation={investigation} node={selected} disabled={false} onValidate={vi.fn()} />);
  expect(screen.getByRole("heading", { name: "Nombre mostrado" })).toBeInTheDocument();
  expect(screen.getAllByText("Example Name").length).toBeGreaterThan(0);
  expect(screen.getByText(/no ejecuta nuevas búsquedas/i)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Aceptar observación" })).toBeInTheDocument();
  expect(JSON.stringify(investigation)).toBe(before);
});

it("keeps old profiles useful, skips empty values and separates linked-account URLs", () => {
  const base = snapshot();
  const p = profile();
  const investigation: Investigation = { ...base, evidence: [
    { ...p, finding: { ...p.finding, extra: { display_name: "Example Name", location: " " }, media: {} } },
    { ...p, id: "linked", provider: "Example Social", finding: { ...p.finding, category: "Linked account",
      url: "https://social.test/example", extra: { source: "gravatar verified account" }, media: {} } },
  ] };
  const group = buildWorkspaceGraph(investigation).nodes.find((n) => n.id === "leaf-group:gravatar")!;
  expect(group.members?.map((n) => n.seedValue)).toEqual([
    "Example Name", "https://gravatar.com/example", "https://social.test/example",
  ]);
});

it("preserves branch alignment when terminal results require pagination", () => {
  const base = snapshot();
  const evidence = [...base.evidence, ...Array.from({ length: 51 }, (_, i) => ({
    ...base.evidence[0]!, id: `orphan-${i}`, actionId: "missing",
  })), { ...base.evidence[0]!, id: "single", actionId: "gravatar" }];
  const graph = workspaceGraphPage(buildWorkspaceGraph({ ...base, evidence }), 1);
  for (const id of ["scan", "gravatar"]) {
    const action = graph.nodes.find((n) => n.id === `action:${id}`)!;
    const edge = graph.edges.find((e) => e.from === action.id)!;
    expect(graph.nodes.find((n) => n.id === edge.to)?.y).toBe(action.y);
  }
});
