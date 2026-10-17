import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { findingSeedNodeId, type Investigation } from "@investia/core";
import { buildWorkspaceGraph, workspaceGraphPage } from "../src/pages/workspace-model";
import { InvestigationGraph } from "../src/components/InvestigationGraph";
import { WorkspaceDetails } from "../src/components/WorkspaceDetails";

const at = "2025-01-01T00:00:00Z";
const email = { kind: "email" as const, value: "root@example.test" };
function snapshot(count = 7): Investigation {
  return {
    id: "case", revision: 1, createdAt: at, updatedAt: at, paused: false,
    emailSeeds: [email],
    actions: [{ id: "scan", spec: { catalogId: "user-scanner.email.v1", provider: "user-scanner", seed: email },
      status: "succeeded", queuedByCatalog: true, proposedAt: at, proposalReason: "Test" }],
    evidence: Array.from({ length: count }, (_, i) => ({ id: `e${i}`, actionId: "scan", seed: email,
      provider: `Provider ${i}`, status: "registered", sourceId: "mock", recordedAt: at })),
    validations: [], audit: [],
  };
}
afterEach(cleanup);

it("collapses seven sibling leaves into one group and one outgoing edge without changing data", () => {
  const investigation = snapshot();
  const before = JSON.stringify(investigation);
  const graph = buildWorkspaceGraph(investigation);
  const groups = graph.nodes.filter((node) => node.kind === "leaf-group");
  expect(groups).toHaveLength(1);
  expect(groups[0]?.members?.map((member) => member.evidence?.id)).toEqual(investigation.evidence.map((e) => e.id));
  expect(graph.nodes.filter((node) => node.kind === "evidence")).toHaveLength(0);
  expect(graph.edges.filter((edge) => edge.from === "action:scan")).toEqual([
    expect.objectContaining({ to: "leaf-group:scan" }),
  ]);
  expect(graph.height).toBeLessThan(500);
  expect(JSON.stringify(investigation)).toBe(before);
});

it("keeps leaves of separate producing actions in separate groups", () => {
  const base = snapshot(2);
  const graph = buildWorkspaceGraph({ ...base,
    actions: [...base.actions, { ...base.actions[0]!, id: "other" }],
    evidence: [...base.evidence, ...base.evidence.map((e) => ({ ...e, id: `${e.id}-other`, actionId: "other" }))],
  });
  expect(graph.nodes.filter((node) => node.kind === "leaf-group").map((node) => node.id)).toEqual(["leaf-group:scan", "leaf-group:other"]);
  expect(graph.edges).toContainEqual(expect.objectContaining({ from: "action:other", to: "leaf-group:other" }));
});

it("preserves single-leaf evidence nodes and standalone missing-parent records", () => {
  const base = snapshot(1);
  expect(buildWorkspaceGraph(base).nodes.find((node) => node.id === "evidence:e0")?.kind).toBe("evidence");
  const graph = buildWorkspaceGraph({ ...base, evidence: [{ ...base.evidence[0]!, actionId: "missing" }] });
  expect(graph.nodes.some((node) => node.id === "evidence:e0")).toBe(true);
  expect(graph.edges.some((edge) => edge.to === "evidence:e0")).toBe(false);
});

it("keeps explicit branches separate and lays out downstream actions after their seed", () => {
  const base = snapshot();
  const graph = buildWorkspaceGraph({ ...base, actions: [...base.actions,
    { ...base.actions[0]!, id: "follow-up", sourceSeedId: findingSeedNodeId("e0"), status: "queued" }],
  });
  const branch = graph.nodes.find((node) => node.id === "evidence:e0")!;
  const action = graph.nodes.find((node) => node.id === "action:follow-up")!;
  expect(branch).toBeDefined();
  expect(action.x).toBeGreaterThan(branch.x);
  expect(graph.width).toBeGreaterThan(action.x + action.width);
  expect(graph.edges).toContainEqual(expect.objectContaining({ from: branch.id, to: action.id }));
  expect(graph.nodes.find((node) => node.id === "leaf-group:scan")?.members).toHaveLength(6);
});

