import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import type { Investigation } from "@investia/core";

const BASE_URL = "http://127.0.0.1:4327";
const DESKTOP = { width: 1672, height: 941 };
const MOBILE = { width: 390, height: 844 };

interface TestState {
  readonly investigation: Investigation;
  readonly executionCount: number;
  readonly executionCalls: readonly { readonly actionId: string; readonly email: string }[];
  readonly requestCounts: Readonly<Record<string, number>>;
}

async function readState(request: APIRequestContext, id: string): Promise<TestState> {
  const response = await request.get(`${BASE_URL}/__test/state/${encodeURIComponent(id)}`);
  expect(response.status(), "test-only state inspection is served by the same Fastify process").toBe(200);
  return response.json() as Promise<TestState>;
}

function count(state: TestState, key: string): number {
  return state.requestCounts[key] ?? 0;
}

async function screenshot(page: Page, filename: string): Promise<string> {
  const path = resolve("test-results", "screenshots", filename);
  await mkdir(dirname(path), { recursive: true });
  await page.screenshot({ path, animations: "disabled", fullPage: true });
  return path;
}

async function readCreateGeometry(page: Page) {
  return page.evaluate(() => {
    const title = document.querySelector<HTMLElement>("#create-title");
    const firstWord = title?.firstChild;
    const secondWord = title?.querySelector("span")?.firstChild;
    if (!(firstWord instanceof Text) || !(secondWord instanceof Text)) throw new Error("Create title words are not separate text nodes");
    const textRects = (text: Text, start: number, end: number) => {
      const range = document.createRange();
      range.setStart(text, start);
      range.setEnd(text, end);
      return [...range.getClientRects()].map((rect) => ({ top: rect.top, left: rect.left, right: rect.right, width: rect.width }));
    };
    const titleStyle = window.getComputedStyle(title!);
    const submit = document.querySelector<HTMLElement>(".create-submit")!;
    const form = document.querySelector<HTMLElement>(".create-form")!;
    return {
      titleText: title!.textContent?.replace(/\s+/gu, " ").trim(),
      hyphens: titleStyle.hyphens,
      overflowWrap: titleStyle.overflowWrap,
      wordBreak: titleStyle.wordBreak,
      firstWordRects: textRects(firstWord, 0, "Nueva".length),
      secondWordRects: textRects(secondWord, 0, secondWord.length),
      formWidth: form.getBoundingClientRect().width,
      submitBottom: submit.getBoundingClientRect().bottom,
      viewportHeight: window.innerHeight,
      submitText: submit.innerText,
    };
  });
}

async function findRightOrnamentIntersections(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const decorations = [...document.querySelectorAll<HTMLElement>(".heritage-sun, .folk-strip, .home-edge-embroidery, .home-mountain, .create-edge-embroidery, .create-mountain, .application-shell--create .corner-flower, .workspace-edge-embroidery, .workspace-mountain")];
    const protectedElements = [...document.querySelectorAll<HTMLElement>(
      ".site-header, .document-title, .history-panel, .history-entry, .workspace-title-block, .detail-content, .graph-node, a, button, input, textarea, select, summary",
    )];
    const overlaps = (a: DOMRect, b: DOMRect) => a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1;
    const intersections: string[] = [];
    for (const decoration of decorations) {
      const decorationRect = decoration.getBoundingClientRect();
      if (window.getComputedStyle(decoration).display === "none" || decorationRect.width === 0 || decorationRect.height === 0) continue;
      for (const element of protectedElements) {
        if (element === decoration || element.getClientRects().length === 0) continue;
        // Closed disclosures and clipped SVG geometry are not painted control areas.
        let bounds = element.getBoundingClientRect();
        let hidden = false;
        for (let ancestor = element.parentElement; ancestor !== null; ancestor = ancestor.parentElement) {
          if (ancestor instanceof HTMLDetailsElement && !ancestor.open && !ancestor.querySelector(":scope > summary")?.contains(element)) {
            hidden = true;
            break;
          }
          const style = getComputedStyle(ancestor);
          const clip = ancestor.getBoundingClientRect();
          const clipX = ["auto", "scroll", "hidden", "clip"].includes(style.overflowX);
          const clipY = ["auto", "scroll", "hidden", "clip"].includes(style.overflowY);
          const left = clipX ? Math.max(bounds.left, clip.left) : bounds.left;
          const right = clipX ? Math.min(bounds.right, clip.right) : bounds.right;
          const top = clipY ? Math.max(bounds.top, clip.top) : bounds.top;
          const bottom = clipY ? Math.min(bounds.bottom, clip.bottom) : bounds.bottom;
          bounds = new DOMRect(left, top, Math.max(0, right - left), Math.max(0, bottom - top));
        }
        if (!hidden && bounds.width > 0 && bounds.height > 0 && overlaps(decorationRect, bounds)) {
          intersections.push(`${decoration.className} overlaps ${element.getAttribute("class") || element.tagName.toLowerCase()}`);
        }
      }
    }
    return [...new Set(intersections)];
  });
}

async function closeNodeList(page: Page): Promise<void> {
  const list = page.locator(".graph-node-list");
  const summary = list.locator("summary");
  if (await list.count() > 0 && await summary.isVisible() && await list.evaluate((element) => (element as HTMLDetailsElement).open)) {
    await summary.click();
  }
}

async function expectNoHorizontalOverflow(page: Page, context: string): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(dimensions.document, `${context}: document must not scroll horizontally`).toBeLessThanOrEqual(dimensions.viewport + 1);
  expect(dimensions.body, `${context}: body must not scroll horizontally`).toBeLessThanOrEqual(dimensions.viewport + 1);
}

