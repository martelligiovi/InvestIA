import assert from "node:assert/strict";
import test from "node:test";
import { deferredTools } from "../src/main.ts";

test("GHunt and FaceCheck readiness defer their tools independently", () => {
  assert.deepEqual(deferredTools({ ghuntConnected: true, facecheckTokenConfigured: true }), []);
  assert.deepEqual(deferredTools({ ghuntConnected: false, facecheckTokenConfigured: true }), ["ghunt.email.v1"]);
  assert.deepEqual(deferredTools({ ghuntConnected: true, facecheckTokenConfigured: false }), ["facecheck.photo.v1"]);
  assert.deepEqual(deferredTools({ ghuntConnected: false, facecheckTokenConfigured: false }), ["ghunt.email.v1", "facecheck.photo.v1"]);
});
