# Local frontend

Use Vite at `127.0.0.1:5173` for development, or build once and let the loopback backend serve the frontend and API from the same origin. The frontend uses hash routes and relative `/investigations` API paths, so production-style local serving does not need CORS or an SPA fallback.

## Interface design

`src/styles/interface.css` is the final presentation layer: warm neutral surfaces, editorial headings, system UI typography for controls and data, and restrained red accents. It adapts the inherited design to the current sectioned creation form, compact workspace header, light-dismiss controls and detail drawer, without changing routes or graph scale. Decorative stamps and separators are hidden; their surrounding content remains accessible.

`src/styles/settings.css` defines the integration cards and the responsive index on **Ajustes** (`#/ajustes`). The index is sticky on desktop and wraps above the cards on smaller screens. Its buttons move focus to their cards without replacing the hash route; `#/ajustes?seccion=ghunt` opens the Google card directly.

`e2e/visual-design.spec.ts` checks navigation, history visibility, compact headings, email controls, graph/detail controls and the settings layout at 1440px, 900px, and 390px. Screenshots are written to the ignored `test-results/redesign/` directory. The acceptance suite covers complete workflows.

## Seeds, actions and grouped leaves

The starting email is an operator seed and remains the only accepted input type. Every recorded finding is also a seed (for example, a reported Canva registration), with provenance from its producing action. `investigationSeedGraph` in core derives these identities from existing records without migrating stored investigations or queuing new actions. An action may explicitly name a `sourceSeedId`; otherwise its embedded operator email is its input. Matching discovered values never establishes a causal edge.

Two or more seeds without actions produced by the same action appear as one paper stack. The two rotated sheets are decorative, not a count of records. Seeds with actions remain separate branches; a single leaf ordinarily keeps its own card. Select a stack to browse its results, 50 per detail page, then open any result for full provenance and human validation. **Volver al grupo** returns to the stack without expanding the graph or issuing requests. Errors and empty results retain their existing presentation. Keyboard selection, centering and zoom remain available.

## Full stack without a dev server

From `APP/`, run `docker compose up -d --build` and open http://127.0.0.1:4317. The app image builds and bundles this frontend beside the backend's TS sources; there is no separate Vite container. Relative API calls are same-origin, with no CORS or proxy setup required. The image also provisions the Linux Python CLI, so the host venv instructions below apply only to native development.

