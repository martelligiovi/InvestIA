import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("Docker installs the pinned Maigret manifest into its own venv and points the runner at it", () => {
  const docker = read("../../../Dockerfile");
  assert.match(docker, /python3 -m venv \/opt\/venv-maigret/);
  assert.match(docker, /\/opt\/venv-maigret\/bin\/python -m pip install --no-cache-dir -r packages\/adapter-maigret\/python\/requirements\.txt/);
  assert.match(docker, /COPY --from=build \/opt\/venv-maigret \/opt\/venv-maigret/);
  assert.match(docker, /MAIGRET_PYTHON=\/opt\/venv-maigret\/bin\/python/);
  assert.match(docker, /RUN install -d -m 0700 -o node -g node \/app\/\.scanner-runs \/app\/\.maigret-runs/);
  assert.ok(docker.indexOf("/app/.maigret-runs") < docker.indexOf("USER node"));
});

test("the Docker context includes the Maigret manifest, and the manifest pins every dependency", () => {
  const ignore = read("../../../.dockerignore");
  assert.match(ignore, /^!packages\/adapter-maigret\/python\/$/m);
  assert.match(ignore, /^!packages\/adapter-maigret\/python\/requirements\.txt$/m);
  const manifest = read("../python/requirements.txt");
  assert.match(manifest, /^maigret==0\.6\.6$/m);
  const pins = manifest.split(/\r?\n/).filter((line) => line && !line.startsWith("#"));
  assert.ok(pins.length > 1);
  assert.ok(pins.every((line) => /^[\w.-]+==[\w.]+$/.test(line)), "every line is an exact pin");
});

test("CI installs Maigret in its own venv and checks its CLI without scanning targets", () => {
  const ci = read("../../../../.github/workflows/ci.yml");
  assert.match(ci, /python -m venv .*venv-maigret/);
  assert.match(ci, /venv-maigret\/bin\/python -m pip install --no-cache-dir -r APP\/packages\/adapter-maigret\/python\/requirements\.txt/);
  assert.match(ci, /venv-maigret\/bin\/python -B -m unittest discover -s APP\/packages\/adapter-maigret\/python\/tests -p test_cli_installation\.py -v/);
});
