import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { EvidenceRecord, Investigation } from "@investia/core";
import { buildWorkspaceGraph, evidenceHeading, actionTitle } from "../src/pages/workspace-model";
import { WorkspaceDetails } from "../src/components/WorkspaceDetails";

const at = "2025-01-01T00:00:00Z";
const gmail = { kind: "email" as const, value: "ana@gmail.com" };
const PHOTO = "https://lh3.googleusercontent.com/a-/ALV-ana";
const photo = { kind: "photo" as const, value: PHOTO };
const THUMB = "data:image/webp;base64,UklGRhYAAABXRUJQ";

function candidate(id: string, score: number, extra: Record<string, string | number | boolean> = {}, thumbnail = THUMB): EvidenceRecord {
  return { id, actionId: "facecheck", seed: photo, provider: "FaceCheck", status: "registered", sourceId: "facecheck:photo", recordedAt: at,
    finding: { target: photo, upstreamStatus: "Found", url: `https://example.org/${id}`, category: "Face match", reason: "",
      extra: { source: "facecheck", score, testing_mode: true, ...extra }, media: { thumbnail } } };
}

function investigation(evidence: EvidenceRecord[] = [candidate("c1", 91), candidate("c2", 80, { testing_mode: false })]): Investigation {
  return {
    id: "case", revision: 1, createdAt: at, updatedAt: at, paused: false, emailSeeds: [gmail], validations: [], audit: [],
    actions: [
      { id: "ghunt", spec: { catalogId: "ghunt.email.v1", provider: "ghunt", seed: gmail }, status: "succeeded", queuedByCatalog: true, proposedAt: at, proposalReason: "Test" },
      { id: "facecheck", spec: { catalogId: "facecheck.photo.v1", provider: "facecheck", seed: photo }, sourceSeedId: "seed:evidence:photo",
        status: "succeeded", queuedByCatalog: true, proposedAt: at, proposalReason: "Test" },
    ],
    evidence: [
      { id: "photo", actionId: "ghunt", seed: gmail, provider: "GHunt", status: "registered", sourceId: "ghunt:email", recordedAt: at,
        finding: { target: gmail, upstreamStatus: "Found", url: PHOTO, category: "Profile photo", reason: "", extra: { source: "ghunt" }, media: { avatar: PHOTO } } },
      ...evidence,
    ],
  };
}

afterEach(() => cleanup());

it("stacks FaceCheck candidates under the face search fed by the GHunt profile photo", () => {
  const snapshot = investigation();
  const original = JSON.stringify(snapshot);
  const graph = buildWorkspaceGraph(snapshot);
  expect(actionTitle(snapshot.actions[1]!)).toBe("Búsqueda facial con FaceCheck");
  const group = graph.nodes.find((node) => node.id === "leaf-group:facecheck")!;
  expect(group.members?.map((member) => member.title)).toEqual(["FaceCheck · 91 · example.org", "FaceCheck · 80 · example.org"]);
  expect(graph.edges.some((edge) => edge.from === "evidence:photo" && edge.to === "action:facecheck")).toBe(true);
  expect(evidenceHeading(snapshot.evidence[1]!)).toBe("Candidato de FaceCheck");
  expect(JSON.stringify(snapshot)).toBe(original);
});

it("shows the thumbnail, source page, score and testing mode, and asks the operator to decide", async () => {
  const snapshot = investigation();
  const node = buildWorkspaceGraph(snapshot).nodes.find((item) => item.id === "leaf-group:facecheck")!.members![0]!;
  const onValidate = vi.fn();
  render(<WorkspaceDetails investigation={snapshot} node={node} disabled={false} onValidate={onValidate} />);
  expect(screen.getByRole("img", { name: /Cara encontrada por FaceCheck/ })).toHaveAttribute("src", THUMB);
  expect(screen.getByRole("link", { name: "https://example.org/c1" })).toHaveAttribute("href", "https://example.org/c1");
  expect(screen.getByText("Foto")).toBeInTheDocument();
  expect(screen.getByText("91")).toBeInTheDocument();
  expect(screen.getByText(/modo prueba/i)).toBeInTheDocument();
  expect(screen.getByText(/candidato.*confirmes o rechaces/i)).toBeInTheDocument();
  expect(document.body).not.toHaveTextContent("UklGRhYAAABXRUJQ");
  expect(screen.getByRole("button", { name: "Aceptar observación" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Rechazar observación" })).toBeInTheDocument();
});

it("never puts an unexpected thumbnail value in an image source", () => {
  const snapshot = investigation([candidate("c1", 91, {}, "https://tracker.example/pixel.png")]);
  const node = buildWorkspaceGraph(snapshot).nodes.find((item) => item.id === "leaf-group:facecheck")?.members?.[0]
    ?? buildWorkspaceGraph(snapshot).nodes.find((item) => item.id === "evidence:c1")!;
  render(<WorkspaceDetails investigation={snapshot} node={node} disabled={false} onValidate={vi.fn()} />);
  expect(screen.queryByRole("img")).toBeNull();
  expect(screen.getByText("https://tracker.example/pixel.png")).toBeInTheDocument();
  expect(screen.queryByText(/modo prueba/i)).toBeInTheDocument();
});