async function expectNoClippedLabelsOrControls(page: Page, context: string): Promise<void> {
  const clipped = await page.evaluate(() => {
    const problems: string[] = [];
    for (const element of document.querySelectorAll<HTMLElement>("label, input, textarea, select, button")) {
      if (element.getClientRects().length === 0) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        problems.push(`${element.tagName.toLowerCase()} has no visible box`);
        continue;
      }
      for (let ancestor = element.parentElement; ancestor !== null && ancestor !== document.body; ancestor = ancestor.parentElement) {
        const style = window.getComputedStyle(ancestor);
        const parent = ancestor.getBoundingClientRect();
        const label = element.getAttribute("aria-label") ?? element.textContent?.trim() ?? element.tagName.toLowerCase();
        if (["hidden", "clip"].includes(style.overflowX) &&
          (rect.left < parent.left - 1 || rect.right > parent.right + 1)) {
          problems.push(`${label.slice(0, 80)} is clipped horizontally by ${ancestor.className || ancestor.tagName}`);
          break;
        }
        if (["hidden", "clip"].includes(style.overflowY) &&
          (rect.top < parent.top - 1 || rect.bottom > parent.bottom + 1)) {
          problems.push(`${label.slice(0, 80)} is clipped vertically by ${ancestor.className || ancestor.tagName}`);
          break;
        }
      }
    }
    return problems;
  });
  expect(clipped, `${context}: labels and controls must remain inside clipping containers`).toEqual([]);
}

async function openNodeList(page: Page): Promise<void> {
  const list = page.locator(".graph-node-list");
  if (!await list.evaluate((element) => (element as HTMLDetailsElement).open)) {
    await list.locator("summary").click();
  }
}

function parseTransform(value: string | null): { readonly x: number; readonly y: number; readonly scale: number } {
  expect(value).not.toBeNull();
  const match = value!.match(/^translate\(([-+\d.e]+) ([-+\d.e]+)\) scale\(([-+\d.e]+)\)$/u);
  expect(match, `expected the SVG view transform, got ${value}`).not.toBeNull();
  return { x: Number(match![1]), y: Number(match![2]), scale: Number(match![3]) };
}

