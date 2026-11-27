import { expect, test } from "@playwright/test";
import type { InvestigationSummary } from "@investia/core";

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
    await expect(page.locator(".workspace-pause-disclosure summary")).toBeVisible();
    await expect(page.locator(".workspace-header summary").filter({ hasText: /^Usernames\b/u })).toHaveCount(0);
    await expect(page.getByText("Controles del expediente", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Autorizar expediente" })).toHaveCount(0);
    const title = await page.locator(".workspace-title-block h1").boundingBox();
    expect(title!.height, "case titles should not monopolize the mobile header").toBeLessThan(100);
    for (const name of ["Acercar grafo", "Alejar grafo", "Centrar grafo completo"]) {
      await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
    }
    if (viewport.width < 821) {
      await page.getByRole("tab", { name: "Detalle", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Detalle del nodo" })).toBeVisible();
      await page.getByRole("tab", { name: "Grafo", exact: true }).click();
    }
    await expect(page.locator(".workspace-state-tag")).toHaveText("Sin acciones ejecutables");
    await page.screenshot({ path: `test-results/redesign/workspace-${viewport.width}.png`, fullPage: true });
    await page.getByRole("link", { name: "Volver al historial" }).click();
    await expect(page.getByRole("link", { name: /Exposición digital · Caso de ejemplo/ }).first()).toContainText("Sin acciones ejecutables");
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

test("Home status chips wrap inside the history row at 320px", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  const at = "2025-03-16T12:00:00.000Z";
  const common = { createdAt: at, updatedAt: at, revision: 2, emailSeedCount: 0, actionCount: 0, paused: false };
  const history: InvestigationSummary[] = [
    { ...common, id: "empty", name: "Cuaderno sin acciones", status: "no_executable_actions" },
    { ...common, id: "claimed", name: "Cuaderno en revisión", status: "claimed_uncertain", actionCount: 1 },
    { ...common, id: "paused", name: "Cuaderno archivado", status: "paused", paused: true },
  ];
  const requests: string[] = [];
  await page.route(/\/(investigations|settings)(?:\/|$)/u, (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    requests.push(`${request.method()} ${path}`);
    return request.method() === "GET" && path === "/investigations" ? route.fulfill({ json: history }) : route.abort();
  });
  await page.goto("/");
  const empty = page.getByRole("link", { name: /Cuaderno sin acciones/ });
  const claimed = page.getByRole("link", { name: /Cuaderno en revisión/ });
  await expect(empty.locator(".status-chip")).toHaveText("Sin acciones ejecutables");
  await expect(claimed.locator(".status-chip")).toHaveText("Acción reclamada · efecto incierto");
  await expect(page.getByRole("link", { name: /Cuaderno archivado/ }).locator(".status-chip--muted")).toHaveText("Pausada");
  for (const entry of [empty, claimed]) {
    expect(await entry.evaluate((row) => {
      const chip = row.querySelector<HTMLElement>(".status-chip")!;
      return row.scrollWidth <= row.clientWidth && chip.scrollWidth <= chip.clientWidth;
    })).toBe(true);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  expect(requests).toEqual(["GET /investigations"]);
  await page.screenshot({ path: "test-results/redesign/home-status-320.png", fullPage: true });
});
