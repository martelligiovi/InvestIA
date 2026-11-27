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
    const canvas = page.locator(".graph-viewport");
    await canvas.screenshot({ path: `test-results/redesign/large-graph-before-${viewport.width}.png`, animations: "disabled" });
    await page.getByRole("button", { name: "Centrar grafo completo", exact: true }).click();
    await expect(first).toHaveAttribute("aria-pressed", "true");
    expect(await canvas.evaluate((element) => [element.scrollLeft, element.scrollTop])).toEqual([0, 0]);
    const bounds = (await canvas.boundingBox())!;
    for (const card of await canvas.locator(".graph-node-card").all()) {
      const centered = (await card.boundingBox())!;
      expect(centered.x).toBeGreaterThanOrEqual(bounds.x - 2);
      expect(centered.x + centered.width).toBeLessThanOrEqual(bounds.x + bounds.width + 2);
      expect(centered.y).toBeGreaterThanOrEqual(bounds.y - 2);
      expect(centered.y + centered.height).toBeLessThanOrEqual(bounds.y + bounds.height + 2);
    }
    await canvas.screenshot({ path: `test-results/redesign/large-graph-fitted-${viewport.width}.png`, animations: "disabled" });
    if (viewport.width >= 1000) {
      const readScale = () => canvas.locator("svg > g").evaluate((group) =>
        (group as SVGGElement).transform.baseVal.getItem(1).matrix.a,
      );
      const readScroll = () => canvas.evaluate((element) => [element.scrollLeft, element.scrollTop, window.scrollY]);
      await canvas.hover();
      const scaleBefore = await readScale();
      const scrollBefore = await readScroll();

      await page.mouse.wheel(0, -100);
      await expect.poll(readScale).toBeGreaterThan(scaleBefore);
      expect(await readScale()).toBeLessThan(scaleBefore * 1.25);
      expect(await readScroll()).toEqual(scrollBefore);

      await page.mouse.wheel(0, 100);
      await expect.poll(readScale).toBeCloseTo(scaleBefore, 6);
      expect(await readScroll()).toEqual(scrollBefore);
    }
    const fittedWidth = (await first.boundingBox())!.width;
    await page.getByRole("button", { name: "Acercar grafo" }).click();
    expect((await first.boundingBox())!.width).toBeGreaterThan(fittedWidth);
    const zoomOut = page.getByRole("button", { name: "Alejar grafo" });
    await expect(zoomOut).toBeEnabled();
    for (let i = 0; i < 8 && await zoomOut.isEnabled(); i++) await zoomOut.click();
    await expect(zoomOut).toBeDisabled();
    await expect(canvas.locator("svg > g")).toHaveAttribute("transform", /scale\(0\.25\)$/u);
    expect((await first.boundingBox())!.width).toBeLessThan(fittedWidth);
    await expect(first).toHaveAttribute("aria-pressed", "true");
    await canvas.screenshot({ path: `test-results/redesign/large-graph-zoomed-out-${viewport.width}.png`, animations: "disabled" });
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
