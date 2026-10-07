# Investigation backend

The local Fastify API uses PostgreSQL as the source of truth. Neo4j is a revision-fenced projection of persisted facts; it never authorizes an action. LangGraph coordinates each run with `PostgresSaver`, while the PostgreSQL claim transaction remains the execution gate. A claim left in flight after a crash is retained as unknown and is not automatically retried; application-level fencing does not guarantee exactly-once remote effects.

## Full stack with Compose

From `APP/`, `docker compose up -d --build` starts the bundled frontend/API app and both databases with local placeholder defaults; no host Python or shell variables are required. See the [root quick path](../../README.md#one-command-full-stack-docker-desktop--linux-containers) for port conflicts and volume safety. App health checks only read `GET /investigations`.

Compose sets `INVESTIA_CONTAINER_NETWORKING=true`: only this exact opt-in allows `HOST=0.0.0.0` and the Neo4j hostname `neo4j` (using `bolt://` in Compose). Other non-loopback hosts and embedded Neo4j credentials remain rejected. The bind guard is enforced in both config loading and startup. Do not set this flag for native development: the unauthenticated app relies on loopback-only host publishing.

The sections below describe the **native development alternative**, with databases in Docker and the backend on the host.

## Provision the local Holehe interpreter

Before starting the real backend, provision its Python bridge dependencies in the ignored checkout-local `APP/.venv`. The manifest pins adapter dependencies; do not install them globally or silently change versions. These commands are from the repository root.

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

Keep that `PYTHON` value in the backend process environment. The bridge is reached only for an explicitly authorized action; startup itself never calls Holehe. See the [adapter guide](../adapter-holehe/README.md).

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
   $env:PYTHON = (Resolve-Path APP\.venv\Scripts\python.exe).Path
   $env:DATABASE_URL = 'postgresql://investia:investia_dev_password@127.0.0.1:5432/investia'
   $env:NEO4J_URI = 'neo4j://127.0.0.1:7687'
   $env:NEO4J_USERNAME = 'neo4j'
   $env:NEO4J_PASSWORD = 'investia_dev_password'
   $env:NEO4J_DATABASE = 'neo4j'
   pnpm --dir APP start
   ```

   Or Bash:

   ```bash
   export PYTHON="$PWD/APP/.venv/Scripts/python.exe" # Bash on Windows
   # On POSIX, use instead: export PYTHON="$PWD/APP/.venv/bin/python"
   export DATABASE_URL='postgresql://investia:investia_dev_password@127.0.0.1:5432/investia'
   export NEO4J_URI='neo4j://127.0.0.1:7687'
   export NEO4J_USERNAME='neo4j'
   export NEO4J_PASSWORD='investia_dev_password'
   export NEO4J_DATABASE='neo4j'
   pnpm --dir APP start
   ```

   The process listens on `127.0.0.1:4317` by default. Without the explicit container opt-in, `HOST` accepts only loopback IPs; `PORT` defaults to `4317`. Press Ctrl+C for graceful shutdown. The backend reads process environment variables directly: `.env.example` is read by Compose, not automatically loaded by Node or the backend.

Startup applies the PostgreSQL investigation migration and initializes `PostgresSaver` tables before opening Fastify. `SIGINT` and `SIGTERM` close Fastify, the Neo4j driver, and the shared PostgreSQL pool. Neo4j outages do not roll back committed PostgreSQL mutations; `/investigations/projections/reconcile` rebuilds projections from PostgreSQL.

After `pnpm --dir APP build`, the backend serves the built frontend at `/` and its assets from the module-relative `packages/frontend/dist` directory. Index HTML is not cached; static assets have MIME, entity-tag, and cache headers. The frontend build is optional: if absent, startup prints an API-only notice and the API continues to work. There is no SPA fallback, so unknown assets and unknown API paths or methods stay JSON 404 responses. The static root is only the frontend build; source and `node_modules` are not mounted. For Vite development at `127.0.0.1:5173` with its API proxy, see the [frontend guide](../frontend/README.md).

## API and execution safety

- `POST /investigations`, `GET /investigations`, `GET /investigations/:id`
- `POST /investigations/:id/emails`
- `POST /investigations/:id/actions/proposals`
- `POST /investigations/:id/authorization` with an explicit `granted` boolean
- `POST /investigations/:id/actions/:actionId/approval`
- `POST /investigations/:id/actions/run`
- `POST /investigations/:id/evidence/:evidenceId/validation` with `accepted`, `rejected`, or `inconclusive`
- `POST /investigations/:id/evidence/:evidenceId/rejection`
- `POST /investigations/:id/pause`, `POST /investigations/:id/resume`
- `GET /investigations/:id/report` (factual Markdown from persisted state)
- `POST /investigations/projections/reconcile`

An action run is dispatched only after PostgreSQL confirms explicit investigation authorization, that action's approval, and an unpaused investigation. The Holehe adapter is not called at startup. API and integration workflow tests inject a fake executor; they never query live accounts. The API has no authentication system, so its loopback-only bind is the local security boundary.

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

Tests run without a database service. The PostgreSQL integrations require `INVESTIA_TEST_DATABASE_URL` to point to a local dedicated database whose name ends in `_test`. Neo4j tests additionally require the test Neo4j variables below. These are separate from `DATABASE_URL`, which is only for backend startup.

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

### Latest recorded independent acceptance

Latest recorded independent MVP checks: **110 TypeScript tests passed (0 failed, 0 skipped), 1 Chromium scenario passed, and all 4 workspace package typechecks passed.** The same acceptance record says all 5 database-gated checks ran and the named runtime reload was verified. This setup task separately ran **5 offline Python adapter tests** and an import-only check of the pinned Holehe GitHub module and `httpx`; no account function was invoked. Test connection values came from `.env.example`, and local PostgreSQL and Neo4j services were left running. Workflow tests use a fake executor and do not query live accounts.

The Chromium scenario is functional evidence, not visual identity with the references. Corrected desktop/mobile screenshots were independently inspected: title wrapping, CTA visibility, ornament spacing and linen texture passed the MVP acceptance checks. The design is a usable interpretation, not a pixel-identical copy. Fresh-client reconstruction is not an abrupt process-crash test. Abrupt crashes, interruption of external effects, and concurrent Neo4j interleavings remain untested.

All integration records use unique IDs. The workflow test removes only its own PostgreSQL investigation, checkpoint rows for its generated thread ID, and Neo4j nodes scoped to its generated investigation ID. It does not drop databases, shared tables/constraints, or volumes. Other existing database integration tests may retain their uniquely identified test records.