it.each([2, 2722])("draws exactly two decorative sheets for %i results, with keyboard selection", (count) => {
  const graph = buildWorkspaceGraph(snapshot(count));
  const group = graph.nodes.find((node) => node.kind === "leaf-group")!;
  const select = vi.fn();
  render(<InvestigationGraph graph={graph} selectedId="evidence:e0" onSelect={select} />);
  const card = document.querySelector("g.graph-node--leaf-group")!;
  expect(card).toHaveAttribute("aria-pressed", "true");
  expect(card.querySelectorAll(".graph-stack-sheet[aria-hidden='true']")).toHaveLength(2);
  fireEvent.keyDown(card, { key: "Enter" });
  fireEvent.keyDown(card, { key: " " });
  expect(select).toHaveBeenNthCalledWith(1, group);
  expect(select).toHaveBeenNthCalledWith(2, group);
});

it("pages group details at 50 and opens individual evidence with human validation", () => {
  const investigation = snapshot(122);
  const group = buildWorkspaceGraph(investigation).nodes.find((node) => node.kind === "leaf-group")!;
  const select = vi.fn();
  const props = { investigation, disabled: false, onValidate: vi.fn(), onSelectNode: select };
  const view = render(<WorkspaceDetails {...props} node={group} />);
  expect(screen.getAllByRole("button", { name: /^Ver resultado:/ })).toHaveLength(50);
  fireEvent.click(screen.getByRole("button", { name: "Siguiente página del grupo" }));
  fireEvent.click(screen.getByRole("button", { name: "Siguiente página del grupo" }));
  expect(screen.getAllByRole("button", { name: /^Ver resultado:/ })).toHaveLength(22);
  fireEvent.click(screen.getAllByRole("button", { name: /^Ver resultado:/ }).at(-1)!);
  expect(select).toHaveBeenLastCalledWith("evidence:e121");
  view.rerender(<WorkspaceDetails {...props} node={group.members!.at(-1)!} />);
  expect(screen.getByText("Provider 121", { exact: true })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Aceptar observación" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Volver al grupo" }));
  expect(select).toHaveBeenLastCalledWith(group.id);
});

it("preserves every branch input edge while paging unrelated terminal evidence", () => {
  const base = snapshot(51);
  const full = buildWorkspaceGraph({ ...base,
    actions: [...base.actions, ...base.evidence.map((e, i) => ({ ...base.actions[0]!, id: `follow-${i}`,
      sourceSeedId: findingSeedNodeId(e.id), status: "queued" as const }))],
    evidence: [...base.evidence, ...base.evidence.map((e) => ({ ...e, id: `orphan-${e.id}`, actionId: "unrecorded" }))],
  });
  const original = JSON.stringify(full);
  const seen: string[] = [];
  for (let page = 0; page < 2; page++) {
    const projected = workspaceGraphPage(full, page);
    for (let i = 0; i < 51; i++) {
      expect(projected.nodes.some((n) => n.id === `evidence:e${i}`)).toBe(true);
      expect(projected.edges).toContainEqual(expect.objectContaining({ from: `evidence:e${i}`, to: `action:follow-${i}` }));
    }
    const terminal = projected.nodes.filter((n) => n.evidence?.actionId === "unrecorded");
    expect(terminal).toHaveLength(page === 0 ? 50 : 1);
    seen.push(...terminal.map((n) => n.id));
    const ids = new Set(projected.nodes.map((n) => n.id));
    expect(projected.edges.every((edge) => ids.has(edge.from) && ids.has(edge.to))).toBe(true);
  }
  expect(new Set(seen).size).toBe(51);
  expect(JSON.stringify(full)).toBe(original);
  render(<InvestigationGraph graph={full} selectedId={null} onSelect={vi.fn()} />);
  expect(screen.getByText("Resultados 1–50 de 51")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Siguiente página de resultados" }));
  expect(screen.getByText("Resultados 51–51 de 51")).toBeInTheDocument();
});
