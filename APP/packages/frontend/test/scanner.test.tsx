import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Investigation } from "@investia/core";
import { buildWorkspaceGraph } from "../src/pages/workspace-model";
import { WorkspaceDetails } from "../src/components/WorkspaceDetails";
import { actionDisplayState, hasCatalogAuthorization } from "../src/pages/workspace-status";

const at = "2025-01-01T00:00:00Z";
const seed = { kind: "email" as const, value: "seed@example.org" };
const investigation: Investigation = {
  id: "case", revision: 1, createdAt: at, updatedAt: at, paused: false, emailSeeds: [seed],
  actions: [{ id: "scan", spec: { catalogId: "user-scanner.email.v1", provider: "user-scanner", seed }, status: "succeeded", proposedAt: at, proposalReason: "Authorized cross-scan" }],
  evidence: [{ id: "finding", actionId: "scan", seed, provider: "Other", status: "registered", sourceId: "user-scanner:email", recordedAt: at,
    finding: { target: { kind: "username", value: "derived-user" }, upstreamStatus: "Found", url: "https://example.org/derived", category: "Social", reason: "Observed", extra: { pivot_source: "profile link", confidence: "candidate", public_email: "derived@example.org", bio: "<script>untrusted</script>" }, media: { avatar: "https://example.org/avatar.png" } } }],
  validations: [], audit: [],
};
afterEach(cleanup);

it("labels scanner actions and discovered targets, connects and displays every finding field", () => {
  const graph = buildWorkspaceGraph(investigation);
  expect(graph.nodes.find((node) => node.kind === "action")?.title).toMatch(/user-scanner/i);
  const node = graph.nodes.find((node) => node.kind === "evidence")!;
  expect(node.title).toContain("derived-user");
  expect(graph.edges).toContainEqual(expect.objectContaining({ from: "action:scan", to: "evidence:finding" }));
  render(<WorkspaceDetails investigation={investigation} node={node} disabled={false} onValidate={vi.fn()} />);
  for (const text of ["derived-user", "derived@example.org", "profile link", "candidate", "Social", "Found", "Observed", "https://example.org/avatar.png", "<script>untrusted</script>"]) {
    expect(screen.getByText(text, { exact: true })).toBeInTheDocument();
  }
  expect(screen.getByRole("link", { name: "https://example.org/derived" })).toHaveAttribute("href", "https://example.org/derived");
  expect(document.querySelector("script,img")).toBeNull();
  expect(screen.getByRole("button", { name: /aceptar observación/i })).toBeDisabled();
});

it("legacy grants display scanner queues as blocked until scanner scope is explicit", () => {
  const authorization = { granted: true, at, reason: "Legacy consent", operator: "local-operator" as const };
  const queued = { ...investigation.actions[0]!, status: "queued" as const, queuedByCatalog: true as const };
  const current = { ...investigation, actions: [queued], authorization };
  expect(hasCatalogAuthorization(current)).toBe(false);
  expect(actionDisplayState(current, queued)).toBe("waiting_authorization");
  const renewed = { ...current, authorization: { ...authorization, catalogScope: "user-scanner.email.v1" as const } };
  expect(hasCatalogAuthorization(renewed)).toBe(true);
  expect(actionDisplayState(renewed, queued)).toBe("queued");
});

it("unsafe provider URLs remain text, never executable links", () => {
  const evidence = { ...investigation.evidence[0]!, finding: { ...investigation.evidence[0]!.finding!, url: "javascript:alert(1)" } };
  const graph = buildWorkspaceGraph({ ...investigation, evidence: [evidence] });
  render(<WorkspaceDetails investigation={investigation} node={graph.nodes.find((node) => node.kind === "evidence")!} disabled={false} onValidate={vi.fn()} />);
  expect(screen.getByText("javascript:alert(1)")).toBeInTheDocument();
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
});
