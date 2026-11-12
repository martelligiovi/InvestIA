import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { EvidenceRecord, Investigation, ValidationDecision } from "@investia/core";
import { FacecheckReview, siteName } from "../src/components/FacecheckReview";
import { WorkspaceDetails } from "../src/components/WorkspaceDetails";
import { buildWorkspaceGraph } from "../src/pages/workspace-model";

const at = "2025-01-01T00:00:00Z";
const gmail = { kind: "email" as const, value: "ana@gmail.com" };
const PHOTO = "https://lh3.googleusercontent.com/a-/ALV-ana";
const photo = { kind: "photo" as const, value: PHOTO };
const THUMB = "data:image/webp;base64,UklGRhYAAABXRUJQ";

function candidate(id: string, score: number, url: string, testing = false, thumbnail = THUMB): EvidenceRecord {
  return { id, actionId: "facecheck", seed: photo, provider: "FaceCheck", status: "registered", sourceId: "facecheck:photo", recordedAt: at,
    finding: { target: photo, upstreamStatus: "Found", url, category: "Face match", reason: "",
      extra: { source: "facecheck", score, group: 0, testing_mode: testing }, media: { thumbnail } } };
}

function decision(evidenceId: string, status: ValidationDecision["status"], n: number): ValidationDecision {
  return { id: `v${n}`, evidenceId, status, reason: "test", at: `2025-01-01T00:0${n}:00Z`, operator: "local-operator" };
}

const CANDIDATES = [
  candidate("ig", 83, "https://www.instagram.com/ana_m/", true),
  candidate("gh", 92, "https://github.com/anam"),
  candidate("li", 90, "https://ar.linkedin.com/in/anam"),
];

function investigation(validations: ValidationDecision[] = [], evidence: EvidenceRecord[] = CANDIDATES): Investigation {
  return {
    id: "case", revision: 1, createdAt: at, updatedAt: at, paused: false, emailSeeds: [gmail], validations, audit: [],
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
  } as Investigation;
}

function review(snapshot: Investigation, onDecide = vi.fn(async () => true), disabled = false) {
  const onClose = vi.fn();
  const view = render(<FacecheckReview investigation={snapshot} actionId="facecheck" disabled={disabled} onDecide={onDecide} onClose={onClose} />);
  return { onDecide, onClose, view };
}

afterEach(() => cleanup());

it("names the site of a candidate link", () => {
  expect(siteName("https://www.instagram.com/ana_m/")).toBe("Instagram");
  expect(siteName("https://ar.linkedin.com/in/anam")).toBe("LinkedIn");
  expect(siteName("https://m.facebook.com/people/x")).toBe("Facebook");
  expect(siteName("https://x.com/ana")).toBe("X (Twitter)");
  expect(siteName("https://southwestjailva.mugshots.zone/a")).toBe("southwestjailva.mugshots.zone");
  expect(siteName("not a url")).toBe("Sitio desconocido");
});

it("shows the best unreviewed candidate first as a card with photo, site, score and link, and no reason field", () => {
  review(investigation());
  const card = screen.getByRole("article", { name: /Candidato 1 de 3/ });
  expect(within(card).getByRole("img", { name: /Cara encontrada por FaceCheck en GitHub/ })).toHaveAttribute("src", THUMB);
  expect(within(card).getByRole("heading", { name: "GitHub" })).toBeInTheDocument();
  expect(within(card).getByText("92")).toBeInTheDocument();
  expect(within(card).getByRole("link", { name: /Abrir la página/ })).toHaveAttribute("href", "https://github.com/anam");
  expect(within(card).getByRole("link", { name: /Abrir la página/ })).toHaveAttribute("rel", "noopener noreferrer");
  expect(screen.getByText("3 por revisar")).toBeInTheDocument();
  expect(screen.queryByRole("textbox")).toBeNull();
});

it("accepts and discards with the buttons and the arrow keys, with an automatic reason", async () => {
  const { onDecide } = review(investigation());
  fireEvent.click(screen.getByRole("button", { name: /^Aceptar/ }));
  expect(onDecide).toHaveBeenLastCalledWith("gh", "accepted", "Revisión de FaceCheck: es la persona buscada.");
  fireEvent.click(screen.getByRole("button", { name: /^Descartar/ }));
  expect(onDecide).toHaveBeenLastCalledWith("gh", "rejected", "Revisión de FaceCheck: no es la persona buscada.");
  const dialog = screen.getByRole("dialog", { name: /Revisar candidatos de FaceCheck/ });
  fireEvent.keyDown(dialog, { key: "ArrowRight" });
  expect(onDecide).toHaveBeenLastCalledWith("gh", "accepted", expect.any(String));
  fireEvent.keyDown(dialog, { key: "ArrowLeft" });
  expect(onDecide).toHaveBeenLastCalledWith("gh", "rejected", expect.any(String));
  expect(onDecide).toHaveBeenCalledTimes(4);
});

it("moves to the next candidate once a decision is stored, and can go back to change it", () => {
  const { view, onDecide } = review(investigation());
  expect(screen.getByRole("button", { name: /Volver al anterior/ })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: /^Descartar/ }));
  expect(onDecide).toHaveBeenCalledWith("gh", "rejected", expect.any(String));
  view.rerender(<FacecheckReview investigation={investigation([decision("gh", "rejected", 1)])} actionId="facecheck" disabled={false} onDecide={vi.fn()} onClose={vi.fn()} />);
  expect(screen.getByRole("article", { name: /Candidato 2 de 3/ })).toHaveTextContent("LinkedIn");
  expect(screen.getByText("2 por revisar")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /Volver al anterior/ }));
  const card = screen.getByRole("article", { name: /GitHub/ });
  expect(card).toHaveTextContent("Descartado");
});