For an occupied app port, local placeholder credentials, and preservation of database volumes, use the [root Compose quick path](../../README.md#one-command-full-stack-docker-desktop--linux-containers). Verify by loading the UI and history only; do not dispatch real investigation/provider actions.

## Backend Python runtime (native alternative)

The same-origin frontend is served by the real backend, whose authorized User Scanner adapter uses the pinned Python dependencies in the ignored checkout-local `APP/.venv-user-scanner`. Provision the environment from the repository root; do not install globally or change manifest versions silently.

**Windows PowerShell:**

```powershell
python -m venv APP/.venv-user-scanner
APP\.venv-user-scanner\Scripts\python.exe -m pip install -r APP\packages\adapter-user-scanner\python\requirements.txt
$env:PYTHON = (Resolve-Path APP\.venv-user-scanner\Scripts\python.exe).Path
```

**Bash on Windows:**

```bash
python -m venv APP/.venv-user-scanner
APP/.venv-user-scanner/Scripts/python.exe -m pip install -r APP/packages/adapter-user-scanner/python/requirements.txt
export PYTHON="$PWD/APP/.venv-user-scanner/Scripts/python.exe"
```

**POSIX:**

```bash
python3 -m venv APP/.venv-user-scanner
APP/.venv-user-scanner/bin/python -m pip install -r APP/packages/adapter-user-scanner/python/requirements.txt
export PYTHON="$PWD/APP/.venv-user-scanner/bin/python"
```

Keep `PYTHON` set in the same shell as the backend. Vite and offline UI tests do not call User Scanner. Backend startup resumes authorized, unpaused automatic queues and can query providers without a browser; use test-only executors for acceptance rather than authorizing real accounts.

## Development

From the repository root, start the backend in one shell using the [backend setup](../backend/README.md), then run:

```powershell
pnpm --dir APP frontend:dev
```

The Vite server is loopback-only and proxies `/investigations` and `/settings` to `127.0.0.1:4317`; set `INVESTIA_API_TARGET` (for example `http://127.0.0.1:4318` for a Docker app published on `APP_PORT=4318`) to proxy to another local backend. These commands are the same in Bash. Backend process environment variables, including `PYTHON`, must be set explicitly in the shell; Node does not automatically load `.env` or `.env.example`. Use the interpreter path appropriate to the host as shown above.

## Build and same-origin serving

From the repository root:

```powershell
pnpm --dir APP build
pnpm --dir APP start
```

`build` creates `packages/frontend/dist`; `start` runs the backend, which serves `/`, `/index.html`, and built assets on `127.0.0.1:4317`. The frontend build is optional for API-only startup: when it is missing, the backend prints a notice and API routes still work. Unknown assets and unknown API paths or methods return JSON 404s; unknown browser routes are handled by the frontend's hash router after `/` loads.

The same commands work in Bash. For the required PostgreSQL and Neo4j variables in PowerShell and Bash, see [backend local setup](../backend/README.md). Backend startup resumes eligible automatic work; do not create or authorize real investigations or use live accounts to verify the UI.

## Research progression

The creation form has two sections, **Expediente** and **Semillas iniciales**, and a two-step guide. There is no separate automatic-advancement section or checkbox. Creating an investigation still records the research intention, enables automatic advancement, and authorizes configured catalog tools for current and future seeds. The authorization API must confirm the grant before the frontend adds initial email seeds. User Scanner can send emails or notifications and cross-scan discovered targets. FaceCheck sends the Google profile photo to facecheck.id and can consume credits; Decodo receives only accepted public page URLs.

The backend queues and runs eligible work; the workspace refreshes snapshots without sending execution requests. Closing the browser does not stop the worker. The workspace header keeps **Usernames**, **Pausar / Reanudar**, **Obtener informe**, and **Generar informe con IA**. Recovery controls appear inline only when needed: **Actualizar expediente** for a stale snapshot, **Autorizar expediente** to grant missing authorization with a recorded reason, and **Ejecutar siguiente acción en cola** only for legacy manual cases with eligible queued work. A missing legacy mode still means manual; run-next applies to the case queue, not the selected node.

Each scoped tool requires an active grant that names it, except Decodo also accepts the FaceCheck scope. An old grant that covers only User Scanner does not cover Decodo or other tools. Missing, revoked, or legacy unscoped grants do not cover scoped actions, and unknown catalog IDs are never covered. Pause or revocation blocks new claims but does not cancel an in-flight provider call. Historical proposal and approval provenance remains readable; old proposals are not silently approved. Claimed actions with unknown outcomes and terminal failures are never offered as retries.

If the initial grant fails or its result is uncertain, creation stops before adding emails and keeps a session-local recovery receipt. Retry reads the existing case first, reconciles any saved grant or revocation, and submits only absent seeds. It never recreates the case automatically or overwrites a recorded revocation. The receipt is not a cross-browser idempotency key.

## Action results

The graph renders at most 50 pageable terminal evidence nodes per page, with first/previous/next/last controls and the displayed result range. Evidence seeds that feed actions stay visible on every page, in addition to that limit, so branches never lose their input connections. Sibling leaves appear as paper stacks with separately paginated member details. Seeds, actions and derived terminal results remain connected; pagination does not change or discard stored findings. The SVG canvas uses a fixed 1:1 pixel scale rather than shrinking the page to fit the viewport, including on mobile. Navigate with scrollbars or drag the background; zoom can enlarge nodes but never shrink them below their original size. **Centrar** centers the selected node at its original size instead of fitting all nodes into the viewport. Zoom stays anchored at the viewport center, and selecting a node from the accessible list recenters it at readable scale. The accessible list contains the current page; all results remain reachable through pagination. These controls only affect local presentation and never dispatch actions or alter the investigation.

Every terminal action has a connected result: persisted supported observations remain individually accessible, either as evidence rectangles or inside a sibling leaf stack, with actual provider, status, source and validation history. User Scanner evidence also shows the discovered email/username, original tool status, URL, category, reason, metadata, media references and pivot source/confidence. Unsafe URLs stay text; media URLs are not automatically fetched. These findings are not verified identities or newly queued seeds. Scanner actions have tool-aware labels, while historical GitHub actions retain their original descriptions. Execution failures gain a derived red circle with an X and selectable, wrapped error details. Successful actions without admitted evidence gain a derived **Sin información admitida** rectangle, including the unsupported-observation count when recorded. These derived results are not persisted evidence and cannot be validated; no information does not imply `not_registered`. Queued/claimed actions never synthesize outcomes. Queue labels distinguish waiting authorization, pause and non-executable historical entries; the workspace headline describes gates or claimed uncertainty rather than claiming the case is active or concluded.

Mocked browser fixtures in `e2e/acceptance.spec.ts` cover automatic authorized creation through information, failure and empty results, plus a queue blocked by revocation. They intercept investigation API traffic, deny external origins and never call a real provider. Independent browser/build verification remains separate from writer unit/typecheck evidence.

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

Historical T2 writer checks passed: **59 frontend unit tests**, **2 Chromium scenarios**, workspace typecheck, and production build. Core/backend checks passed **21/29** tests with the backend's **5 database-gated tests skipped**. Browser acceptance retained the existing viewport, clipping, ornament, touch, graph, and report assertions. These are historical writer results, not independent T3 closure or real-database evidence.

## Historical independent MVP acceptance

The independent acceptance record reports **110 TypeScript tests passed (0 failed, 0 skipped), 1 Chromium scenario passed, and all 4 workspace package typechecks passed**; all 5 database-gated checks ran and the named runtime reload was verified. The separate offline Python adapter suite has now passed all **5 tests**. The Chromium scenario demonstrates behavior, not identical visuals: corrected desktop/mobile screenshots were independently inspected, and title wrapping, CTA visibility, ornament spacing and linen texture passed MVP acceptance. This is a usable interpretation of the references; no pixel-identical claim is made.

## Decodo page scraping

Under **Ajustes → Decodo**, set the token and choose Web Data API (Bearer, default) or Web Scraping API v2 (Basic). The frontend uses `/settings/decodo`; it shows only a masked hint of the saved token. An empty token field preserves the current token when saving a mode change. **Quitar token** deletes the token without changing the mode.

Accepting a FaceCheck match queues its eligible public URL for Decodo, never its image or thumbnail. In automatic mode, a configured token, an active grant naming Decodo or FaceCheck, an accepted match and an unpaused case let the server run it without another click. The graph keeps that match outside the candidate stack so its Decodo action and page evidence remain connected. When only discarded leaves remain, the graph omits the stack if an accepted candidate already has its own branch. Otherwise it keeps a **Ningún candidato aceptado** stack connected to the FaceCheck action. Discarded matches remain accessible through **Revisar candidatos**.

Decodo extraction operates in two generic, site-agnostic layers:

1. **Layer 1 — Deterministic semantic HTML cleanup (`@investia/adapter-decodo`).** Decodo fetches raw HTML (`headless: "html"`, retrying once without `headless` on HTTP `999`) and strips navigation/header/footer/aside/form/dialog/ARIA-hidden chrome before truncation, prefers substantial `<main>`, `<article>`, or `[role="main"]` regions, deduplicates repeated blocks, extracts clean metadata/preview and up to 10 validated public non-asset body links, and fails explicitly on real login walls without falsely rejecting rich public profiles that include sign-in modals. The drawer's **Página recopilada por Decodo** section renders the stored factual text as plain inert text and links only to validated public URLs.
2. **Layer 2 — Optional on-demand AI normalization (**Normalizar con IA**).** Selecting any `decodo:url` evidence node (including existing Markdown records) shows **Resumen estructurado (asistido por IA)** alongside the untouched raw page. Clicking **Normalizar con IA** (or **Volver a normalizar con IA**) calls `POST /investigations/:id/evidence/:evidenceId/normalize` using the configured NVIDIA Build model (`#/ajustes`), while stored normalizations load via `GET /investigations/:id/normalizations`. Persisted normalizations live separately in PostgreSQL (`005_evidence_ai_normalizations.sql`), never overwrite raw factual evidence, and render strictly as inert text with `SafeLink` public-only validation for `relatedUrls` and a collapsible structured JSON preview.

For previously accepted FaceCheck matches without a Decodo action, use **Decodo** beside one candidate, **Aplicar Decodo a aceptados (N)** for the eligible group, or **Aplicar scraping con Decodo** in the match detail. These controls queue only eligible public URLs, require no new validation reason, and do not rerun FaceCheck. The same authorization, token, and advancement rules still apply.

## NVIDIA Build AI reports

Under **Ajustes → Inteligencia artificial** (`#/ajustes`, linked from the header on every other page), configure the optional AI-written report:

- **API key.** Get a free key at [build.nvidia.com/models](https://build.nvidia.com/models) and paste it in the password field. It is stored by the backend in PostgreSQL and is never returned to the browser; the page shows only *Configurada (hint)* or *Sin configurar*. Leaving the field empty on save keeps the stored key; **Quitar API key** deletes it.
- **Model.** The list shows build.nvidia.com Free Endpoint chat models, read live from the NVIDIA catalog; reasoning models are marked. **Recargar modelos** refreshes the list without discarding draft edits. When the catalog is unreachable, a static fallback list is shown with a note. A saved model that is no longer listed stays selectable.
- **Defaults.** Saving only the key works with the defaults: model `nvidia/nemotron-3.5-super-vl-120b-a12b`, reasoning effort *Predeterminado del modelo* (`default`, not sent to the provider), temperature `0.6`, top_p `0.95`, max tokens `8192`. Some popular free endpoints can stay queued without answering; the backend streams the response and fails after 90 seconds without tokens (`AI_PROVIDER_TIMEOUT`) so another model can be chosen. **Parámetros avanzados** edits reasoning effort, temperature (0–2), top_p (>0–1) and max tokens (256–32768). **Restaurar valores por defecto** refills the form; nothing changes until **Guardar ajustes de IA**.

In the workspace, **Generar informe con IA** sits next to the unchanged **Obtener informe**. Generating sends the collected case data to NVIDIA Build; when a `decodo:url` record has a stored AI normalization whose `sourceContentHash` still matches the raw page, the AI prompt substitutes that compact normalized summary (explicitly marked AI-derived) to conserve token budget, while **Obtener informe** (`compileInvestigationReport`) stays 100% purely factual. The result is Markdown: a hypothetical narrative in Spanish (who the person might be, interests, conclusions with explicit confidence wording) followed by a **Datos utilizados** appendix with the complete factual report. It is previewed as inert text and downloads as `informe-ia-<id>.md`; it shares the factual report's revision binding, so a newer case revision hides it. Missing or rejected keys, free-tier rate limits, invalid JSON normalizations, rejected models/parameters and provider outages show specific Spanish messages that point back to `#/ajustes` where relevant.

## Positive finding retention

Only tool-reported positive results (`Registered` / `Found`, normalized as `registered`) are admitted to persisted evidence and therefore to the graph and report. Negative, unknown, skipped and provider-error rows are not retained as findings; valid omitted results are not counted as unsupported inputs. A successful scan may produce no admitted evidence. Execution failures remain terminal action failures and are not silently discarded or retried. Findings describe the observed target, including cross-discovered targets, not necessarily the original email seed. A tool report is not independent proof of identity, ownership or infallible account existence.
