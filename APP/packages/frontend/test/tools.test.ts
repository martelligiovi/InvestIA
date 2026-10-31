import { describe, expect, it } from "vitest";
import { createInitialInvestigation, type GitHubCatalogAction, type Investigation } from "@investia/core";
import { actionTitle, evidenceHeading } from "../src/pages/workspace-model";
import { actionDisplayState, hasCatalogAuthorization } from "../src/pages/workspace-status";

const seed = { kind: "email", value: "ana@example.test" } as const;
const at = "2025-01-01T00:00:00.000Z";

function action(spec: GitHubCatalogAction["spec"]): GitHubCatalogAction {
  return { id: spec.catalogId, spec, status: "queued", queuedByCatalog: true, proposedAt: at, proposalReason: "Catalog queue" };
}

const scanner = action({ catalogId: "user-scanner.email.v1", provider: "user-scanner", seed });
const gravatar = action({ catalogId: "gravatar.email.v1", provider: "gravatar", seed });

function withGrant(scopes: Investigation["authorization"]): Investigation {
  return { ...createInitialInvestigation("case", at), actions: [scanner, gravatar], authorization: scopes };
}

describe("tool-aware workspace labels", () => {
  it("titles each catalog action by its tool", () => {
    expect(actionTitle(scanner)).toBe("Búsqueda de email y enlaces con user-scanner");
    expect(actionTitle(gravatar)).toBe("Perfil público de Gravatar");
    expect(actionTitle(action({ catalogId: "github.email-registration.v1", provider: "github", seed }))).toBe("Comprobación de registro en GitHub");
  });

  it("names the tool that produced a finding", () => {
    const finding = { target: seed, upstreamStatus: "Found", url: "", category: "", reason: "", extra: {}, media: {} } as const;
    const base = { id: "e", actionId: "a", seed, provider: "GitHub", status: "registered", recordedAt: at } as const;
    expect(evidenceHeading({ ...base, sourceId: "gravatar:email", finding })).toBe("Hallazgo de Gravatar");
    expect(evidenceHeading({ ...base, sourceId: "user-scanner:email", finding })).toBe("Hallazgo de user-scanner");
    expect(evidenceHeading({ ...base, sourceId: "github-seed-box" })).toBe("Observación de registro");
  });
});

describe("per-tool consent in the workspace", () => {
  const grant = { granted: true, at, reason: "Consent", operator: "local-operator" } as const;

  it("a user-scanner-only grant leaves Gravatar waiting for authorization", () => {
    const investigation = withGrant({ ...grant, catalogScope: "user-scanner.email.v1" });
    expect(actionDisplayState(investigation, scanner)).toBe("queued");
    expect(actionDisplayState(investigation, gravatar)).toBe("waiting_authorization");
    expect(hasCatalogAuthorization(investigation)).toBe(false);
  });

  it("a grant naming both tools enables the whole queue", () => {
    const investigation = withGrant({ ...grant, catalogScopes: ["user-scanner.email.v1", "gravatar.email.v1"] });
    expect(actionDisplayState(investigation, gravatar)).toBe("queued");
    expect(hasCatalogAuthorization(investigation)).toBe(true);
  });
});
