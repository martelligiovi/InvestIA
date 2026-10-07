# Holehe adapter

The production adapter launches the Python bridge only for an explicitly dispatched, authorized action. It does not query accounts during backend startup or during the offline tests below.

## Provision the local Python environment

From the repository root, create the ignored checkout-local `APP/.venv` and install the exact pinned requirements. Do not install these dependencies globally or change their versions without a separate authorization.

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

Keep `PYTHON` set in the same process environment that launches the backend. The TypeScript process runner uses `PYTHON`, falling back to `python` only when it is unset.

## Offline verification

From the repository root, run the bridge tests with the local interpreter:

```powershell
APP\.venv\Scripts\python.exe -B -m unittest discover -s APP\packages\adapter-holehe\python\tests -p test_holehe_bridge.py -v
```

The Python tests use injected clients and module loaders; they do not call live services. The dependency manifest is [`python/requirements.txt`](python/requirements.txt).