it("skips a candidate without deciding it", () => {
  const { onDecide } = review(investigation());
  fireEvent.click(screen.getByRole("button", { name: /Saltar/ }));
  expect(onDecide).not.toHaveBeenCalled();
  expect(screen.getByRole("article", { name: /Candidato 2 de 3/ })).toHaveTextContent("LinkedIn");
});

it("lists discarded candidates by their latest decision and lets the operator restore one", () => {
  const snapshot = investigation([decision("gh", "rejected", 1), decision("li", "rejected", 2), decision("li", "accepted", 3)]);
  const { onDecide } = review(snapshot);
  fireEvent.click(screen.getByRole("tab", { name: /Descartados \(1\)/ }));
  const list = screen.getByRole("list", { name: "Descartados" });
  expect(within(list).getAllByRole("listitem")).toHaveLength(1);
  expect(list).toHaveTextContent("GitHub");
  fireEvent.click(within(list).getByRole("button", { name: /Mover a aceptados/ }));
  expect(onDecide).toHaveBeenCalledWith("gh", "accepted", "Revisión de FaceCheck: es la persona buscada.");
  fireEvent.click(screen.getByRole("tab", { name: /Aceptados \(1\)/ }));
  expect(screen.getByRole("list", { name: "Aceptados" })).toHaveTextContent("LinkedIn");
});

it("says when every candidate is reviewed and that only accepted ones go to the report", () => {
  review(investigation([decision("gh", "accepted", 1), decision("li", "rejected", 2), decision("ig", "rejected", 3)]));
  expect(screen.getByRole("status")).toHaveTextContent("Revisaste los 3 candidatos");
  expect(screen.getByRole("status")).toHaveTextContent("1 aceptado");
  expect(screen.getByRole("status")).toHaveTextContent("2 descartados");
  expect(screen.getByText(/Solo los aceptados entran en el informe/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^Aceptar/ })).toBeNull();
});

it("treats an inconclusive candidate as still to review and marks testing-mode results", () => {
  review(investigation([decision("gh", "accepted", 1), decision("li", "inconclusive", 2), decision("ig", "rejected", 3)]));
  expect(screen.getByRole("article", { name: /Candidato/ })).toHaveTextContent("LinkedIn");
  review(investigation([decision("gh", "accepted", 1), decision("li", "accepted", 2)]));
  expect(screen.getAllByText(/modo prueba/i).length).toBeGreaterThan(0);
});

it("loads the Google profile photo only after the operator asks to compare", () => {
  review(investigation());
  expect(screen.queryByRole("img", { name: /Foto de perfil de Google/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Mostrar foto de perfil/ }));
  const reference = screen.getByRole("img", { name: /Foto de perfil de Google/ });
  expect(reference).toHaveAttribute("src", PHOTO);
  expect(reference).toHaveAttribute("referrerpolicy", "no-referrer");
});

it("never loads an unexpected thumbnail or links an unsafe page", () => {
  review(investigation([], [candidate("bad", 95, "javascript:alert(1)", false, "https://tracker.example/pixel.png")]));
  const card = screen.getByRole("article", { name: /Candidato 1 de 1/ });
  expect(within(card).queryByRole("img")).toBeNull();
  expect(within(card).queryByRole("link")).toBeNull();
});

it("disables decisions while a change is being saved and closes with Escape", () => {
  const { onDecide, onClose } = review(investigation(), vi.fn(async () => true), true);
  expect(screen.getByRole("button", { name: /^Aceptar/ })).toBeDisabled();
  const dialog = screen.getByRole("dialog");
  fireEvent.keyDown(dialog, { key: "ArrowRight" });
  expect(onDecide).not.toHaveBeenCalled();
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(onClose).toHaveBeenCalled();
});

it("does not move through the deck while a decision is being saved", () => {
  const snapshot = investigation();
  const { view } = review(snapshot);
  fireEvent.click(screen.getByRole("button", { name: /^Aceptar/ }));
  view.rerender(<FacecheckReview investigation={snapshot} actionId="facecheck" disabled onDecide={vi.fn()} onClose={vi.fn()} />);
  const dialog = screen.getByRole("dialog");
  fireEvent.keyDown(dialog, { key: "ArrowDown" });
  fireEvent.keyDown(dialog, { key: "z" });
  expect(screen.getByRole("article", { name: /Candidato 1 de 3/ })).toHaveTextContent("GitHub");
  expect(screen.getByRole("button", { name: /Saltar/ })).toBeDisabled();
  expect(screen.getByRole("button", { name: /Volver al anterior/ })).toBeDisabled();
});

it("offers the card review from the FaceCheck candidate group and from a single candidate", () => {
  const snapshot = investigation([decision("gh", "accepted", 1)]);
  const graph = buildWorkspaceGraph(snapshot);
  const group = graph.nodes.find((node) => node.id === "leaf-group:facecheck")!;
  expect(group.title).toBe("3 candidatos de FaceCheck");
  const onReview = vi.fn();
  render(<WorkspaceDetails investigation={snapshot} node={group} disabled={false} onValidate={vi.fn()} onReviewFacecheck={onReview} />);
  fireEvent.click(screen.getByRole("button", { name: /Revisar candidatos · 2 por revisar/ }));
  expect(onReview).toHaveBeenCalledWith("facecheck");
  cleanup();
  render(<WorkspaceDetails investigation={snapshot} node={group.members![0]!} disabled={false} onValidate={vi.fn()} onReviewFacecheck={onReview} />);
  expect(screen.getByRole("button", { name: /Revisar candidatos/ })).toBeInTheDocument();
});
