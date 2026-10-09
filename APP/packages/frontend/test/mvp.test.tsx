import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Investigation, InvestigationSummary } from "@investia/core";
import App from "../src/App";

type CapturedCall = { input: RequestInfo | URL; init?: RequestInit };
type RouteHandler = (call: CapturedCall) => Promise<Response>;

const createdAt = "2025-03-16T12:00:00.000Z";
const sampleSummary: InvestigationSummary = {
  id: "case-1",
  name: "Cuaderno de otoño",
  revision: 0,
  createdAt,
  updatedAt: createdAt,
  paused: false,
  emailSeedCount: 2,
  actionCount: 0,
};

function investigation(emailSeeds: string[] = []): Investigation {
  return {
    id: "case-1",
    name: "Cuaderno de otoño",
    revision: emailSeeds.length,
    createdAt,
    updatedAt: createdAt,
    paused: false,
    emailSeeds: emailSeeds.map((value) => ({ kind: "email", value })),
    actions: [],
    evidence: [],
    validations: [],
    audit: [],
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installFetch(handler: RouteHandler) {
  const calls: CapturedCall[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { input, init };
    calls.push(call);
    return handler(call);
  });
  vi.stubGlobal("fetch", fetcher);
  return { calls, fetcher };
}

function bodyOf(call: CapturedCall): unknown {
  return call.init?.body === undefined ? undefined : JSON.parse(String(call.init.body));
}

function routeTo(hash: string) {
  window.history.replaceState(null, "", `/${hash}`);
}

function requestPath(call: CapturedCall): string {
  return String(call.input);
}

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
  window.sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe("home e historial real", () => {
  it("muestra la carga, datos reales, estado pausado/activo y navega al expediente", async () => {
    let resolveList!: (response: Response) => void;
    const pendingList = new Promise<Response>((resolve) => { resolveList = resolve; });
    const { calls } = installFetch(async (call) => requestPath(call) === "/investigations" ? pendingList : json(investigation()));
    routeTo("#/");
    render(<App />);

    expect(screen.getByRole("status")).toHaveTextContent(/cargando/i);
    resolveList(json([
      sampleSummary,
      { ...sampleSummary, id: "case-2", name: "Pausada", paused: true, createdAt: "2025-03-15T12:00:00.000Z" },
    ]));

    const entry = await screen.findByRole("link", { name: /Cuaderno de otoño/i });
    expect(entry).toHaveAttribute("href", "#/investigaciones/case-1");
    expect(screen.getByText("Activa")).toBeInTheDocument();
    expect(screen.getAllByText("Pausada")).toHaveLength(2);
    expect(screen.getByText(/16 de marzo de 2025/i)).toBeInTheDocument();
    expect(calls.map(requestPath)).toEqual(["/investigations"]);

    await userEvent.setup().click(entry);
    expect(window.location.hash).toBe("#/investigaciones/case-1");
    expect(await screen.findByRole("heading", { name: "Cuaderno de otoño" })).toBeInTheDocument();
  });

  it("presenta vacío y error con reintento; vuelve a cargar al regresar al inicio", async () => {
    let attempts = 0;
    const { calls } = installFetch(async () => {
      attempts += 1;
      if (attempts === 1) return json({ error: "UNAVAILABLE", message: "offline" }, 503);
      return json([]);
    });
    routeTo("#/");
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/no se pudo cargar/i);
    await user.click(screen.getByRole("button", { name: /intentar de nuevo/i }));
    expect(await screen.findByText(/todavía no hay investigaciones/i)).toBeInTheDocument();

    await user.click(screen.getAllByRole("link", { name: /nueva investigación/i })[0]!);
    await screen.findByRole("heading", { name: "Nueva investigación" });
    await user.click(screen.getByRole("link", { name: /investia, inicio/i }));
    await waitFor(() => expect(calls.filter((call) => requestPath(call) === "/investigations")).toHaveLength(3));
  });
});

