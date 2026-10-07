import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from holehe_bridge import ALLOWED_MODULES, run_module


class FakeClient:
    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc_value, traceback):
        return False


class HoleheBridgeTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.imports = []
        self.clients = []

    async def invoke(self, record=None, *, raises=False):
        async def github(email, client, out):
            self.assertEqual(email, "person@example.org")
            self.assertIs(client, self.clients[-1])
            if raises:
                raise RuntimeError("do not expose upstream exception details")
            if record is not None:
                out.append(record)

        module = SimpleNamespace(github=github)

        def module_loader(name):
            self.imports.append(name)
            return module

        def client_factory():
            client = FakeClient()
            self.clients.append(client)
            return client

        return await run_module(
            "github",
            "person@example.org",
            module_loader=module_loader,
            client_factory=client_factory,
        )

    async def test_allowlist_targets_explicit_upstream_module(self):
        self.assertEqual(ALLOWED_MODULES, {
            "github": ("holehe.modules.programing.github", "github")
        })
        result = await self.invoke({"exists": True, "rateLimit": False})
        self.assertEqual(self.imports, ["holehe.modules.programing.github"])
        self.assertEqual(result, {"contract_version": 1, "status": "registered"})

    async def test_preserves_all_upstream_outcomes(self):
        cases = [
            ({"exists": True}, "registered"),
            ({"exists": False}, "not_registered"),
            ({"exists": None}, "unknown"),
            ({"rateLimit": True, "exists": None}, "rate_limited"),
            ({"error": True, "exists": False}, "error"),
        ]
        for record, expected in cases:
            with self.subTest(record=record):
                self.assertEqual((await self.invoke(record))["status"], expected)

    async def test_empty_result_is_unknown(self):
        self.assertEqual((await self.invoke())["status"], "unknown")

    async def test_module_failures_are_sanitized_as_error(self):
        result = await self.invoke(raises=True)
        self.assertEqual(result, {"contract_version": 1, "status": "error"})

    async def test_rejects_modules_outside_the_allowlist_before_importing(self):
        with self.assertRaises(ValueError):
            await run_module("instagram", "person@example.org", module_loader=lambda _: self.fail("imported"))


if __name__ == "__main__":
    unittest.main()
