# Local frontend

Use Vite at `127.0.0.1:5173` for development, or build once and let the loopback backend serve the frontend and API from the same origin. The frontend uses hash routes and relative `/investigations` API paths, so production-style local serving does not need CORS or an SPA fallback.

## Full stack without a dev server

From `APP/`, run `docker compose up -d --build` and open http://127.0.0.1:4317. The app image builds and bundles this frontend beside the backend's TS sources; there is no separate Vite container. Relative API calls are same-origin, with no CORS or proxy setup required. The image also provisions the Linux Python bridge, so the host venv instructions below apply only to native development.

For an occupied app port, local placeholder credentials, and preservation of database volumes, use the [root Compose quick path](../../README.md#one-command-full-stack-docker-desktop--linux-containers). Verify by loading the UI and history only; do not dispatch real investigation/provider actions.

## Backend Python runtime (native alternative)

The same-origin frontend is served by the real backend, whose explicitly dispatched Holehe adapter uses the pinned Python dependencies in the ignored checkout-local `APP/.venv`. Provision the environment from the repository root; do not install globally or change manifest versions silently.

**Windows PowerShell:**

```powershell
python -m venv APP/.venv
APP\.venv\Scripts\python.exe -m pip install -r APP\packages\adapter-holehe\python\requirements.txt
$env:PYTHON = (Resolve-Path APP\.venv\Scripts\python.exe).Path
```

**Bash on Windows:**

```bash
python -m venv APP/.venv
APP/.venv/Scripts/python.exe -m pip install -r APP/packages/adapter-holehe/python/requirements.txt
export PYTHON="$PWD/APP/.venv/Scripts/python.exe"
```

**POSIX:**

```bash
python3 -m venv APP/.venv
APP/.venv/bin/python -m pip install -r APP/packages/adapter-holehe/python/requirements.txt
export PYTHON="$PWD/APP/.venv/bin/python"
```

Keep `PYTHON` set in the same shell as the backend. Vite and the offline UI tests do not call Holehe; backend startup also makes no account queries.

## Development

From the repository root, start the backend in one shell using the [backend setup](../backend/README.md), then run:

```powershell
pnpm --dir APP frontend:dev
```

The Vite server is loopback-only and proxies `/investigations` to `127.0.0.1:4317`. These commands are the same in Bash. Backend process environment variables, including `PYTHON`, must be set explicitly in the shell; Node does not automatically load `.env` or `.env.example`. Use the interpreter path appropriate to the host as shown above.

## Build and same-origin serving

From the repository root:

```powershell
pnpm --dir APP build
pnpm --dir APP start
```

`build` creates `packages/frontend/dist`; `start` runs the backend, which serves `/`, `/index.html`, and built assets on `127.0.0.1:4317`. The frontend build is optional for API-only startup: when it is missing, the backend prints a notice and API routes still work. Unknown assets and unknown API paths or methods return JSON 404s; unknown browser routes are handled by the frontend's hash router after `/` loads.

The same commands work in Bash. For the required PostgreSQL and Neo4j variables in PowerShell and Bash, see [backend local setup](../backend/README.md). Backend startup itself does not query accounts; do not execute an investigation action or use live accounts to verify the UI.

## Verification

Frontend unit tests, typecheck, and production build are independent of database services:

```powershell
pnpm --dir APP frontend:test
pnpm --dir APP frontend:typecheck
pnpm --dir APP build
```

Run backend static-serving/API regression checks separately:

```powershell
pnpm --dir APP --filter @investia/backend test
pnpm --dir APP --filter @investia/backend typecheck
```

The backend suite includes five database-gated tests. When test database variables are absent, those tests skip; skips are not evidence of PostgreSQL or Neo4j behavior. The frontend checks do not need those variables.

## Real-browser acceptance (Chromium)

From the repository root, install workspace dependencies and the local Chromium browser, then build the production frontend before running the same-origin browser suite:

```powershell
pnpm --dir APP install
pnpm --dir APP --filter @investia/frontend exec playwright install chromium
pnpm --dir APP --filter @investia/frontend build
pnpm --dir APP --filter @investia/frontend test:e2e
```

The Playwright server uses the actual Vite build and `createBackendApp` on `127.0.0.1:4327`, with a test-only fake GitHub observer and isolated in-memory store. It never calls external accounts and does not enable a production fake-executor flag or add production routes. Browser screenshots and the HTML report are written under the ignored `packages/frontend/test-results/` directory. The test server uses this port exclusively and will fail rather than attach to an unrelated process.

## Latest observed acceptance status

The independent acceptance record reports **110 TypeScript tests passed (0 failed, 0 skipped), 1 Chromium scenario passed, and all 4 workspace package typechecks passed**; all 5 database-gated checks ran and the named runtime reload was verified. The separate offline Python adapter suite has now passed all **5 tests**. The Chromium scenario demonstrates behavior, not identical visuals: corrected desktop/mobile screenshots were independently inspected, and title wrapping, CTA visibility, ornament spacing and linen texture passed MVP acceptance. This is a usable interpretation of the references; no pixel-identical claim is made.