describe("creación nombrada y recuperación", () => {
  it.each(["rejected", "response_lost"])("persiste consentimiento antes de semillas y reconcilia autorización %s", async (failure) => {
    let authorized = false;
    let attempts = 0;
    const { calls } = installFetch(async (call) => {
      const path = requestPath(call);
      const current = { ...investigation(), ...(authorized ? { authorization: { granted: true, at: createdAt, reason: "Consentimiento", operator: "local-operator" } } : {}) };
      if (path.endsWith("/authorization")) {
        attempts += 1;
        authorized = failure === "response_lost" || attempts > 1;
        if (attempts === 1) return json({ error: "UNAVAILABLE" }, 503);
        return json({ ...current, authorization: { granted: true } });
      }
      if (path.endsWith("/emails")) return json(investigation(["uno@example.test"]));
      return json(current);
    });
    routeTo("#/nueva");
    const user = userEvent.setup();
    const first = render(<App />);
    const consent = screen.getByRole("checkbox", { name: /autorizar consultas/i });
    expect(consent).not.toBeChecked();
    await user.click(consent);
    await user.type(screen.getByLabelText(/nombre de la investigación/i), "Consentido");
    await user.type(screen.getByLabelText(/intención de la investigación/i), "Revisar exposición");
    await user.type(screen.getByLabelText(/correo electrónico 1/i), "uno@example.test");
    await user.click(screen.getByRole("button", { name: /crear investigación/i }));
    expect(await screen.findByText(/no se pudo confirmar la autorización/i)).toBeInTheDocument();
    expect(calls.map(requestPath)).toEqual(["/investigations", "/investigations/case-1/authorization"]);
    expect(bodyOf(calls[1]!)).toMatchObject({ granted: true, reason: expect.stringMatching(/semillas actuales y futuras/i) });
    expect(JSON.parse(window.sessionStorage.getItem("investia.creation-recovery.v1")!)).toMatchObject({ consent: true });
    first.unmount();
    render(<App />);
    await screen.findByRole("button", { name: /reintentar correos pendientes/i });
    await waitFor(() => expect(screen.queryByText(/comprobando los correos/i)).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /reintentar correos pendientes/i }));
    await screen.findByRole("heading", { name: "Cuaderno de otoño" });
    expect(calls.filter((call) => requestPath(call) === "/investigations")).toHaveLength(1);
    expect(calls.filter((call) => requestPath(call).endsWith("/authorization"))).toHaveLength(failure === "response_lost" ? 1 : 2);
    expect(calls.filter((call) => requestPath(call).endsWith("/emails"))).toHaveLength(1);
  });
  it.each([false, true])("reconcilia semillas completas sin perder autorización pendiente ni reautorizar una revocación (recibo %s)", async (confirmed) => {
    window.sessionStorage.setItem("investia.creation-recovery.v1", JSON.stringify({ version: 1, phase: "partial", name: "Caso",
      intention: "Revisar", advancementMode: "automatic", emails: ["uno@example.test"], completedEmails: ["uno@example.test"],
      investigationId: "case-1", consent: true, authorizationConfirmed: confirmed }));
    const { calls } = installFetch(async (call) => json({ ...investigation(["uno@example.test"]),
      ...(confirmed || requestPath(call).endsWith("/authorization") ? { authorization: { granted: !confirmed, at: createdAt, reason: "Cambio", operator: "local-operator" } } : {}) }));
    routeTo("#/nueva");
    const user = userEvent.setup();
    render(<App />);
    if (!confirmed) {
      await screen.findByText(/autorización pendiente de confirmación/i);
      expect(window.location.hash).toBe("#/nueva");
      await user.click(screen.getByRole("button", { name: /reintentar correos pendientes/i }));
    }
    await screen.findByRole("heading", { name: "Cuaderno de otoño" });
    expect(calls.filter((call) => requestPath(call).endsWith("/authorization"))).toHaveLength(confirmed ? 0 : 1);
    expect(calls.filter((call) => call.init?.method === "POST" && !requestPath(call).endsWith("/authorization"))).toHaveLength(0);
  });
  it.each(["automatic", "manual"])("exige intención y recupera el borrador con modo %s", async (mode) => {
    const { calls } = installFetch(async () => { throw new Error("respuesta incierta"); });
    routeTo("#/nueva");
    const user = userEvent.setup();
    render(<App />);
    await user.type(screen.getByLabelText(/nombre de la investigación/i), "Caso");
    await user.type(screen.getByLabelText(/correo electrónico 1/i), "ana@example.test");
    await user.click(screen.getByRole("button", { name: /crear investigación/i }));
    expect(await screen.findByText("Ingresá la intención de la investigación.")).toBeInTheDocument();
    expect(calls).toHaveLength(0);
    await user.type(screen.getByLabelText(/intención de la investigación/i), "  Verificar exposición  ");
    if (mode === "manual") await user.click(screen.getByRole("checkbox", { name: /avance manual/i }));
    await user.click(screen.getByRole("button", { name: /crear investigación/i }));
    await screen.findByText(/No se pudo confirmar si se creó/i);
    expect(bodyOf(calls[0]!)).toEqual({ name: "Caso", intention: "Verificar exposición", advancementMode: mode });
    expect(JSON.parse(window.sessionStorage.getItem("investia.creation-recovery.v1")!)).toMatchObject({
      intention: "Verificar exposición", advancementMode: mode,
    });
    cleanup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: /Ya revisé el historial/i }));
    expect(screen.getByLabelText(/intención de la investigación/i)).toHaveValue("Verificar exposición");
    expect(screen.getByRole("checkbox", { name: /avance manual/i })).toHaveProperty("checked", mode === "manual");
    expect(calls).toHaveLength(1);
  });
  it("valida nombres Unicode acotados y todos los correos antes de crear", async () => {
    const { calls } = installFetch(async () => json(investigation()));
    routeTo("#/nueva");
    const user = userEvent.setup();
    render(<App />);

    fireEvent.change(screen.getByLabelText(/nombre de la investigación/i), { target: { value: "🧭".repeat(121) } });
    await user.type(screen.getByLabelText(/correo electrónico 1/i), "valido@example.test");
    await user.click(screen.getByRole("button", { name: /agregar correo/i }));
    await user.type(screen.getByLabelText(/correo electrónico 2/i), "no-es-un-email");
    await user.click(screen.getByRole("button", { name: /crear investigación/i }));

    expect(await screen.findByText("El nombre debe tener hasta 120 caracteres.")).toBeInTheDocument();
    expect(screen.getByText(/correo electrónico válido/i)).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it("enfoca el campo real del nombre cuando el nombre es inválido", async () => {
    const { calls } = installFetch(async () => json(investigation()));
    routeTo("#/nueva");
    const user = userEvent.setup();
    render(<App />);

    const nameInput = screen.getByLabelText(/nombre de la investigación/i);
    await user.type(screen.getByLabelText(/correo electrónico 1/i), "valido@example.test");
    await user.click(screen.getByRole("button", { name: /crear investigación/i }));

    expect(await screen.findByText("Ingresá un nombre para la investigación.")).toBeInTheDocument();
    await waitFor(() => expect(nameInput).toHaveFocus());
    expect(calls).toHaveLength(0);
  });

  it("crea el nombre y varias semillas email sin proponer, autorizar ni ejecutar acciones", async () => {
    const callsData: Array<{ path: string; body: unknown }> = [];
    installFetch(async (call) => {
      const path = requestPath(call);
      callsData.push({ path, body: bodyOf(call) });
      if (path === "/investigations") return json(investigation());
      if (path === "/investigations/case-1") return json(investigation(["uno@example.test", "dos+prueba@example.test"]));
      if (path.endsWith("/emails")) return json(investigation(["uno@example.test", "dos+prueba@example.test"]));
      throw new Error(`Unexpected request ${path}`);
    });
    routeTo("#/nueva");
    const user = userEvent.setup();
    render(<App />);

    await user.type(screen.getByLabelText(/intención de la investigación/i), "Verificar registro");
    const boundedUnicodeName = "🧭".repeat(120);
    fireEvent.change(screen.getByLabelText(/nombre de la investigación/i), { target: { value: `  ${boundedUnicodeName}  ` } });
    await user.type(screen.getByLabelText(/correo electrónico 1/i), "uno@example.test");
    expect(screen.getByRole("button", { name: "Quitar correo 1" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /agregar correo/i }));
    await user.type(screen.getByLabelText(/correo electrónico 2/i), "dos+prueba@example.test");
    await user.click(screen.getByRole("button", { name: /crear investigación/i }));

    expect(await screen.findByText("case-1")).toBeInTheDocument();
    expect(callsData.map(({ path }) => path)).toEqual([
      "/investigations",
      "/investigations/case-1/emails",
      "/investigations/case-1/emails",
      "/investigations/case-1",
    ]);
    expect(callsData.map(({ body }) => body)).toEqual([
      { name: boundedUnicodeName, intention: "Verificar registro", advancementMode: "automatic" },
      { email: "uno@example.test", reason: expect.any(String) },
      { email: "dos+prueba@example.test", reason: expect.any(String) },
      undefined,
    ]);
    expect(callsData.every(({ path }) => !/authorization|proposals|actions\/run/u.test(path))).toBe(true);
  });

  it("bloquea envíos dobles mientras la creación sigue pendiente", async () => {
    let finishCreate!: (response: Response) => void;
    const createPending = new Promise<Response>((resolve) => { finishCreate = resolve; });
    const { calls } = installFetch(async (call) => {
      if (requestPath(call) === "/investigations") return createPending;
      return json(investigation(["uno@example.test"]));
    });
    routeTo("#/nueva");
    const user = userEvent.setup();
    render(<App />);
    await user.type(screen.getByLabelText(/intención de la investigación/i), "Verificar registro");
    await user.type(screen.getByLabelText(/nombre de la investigación/i), "Caso único");
    await user.type(screen.getByLabelText(/correo electrónico 1/i), "uno@example.test");
    await user.dblClick(screen.getByRole("button", { name: /crear investigación/i }));

    expect(calls.filter((call) => requestPath(call) === "/investigations")).toHaveLength(1);
    finishCreate(json(investigation()));
    expect(await screen.findByText("case-1")).toBeInTheDocument();
  });

  it("conserva el progreso parcial y reintenta solo semillas aún ausentes tras releer", async () => {
    let serverEmails: string[] = [];
    let failedSecondPost = false;
    const calls: CapturedCall[] = [];
    installFetch(async (call) => {
      calls.push(call);
      const path = requestPath(call);
      if (path === "/investigations") return json(investigation());
      if (path === "/investigations/case-1") return json(investigation(serverEmails));
      if (path.endsWith("/emails")) {
        const email = (bodyOf(call) as { email: string }).email;
        if (email === "dos@example.test" && !failedSecondPost) {
          failedSecondPost = true;
          return json({ error: "UNAVAILABLE", message: "offline" }, 503);
        }
        serverEmails = [...serverEmails, email];
        return json(investigation(serverEmails));
      }
      throw new Error(`Unexpected request ${path}`);
    });
    routeTo("#/nueva");
    const user = userEvent.setup();
    render(<App />);
    await user.type(screen.getByLabelText(/intención de la investigación/i), "Verificar registro");
    await user.type(screen.getByLabelText(/nombre de la investigación/i), "Recuperable");
    await user.type(screen.getByLabelText(/correo electrónico 1/i), "uno@example.test");
    await user.click(screen.getByRole("button", { name: /agregar correo/i }));
    await user.type(screen.getByLabelText(/correo electrónico 2/i), "dos@example.test");
    await user.click(screen.getByRole("button", { name: /crear investigación/i }));
    expect(await screen.findByText(/se guardó 1 de 2 correos/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /reintentar correos pendientes/i }));
    expect(await screen.findByText("case-1")).toBeInTheDocument();
    const emailPosts = calls.filter((call) => requestPath(call).endsWith("/emails"));
    expect(emailPosts.map((call) => (bodyOf(call) as { email: string }).email)).toEqual([
      "uno@example.test",
      "dos@example.test",
      "dos@example.test",
    ]);
    expect(calls.some((call) => requestPath(call) === "/investigations/case-1")).toBe(true);
  });

  it("al recargar reconcilia una respuesta incierta de email sin duplicar la semilla", async () => {
    let serverEmails: string[] = [];
    let failOnce = false;
    const calls: CapturedCall[] = [];
    installFetch(async (call) => {
      calls.push(call);
      const path = requestPath(call);
      if (path === "/investigations") return json(investigation());
      if (path === "/investigations/case-1") return json(investigation(serverEmails));
      if (path.endsWith("/emails")) {
        const email = (bodyOf(call) as { email: string }).email;
        serverEmails = [...serverEmails, email];
        if (email === "dos@example.test" && !failOnce) {
          failOnce = true;
          return json({ error: "UNAVAILABLE", message: "response lost" }, 503);
        }
        return json(investigation(serverEmails));
      }
      throw new Error(`Unexpected request ${path}`);
    });
    routeTo("#/nueva");
    const user = userEvent.setup();
    const firstRender = render(<App />);
    await user.type(screen.getByLabelText(/intención de la investigación/i), "Verificar registro");
    await user.type(screen.getByLabelText(/nombre de la investigación/i), "Carga parcial");
    await user.type(screen.getByLabelText(/correo electrónico 1/i), "uno@example.test");
    await user.click(screen.getByRole("button", { name: /agregar correo/i }));
    await user.type(screen.getByLabelText(/correo electrónico 2/i), "dos@example.test");
    await user.click(screen.getByRole("button", { name: /crear investigación/i }));
    expect(await screen.findByText(/se guardó 1 de 2 correos/i)).toBeInTheDocument();
    firstRender.unmount();

    render(<App />);
    expect(await screen.findByText("case-1")).toBeInTheDocument();
    expect(calls.filter((call) => requestPath(call).endsWith("/emails"))).toHaveLength(2);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("no reintenta automáticamente una creación HTTP ambigua y conserva la guía de historial", async () => {
    const { calls } = installFetch(async (call) => {
      if (requestPath(call) === "/investigations") {
        return json({ error: "UNAVAILABLE", message: "response lost" }, 503);
      }
      return json([]);
    });
    routeTo("#/nueva");
    const user = userEvent.setup();
    const firstRender = render(<App />);
    await user.type(screen.getByLabelText(/intención de la investigación/i), "Verificar registro");
    await user.type(screen.getByLabelText(/nombre de la investigación/i), "Posible alta");
    await user.type(screen.getByLabelText(/correo electrónico 1/i), "uno@example.test");
    await user.click(screen.getByRole("button", { name: /crear investigación/i }));

    expect(await screen.findByText(/no se pudo confirmar si se creó/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /revisar historial/i })).toHaveAttribute("href", "#/");
    firstRender.unmount();
    render(<App />);

    expect(await screen.findByText(/no se pudo confirmar si se creó/i)).toBeInTheDocument();
    expect(calls.filter((call) => requestPath(call) === "/investigations")).toHaveLength(1);
  });
});
