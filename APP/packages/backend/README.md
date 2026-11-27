# Investigation backend

The local Fastify API uses PostgreSQL as the source of truth. Neo4j is a revision-fenced projection of persisted facts; it never authorizes an action. LangGraph coordinates requested manual runs with `PostgresSaver`. Automatic progression is a backend-owned worker that calls the same core execution service; PostgreSQL snapshots and atomic claim transactions remain the execution authority, not graph checkpoints. A claim left in flight after a crash is retained as unknown and is not automatically retried; application-level fencing does not guarantee exactly-once remote effects.

## Full stack with Compose

From `APP/`, `docker compose up -d --build` starts the bundled frontend/API app and both databases with local placeholder defaults; no host Python or shell variables are required. See the [root quick path](../../README.md#one-command-full-stack-docker-desktop--linux-containers) for port conflicts and volume safety. App health checks only read `GET /investigations`.

Compose sets `INVESTIA_CONTAINER_NETWORKING=true`: only this exact opt-in allows `HOST=0.0.0.0` and the Neo4j hostname `neo4j` (using `bolt://` in Compose). Other non-loopback hosts and embedded Neo4j credentials remain rejected. The bind guard is enforced in both config loading and startup. Do not set this flag for native development: the unauthenticated app relies on loopback-only host publishing.

The sections below describe the **native development alternative**, with databases in Docker and the backend on the host.

## Provision the local User Scanner interpreter

Before starting the real backend, provision its Python CLI dependencies in the ignored checkout-local `APP/.venv-user-scanner`. The manifest pins adapter dependencies; do not install them globally or silently change versions. These commands are from the repository root.

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

Keep that `PYTHON` value in the backend process environment. The scanner is reached only for an authorized, unpaused case with eligible queued work. Starting the backend resumes automatic cases from persisted queues and can therefore call User Scanner without a browser or run-next click. Do not authorize real cases merely to verify startup. See the [adapter guide](../adapter-user-scanner/README.md).

## Start local services (Windows PowerShell)

1. Open Docker Desktop and wait for its Linux engine to be ready. From `APP/`, start the Compose services:

   ```powershell
   docker compose --env-file .env.example up -d postgres neo4j
   docker compose --env-file .env.example ps
   ```

   Compose binds PostgreSQL and Neo4j to loopback and keeps data in named volumes. `.env.example` supplies local-only placeholder credentials. Do not use them outside local development.

2. The PostgreSQL init script creates `investia_test` only when PostgreSQL initializes a new data volume. For an existing volume, check whether it is already present:

   ```powershell
   docker compose --env-file .env.example exec postgres psql -U investia -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='investia_test';"
   ```

   If the result is empty, create only that missing database:

   ```powershell
   docker compose --env-file .env.example exec postgres psql -U investia -d postgres -c "CREATE DATABASE investia_test;"
   ```

   Do not reset or remove volumes to initialize the test database.

3. Set development connection values in the same shell that runs the API. From the repository root, use either PowerShell:

   ```powershell
   $env:PYTHON = (Resolve-Path APP\.venv-user-scanner\Scripts\python.exe).Path
   $env:DATABASE_URL = 'postgresql://investia:investia_dev_password@127.0.0.1:5432/investia'
   $env:NEO4J_URI = 'neo4j://127.0.0.1:7687'
   $env:NEO4J_USERNAME = 'neo4j'
   $env:NEO4J_PASSWORD = 'investia_dev_password'
   $env:NEO4J_DATABASE = 'neo4j'
   pnpm --dir APP start
   ```

   Or Bash:

   ```bash
   export PYTHON="$PWD/APP/.venv-user-scanner/Scripts/python.exe" # Bash on Windows
   # On POSIX, use instead: export PYTHON="$PWD/APP/.venv-user-scanner/bin/python"
   export DATABASE_URL='postgresql://investia:investia_dev_password@127.0.0.1:5432/investia'
   export NEO4J_URI='neo4j://127.0.0.1:7687'
   export NEO4J_USERNAME='neo4j'
   export NEO4J_PASSWORD='investia_dev_password'
   export NEO4J_DATABASE='neo4j'
   pnpm --dir APP start
   ```

   The process listens on `127.0.0.1:4317` by default. Without the explicit container opt-in, `HOST` accepts only loopback IPs; `PORT` defaults to `4317`. Press Ctrl+C for graceful shutdown. The backend reads process environment variables directly: `.env.example` is read by Compose, not automatically loaded by Node or the backend.

Startup applies the PostgreSQL investigation migration and initializes `PostgresSaver` tables before opening Fastify. `SIGINT` and `SIGTERM` stop new worker claims, wait for its in-flight execution to finish, then close Fastify, the Neo4j driver, and the shared PostgreSQL pool. Shutdown does not cancel a provider call already in flight. Neo4j outages do not roll back committed PostgreSQL mutations; `/investigations/projections/reconcile` rebuilds projections from PostgreSQL.

After `pnpm --dir APP build`, the backend serves the built frontend at `/` and its assets from the module-relative `packages/frontend/dist` directory. Index HTML is not cached; static assets have MIME, entity-tag, and cache headers. The frontend build is optional: if absent, startup prints an API-only notice and the API continues to work. There is no SPA fallback, so unknown assets and unknown API paths or methods stay JSON 404 responses. The static root is only the frontend build; source and `node_modules` are not mounted. For Vite development at `127.0.0.1:5173` with its API proxy, see the [frontend guide](../frontend/README.md).

## API and execution safety

- `POST /investigations`, `GET /investigations`, `GET /investigations/:id`
- `POST /investigations/:id/emails` (queues user-scanner)
- `POST /investigations/:id/usernames` with `username` and `reason` (accepted operator seed; queues Maigret)
- `POST /investigations/:id/usernames/decisions` with `username`, `decision` (`accepted` or `rejected`) and `reason`, for a username proposed by current evidence; accepting queues Maigret
- `POST /investigations/:id/actions/proposals`
- `POST /investigations/:id/authorization` with an explicit `granted` boolean
- `POST /investigations/:id/actions/:actionId/approval`
- `POST /investigations/:id/actions/run`
- `POST /investigations/:id/evidence/:evidenceId/validation` with `accepted`, `rejected`, or `inconclusive`
- `POST /investigations/:id/evidence/:evidenceId/decodo` with no body or a strict `{ reason?: string }` body. Queues Decodo for an already-accepted FaceCheck match and returns `201` with the updated investigation. Returns `409` when Decodo is disabled, the match is ineligible, or an action already exists; returns `404` for a missing investigation or evidence record.
- `POST /investigations/:id/evidence/:evidenceId/rejection`
- `POST /investigations/:id/pause`, `POST /investigations/:id/resume`
- `GET /investigations/:id/report` (factual Markdown from persisted state)
- `GET /investigations/:id/normalizations` returns `{ normalizations }` with stored Layer 2 AI page normalizations whose `evidenceId` matches a `decodo:url` finding in the investigation and whose `sourceContentHash` matches the current stored page content; stale or orphaned normalizations are excluded. Returns `404` when the investigation does not exist.
- `POST /investigations/:id/evidence/:evidenceId/normalize` with no body or `{}` runs optional on-demand AI normalization via NVIDIA Build for a stored `decodo:url` finding, returning `200` with the persisted `EvidenceAiNormalization` record without mutating the investigation snapshot or raw evidence. Enforces lookup precedence (`404` missing investigation, `404` missing evidence, `409` non-Decodo or finding-less evidence, `409 AI_NOT_CONFIGURED` missing NVIDIA Build API key) and returns `502 AI_PROVIDER_INVALID_RESPONSE` without writing when model output is not valid normalized JSON. Startup applies `005_evidence_ai_normalizations.sql`.
- `POST /investigations/:id/report/ai` generates the hypothetical Spanish Markdown report via NVIDIA Build, substituting compact hash-verified `aiNormalizedPage` summaries in the model prompt when available to conserve context budget while keeping the `## Datos utilizados` appendix strictly raw factual.
- `POST /investigations/projections/reconcile`
- `GET /settings/facecheck` returns `{ tokenConfigured, tokenHint, testingMode }`; the full token is never returned.
- `PUT /settings/facecheck` accepts `{ token?: string, testingMode?: boolean }` with at least one field. `DELETE /settings/facecheck/token` clears only the token. Both return the same settings view. These routes require a same-origin loopback request.
- `GET /settings/decodo` returns `{ tokenConfigured, tokenHint, apiMode }`, never the full token. `PUT /settings/decodo` accepts `{ token?: string, apiMode?: "web_data" | "scraping_v2" }` with at least one field. `DELETE /settings/decodo/token` clears the token but preserves the mode. Both writes return the same view. All three routes require same-origin loopback requests; startup applies `004_decodo_settings.sql` for PostgreSQL storage.

FaceCheck testing mode defaults to `true`: demo searches do not consume credits and use only the first 100,000 faces. A GHunt profile photo queues FaceCheck subject to scoped authorization and the case's manual or automatic mode; the action waits until a token is configured. Each result retains its source URL, thumbnail and score and is a candidate, not a confirmed identity. Only candidates whose latest operator decision is accepted enter factual and AI reports. The workspace reviews them one card at a time (thumbnail, site, score, link; Descartar / Aceptar or ← / →) from the candidate group, any candidate or the FaceCheck action, with Aceptados and Descartados tabs to change a decision; the review reads stored candidates only and never calls FaceCheck. The Google profile photo is loaded for comparison only when the operator asks.

Accepting a FaceCheck result atomically queues one `decodo.url.v1` action when the source URL is eligible and wakes the automatic runner. Decodo receives only the URL, never the photo or thumbnail. Execution requires an active investigation grant naming Decodo or FaceCheck, an unpaused case, a configured token and a still-accepted FaceCheck parent; manual cases use run-next. Web Data API uses Bearer by default; Web Scraping API v2 uses Basic. A headless `999` (Decodo or target status), `612`/`613` (Decodo scrape failure), login page, or empty result gets one attempt without browser rendering, for at most two requests per scrape. Other provider errors are not retried. Terminal failures record no page finding. Decodo findings with a no-longer-accepted FaceCheck parent are excluded from reports.

New investigations default to `advancementMode: "automatic"`; choose `"manual"` at creation to require case-level run-next. Intention is persisted once at creation, never reused as an action reason. Recording an email seed atomically adds its User Scanner catalog action to the queue with `queuedByCatalog: true` and a system `action_queued` event, not a human approval. PostgreSQL checks case authorization, pause state, and catalog eligibility (or a genuine historical approval) inside the claim transaction. Automatic claims additionally recheck persisted automatic mode; missing legacy mode is manual.

After a successful User Scanner scan, a Gravatar finding for the scanned email (or one reporting only a username or an unusable address) queues a profile lookup linked to that finding (`sourceSeedId`). A finding for another discovered email only creates a linked proposed lookup for that email, and a scan without a finding for the scanned email creates a proposed Gravatar action for it. Both are written in the same transaction that records the scan result. Approve a proposal with a reason through the existing approval endpoint to queue it. A failed scan creates no proposal. Neither path bypasses scoped authorization or pause. In manual mode the operator must still run the next action; in automatic mode the worker handles eligible queued work.

Earlier preview builds queued Gravatar beside User Scanner without a link. Such unclaimed entries never run before their scanner succeeds; the next claim transaction links them to the scanner's Gravatar finding or turns them into proposals, without rewriting claimed, completed or approved work.

The worker enumerates persisted investigations immediately at startup and then waits one second after each completed sweep. Sweeps are single-flight and capped at 16 claim attempts, with a rotating case cursor. Errors end that case's sweep and are reported without immediate retries. Queued actions resume after restart; claimed actions remain fenced because their external outcome is uncertain. Terminal failures are retained, never automatically retried. Multiple workers and manual requests rely on the same atomic PostgreSQL claim gate to avoid claiming an action twice. Neo4j projection is downstream and cannot trigger a repeat execution.

Historical snapshots, events and approvals remain readable. The proposals endpoint now creates explicit User Scanner proposals, requiring approval. Stored GitHub-only actions are not reinterpreted: the production scanner executor rejects them before provider dispatch, retaining a terminal failure. An explicit new scanner proposal for that seed is required. Claimed and terminal entries are never rewritten or retried. API and integration workflow tests inject a fake executor; they never query live accounts. The API has no authentication system, so its loopback-only bind is the local security boundary.

## Scanner findings and compatibility

The active catalog is `user-scanner.email.v1`. Its email SeedBox runs the requested loud/cross-scan command and retains every valid JSON result with observed email/username, platform, URL, upstream status, category, reason, metadata, media and provenance/confidence. Original email seeds stay separate; a positive Gravatar finding can queue its profile lookup, while other discoveries do not automatically enqueue new actions. PostgreSQL stores the additive `finding` payload, Neo4j projects both its full JSON and key target/provenance properties, and reports include those fields. Confidence is not identity attribution.

New grants record the active scoped catalog at grant time. An active grant covers only the tools named in `catalogScopes`, or User Scanner via the older `catalogScope` marker. The single compatibility exception is that `facecheck.photo.v1` also covers `decodo.url.v1`, so existing FaceCheck grants do not need renewal to scrape accepted matches. An active grant naming only User Scanner does not cover Decodo. Missing, revoked, and legacy unscoped grants (including an empty list without a single-scope marker) cannot claim scoped actions. Unknown catalog IDs are never covered. Old GitHub-only records remain readable, but the scanner refuses their execution before contacting providers. Missing legacy advancement mode remains manual. No data/volume reset or automatic replay is needed.

See [the adapter guide](../adapter-user-scanner/README.md) for pinned installation and target-free CLI checks.

## Tests and honest verification status

From the repository root, focused backend checks use the workspace package scripts:

```powershell
pnpm --dir APP --filter @investia/backend test
pnpm --dir APP --filter @investia/backend typecheck
```

The full workspace gates are also available:

```powershell
pnpm --dir APP test
pnpm --dir APP typecheck
```

Offline tests run without a database service. Worker coverage is included through `workflow.test.ts` because the package script explicitly enumerates test entry points; it covers mode/gate filtering, bounded draining, restart enumeration, overlapping sweeps, shutdown waiting, and error handling. `evidence-normalization.test.ts` covers `005_evidence_ai_normalizations.sql` store persistence/validation, Decodo evidence normalization routes, hash-verified staleness filtering, and AI report prompt integration without live provider calls. Store tests cover catalog queue decoding and automatic-mode checks at claim time. The SQL fake is not evidence of real database concurrency. The PostgreSQL integrations require `INVESTIA_TEST_DATABASE_URL` to point to a local dedicated database whose name ends in `_test`. Neo4j tests additionally require the test Neo4j variables below. These are separate from `DATABASE_URL`, which is only for backend startup.

Set integration variables in the PowerShell session that runs tests:

```powershell
$env:INVESTIA_TEST_DATABASE_URL = 'postgresql://investia:investia_dev_password@127.0.0.1:5432/investia_test'
$env:INVESTIA_TEST_NEO4J_URI = 'neo4j://127.0.0.1:7687'
$env:INVESTIA_TEST_NEO4J_USERNAME = 'neo4j'
$env:INVESTIA_TEST_NEO4J_PASSWORD = 'investia_dev_password'
$env:INVESTIA_TEST_NEO4J_DATABASE = 'neo4j'
pnpm --dir APP test
```

`INVESTIA_TEST_NEO4J_DATABASE` is optional and defaults to `neo4j`. When required database-test variables are absent, the five database-gated tests skip; a skip is not evidence of database behavior.

### Automatic progression writer verification

T2 writer checks passed: core **21**, backend **29**, frontend **59** tests; workspace typecheck and production build passed; **2 Chromium scenarios** passed against the built UI with a fake observer and real automatic worker. The backend's **5 database-gated tests skipped** because connection prerequisites were absent; these checks do not establish real PostgreSQL/Neo4j behavior. Independent T3 verification remains separate.

### Historical independent MVP acceptance

Latest recorded independent MVP checks: **110 TypeScript tests passed (0 failed, 0 skipped), 1 Chromium scenario passed, and all 4 workspace package typechecks passed.** The same acceptance record says all 5 database-gated checks ran and the named runtime reload was verified. This setup task separately ran **5 offline Python adapter tests** and an import-only check of the pinned Holehe GitHub module and `httpx`; no account function was invoked. Test connection values came from `.env.example`, and local PostgreSQL and Neo4j services were left running. Workflow tests use a fake executor and do not query live accounts.

The Chromium scenario is functional evidence, not visual identity with the references. Corrected desktop/mobile screenshots were independently inspected: title wrapping, CTA visibility, ornament spacing and linen texture passed the MVP acceptance checks. The design is a usable interpretation, not a pixel-identical copy. Fresh-client reconstruction is not an abrupt process-crash test. Abrupt crashes, interruption of external effects, and concurrent Neo4j interleavings remain untested.

All integration records use unique IDs. The workflow test removes only its own PostgreSQL investigation, checkpoint rows for its generated thread ID, and Neo4j nodes scoped to its generated investigation ID. It does not drop databases, shared tables/constraints, or volumes. Other existing database integration tests may retain their uniquely identified test records.
## Positive finding retention

Only tool-reported positive results (`Registered` / `Found`, normalized as `registered`) are admitted to persisted evidence and therefore to the graph and report. Negative, unknown, skipped and provider-error rows are not retained as findings; valid omitted results are not counted as unsupported inputs. A successful scan may produce no admitted evidence. Execution failures remain terminal action failures and are not silently discarded or retried. Findings describe the observed target, including cross-discovered targets, not necessarily the original email seed. A tool report is not independent proof of identity, ownership or infallible account existence.
