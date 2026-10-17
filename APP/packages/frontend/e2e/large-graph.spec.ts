import { expect, test } from "@playwright/test";
import type { Investigation } from "@investia/core";

for (const viewport of [{ width: 1672, height: 941 }, { width: 390, height: 844 }]) {
  test(`2722 findings remain navigable at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const at = "2025-01-01T00:00:00Z";
    const seed = { kind: "email" as const, value: "person@example.org" };
    const state: Investigation = {
      id: "large-graph", name: "Large graph", revision: 4, createdAt: at, updatedAt: at, paused: true,
      emailSeeds: [seed], actions: [{ id: "scan", spec: { catalogId: "user-scanner.email.v1", provider: "user-scanner", seed }, status: "succeeded", proposedAt: at, proposalReason: "Offline fixture" }],
      evidence: Array.from({ length: 2722 }, (_, i) => ({ id: `finding-${i}`, actionId: "scan", seed, provider: `Platform ${i}`, status: "registered" as const, sourceId: "user-scanner:email", recordedAt: at })),
      validations: [], audit: [],
    };
    const errors: string[] = [], mutations: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route("**/*", async (route) => {
      const request = route.request();
      if (new URL(request.url()).origin !== "http://127.0.0.1:4327") return route.abort();
      if (request.method() !== "GET") { mutations.push(request.method()); return route.abort(); }
      if (new URL(request.url()).pathname === "/investigations/large-graph") return route.fulfill({ json: state });
      return route.continue();
    });
    await page.goto("/#/investigaciones/large-graph");
    await expect(page.getByRole("heading", { name: "Large graph", exact: true })).toBeVisible();
    const first = page.locator(".graph-node--leaf-group");
    const rect = await first.boundingBox();
    expect(rect!.width).toBeGreaterThanOrEqual(230);
    expect(rect!.height).toBeGreaterThanOrEqual(90);
    await expect(page.locator(".graph-node--evidence")).toHaveCount(0);
    await expect(first).toHaveCount(1);
    await expect(first.locator(".graph-stack-sheet[aria-hidden='true']")).toHaveCount(2);
    await page.locator(".graph-node-list summary").click();
    await page.locator(".graph-node-list button").nth(2).click();
    if (viewport.width < 600) {
      await page.getByRole("tab", { name: "Detalle", exact: true }).click();
      await expect(page.getByRole("tabpanel", { name: "Detalle" })).toContainText("2722 resultados");
      await page.getByRole("tab", { name: "Grafo", exact: true }).click();
    } else await expect(page.getByRole("tabpanel", { name: "Detalle" })).toContainText("2722 resultados");
    await page.getByRole("button", { name: "Centrar nodo seleccionado", exact: true }).click();
    const bounds = await page.locator(".graph-viewport").boundingBox();
    const centered = await first.boundingBox();
    expect(centered!.width).toBeGreaterThanOrEqual(230);
    expect(centered!.height).toBeGreaterThanOrEqual(90);
    expect(centered!.x).toBeGreaterThanOrEqual(bounds!.x - 2);
    expect(centered!.x + centered!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width + 2);
    expect(centered!.y).toBeGreaterThanOrEqual(bounds!.y - 2);
    expect(centered!.y + centered!.height).toBeLessThanOrEqual(bounds!.y + bounds!.height + 2);
    await page.getByRole("button", { name: "Acercar grafo" }).click();
    expect((await first.boundingBox())!.width).toBeGreaterThan(280);
    await page.getByRole("button", { name: "Alejar grafo" }).click();
    await expect(page.getByRole("button", { name: "Alejar grafo" })).toBeDisabled();
    expect((await first.boundingBox())!.width).toBeGreaterThanOrEqual(230);
    if (viewport.width < 600) await page.getByRole("tab", { name: "Detalle", exact: true }).click();
    await expect(page.getByRole("button", { name: /^Ver resultado:/ })).toHaveCount(50);
    await page.getByRole("button", { name: "Siguiente página del grupo" }).click();
    await expect(page.getByText("Resultados 51–100 de 2722", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Última página del grupo" }).click();
    await expect(page.getByText("Resultados 2701–2722 de 2722", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Ver resultado:/ })).toHaveCount(22);
    await page.getByRole("button", { name: /^Ver resultado:/ }).last().click();
    await expect(page.getByRole("tabpanel", { name: "Detalle" })).toContainText("Platform 2721");
    await expect(page.getByRole("button", { name: "Aceptar observación" })).toBeVisible();
    await page.getByRole("button", { name: "Volver al grupo" }).click();
    if (viewport.width < 600) await page.getByRole("tab", { name: "Grafo", exact: true }).click();
    await page.screenshot({ path: `test-results/redesign/leaf-stack-${viewport.width}.png`, fullPage: true });
    expect(errors).toEqual([]);
    expect(mutations).toEqual([]);
  });
}
