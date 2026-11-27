import { expect, test } from "@playwright/test";
import type { Investigation } from "@investia/core";

for (const width of [1440, 320]) {
  test(`action rerun confirmation fits the detail panel at ${width}px`, async ({ page }) => {
    const at = "2025-03-16T12:00:00.000Z";
    const id = "rerun-visual-fixture";
    const seed = { kind: "email", value: "una-semilla-larga-para-probar-el-ajuste@example.test" } as const;
    const investigation: Investigation = { id, revision: 7, name: "Reejecución de ejemplo", createdAt: at, updatedAt: at,
      advancementMode: "manual", paused: false, emailSeeds: [seed], evidence: [], validations: [], audit: [],
      authorization: { granted: true, at, reason: "Fixture", operator: "local-operator", catalogScopes: ["user-scanner.email.v1"] },
      actions: [{ id: "visual-action", spec: { catalogId: "user-scanner.email.v1", provider: "user-scanner", seed },
        status: "succeeded", queuedByCatalog: true, proposedAt: at, completedAt: at, proposalReason: "Fixture" }],
    };
    await page.route(`**/investigations/${id}`, (route) => route.fulfill({ json: investigation }));
    await page.setViewportSize({ width, height: 860 });
    await page.goto(`/#/investigaciones/${id}`);
    await page.locator('[data-node-id="action:visual-action"]').click();
    const detailTab = page.getByRole("tab", { name: "Detalle", exact: true });
    if (await detailTab.isVisible()) await detailTab.click();
    const panel = page.getByRole("complementary", { name: "Detalle del nodo" });
    await panel.getByRole("button", { name: "Reejecutar", exact: true }).click();
    const region = panel.getByRole("region", { name: "Reejecución" });
    await expect(region).toContainText("solo si la nueva ejecución termina bien");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const regionBounds = (await region.boundingBox())!;
    for (const name of ["Confirmar reejecución", "Cancelar"]) {
      const button = region.getByRole("button", { name, exact: true });
      await expect(button).toBeVisible();
      const bounds = (await button.boundingBox())!;
      expect(bounds.height).toBeGreaterThanOrEqual(44);
      expect(bounds.x).toBeGreaterThanOrEqual(regionBounds.x);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(regionBounds.x + regionBounds.width + 1);
    }
    await panel.screenshot({ path: `test-results/redesign/rerun-${width}.png` });
    await region.getByRole("button", { name: "Cancelar", exact: true }).click();
    await expect(panel.getByRole("button", { name: "Reejecutar", exact: true })).toBeVisible();
  });
}

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  test(`editorial interface preserves navigation and controls at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const checkLayout = async () => {
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
      await expect(page.locator(".home-emblem, .create-guide .ascii-art")).toBeHidden();
    };

    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Investigaciones anteriores" })).toBeVisible();
    await checkLayout();
    const recentTop = await page.locator(".history-panel").evaluate((el) => el.getBoundingClientRect().top);
    expect(recentTop, "returning users should reach history in the first viewport").toBeLessThan(viewport.height * 0.65);
    await page.getByRole("link", { name: "Nueva investigación", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Nueva investigación", exact: true })).toBeVisible();
    await checkLayout();
    expect(await page.locator("#create-title").evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeLessThanOrEqual(48);
    const advancement = page.getByRole("region", { name: "Avance automático" });
    await expect(advancement).toContainText(/Decodo.*URL públicas.*FaceCheck/);
    await expect(page.getByRole("checkbox")).toHaveCount(0);
    await page.getByRole("button", { name: "+ Agregar correo", exact: true }).click();
    await expect(page.locator("input[type=email]")).toHaveCount(2);
    await page.getByRole("button", { name: "Quitar correo 2", exact: true }).click();
    await expect(page.locator("input[type=email]")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Quitar correo 1", exact: true })).toBeDisabled();
    const emailBox = await page.locator("input[type=email]").boundingBox();
    const removeBox = await page.getByRole("button", { name: "Quitar correo 1", exact: true }).boundingBox();
    expect(Math.abs(emailBox!.y - removeBox!.y), "email and removal control should share a row").toBeLessThan(5);
    await page.locator("#investigation-name").fill("Exposición digital · Caso de ejemplo");
    await page.locator("#investigation-intention").fill("Revisar la presencia pública de un correo de ejemplo.");
    await page.locator("input[type=email]").fill("visual@example.com");
    await page.getByRole("button", { name: "Crear investigación", exact: true }).click();
    await page.waitForURL(/investigaciones\//);
    await expect(page.locator(".workspace-title-block h1")).toHaveText("Exposición digital · Caso de ejemplo");
    await checkLayout();
    await expect(page.getByRole("button", { name: "Obtener informe", exact: true })).toBeVisible();
    await expect(page.locator(".workspace-usernames-disclosure summary")).toBeVisible();
    await expect(page.locator(".workspace-pause-disclosure")).toHaveCount(0);
    await expect(page.getByText("Controles del expediente", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Autorizar expediente" })).toHaveCount(0);
    const title = await page.locator(".workspace-title-block h1").boundingBox();
    expect(title!.height, "case titles should not monopolize the mobile header").toBeLessThan(100);
    for (const name of ["Acercar grafo", "Alejar grafo", "Centrar nodo seleccionado"]) {
      await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
    }
    if (viewport.width < 821) {
      await page.getByRole("tab", { name: "Detalle", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Detalle del nodo" })).toBeVisible();
      await page.getByRole("tab", { name: "Grafo", exact: true }).click();
    }
    await page.screenshot({ path: `test-results/redesign/workspace-${viewport.width}.png`, fullPage: true });
    await page.getByRole("link", { name: "Volver al historial" }).click();
    await expect(page.getByRole("link", { name: /Exposición digital · Caso de ejemplo/ }).first()).toBeVisible();
    await page.screenshot({ path: `test-results/redesign/home-${viewport.width}.png`, fullPage: true });
    await page.goto("/#/nueva");
    await page.screenshot({ path: `test-results/redesign/create-${viewport.width}.png`, fullPage: true });
    await page.goto("/#/not-a-route");
    await expect(page.getByRole("heading", { name: "No encontramos esta página" })).toBeVisible();
    await checkLayout();
    await page.screenshot({ path: `test-results/redesign/not-found-${viewport.width}.png`, fullPage: true });
    await page.getByRole("link", { name: "Volver al inicio" }).click();
    await expect(page.getByRole("heading", { name: "Investigaciones anteriores" })).toBeVisible();
  });
}
