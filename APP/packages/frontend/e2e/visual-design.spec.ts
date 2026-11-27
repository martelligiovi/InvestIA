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

const viewports = [{ width: 1440, height: 1000 }, { width: 900, height: 900 }, { width: 390, height: 844 }];

for (const viewport of viewports) {
  test(`editorial interface preserves navigation and controls at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const checkLayout = async () => {
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
      await expect(page.locator(".home-emblem, .create-guide .ascii-art")).toBeHidden();
    };

    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Investigaciones anteriores" })).toBeVisible();
    const principles = page.locator(".home-principles");
    await expect(principles.getByRole("listitem")).toHaveCount(2);
    const principleColumns = await principles.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length);
    expect(principleColumns).toBe(viewport.width > 600 && viewport.width <= 900 ? 2 : 1);
    await checkLayout();
    const recentTop = await page.locator(".history-panel").evaluate((el) => el.getBoundingClientRect().top);
    expect(recentTop, "returning users should reach history in the first viewport").toBeLessThan(viewport.height * 0.65);
    await page.getByRole("link", { name: "Nueva investigación", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Nueva investigación", exact: true })).toBeVisible();
    await checkLayout();
    expect(await page.locator("#create-title").evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeLessThanOrEqual(48);
    await expect(page.getByRole("group", { name: "Datos iniciales" }).getByRole("heading", { level: 2 })).toHaveText(["Expediente", "Semillas iniciales"]);
    await expect(page.getByRole("region", { name: "Avance automático" })).toHaveCount(0);
    const guide = page.getByRole("complementary", { name: "Cómo se abre un expediente" });
    await expect(guide.getByRole("listitem")).toHaveCount(2);
    await expect(guide.getByText(/Creá el expediente para iniciar el avance automático/u)).toHaveCount(0);
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
    const createRequest = page.waitForRequest((request) => new URL(request.url()).pathname === "/investigations" && request.method() === "POST");
    await page.getByRole("button", { name: "Crear investigación", exact: true }).click();
    expect((await createRequest).postDataJSON()).toMatchObject({ advancementMode: "automatic" });
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

  test(`settings cards and index fit at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const defaults = { model: "fixture/model", reasoningEffort: "default", temperature: 0.6, topP: 0.95, maxTokens: 4096 };
    const fixtures: Readonly<Record<string, unknown>> = {
      "/settings/ai": { apiKeyConfigured: false, apiKeyHint: null, settings: defaults, defaults },
      "/settings/ai/models": { source: "live", models: [{ id: "fixture/model", name: "Modelo de ejemplo", description: "", reasoning: false }] },
      "/settings/ghunt": { available: true, state: "requires_connection", account: null },
      "/settings/facecheck": { tokenConfigured: true, tokenHint: "••••1234", testingMode: true },
      "/settings/decodo": { tokenConfigured: true, tokenHint: "••••5678", apiMode: "scraping_v2" },
    };
    await page.route("**/settings/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      expect(route.request().method()).toBe("GET");
      expect(fixtures[path]).toBeDefined();
      await route.fulfill({ json: fixtures[path] });
    });
    await page.goto("/#/ajustes");
    const settings = page.getByRole("region", { name: "Ajustes", exact: true });
    const index = settings.getByRole("navigation", { name: "Integraciones" });
    await expect(settings.getByRole("heading", { level: 2 })).toHaveText(["Inteligencia artificial", "Google (GHunt)", "FaceCheck.id", "Decodo"]);
    await expect(settings.getByRole("button", { name: "Recargar modelos" })).toBeEnabled();
    await expect(settings.getByLabel("Código de GHunt Companion")).toBeVisible();
    await expect(settings.getByRole("checkbox", { name: "Modo prueba" })).toBeChecked();
    await expect(settings.getByRole("combobox", { name: "Modo de API" })).toHaveValue("scraping_v2");
    const layout = await index.evaluate((element) => ({
      indexPosition: getComputedStyle(element).position,
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
    }));
    expect(layout.indexPosition).toBe(viewport.width >= 1024 ? "sticky" : "static");
    expect(Math.max(layout.documentWidth, layout.bodyWidth)).toBeLessThanOrEqual(layout.viewportWidth);
    await page.screenshot({ path: `test-results/redesign/settings-${viewport.width}.png`, animations: "disabled", fullPage: true });

    await index.getByRole("button", { name: "Decodo" }).press("Enter");
    const decodo = settings.getByRole("region", { name: "Decodo", exact: true });
    await expect(decodo).toBeFocused();
    await expect(decodo.getByRole("heading", { name: "Decodo" })).toBeInViewport();
    await expect(page).toHaveURL(/#\/ajustes$/u);
  });
}

test("late AI settings do not undo scrolling away from the GHunt deep link", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const defaults = { model: "fixture/model", reasoningEffort: "default", temperature: 0.6, topP: 0.95, maxTokens: 4096 };
  const fixtures: Readonly<Record<string, unknown>> = {
    "/settings/ai": { apiKeyConfigured: false, apiKeyHint: null, settings: defaults, defaults },
    "/settings/ai/models": { source: "live", models: [] },
    "/settings/ghunt": { available: true, state: "requires_connection", account: null },
    "/settings/facecheck": { tokenConfigured: false, tokenHint: null, testingMode: true },
    "/settings/decodo": { tokenConfigured: false, tokenHint: null, apiMode: "web_data" },
  };
  let releaseAi!: () => void;
  const gate = new Promise<void>((resolve) => { releaseAi = resolve; });
  await page.route("**/settings/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/settings/ai") await gate;
    await route.fulfill({ json: fixtures[path] });
  });

  try {
    await page.goto("/#/ajustes?seccion=ghunt");
    const google = page.getByRole("region", { name: "Google (GHunt)" });
    await expect(google).toBeFocused();
    await expect(google.getByRole("heading")).toBeInViewport();
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    await expect(google).toBeFocused();

    releaseAi();
    await expect(page.getByLabel("API key de NVIDIA Build")).toBeVisible();
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await expect(google).toBeFocused();
  } finally {
    releaseAi();
  }
});
