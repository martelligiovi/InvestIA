import assert from "node:assert/strict";
import test from "node:test";
import { GhuntSessionError, type GhuntSession, type GhuntSessionStatus } from "../../adapter-ghunt/src/index.ts";
import { createBackendApp } from "../src/api.ts";

const local = { host: "127.0.0.1:4317", origin: "http://127.0.0.1:4317", "sec-fetch-site": "same-origin" };

function fakeSession(connectFailure?: GhuntSessionError) {
  let current: GhuntSessionStatus = { state: "requires_connection", account: null };
  const codes: string[] = [];
  const session: GhuntSession = {
    async status() { return current; },
    async connect(code) {
      codes.push(code);
      if (connectFailure) throw connectFailure;
      current = { state: "connected", account: "owner@gmail.com" };
      return current;
    },
    async disconnect() { current = { state: "requires_connection", account: null }; return current; },
    async exclusive(operation) { return operation(); },
    async markInvalid() { current = { ...current, state: "invalid_session" }; },
  };
  return { session, codes, get current() { return current; } };
}

function app(session: GhuntSession | undefined) {
  return createBackendApp({} as never, { actionRunner: {} as never, projector: {} as never, ghunt: { session } });
}

test("Google session status, connect and disconnect from the local page", async (t) => {
  const fake = fakeSession();
  const server = app(fake.session);
  t.after(() => server.close());
  assert.deepEqual((await server.inject({ method: "GET", url: "/settings/ghunt", headers: local })).json(), { available: true, state: "requires_connection", account: null });
  const connected = await server.inject({ method: "POST", url: "/settings/ghunt/session", headers: local, payload: { code: "Y29kZQ==" } });
  assert.equal(connected.statusCode, 200);
  assert.deepEqual(connected.json(), { available: true, state: "connected", account: "owner@gmail.com" });
  assert.deepEqual(fake.codes, ["Y29kZQ=="]);
  assert.equal(connected.body.includes("Y29kZQ=="), false);
  const removed = await server.inject({ method: "DELETE", url: "/settings/ghunt/session", headers: local });
  assert.deepEqual(removed.json(), { available: true, state: "requires_connection", account: null });
});

test("Vite's same-origin dev proxy and origin-less local requests are accepted", async (t) => {
  const server = app(fakeSession().session);
  t.after(() => server.close());
  for (const headers of [{ host: "127.0.0.1:5173", origin: "http://127.0.0.1:5173" }, { host: "localhost:4318" }, { host: "[::1]:4317", "sec-fetch-site": "none" }]) {
    assert.equal((await server.inject({ method: "GET", url: "/settings/ghunt", headers })).statusCode, 200, JSON.stringify(headers));
  }
});

test("cross-site and rebinding requests cannot read or change the Google session", async (t) => {
  const fake = fakeSession();
  const server = app(fake.session);
  t.after(() => server.close());
  const hostile = [
    { host: "127.0.0.1:4317", origin: "https://evil.example" },
    { host: "127.0.0.1:4317", origin: "http://127.0.0.1:9999" },
    { host: "127.0.0.1:4317", origin: "null" },
    { host: "127.0.0.1:4317", "sec-fetch-site": "cross-site" },
    { host: "127.0.0.1:4317", "sec-fetch-site": "same-site" },
    { host: "evil.example:4317", origin: "http://evil.example:4317" },
    { host: "user:pw@127.0.0.1:4317" },
  ];
  for (const headers of hostile) {
    for (const [method, url] of [["GET", "/settings/ghunt"], ["POST", "/settings/ghunt/session"], ["DELETE", "/settings/ghunt/session"]] as const) {
      const response = await server.inject({ method, url, headers, ...(method === "POST" ? { payload: { code: "Y29kZQ==" } } : {}) });
      assert.equal(response.statusCode, 403, `${method} ${JSON.stringify(headers)}`);
      assert.equal(response.json().error, "FORBIDDEN");
    }
  }
  assert.deepEqual(fake.codes, []);
  assert.equal(fake.current.state, "requires_connection");
});

test("connection failures map to public messages without echoing the code", async (t) => {
  for (const [code, status, error] of [["invalid_code", 400, "GHUNT_INVALID_CODE"], ["rejected", 502, "GHUNT_LOGIN_REJECTED"], ["timeout", 504, "GHUNT_TIMEOUT"], ["busy", 409, "GHUNT_BUSY"], ["process_failure", 502, "GHUNT_UNAVAILABLE"]] as const) {
    const fake = fakeSession(new GhuntSessionError(code));
    const server = app(fake.session);
    t.after(() => server.close());
    const response = await server.inject({ method: "POST", url: "/settings/ghunt/session", headers: local, payload: { code: "c2VjcmV0" } });
    assert.equal(response.statusCode, status);
    assert.equal(response.json().error, error);
    assert.equal(response.body.includes("c2VjcmV0"), false);
    assert.equal(fake.current.state, "requires_connection");
  }
});

test("malformed bodies are rejected before reaching GHunt", async (t) => {
  const fake = fakeSession();
  const server = app(fake.session);
  t.after(() => server.close());
  for (const payload of [{}, { code: "" }, { code: 1 }, { code: "x", extra: true }, { code: "x".repeat(16_385) }]) {
    assert.equal((await server.inject({ method: "POST", url: "/settings/ghunt/session", headers: local, payload })).statusCode, 400);
  }
  assert.deepEqual(fake.codes, []);
});

test("without GHunt installed the status says so and connecting is refused", async (t) => {
  const server = app(undefined);
  t.after(() => server.close());
  assert.deepEqual((await server.inject({ method: "GET", url: "/settings/ghunt", headers: local })).json(), { available: false, state: "requires_connection", account: null });
  const response = await server.inject({ method: "POST", url: "/settings/ghunt/session", headers: local, payload: { code: "Y29kZQ==" } });
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error, "GHUNT_NOT_INSTALLED");
});

test("origin-less non-JSON forms cannot connect a Google session", async (t) => {
  const fake = fakeSession();
  const server = app(fake.session);
  t.after(() => server.close());
  for (const [contentType, payload] of [["text/plain", '{"code":"Y29kZQ=="}'], ["application/x-www-form-urlencoded", "code=Y29kZQ%3D%3D"], ["multipart/form-data; boundary=x", "--x\r\nContent-Disposition: form-data; name=\"code\"\r\n\r\nY29kZQ==\r\n--x--\r\n"]] as const) {
    const response = await server.inject({ method: "POST", url: "/settings/ghunt/session", headers: { host: "127.0.0.1:4317", "content-type": contentType }, payload });
    assert.ok([400, 415].includes(response.statusCode), `${contentType} -> ${response.statusCode}`);
  }
  assert.deepEqual(fake.codes, []);
});
