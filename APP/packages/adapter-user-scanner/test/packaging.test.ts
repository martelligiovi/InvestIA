import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("Docker provisions a private scanner directory for the non-root runtime", () => {
  const docker = readFileSync(new URL("../../../Dockerfile", import.meta.url), "utf8");
  assert.match(docker, /RUN install -d -m 0700 -o node -g node \/app\/\.scanner-runs/);
  assert.ok(docker.indexOf("RUN install -d") < docker.indexOf("USER node"));
  assert.match(docker, /^USER node$/m);
});

test("Docker context includes the pinned scanner manifest and excludes the removed bridge", () => {
  const ignore = readFileSync(new URL("../../../.dockerignore", import.meta.url), "utf8");
  const docker = readFileSync(new URL("../../../Dockerfile", import.meta.url), "utf8");
  const manifest = readFileSync(new URL("../python/requirements.txt", import.meta.url), "utf8");
  assert.match(ignore, /^!packages\/adapter-user-scanner\/python\/requirements\.txt$/m);
  assert.doesNotMatch(ignore + docker + manifest, /adapter-holehe|holehe_bridge|holehe==/);
  assert.match(docker, /packages\/adapter-user-scanner\/python\/requirements\.txt/);
  assert.match(docker, /COPY --from=build \/opt\/venv \/opt\/venv/);
  assert.match(docker, /PATH="\/opt\/venv\/bin:/);
  assert.match(manifest, /^user-scanner==1\.5\.2\.1$/m);
  assert.ok(manifest.split(/\r?\n/).filter((line) => line && !line.startsWith("#")).every((line) => /^[\w.-]+==[\w.]+$/.test(line)));
});
