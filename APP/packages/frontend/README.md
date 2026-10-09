# Local frontend

Use Vite at `127.0.0.1:5173` for development, or build once and let the loopback backend serve the frontend and API from the same origin. The frontend uses hash routes and relative `/investigations` API paths, so production-style local serving does not need CORS or an SPA fallback.

## Full stack without a dev server

From `APP/`, run `docker compose up -d --build` and open http://127.0.0.1:4317. The app image builds and bundles this frontend beside the backend's TS sources; there is no separate Vite container. Relative API calls are same-origin, with no CORS or proxy setup required. The image also provisions the Linux Python bridge, so the host venv instructions below apply only to native development.

For an occupied app port, local placeholder credentials, and preservation of database volumes, use the [root Compose quick path](../../README.md#one-command-full-stack-docker-desktop--linux-containers). Verify by loading the UI and history only; do not dispatch real investigation/provider actions.

## Backend Python runtime (native alternative)

The same-origin frontend is served by the real backend, whose authorized Holehe adapter uses the pinned Python dependencies in the ignored checkout-local `APP/.venv`. Provision the environment from the repository root; do not install globally or change manifest versions silently.

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

Keep `PYTHON` set in the same shell as the backend. Vite and offline UI tests do not call Holehe. Backend startup resumes authorized, unpaused automatic queues and can query providers without a browser; use test-only executors for acceptance rather than authorizing real accounts.

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

The same commands work in Bash. For the required PostgreSQL and Neo4j variables in PowerShell and Bash, see [backend local setup](../backend/README.md). Backend startup resumes eligible automatic work; do not authorize real investigations or use live accounts to verify the UI.

## Research progression

Creation collects the research intention once and defaults to automatic advancement. Select **Elegir avance manual** at instantiation to require the case-level **Ejecutar siguiente acción en cola** control. Missing legacy mode remains manual; mode is not changed later in the workspace.

New email seeds receive catalog queue entries on the backend without per-node proposal, research-motive, approval, or advance controls. Automatic progression belongs entirely to the server: the workspace only refreshes snapshots while work is eligible or claimed, never polls an execution endpoint. Closing the browser does not stop the worker. Manual mode uses run-next for the case queue, not the selected graph node, without a separate node approval.

Creation offers **Autorizar consultas del catálogo**, unchecked by default. Checking it explicitly authorizes present and future catalog seeds in that case until revocation; the generated audit reason records this scope. The existing authorization API must confirm the grant before any initial email seeds are queued. Unchecked creation and existing cases stay unapproved. A failed/uncertain grant stops seed submission and keeps consent in the session recovery record. Retry reads the existing case first, reconciles any saved grant (or revocation), then submits only absent seeds; it never resends case creation automatically or overwrites a recorded revocation. The recovery receipt is session-local, not a cross-browser creation idempotency key.

Case authorization, pause/resume, and evidence validation remain independent controls with their own audit reasons. Pause or revocation blocks new claims but does not cancel an in-flight provider call. Historical proposal/approval provenance remains readable; old proposed actions are not silently approved. Claimed actions with unknown outcomes and terminal failures are never offered as retries.

## Action results

Every terminal action has a connected result: persisted supported observations remain evidence rectangles with actual provider, registration status, source and validation history. Execution failures gain a derived red circle with an X and selectable, wrapped error details. Successful actions without admitted evidence gain a derived **Sin información admitida** rectangle, including the unsupported-observation count when recorded. These derived results are not persisted evidence and cannot be validated; no information does not imply `not_registered`. Queued/claimed actions never synthesize outcomes. Queue labels distinguish waiting authorization, pause and non-executable historical entries; the workspace headline describes gates or claimed uncertainty rather than claiming the case is active or concluded.

Mocked browser fixtures in `e2e/acceptance.spec.ts` cover checked creation through information, failure and empty results, plus unchecked blocked queues. They intercept investigation API traffic, deny external origins and never call a real provider. Independent browser/build verification remains separate from writer unit/typecheck evidence.

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

The Playwright server uses the actual Vite build and `createBackendApp` on `127.0.0.1:4327`, the real `AutomaticInvestigationRunner`, a test-only fake GitHub observer, and an isolated in-memory store implementing catalog eligibility and automatic-mode claim checks. Acceptance covers creation intention, manual run-next without node approvals, automatic draining without browser execution requests, independent authorization/pause/revocation gates, evidence validation, and the existing responsive/graph/report behaviors. The in-memory store is not evidence of real PostgreSQL concurrency. It never calls external accounts and does not enable a production fake-executor flag or add production routes. Browser screenshots and the HTML report are written under the ignored `packages/frontend/test-results/` directory. The test server uses this port exclusively and will fail rather than attach to an unrelated process.

## Automatic progression writer verification

T2 writer checks passed: **59 frontend unit tests**, **2 Chromium scenarios**, workspace typecheck, and production build. Core/backend checks passed **21/29** tests with the backend's **5 database-gated tests skipped**. Browser acceptance retained the existing viewport, clipping, ornament, touch, graph, and report assertions. Creation metadata now uses a compact desktop layout with a correctly sized manual-mode checkbox; the desktop CTA bottom measured **929.05px** within the unchanged **941px** viewport bound. These are writer results, not independent T3 closure or real-database evidence.

## Historical independent MVP acceptance

The independent acceptance record reports **110 TypeScript tests passed (0 failed, 0 skipped), 1 Chromium scenario passed, and all 4 workspace package typechecks passed**; all 5 database-gated checks ran and the named runtime reload was verified. The separate offline Python adapter suite has now passed all **5 tests**. The Chromium scenario demonstrates behavior, not identical visuals: corrected desktop/mobile screenshots were independently inspected, and title wrapping, CTA visibility, ornament spacing and linen texture passed MVP acceptance. This is a usable interpretation of the references; no pixel-identical claim is made.
