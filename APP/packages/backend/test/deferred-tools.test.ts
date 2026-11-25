import assert from "node:assert/strict";
import test from "node:test";
import { deferredTools } from "../src/main.ts";

test("GHunt and FaceCheck readiness defer their tools independently", () => {
  assert.deepEqual(deferredTools({ ghuntConnected: true, facecheckTokenConfigured: true, decodoTokenConfigured: true }), []);
  assert.deepEqual(deferredTools({ ghuntConnected: false, facecheckTokenConfigured: true, decodoTokenConfigured: true }), ["ghunt.email.v1"]);
  assert.deepEqual(deferredTools({ ghuntConnected: true, facecheckTokenConfigured: false, decodoTokenConfigured: true }), ["facecheck.photo.v1"]);
  assert.deepEqual(deferredTools({ ghuntConnected: false, facecheckTokenConfigured: false, decodoTokenConfigured: true }), ["ghunt.email.v1", "facecheck.photo.v1"]);
});

test("Decodo waits for a token independently of other tools", () => {
  assert.deepEqual(deferredTools({ ghuntConnected: true, facecheckTokenConfigured: true, decodoTokenConfigured: false }), ["decodo.url.v1"]);
  assert.deepEqual(deferredTools({ ghuntConnected: false, facecheckTokenConfigured: false, decodoTokenConfigured: false }), ["ghunt.email.v1", "facecheck.photo.v1", "decodo.url.v1"]);
});
