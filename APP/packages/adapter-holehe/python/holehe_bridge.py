"""Narrow async bridge to explicitly allowed Holehe modules; never invokes Holehe's CLI."""

import asyncio
import importlib
import json
import sys
from typing import Any, Callable

CONTRACT_VERSION = 1
ALLOWED_MODULES = {
    "github": ("holehe.modules.programing.github", "github"),
}


def _classify(records: list[dict[str, Any]]) -> str:
    if not records or not isinstance(records[-1], dict):
        return "unknown"
    result = records[-1]
    if result.get("error") is True:
        return "error"
    if result.get("rateLimit") is True:
        return "rate_limited"
    if result.get("exists") is True:
        return "registered"
    if result.get("exists") is False:
        return "not_registered"
    return "unknown"


def _default_client_factory():
    import httpx

    return httpx.AsyncClient(timeout=10)


async def run_module(
    module_name: str,
    email: str,
    *,
    module_loader: Callable[[str], Any] | None = None,
    client_factory: Callable[[], Any] | None = None,
) -> dict[str, Any]:
    """Run one allowlisted async module with injectable boundaries for offline tests."""
    if module_name not in ALLOWED_MODULES:
        raise ValueError("Unsupported Holehe module")

    module_path, function_name = ALLOWED_MODULES[module_name]
    loader = module_loader or importlib.import_module
    make_client = client_factory or _default_client_factory
    try:
        module = loader(module_path)
        function = getattr(module, function_name)
        records: list[dict[str, Any]] = []
        async with make_client() as client:
            await function(email, client, records)
        status = _classify(records)
    except Exception:
        # Upstream exception messages can contain the seed or provider response data.
        status = "error"
    return {"contract_version": CONTRACT_VERSION, "status": status}


def main(arguments: list[str] | None = None) -> int:
    args = sys.argv[1:] if arguments is None else arguments
    try:
        if len(args) != 2:
            raise ValueError("Expected module and email")
        result = asyncio.run(run_module(args[0], args[1]))
    except Exception:
        # Do not expose upstream exception text, which may contain the seed or response data.
        result = {"contract_version": CONTRACT_VERSION, "status": "error"}
    sys.stdout.write(json.dumps(result, separators=(",", ":")) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
