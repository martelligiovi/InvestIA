import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EvidenceRecord, Investigation } from "@investia/core";
import { UsernameSeedsPanel } from "../src/components/UsernameSeedsPanel";

const at = "2025-03-16T12:00:00.000Z";
const seed = { kind: "email" as const, value: "ana@example.test" };

function evidence(id: string, provider: string, target: string, discovered?: string): EvidenceRecord {
  return {
    id, actionId: "action-1", seed, provider, status: "registered", sourceId: "user-scanner:email", recordedAt: at,
    finding: {
      target: { kind: "username", value: target }, upstreamStatus: "Found", url: "", category: "", reason: "",
      extra: discovered === undefined ? {} : { discovered_usernames: discovered }, media: {},
    },
  };
}

function investigation(overrides: Partial<Investigation> = {}): Investigation {
  return {
    id: "case-1", name: "Caso", revision: 3, createdAt: at, updatedAt: at, paused: false,
    emailSeeds: [seed], actions: [], validations: [], audit: [],
    evidence: [evidence("e1", "GitHub", "anaexample", "ana-alt"), evidence("e2", "Reddit", "anaexample")],
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("UsernameSeedsPanel", () => {
  it("lists each derived proposal once with the tool that found it", () => {
    render(<UsernameSeedsPanel investigation={investigation()} disabled={false} onAdd={vi.fn()} onDecide={vi.fn()} />);
    const list = screen.getByRole("list", { name: "Usernames propuestos" });
    expect(within(list).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      expect.stringContaining("anaexample"), expect.stringContaining("ana-alt"),
    ]);
    expect(within(list).getAllByRole("listitem")[0]!.textContent).toContain("GitHub");
  });

  it("accepts or rejects a proposal only with a reason", async () => {
    const onDecide = vi.fn(async () => true);
    const user = userEvent.setup();
    render(<UsernameSeedsPanel investigation={investigation()} disabled={false} onAdd={vi.fn()} onDecide={onDecide} />);
    const accept = screen.getByRole("button", { name: "Aceptar anaexample" });
    expect(accept).toBeDisabled();
    await user.type(screen.getByLabelText("Motivo de la decisión"), "Misma persona");
    await user.click(accept);
    await user.type(screen.getByLabelText("Motivo de la decisión"), "Otra persona");
    await user.click(screen.getByRole("button", { name: "Rechazar ana-alt" }));
    expect(onDecide.mock.calls).toEqual([["anaexample", "accepted", "Misma persona"], ["ana-alt", "rejected", "Otra persona"]]);
  });

  it("adds a username manually only when it is valid and has a reason", async () => {
    const onAdd = vi.fn(async () => true);
    const user = userEvent.setup();
    render(<UsernameSeedsPanel investigation={investigation({ evidence: [] })} disabled={false} onAdd={onAdd} onDecide={vi.fn()} />);
    expect(screen.getByText("Sin usernames propuestos.")).toBeInTheDocument();
    const add = screen.getByRole("button", { name: "Agregar username" });
    await user.type(screen.getByLabelText("Username"), "--help");
    await user.type(screen.getByLabelText("Motivo del username"), "Aportado");
    expect(add).toBeDisabled();
    expect(screen.getByText(/Usá letras, números/)).toBeInTheDocument();
    await user.clear(screen.getByLabelText("Username"));
    await user.type(screen.getByLabelText("Username"), " anaexample ");
    await user.click(add);
    expect(onAdd.mock.calls).toEqual([["anaexample", "Aportado"]]);
    expect(screen.getByLabelText("Username")).toHaveValue("");
  });

  it("shows decided usernames and disables every control while the case is busy", () => {
    const decided = investigation({
      usernameSeeds: [
        { kind: "username", value: "anaexample", origin: { kind: "evidence", evidenceId: "e1" }, status: "accepted", at, reason: "Proposed from a GitHub finding.", decision: { at, reason: "Misma", operator: "local-operator" } },
        { kind: "username", value: "manual-one", origin: { kind: "operator" }, status: "accepted", at, reason: "Aportado" },
      ],
    });
    render(<UsernameSeedsPanel investigation={decided} disabled onAdd={vi.fn()} onDecide={vi.fn()} />);
    const list = screen.getByRole("list", { name: "Usernames decididos" });
    expect(within(list).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      expect.stringMatching(/anaexample.*Aceptado/), expect.stringMatching(/manual-one.*Aportado por el operador/),
    ]);
    expect(within(screen.getByRole("list", { name: "Usernames propuestos" })).getAllByRole("listitem")).toHaveLength(1);
    for (const button of screen.getAllByRole("button")) expect(button).toBeDisabled();
  });
});

describe("workspace username controls", () => {
  it("does not render a Usernames disclosure or panel even when proposals exist", async () => {
    const { WorkspacePage } = await import("../src/pages/WorkspacePage");
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(investigation()), {
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetcher);
    const { container } = render(<WorkspacePage id="case-1" />);
    await screen.findByRole("heading", { name: "Caso" });
    const header = container.querySelector<HTMLElement>(".workspace-header")!;
    expect(within(header).queryByText(/^Usernames(?: \(\d+\))?$/u, { selector: "summary" })).not.toBeInTheDocument();
    expect(container.querySelector(".workspace-usernames-disclosure, .username-seeds-panel")).not.toBeInTheDocument();
    expect(fetcher.mock.calls.map(([input, init]) => `${init?.method ?? "GET"} ${String(input)}`)).toEqual(["GET /investigations/case-1"]);
  });
});
