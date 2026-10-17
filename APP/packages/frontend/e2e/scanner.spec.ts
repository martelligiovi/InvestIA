import { expect, test } from "@playwright/test";
import type { Investigation } from "@investia/core";

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`scanner findings display safely at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const at = "2025-01-01T00:00:00Z";
    const seed = { kind: "email" as const, value: "seed@example.org" };
    const state: Investigation = {
      id: "scanner-browser", name: "Scanner findings", revision: 1, createdAt: at, updatedAt: at, paused: true,
      emailSeeds: [seed], actions: [{ id: "scan", spec: { catalogId: "user-scanner.email.v1", provider: "user-scanner", seed }, status: "succeeded", proposedAt: at, proposalReason: "Offline fixture" }],
      evidence: [{ id: "scanner-evidence", actionId: "scan", seed, provider: "Example", status: "registered", sourceId: "user-scanner:email", recordedAt: at,
        finding: { target: { kind: "email", value: "derived@example.org" }, upstreamStatus: "Registered", url: "javascript:alert(1)", category: "Social", reason: "Offline fixture", extra: { pivot_source: "profile link", confidence: "candidate", bio: "<script>unsafe</script>" }, media: { avatar: "https://example.org/avatar" } } }],
      validations: [], audit: [],
    };
    const external: string[] = [];
    const mutations: string[] = [];
    await page.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== "http://127.0.0.1:4327") { external.push(request.url()); return route.abort(); }
      if (url.pathname === "/investigations/scanner-browser") {
        if (request.method() !== "GET") mutations.push(request.method());
        return route.fulfill({ json: state });
      }
      return route.continue();
    });
    await page.goto("/#/investigaciones/scanner-browser");
    await expect(page.getByRole("heading", { name: "Scanner findings" })).toBeVisible();
    const button = page.getByRole("button", { name: /^Evidencia: scanner-evidence/ }).first();
    await button.focus();
    await page.keyboard.press("Enter");
    if (viewport.width < 600) await page.getByRole("tab", { name: "Detalle" }).click();
    const panel = page.getByRole("tabpanel", { name: "Detalle" });
    await expect(panel.getByRole("heading", { name: "Hallazgo de user-scanner" })).toBeVisible();
    for (const value of ["derived@example.org", "profile link", "candidate", "javascript:alert(1)", "<script>unsafe</script>", "https://example.org/avatar"]) {
      await expect(panel.getByText(value, { exact: true })).toBeVisible();
    }
    await expect(panel.locator("a[href^='javascript:'],img,script")).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "Aceptar observación" })).toBeDisabled();
    expect(external).toEqual([]);
    expect(mutations).toEqual([]);
  });
}