test("real same-origin browser workflow, responsive acceptance, and explicit execution gates", async ({ page, request }) => {
  test.setTimeout(90_000);
  const suffix = randomUUID().slice(0, 10);
  const investigationName = `Cuaderno T6 ${suffix}`;
  const firstEmail = `t6-${suffix}@example.test`;
  const secondEmail = `t6+${"longaddress".repeat(11)}-${suffix}@example.test`;
  const screenshotPaths: string[] = [];
  const browserApiOrigins = new Set<string>();
  const browserApiRequests: string[] = [];
  const browserApiFailures: string[] = [];
  const browserApiErrors: string[] = [];
  const browserResourceErrors: string[] = [];
  const intentionalApi404s = new Set<string>();
  const observedIntentionalApi404s: string[] = [];
  const unexpectedBrowserRequests: string[] = [];
  const browserConsoleErrors: string[] = [];
  const browserPageErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserConsoleErrors.push(`${message.text()} at ${JSON.stringify(message.location())}`);
  });
  page.on("pageerror", (error) => browserPageErrors.push(error.message));
  page.on("request", (browserRequest) => {
    const url = new URL(browserRequest.url());
    if (url.origin !== BASE_URL) unexpectedBrowserRequests.push(browserRequest.url());
    if (url.pathname.startsWith("/investigations")) {
      browserApiOrigins.add(url.origin);
      browserApiRequests.push(`${browserRequest.method()} ${url.pathname}`);
    }
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (response.status() < 400) return;
    if (!url.pathname.startsWith("/investigations")) {
      browserResourceErrors.push(`${response.request().method()} ${url.pathname} returned ${response.status()}`);
      return;
    }
    const requestKey = `${response.request().method()} ${url.pathname}`;
    if (response.status() === 404 && intentionalApi404s.has(requestKey)) observedIntentionalApi404s.push(requestKey);
    else browserApiErrors.push(`${requestKey} returned ${response.status()}`);
  });
  page.on("requestfailed", (browserRequest) => {
    if (new URL(browserRequest.url()).pathname.startsWith("/investigations")) {
      browserApiFailures.push(`${browserRequest.url()} ${browserRequest.failure()?.errorText ?? "unknown"}`);
    }
  });
  await page.route("**/*", async (route) => {
    if (new URL(route.request().url()).origin !== BASE_URL) {
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  await page.setViewportSize(DESKTOP);
  await page.addInitScript(() => {
    const fetchLog: { url: string; status: number | null; error: string | null }[] = [];
    Object.defineProperty(window, "__investiaFetchLog", { value: fetchLog, configurable: true });
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const entry = { url: String(input), status: null as number | null, error: null as string | null };
      fetchLog.push(entry);
      try {
        const response = await nativeFetch(input, init);
        entry.status = response.status;
        return response;
      } catch (error) {
        entry.error = String(error);
        throw error;
      }
    };
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Investigaciones anteriores" })).toBeVisible();
  await expect(page.locator(".application-shell")).toHaveClass(/application-shell--home/u);
  await expect(page.locator(".site-header, .site-footer")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "InvestIA", exact: true })).toBeVisible();
  const stitches = page.locator("pre.ascii-stitch");
  await expect(stitches).toHaveCount(2);
  for (const stitch of await stitches.all()) {
    await expect(stitch).toHaveAttribute("aria-hidden", "true");
    expect(await stitch.textContent()).toMatch(/^[\x20-\x7e\n]+$/u);
    expect(await stitch.evaluate((element) => getComputedStyle(element).whiteSpace)).toBe("pre");
  }
  await expect(page.locator(".home-mountain")).toBeVisible();
  await expect.poll(async () => page.locator(".history-panel").innerText(), {
    message: `browser requests=${JSON.stringify(browserApiRequests)}; failures=${JSON.stringify(browserApiFailures)}; console=${JSON.stringify(browserConsoleErrors)}; pageerrors=${JSON.stringify(browserPageErrors)}; fetches=${JSON.stringify(await page.evaluate(() => Reflect.get(window, "__investiaFetchLog")))}`,
    timeout: 15_000,
  }).toContain("Todavía no hay investigaciones.");
  await expect(page.locator(".new-investigation-link")).toHaveCount(0);
  const initialFetches = await page.evaluate(() => Reflect.get(window, "__investiaFetchLog") as { url: string; status: number | null; error: string | null }[]);
  expect(initialFetches.find((entry) => entry.url === "/investigations")).toMatchObject({ status: 200, error: null });
  expect(new URL(page.url()).origin).toBe(BASE_URL);

  await page.keyboard.press("Tab");
  const skipLink = page.getByRole("link", { name: "Saltar al contenido" });
  await expect(skipLink).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("main")).toBeFocused();
  await expectNoHorizontalOverflow(page, "desktop empty home");

  await page.getByRole("link", { name: /Nueva investigación/ }).last().click();
  await expect(page.getByRole("heading", { name: "Nueva investigación" })).toBeVisible();
  await expect(page.locator(".application-shell")).not.toHaveClass(/application-shell--home/u);
  await expect(page.locator(".application-shell")).toHaveClass(/application-shell--create/u);
  await expect(page.locator(".home-mountain, .mountain-collage, .folk-strip, .site-footer")).toHaveCount(0);
  await expect(page.locator(".create-edge-embroidery pre.ascii-stitch")).toHaveAttribute("aria-hidden", "true");
  await expect(page.locator(".create-mountain")).toBeVisible();
  await expect(page.getByRole("link", { name: "Volver", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Semillas iniciales" })).toBeVisible();
  await expect(page.getByRole("combobox")).toHaveCount(0);
  await expect(page.locator(".site-header")).toBeVisible();
  await page.getByLabel("Nombre de la investigación").fill(investigationName);
  await page.getByLabel("Correo electrónico 1").fill(firstEmail);
  await page.getByRole("button", { name: /Agregar correo/ }).click();
  await page.getByLabel("Correo electrónico 2").fill(secondEmail);

  await expectNoHorizontalOverflow(page, "desktop filled creation form");
  await expectNoClippedLabelsOrControls(page, "desktop filled creation form");
  screenshotPaths.push(await screenshot(page, "create-desktop.png"));
  const desktopCreateGeometry = await readCreateGeometry(page);
  console.info(`T6 desktop create geometry: ${JSON.stringify(desktopCreateGeometry)}`);
  expect(desktopCreateGeometry.titleText).toBe("Nueva investigación");
  expect(desktopCreateGeometry.hyphens).toBe("none");
  expect(desktopCreateGeometry.overflowWrap).toBe("normal");
  expect(desktopCreateGeometry.wordBreak).toBe("normal");
  expect(desktopCreateGeometry.firstWordRects).toHaveLength(1);
  expect(desktopCreateGeometry.secondWordRects).toHaveLength(1);
  expect(Math.abs(desktopCreateGeometry.firstWordRects[0]!.top - desktopCreateGeometry.secondWordRects[0]!.top)).toBeLessThan(1);
  expect(desktopCreateGeometry.formWidth).toBeGreaterThanOrEqual(1_000);
  expect(desktopCreateGeometry.submitBottom).toBeLessThanOrEqual(desktopCreateGeometry.viewportHeight);
  expect(await page.locator(".new-investigation-link").count()).toBe(0);
  expect(await findRightOrnamentIntersections(page)).toEqual([]);

  await page.setViewportSize(MOBILE);
  await expectNoHorizontalOverflow(page, "mobile filled creation form");
  await expectNoClippedLabelsOrControls(page, "mobile filled creation form");
  const mobileCreateGeometry = await readCreateGeometry(page);
  expect(mobileCreateGeometry.titleText).toBe("Nueva investigación");
  expect(mobileCreateGeometry.hyphens).toBe("none");
  expect(mobileCreateGeometry.overflowWrap).toBe("normal");
  expect(mobileCreateGeometry.wordBreak).toBe("normal");
  expect(mobileCreateGeometry.firstWordRects).toHaveLength(1);
  expect(mobileCreateGeometry.secondWordRects).toHaveLength(1);
  expect(mobileCreateGeometry.secondWordRects[0]!.top).toBeGreaterThan(mobileCreateGeometry.firstWordRects[0]!.top);
  expect(await findRightOrnamentIntersections(page)).toEqual([]);
  const secondEmailInput = page.getByLabel("Correo electrónico 2");
  await secondEmailInput.scrollIntoViewIfNeeded();
  await secondEmailInput.press("End");
  expect(await secondEmailInput.inputValue()).toBe(secondEmail);
  expect(await secondEmailInput.evaluate((input) => (input as HTMLInputElement).scrollLeft)).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Crear investigación" }).scrollIntoViewIfNeeded();
  await expect(page.getByRole("button", { name: "Crear investigación" })).toBeInViewport();
  screenshotPaths.push(await screenshot(page, "create-mobile.png"));
  for (const width of [320, 768, 1024]) {
    await page.setViewportSize({ width, height: 941 });
    await expectNoHorizontalOverflow(page, `${width}px filled creation form`);
    await expectNoClippedLabelsOrControls(page, `${width}px filled creation form`);
    expect(await findRightOrnamentIntersections(page), `${width}px creation decorations`).toEqual([]);
  }
  await page.setViewportSize(DESKTOP);

  await page.getByRole("button", { name: "Crear investigación" }).click();
  await expect(page.getByRole("heading", { name: investigationName })).toBeVisible();
  const defaultNodeList = page.locator(".graph-node-list");
  await expect(defaultNodeList).toBeVisible();
  expect(await defaultNodeList.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(false);
  await expect(page.locator(".workspace-meta-bar, .workspace-commandbar, .workspace-command-bar")).toHaveCount(0);
  const caseControls = page.locator(".workspace-case-controls");
  expect(await caseControls.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(false);
  await caseControls.locator("summary").click();
  const reference = page.getByLabel(/^Referencia completa:/);
  await expect(reference).toBeVisible();
  const id = (await reference.textContent())?.trim();
  expect(id).toBeTruthy();
  await page.reload();
  await expect(page.getByRole("heading", { name: investigationName })).toBeVisible();

  let state = await readState(request, id!);
  expect(state.investigation.name).toBe(investigationName);
  expect(state.investigation.emailSeeds.map((seed) => seed.value)).toEqual([firstEmail, secondEmail]);
  expect(state.investigation.authorization).toBeUndefined();
  expect(state.investigation.actions).toEqual([]);
  expect(state.investigation.audit.map((event) => event.kind)).toEqual(["email_seed_added", "email_seed_added"]);
  expect(state.executionCount).toBe(0);
  expect(count(state, "POST /investigations")).toBe(1);
  expect(count(state, "POST /investigations/:id/emails")).toBe(2);
  expect(count(state, "POST /investigations/:id/actions/proposals")).toBe(0);
  expect(count(state, "POST /investigations/:id/authorization")).toBe(0);
  expect(count(state, "POST /investigations/:id/actions/:actionId/approval")).toBe(0);
  expect(count(state, "POST /investigations/:id/actions/run")).toBe(0);

  const proposeButton = page.getByRole("button", { name: "Proponer comprobación de registro en GitHub" });
  await page.getByLabel("Motivo para proponer").fill("Registrar una propuesta manual sin ejecución implícita.");
  await proposeButton.click();
  await expect.poll(async () => (await readState(request, id!)).investigation.actions.length).toBe(1);
  state = await readState(request, id!);
  const action = state.investigation.actions[0]!;
  expect(action.status).toBe("proposed");
  expect(state.investigation.authorization).toBeUndefined();
  expect(state.executionCount).toBe(0);
  expect(count(state, "POST /investigations/:id/actions/proposals")).toBe(1);
  expect(count(state, "POST /investigations/:id/authorization")).toBe(0);
  expect(count(state, "POST /investigations/:id/actions/:actionId/approval")).toBe(0);
  expect(count(state, "POST /investigations/:id/actions/run")).toBe(0);
  await caseControls.locator("summary").click();
  const dispatch = page.getByRole("button", { name: "Ejecutar siguiente acción aprobada en cola" });
  await expect(dispatch).toBeDisabled();

  await openNodeList(page);
  await page.locator(".graph-node-list").getByRole("button", { name: new RegExp(`^Acción: ${action.id}\\.`) }).click();
  await page.getByLabel("Motivo de aprobación").fill("Aprobar esta propuesta en una decisión separada.");
  await page.getByRole("button", { name: "Aprobar acción" }).click();
  await expect.poll(async () => (await readState(request, id!)).investigation.actions[0]?.status).toBe("queued");
  state = await readState(request, id!);
  expect(state.investigation.authorization).toBeUndefined();
  expect(state.executionCount).toBe(0);
  expect(count(state, "POST /investigations/:id/actions/:actionId/approval")).toBe(1);
  expect(count(state, "POST /investigations/:id/authorization")).toBe(0);
  expect(count(state, "POST /investigations/:id/actions/run")).toBe(0);
  await expect(dispatch).toBeDisabled();

  await page.getByLabel("Motivo de autorización").fill("Autorizar por separado después de revisar la propuesta.");
  await page.getByRole("button", { name: "Otorgar autorización" }).click();
  await expect.poll(async () => (await readState(request, id!)).investigation.authorization?.granted).toBe(true);
  state = await readState(request, id!);
  expect(state.investigation.actions[0]?.status).toBe("queued");
  expect(state.executionCount).toBe(0);
  expect(count(state, "POST /investigations/:id/authorization")).toBe(1);
  expect(count(state, "POST /investigations/:id/actions/run")).toBe(0);
  await expect(dispatch).toBeEnabled();

  await page.locator(".workspace-pause-disclosure summary").click();
  await page.getByLabel("Motivo para pausar el expediente").fill("Pausar antes del despacho explícito.");
  await page.getByRole("button", { name: "Pausar expediente" }).click();
  await expect.poll(async () => (await readState(request, id!)).investigation.paused).toBe(true);
  await expect(dispatch).toBeDisabled();
  const blockedDispatch = await request.post(`${BASE_URL}/investigations/${encodeURIComponent(id!)}/actions/run`);
  expect(blockedDispatch.status()).toBe(200);
  expect((await blockedDispatch.json() as { action: unknown }).action).toBeNull();
  state = await readState(request, id!);
  expect(state.investigation.actions[0]?.status).toBe("queued");
  expect(state.executionCount).toBe(0);
  expect(count(state, "POST /investigations/:id/actions/run")).toBe(1);

  await page.getByLabel("Motivo para reanudar el expediente").fill("Reanudar sin despachar automáticamente.");
  await page.getByRole("button", { name: "Reanudar expediente" }).click();
  await expect.poll(async () => (await readState(request, id!)).investigation.paused).toBe(false);
  await expect(dispatch).toBeEnabled();
  state = await readState(request, id!);
  expect(state.executionCount).toBe(0);
  expect(count(state, "POST /investigations/:id/actions/run")).toBe(1);

  await page.locator(".workspace-pause-disclosure summary").click();
  await dispatch.click();
  await expect.poll(async () => (await readState(request, id!)).investigation.actions[0]?.status).toBe("succeeded");
  state = await readState(request, id!);
  expect(state.executionCount).toBe(1);
  expect(state.executionCalls).toEqual([{ actionId: action.id, email: firstEmail }]);
  expect(state.investigation.evidence).toHaveLength(1);
  expect(state.investigation.evidence[0]).toMatchObject({
    actionId: action.id,
    provider: "github",
    sourceId: "test-only-fake-github-observer",
    status: "unknown",
  });
  expect(count(state, "POST /investigations/:id/actions/run")).toBe(2);
  expect(state.investigation.audit.map((event) => event.kind)).toEqual([
    "email_seed_added",
    "email_seed_added",
    "action_proposed",
    "action_approved",
    "authorization_changed",
    "paused",
    "resumed",
    "action_claimed",
    "action_succeeded",
  ]);

  const graph = page.locator("svg.investigation-graph");
  await expect(graph).toBeVisible();
  await openNodeList(page);
  const evidence = state.investigation.evidence[0]!;
  const evidenceListButton = page.locator(".graph-node-list").getByRole("button", { name: new RegExp(`^Evidencia: ${evidence.id}\\.`) });
  await graph.locator(".graph-node--seed").first().click();
  await expect(page.getByRole("heading", { name: "Semilla" })).toBeVisible();
  await graph.locator(".graph-node--evidence").first().click();
  await expect(page.getByRole("heading", { name: "Observación de registro" })).toBeVisible();
  await openNodeList(page);
  await evidenceListButton.click();
  await expect(evidenceListButton).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("heading", { name: "Observación de registro" })).toBeVisible();
  const evidenceTechnicalValue = page.locator(".workspace-detail-panel .workspace-technical-value").first();
  await expect(evidenceTechnicalValue.locator("summary")).toHaveText("Ver valor completo");
  await expect(evidenceTechnicalValue.locator("summary")).toHaveAttribute("aria-label", expect.stringContaining(evidence.id));
  expect(await evidenceTechnicalValue.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(false);
  await evidenceTechnicalValue.locator("summary").click();
  await expect(evidenceTechnicalValue.locator("code")).toHaveText(evidence.id);
  await evidenceTechnicalValue.locator("summary").click();
  expect(await graph.locator("[data-edge]").count()).toBe(2);
  expect(await graph.locator(".graph-node").count()).toBe(4);

  const graphBox = await graph.boundingBox();
  expect(graphBox).not.toBeNull();
  const dragStart = { x: graphBox!.x + graphBox!.width - 12, y: graphBox!.y + graphBox!.height - 12 };
  const dragTargetTag = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName.toLowerCase(), dragStart);
  expect(dragTargetTag, "pan starts on empty SVG canvas rather than a node").toBe("svg");
  const matrixBefore = await graph.evaluate((svg) => {
    const matrix = (svg as SVGSVGElement).getScreenCTM();
    return matrix === null ? null : { a: matrix.a, b: matrix.b, c: matrix.c, d: matrix.d };
  });
  expect(matrixBefore).not.toBeNull();
  if (matrixBefore === null) throw new Error("SVG screen CTM was unavailable before panning");
  expect(matrixBefore.a).toBeGreaterThan(0);
  expect(matrixBefore.d).toBeGreaterThan(0);
  const initialTransform = parseTransform(await graph.locator(":scope > g").getAttribute("transform"));
  const dragX = 26;
  const dragY = 18;
  await page.mouse.move(dragStart.x, dragStart.y);
  await page.mouse.down();
  await page.mouse.move(dragStart.x + dragX, dragStart.y + dragY, { steps: 3 });
  await page.mouse.up();
  const movedTransform = parseTransform(await graph.locator(":scope > g").getAttribute("transform"));
  const determinant = matrixBefore.a * matrixBefore.d - matrixBefore.b * matrixBefore.c;
  const expectedSvgX = (matrixBefore.d * dragX - matrixBefore.c * dragY) / determinant;
  const expectedSvgY = (-matrixBefore.b * dragX + matrixBefore.a * dragY) / determinant;
  expect(movedTransform.x - initialTransform.x).toBeCloseTo(expectedSvgX, 0);
  expect(movedTransform.y - initialTransform.y).toBeCloseTo(expectedSvgY, 0);
  const matrixAfterPan = await graph.evaluate((svg) => {
    const matrix = (svg as SVGSVGElement).getScreenCTM();
    return { a: matrix?.a ?? Number.NaN, d: matrix?.d ?? Number.NaN };
  });
  expect(Number.isFinite(matrixAfterPan.a) && matrixAfterPan.a > 0).toBe(true);
  expect(Number.isFinite(matrixAfterPan.d) && matrixAfterPan.d > 0).toBe(true);

  const zoomButton = page.getByRole("button", { name: "Acercar grafo" });
  const beforeZoom = parseTransform(await graph.locator(":scope > g").getAttribute("transform"));
  await zoomButton.click();
  const afterZoom = parseTransform(await graph.locator(":scope > g").getAttribute("transform"));
  expect(afterZoom.scale).toBeCloseTo(beforeZoom.scale * 1.25, 6);
  await page.getByRole("button", { name: "Ajustar grafo" }).click();
  const fittedTransform = parseTransform(await graph.locator(":scope > g").getAttribute("transform"));
  expect(fittedTransform.scale).toBeGreaterThan(0);
  expect(fittedTransform.scale).toBeLessThanOrEqual(2.4);
  const fitGeometry = await page.evaluate(() => {
    const viewport = document.querySelector<HTMLElement>(".graph-viewport")!.getBoundingClientRect();
    const nodes = [...document.querySelectorAll<SVGGraphicsElement>(".investigation-graph .graph-node")]
      .map((node) => {
        const box = node.getBoundingClientRect();
        return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
      });
    const matrix = (document.querySelector(".investigation-graph") as SVGSVGElement).getScreenCTM()!;
    return { viewport: { left: viewport.left, right: viewport.right, top: viewport.top, bottom: viewport.bottom }, nodes, matrix: { a: matrix.a, d: matrix.d } };
  });
  expect(fitGeometry.matrix.a).toBeGreaterThan(0);
  expect(fitGeometry.matrix.d).toBeGreaterThan(0);
  for (const node of fitGeometry.nodes) {
    expect(node.left).toBeGreaterThanOrEqual(fitGeometry.viewport.left - 1);
    expect(node.right).toBeLessThanOrEqual(fitGeometry.viewport.right + 1);
    expect(node.top).toBeGreaterThanOrEqual(fitGeometry.viewport.top - 1);
    expect(node.bottom).toBeLessThanOrEqual(fitGeometry.viewport.bottom + 1);
  }

  await caseControls.locator("summary").click();
  const mobileGraphTab = page.getByRole("tab", { name: "Grafo" });
  const mobileDetailTab = page.getByRole("tab", { name: "Detalle" });
  await page.setViewportSize(MOBILE);
  await expectNoHorizontalOverflow(page, "mobile workspace overview");
  await expectNoClippedLabelsOrControls(page, "mobile workspace overview");
  await mobileGraphTab.scrollIntoViewIfNeeded();
  await graph.scrollIntoViewIfNeeded();
  const mobileGraphBox = await graph.boundingBox();
  expect(mobileGraphBox).not.toBeNull();
  const mobileDragStart = { x: mobileGraphBox!.x + mobileGraphBox!.width - 5, y: mobileGraphBox!.y + mobileGraphBox!.height - 5 };
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName.toLowerCase(), mobileDragStart)).toBe("svg");
  const mobileMatrix = await graph.evaluate((svg) => {
    const matrix = (svg as SVGSVGElement).getScreenCTM();
    return matrix === null ? null : { a: matrix.a, b: matrix.b, c: matrix.c, d: matrix.d };
  });
  expect(mobileMatrix).not.toBeNull();
  if (mobileMatrix === null) throw new Error("SVG screen CTM was unavailable during mobile pan");
  const mobileTransformBefore = parseTransform(await graph.locator(":scope > g").getAttribute("transform"));
  const mobileDragX = 18;
  const mobileDragY = 13;
  await page.mouse.move(mobileDragStart.x, mobileDragStart.y);
  await page.mouse.down();
  await page.mouse.move(mobileDragStart.x + mobileDragX, mobileDragStart.y + mobileDragY, { steps: 3 });
  await page.mouse.up();
  const mobileTransformAfter = parseTransform(await graph.locator(":scope > g").getAttribute("transform"));
  const mobileDeterminant = mobileMatrix.a * mobileMatrix.d - mobileMatrix.b * mobileMatrix.c;
  expect(mobileTransformAfter.x - mobileTransformBefore.x).toBeCloseTo((mobileMatrix.d * mobileDragX - mobileMatrix.c * mobileDragY) / mobileDeterminant, 0);
  expect(mobileTransformAfter.y - mobileTransformBefore.y).toBeCloseTo((-mobileMatrix.b * mobileDragX + mobileMatrix.a * mobileDragY) / mobileDeterminant, 0);
  // CDP emits genuine touch input, including Chromium's native gesture arbitration.
  const touchSession = await page.context().newCDPSession(page);
  await touchSession.send("Emulation.setTouchEmulationEnabled", { enabled: true });
  await graph.evaluate((svg) => {
    svg.setAttribute("data-touch-trace", "[]");
    for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) {
      svg.parentElement!.addEventListener(type, (event) => {
        const pointer = event as PointerEvent;
        if (pointer.pointerType !== "touch") return;
        const trace = JSON.parse(svg.getAttribute("data-touch-trace")!) as string[];
        trace.push(type);
        svg.setAttribute("data-touch-trace", JSON.stringify(trace));
      });
    }
  });
  const dispatchTouch = async (type: "touchStart" | "touchMove" | "touchEnd", x = 0, y = 0) => {
    await touchSession.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: type === "touchEnd" ? [] : [{ x, y, id: 1 }],
    });
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  };
  const touchBefore = parseTransform(await graph.locator(":scope > g").getAttribute("transform"));
  const scrollBeforeTouch = await page.evaluate(() => window.scrollY);
  await dispatchTouch("touchStart", mobileDragStart.x, mobileDragStart.y);
  const touchTransforms = [];
  for (const delta of [12, 36, 72]) {
    await dispatchTouch("touchMove", mobileDragStart.x - delta, mobileDragStart.y - delta);
    touchTransforms.push(parseTransform(await graph.locator(":scope > g").getAttribute("transform")));
  }
  await dispatchTouch("touchEnd");
  const touchTrace = JSON.parse((await graph.getAttribute("data-touch-trace"))!) as string[];
  console.log("Mobile touch pan", JSON.stringify({ touchTrace, touchBefore, touchTransforms }));
  expect(touchTrace, "custom pan must retain the touch pointer, not yield to browser scrolling").not.toContain("pointercancel");
  expect(touchTrace[0]).toBe("pointerdown");
  expect(touchTrace.at(-1)).toBe("pointerup");
  expect(touchTrace.filter((type) => type === "pointermove")).toHaveLength(3);
  expect(touchTransforms[2]!.x).toBeLessThan(touchTransforms[1]!.x);
  expect(touchTransforms[1]!.x).toBeLessThan(touchTransforms[0]!.x);
  expect(touchTransforms[2]!.x - touchBefore.x).toBeCloseTo((-mobileMatrix.d * 72 + mobileMatrix.c * 72) / mobileDeterminant, 0);
  expect(touchTransforms[2]!.y - touchBefore.y).toBeCloseTo((mobileMatrix.b * 72 - mobileMatrix.a * 72) / mobileDeterminant, 0);
  expect(await page.evaluate(() => window.scrollY), "graph drag must not scroll the page").toBe(scrollBeforeTouch);
  await page.getByRole("button", { name: "Ajustar grafo" }).click();
  const touchNode = graph.locator(".graph-node--seed").first();
  const touchNodeBox = await touchNode.boundingBox();
  expect(touchNodeBox).not.toBeNull();
  await dispatchTouch("touchStart", touchNodeBox!.x + touchNodeBox!.width / 2, touchNodeBox!.y + touchNodeBox!.height / 2);
  await dispatchTouch("touchEnd");
  await expect(touchNode).toHaveAttribute("aria-pressed", "true");
  // Keyboard selection still works after a touch drag and tap.
  await mobileGraphTab.click();
  const keyboardNode = graph.locator(".graph-node--evidence").first();
  await keyboardNode.focus();
  await page.keyboard.press("Enter");
  await expect(keyboardNode).toHaveAttribute("aria-pressed", "true");
  await mobileGraphTab.click();
  const mobileFitGeometry = await page.evaluate(() => {
    const viewport = document.querySelector<HTMLElement>(".graph-viewport")!.getBoundingClientRect();
    const nodes = [...document.querySelectorAll<SVGGraphicsElement>(".investigation-graph .graph-node")].map((node) => node.getBoundingClientRect());
    const matrix = (document.querySelector(".investigation-graph") as SVGSVGElement).getScreenCTM()!;
    return { viewport: { left: viewport.left, right: viewport.right, top: viewport.top, bottom: viewport.bottom }, nodes: nodes.map((node) => ({ left: node.left, right: node.right, top: node.top, bottom: node.bottom })), scale: { x: matrix.a, y: matrix.d } };
  });
  expect(mobileFitGeometry.scale.x).toBeGreaterThan(0);
  expect(mobileFitGeometry.scale.y).toBeGreaterThan(0);
  for (const node of mobileFitGeometry.nodes) {
    expect(node.left).toBeGreaterThanOrEqual(mobileFitGeometry.viewport.left - 1);
    expect(node.right).toBeLessThanOrEqual(mobileFitGeometry.viewport.right + 1);
    expect(node.top).toBeGreaterThanOrEqual(mobileFitGeometry.viewport.top - 1);
    expect(node.bottom).toBeLessThanOrEqual(mobileFitGeometry.viewport.bottom + 1);
  }
  await closeNodeList(page);
  expect(await findRightOrnamentIntersections(page)).toEqual([]);
  screenshotPaths.push(await screenshot(page, "workspace-mobile-graph.png"));
  await mobileGraphTab.focus();
  await page.keyboard.press("ArrowRight");
  await expect(mobileDetailTab).toBeFocused();
  await expect(mobileDetailTab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: "Observación de registro" })).toBeVisible();
  await expectNoHorizontalOverflow(page, "mobile selected evidence detail");
  await expectNoClippedLabelsOrControls(page, "mobile selected evidence detail");
  await page.locator("#workspace-detail-panel").scrollIntoViewIfNeeded();
  await closeNodeList(page);
  expect(await findRightOrnamentIntersections(page)).toEqual([]);
  screenshotPaths.push(await screenshot(page, "workspace-mobile.png"));
  await page.evaluate(() => window.scrollTo(0, 0));
  expect(await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight)).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.elementFromPoint(2, 600)?.closest(".graph-viewport"))).toBeNull();
  await dispatchTouch("touchStart", 2, 600);
  await dispatchTouch("touchMove", 2, 560);
  await dispatchTouch("touchMove", 2, 400);
  await dispatchTouch("touchMove", 2, 250);
  await dispatchTouch("touchEnd");
  await expect.poll(async () => page.evaluate(() => window.scrollY), { message: "touch swipe outside the graph must still scroll the page" }).toBeGreaterThan(0);
  console.log("Outside-graph touch scroll", await page.evaluate(() => window.scrollY));
  await touchSession.send("Emulation.setTouchEmulationEnabled", { enabled: false });
  await touchSession.detach();
  await caseControls.locator("summary").click();
  await expect(page.getByRole("button", { name: "Actualizar expediente" })).toBeVisible();
  await expect(dispatch).toBeDisabled();
  await caseControls.locator("summary").click();
  for (const width of [320, 768, 1024]) {
    await page.setViewportSize({ width, height: 941 });
    await expectNoHorizontalOverflow(page, `${width}px workspace detail`);
    await expectNoClippedLabelsOrControls(page, `${width}px workspace detail`);
    expect(await findRightOrnamentIntersections(page), `${width}px workspace ornaments`).toEqual([]);
    if (width <= 820) await mobileGraphTab.click();
    await expectNoHorizontalOverflow(page, `${width}px workspace graph`);
    expect(await findRightOrnamentIntersections(page), `${width}px workspace graph ornaments`).toEqual([]);
    if (width <= 820) await mobileDetailTab.click();
  }

  await page.setViewportSize(DESKTOP);
  await page.getByRole("button", { name: "Ajustar grafo" }).click();
  await expectNoHorizontalOverflow(page, "desktop factual workspace");
  await expectNoClippedLabelsOrControls(page, "desktop factual workspace");
  await closeNodeList(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  expect(await findRightOrnamentIntersections(page)).toEqual([]);
  screenshotPaths.push(await screenshot(page, "workspace-desktop.png"));

  await page.getByLabel("Motivo de validación").fill("La observación se acepta solo como registro factual.");
  await page.getByRole("button", { name: "Aceptar observación" }).click();
  await expect.poll(async () => (await readState(request, id!)).investigation.validations.length).toBe(1);
  state = await readState(request, id!);
  expect(state.investigation.validations[0]).toMatchObject({ evidenceId: evidence.id, status: "accepted" });
  expect(state.investigation.evidence[0]?.status).toBe("unknown");
  expect(state.executionCount).toBe(1);
  expect(count(state, "POST /investigations/:id/evidence/:evidenceId/validation")).toBe(1);

  await page.getByRole("button", { name: "Obtener informe" }).click();
  const preview = page.getByLabel("Vista previa del informe");
  await expect(preview).toBeVisible();
  await expect(preview).toContainText("Identity attribution is unsupported");
  await expect(preview).toContainText("accepted");
  await expect(page.getByRole("link", { name: "Descargar Markdown" })).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: "Descargar Markdown" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(`investigacion-${id}.md`);
  const reportPath = resolve("test-results", "downloads", download.suggestedFilename());
  await mkdir(dirname(reportPath), { recursive: true });
  await download.saveAs(reportPath);
  expect(await (await import("node:fs/promises")).readFile(reportPath, "utf8")).toContain("unknown");

  const revisionWithReport = state.investigation.revision;
  await page.getByLabel("Motivo de validación").fill("Registrar una segunda decisión y vencer el informe previo.");
  await page.getByRole("button", { name: "Marcar inconclusa" }).click();
  await expect.poll(async () => (await readState(request, id!)).investigation.revision).toBeGreaterThan(revisionWithReport);
  await expect(preview).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Descargar Markdown" })).toHaveCount(0);
  state = await readState(request, id!);
  expect(state.investigation.validations.map((validation) => validation.status)).toEqual(["accepted", "inconclusive"]);
  expect(state.executionCount).toBe(1);
  expect(count(state, "POST /investigations/:id/evidence/:evidenceId/validation")).toBe(2);

  await page.getByRole("link", { name: "Volver al historial" }).click();
  await expect(page.getByRole("link", { name: new RegExp(investigationName) })).toBeVisible();
  await expectNoHorizontalOverflow(page, "desktop populated home");
  await expectNoClippedLabelsOrControls(page, "desktop populated home");
  const historyWidthRatio = await page.evaluate(() => document.querySelector<HTMLElement>(".history-panel")!.getBoundingClientRect().width / window.innerWidth);
  expect(historyWidthRatio).toBeGreaterThanOrEqual(0.23);
  expect(historyWidthRatio).toBeLessThanOrEqual(0.31);
  expect(await findRightOrnamentIntersections(page)).toEqual([]);
  await page.evaluate(() => window.scrollTo(0, 0));
  screenshotPaths.push(await screenshot(page, "home-desktop.png"));
  await page.setViewportSize(MOBILE);
  await expectNoHorizontalOverflow(page, "mobile populated home");
  await expectNoClippedLabelsOrControls(page, "mobile populated home");
  expect(await findRightOrnamentIntersections(page)).toEqual([]);
  screenshotPaths.push(await screenshot(page, "home-mobile.png"));

  const lateId = `missing-late-${suffix}`;
  const latePath = `/investigations/${encodeURIComponent(lateId)}`;
  const lateRequestKey = `GET ${latePath}`;
  intentionalApi404s.add(lateRequestKey);
  let releaseLate404!: () => void;
  const late404Gate = new Promise<void>((resolveGate) => { releaseLate404 = resolveGate; });
  await page.route(`${BASE_URL}${latePath}`, async (route) => {
    await late404Gate;
    await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "NOT_FOUND", message: "Not found" }) });
  });
  const lateRequest = page.waitForRequest((browserRequest) => new URL(browserRequest.url()).pathname === latePath);
  await page.evaluate((id) => { window.location.hash = `#/investigaciones/${encodeURIComponent(id)}`; }, lateId);
  await lateRequest;
  await page.evaluate(() => { window.location.hash = "#/"; });
  await expect(page.getByRole("heading", { name: "Investigaciones anteriores" })).toBeVisible();
  const lateResponsePromise = page.waitForResponse((response) => new URL(response.url()).pathname === latePath);
  releaseLate404();
  const lateResponse = await lateResponsePromise;
  expect(lateResponse.status()).toBe(404);
  await lateResponse.finished();
  await page.evaluate(() => new Promise<void>((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame()))));
  await expect(page.getByRole("heading", { name: "Investigaciones anteriores" })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(observedIntentionalApi404s).toEqual([lateRequestKey]);
  await page.unroute(`${BASE_URL}${latePath}`);

  expect([...browserApiOrigins], "all browser API traffic must stay same-origin").toEqual([BASE_URL]);
  expect(unexpectedBrowserRequests, "outbound browser requests are denied except to the local test origin").toEqual([]);
  expect(browserApiFailures, "browser API requests must settle without transport failures").toEqual([]);
  expect(browserApiErrors, "unexpected browser API errors (the deliberate late 404 is excluded)").toEqual([]);
  const late404ConsoleErrors = browserConsoleErrors.filter((error) => error.includes(`${BASE_URL}${latePath}`) && error.includes("404"));
  expect(late404ConsoleErrors, "the only console 404 is the intentional late API rejection").toHaveLength(1);
  expect(browserConsoleErrors.filter((error) => !late404ConsoleErrors.includes(error)), "unexpected browser console errors").toEqual([]);
  expect(browserResourceErrors, "unexpected static-resource errors").toEqual([]);
  expect(browserPageErrors, "uncaught browser page errors").toEqual([]);
  console.info(`T6 browser screenshots: ${screenshotPaths.join(", ")}`);
});
