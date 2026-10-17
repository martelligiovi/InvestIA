# User Scanner email adapter

The email `SeedBox` runs the pinned User Scanner CLI and returns all structured results, including other platforms, discovered emails, handles, URLs, metadata, media, pivot sources and upstream confidence. These are observations, never proof of identity. Holehe is no longer installed or invoked by the app image.

## Bundled runtime

Docker installs the complete pinned Python manifest during build and ships `/opt/venv` in the runtime image. The scanner is available on `PATH`; startup never installs dependencies. The image creates `/app/.scanner-runs` owned by the non-root `node` user with mode `0700`, so private reports can be written without making `/app` writable or running the scanner as root. Tools belong in workspace adapter packages with an explicit dependency manifest and image provisioning, not an operator's global environment.

From `APP/`, `docker compose up -d --build` provides the app, UI, scanner and databases. Building requires access to package registries; running scans requires access to upstream services.

For native setup, follow [the app guide](../../README.md#native-development-alternative) and set `PYTHON` to the isolated interpreter.

## Invocation and safety

Equivalent CLI command:

```bash
user-scanner -e "person@example.org" --allow-loud --cross-scan --cross-links all --cross-emails all --cross-depth 2 --cross-sweep 25 --verbose
```

The adapter invokes `PYTHON -B -m user_scanner` with those arguments plus `-f json -o <private-per-run-file>`. It uses separate arguments and no shell. The report is validated before ingest; a successful process exit without a valid report is not success. Temporary reports are removed on success and failure. Default limits are 20 minutes and 16 MiB each for the report and combined diagnostics; options are injectable for tests/deployments. No automatic tool retry occurs.

**`--allow-loud` may send password-reset emails or notifications.** Case authorization covers this command and its cross-scan targets. The UI explicitly describes that scope. Fresh authorization is tagged with the scanner catalog scope; a legacy grant does not silently authorize the broader command and must be explicitly renewed. Pausing or revoking consent blocks new claims, not an already-running scanner. Do not authorize real cases to test installation or startup.

Original seeds remain unchanged. Cross-discovered addresses and usernames are findings, not extra queued seeds. Historical GitHub-only actions remain readable but the real scanner rejects execution of them before provider dispatch; an explicit new scanner proposal and approval is required. Existing claimed actions and terminal failures are never replayed.

## Offline verification

From the repository root:

```bash
pnpm --dir APP --filter @investia/adapter-user-scanner test
pnpm --dir APP --filter @investia/adapter-user-scanner typecheck
APP/.venv-user-scanner/Scripts/python.exe -B -m unittest discover -s APP/packages/adapter-user-scanner/python/tests -p test_cli_installation.py -v
```

On POSIX use `APP/.venv-user-scanner/bin/python`. The Python check runs only `--help` and checks installed version/flags; it does not pass a target. Adapter tests use fake processes and JSON fixtures, never live accounts.

Image-only smoke (from `APP/`, after building `investia-user-scanner:local`):

```bash
docker run --rm --network none --entrypoint user-scanner investia-user-scanner:local --help
```

Source: [kaifcodec/user-scanner](https://github.com/kaifcodec/user-scanner), pinned distribution **1.5.2.1** from PyPI. The upstream MIT license and dependency licenses remain included in installed packages.

## Positive finding retention

Only tool-reported positive results (`Registered` / `Found`, normalized as `registered`) are admitted to persisted evidence and therefore to the graph and report. Negative, unknown, skipped and provider-error rows are not retained as findings; valid omitted results are not counted as unsupported inputs. A successful scan may produce no admitted evidence. Execution failures remain terminal action failures and are not silently discarded or retried. Findings describe the observed target, including cross-discovered targets, not necessarily the original email seed. A tool report is not independent proof of identity, ownership or infallible account existence.
