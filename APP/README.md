# InvestIA local investigation backend

InvestIA is a local, single-operator investigation API—not just the original seed-box demo. Fastify serves a loopback-only API; PostgreSQL is the authoritative investigation store; Neo4j is a revision-fenced factual projection; and LangGraph uses PostgreSQL checkpoints to coordinate approved action runs.

## One-command full stack (Docker Desktop / Linux containers)

From `APP/`, run:

```bash
docker compose up -d --build
```

Open **http://127.0.0.1:4317**. One app container serves the compiled frontend and API on the same origin; separate PostgreSQL and Neo4j containers become healthy before app startup. Startup applies the usual PostgreSQL migrations and checkpoint setup. The image builds Linux Python dependencies from the pinned adapter manifest; no host Node installation, Python venv, or shell environment setup is needed.

Compose includes local-only placeholder credentials by default. `.env.example` documents them; it is not required for this command. If the host API already occupies 4317, copy `.env.example` to `.env`, change `APP_PORT=4318`, and open http://127.0.0.1:4318 instead. Keep existing DB passwords when reusing volumes; changing a placeholder does not rotate stored credentials. Passwords used in `DATABASE_URL` must be URL-safe (percent-encoded when needed).

```bash
docker compose ps
docker compose logs app
```

Readiness uses only `GET /investigations`; loading `/` or history does not run providers. All published ports bind **127.0.0.1 only** because the API has no authentication. Do not expose them on a LAN. Container networking is enabled explicitly inside Compose; native startup keeps its loopback restrictions.

Existing project identity and named database volumes are unchanged. Run from the same `APP/` directory and retain any existing Compose project-name override. Do not run `docker compose down -v` or remove volumes to troubleshoot. Docker build/deployment and real-browser acceptance are separate verification steps, not implied by unit checks.

## Native development alternative

The backend needs local PostgreSQL and Neo4j services. Use Docker Desktop with the Compose instructions in [the backend guide](packages/backend/README.md), then provision the pinned Holehe dependencies in the checkout-local `APP/.venv` (never install them globally). Run these commands from the repository root:

```powershell
python -m venv APP/.venv
APP\.venv\Scripts\python.exe -m pip install -r APP\packages\adapter-holehe\python\requirements.txt
$env:PYTHON = (Resolve-Path APP\.venv\Scripts\python.exe).Path
```

For Bash on Windows, use the Windows `Scripts` interpreter:

```bash
python -m venv APP/.venv
APP/.venv/Scripts/python.exe -m pip install -r APP/packages/adapter-holehe/python/requirements.txt
export PYTHON="$PWD/APP/.venv/Scripts/python.exe"
```

On POSIX, use the virtual environment's `bin` interpreter instead:

```bash
python3 -m venv APP/.venv
APP/.venv/bin/python -m pip install -r APP/packages/adapter-holehe/python/requirements.txt
export PYTHON="$PWD/APP/.venv/bin/python"
```

Keep `PYTHON` set in the shell that launches the backend. Set `DATABASE_URL`, `NEO4J_URI`, `NEO4J_USERNAME`, and `NEO4J_PASSWORD` there too, then start from the repository root with:

```powershell
pnpm --dir APP start
```

The API binds to `127.0.0.1:4317` by default. It does not authenticate requests; loopback binding is its local security boundary. Holehe is reached only for an explicitly requested run after persisted authorization, per-action approval, and unpaused-state checks. Startup and tests do not query accounts. See the [adapter guide](packages/adapter-holehe/README.md) for Python-only verification.

## Frontend quick path

The frontend uses hash routes and a relative API client. For development, start the loopback backend using [its local setup](packages/backend/README.md), then run the Vite dev server:

```powershell
pnpm --dir APP frontend:dev
```

For same-origin local serving, build the frontend and start the backend; it serves `packages/frontend/dist` from beside its module, regardless of the current directory:

```powershell
pnpm --dir APP build
pnpm --dir APP start
```

The build is optional for API-only startup; a missing build prints a notice and does not enable an SPA fallback. See the [frontend guide](packages/frontend/README.md) for build, test, and typecheck commands and the [backend guide](packages/backend/README.md) for Windows PowerShell and Bash environment setup. `.env.example` is not automatically loaded by the backend process.

## Workspace checks and test status

From the repository root:

```powershell
pnpm --dir APP test
pnpm --dir APP typecheck
pnpm --dir APP frontend:test
pnpm --dir APP frontend:typecheck
pnpm --dir APP build
```

The default suite includes deterministic offline tests and database-gated integration tests. PostgreSQL integration requires `INVESTIA_TEST_DATABASE_URL` to target a dedicated local database ending in `_test`; Neo4j integration additionally uses `INVESTIA_TEST_NEO4J_URI`, `INVESTIA_TEST_NEO4J_USERNAME`, and `INVESTIA_TEST_NEO4J_PASSWORD`. When required variables are absent, the five database-gated tests skip; skips are not database verification. The full workflow integration uses a fake executor, never Holehe or live accounts.

Latest recorded independent MVP checks: **110 TypeScript tests passed (0 failed, 0 skipped), 1 Chromium scenario passed, and all 4 workspace package typechecks passed.** The same acceptance record says all 5 database-gated checks ran and the named runtime reload was verified. This setup task separately ran **5 offline Python adapter tests**, and imported the pinned Holehe GitHub module and `httpx` without invoking an account function. Test connection variables were loaded from `.env.example` into the test process only. Local Compose PostgreSQL and Neo4j services (`app-postgres-1` and `app-neo4j-1`) were running for verification and were left running afterward. The actual-database checks covered PostgreSQL constraints, concurrent claims and completion fencing; `PostgresSaver` checkpointing and the reconstructed API workflow; and Neo4j sequential stale-revision fencing and validation relationships. Workflow execution used a fake external executor; no live Holehe queries were made.

The Chromium run is functional evidence, not a claim of visual identity with the design references. Corrected desktop/mobile screenshots were independently inspected: title wrapping, CTA visibility, ornament spacing and linen texture passed the MVP acceptance checks. The design is a usable interpretation, not a pixel-identical copy. Fresh-client runtime reconstruction is not an abrupt process-crash test. See the [backend guide](packages/backend/README.md) for service, environment, and test commands.