# Maigret adapter

`createMaigretBox()` is the `maigret.username.v1` SeedBox. For a username seed it runs the pinned [Maigret](https://github.com/soxoj/maigret) 0.6.6 CLI and turns every claimed site into a username finding with the profile data Maigret extracted (name, location, bio, avatar, other usernames and links).

## Command

The runner spawns, without a shell and inside a private per-run directory:

```text
python -B -m maigret <username> --json simple --folderoutput <run-dir> --top-sites 500 --timeout 30 --retries 1 --no-recursion --no-autoupdate --no-color --no-progressbar
```

- `--no-recursion`: usernames Maigret discovers are reported as `discovered_usernames`; they reach Maigret again only as operator-confirmed seeds.
- `--no-autoupdate`: the pinned release always uses its bundled site database; nothing updates at runtime.
- Similar-search sites (`is_similar`) are dropped as likely false positives.
- Only an allowlist of public profile fields is kept from what Maigret extracts; names that look like credentials (password, token, key, session, cookie, hash...) are always dropped.
- Usernames must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`, so a seed can never be read as an option or as several targets.
- The scan is killed after 15 minutes or 16 MiB of output; the run directory is always removed.

`MAIGRET_PYTHON` selects the interpreter (default `python`). Install the manifest into its own venv, separate from user-scanner:

```sh
python -m venv APP/.venv-maigret
APP/.venv-maigret/bin/python -m pip install -r APP/packages/adapter-maigret/python/requirements.txt
export MAIGRET_PYTHON="$PWD/APP/.venv-maigret/bin/python"
```

On Windows use `APP\.venv-maigret\Scripts\python.exe`.

## Checks

```sh
pnpm --dir APP --filter @investia/adapter-maigret test
python -B -m unittest discover -s APP/packages/adapter-maigret/python/tests -p test_cli_installation.py -v
```

The Node tests use a fake process and a report recorded from the real CLI against a loopback-only site; the Python check reads `--help` and never passes a target.
