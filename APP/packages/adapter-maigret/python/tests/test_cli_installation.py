"""Installation-only checks: never pass a target or contact account providers."""
import importlib.metadata
import subprocess
import sys
import unittest


class MaigretInstallationTests(unittest.TestCase):
    def test_pinned_release_and_required_cli_flags(self):
        self.assertEqual(importlib.metadata.version("maigret"), "0.6.6")
        result = subprocess.run(
            [sys.executable, "-B", "-m", "maigret", "--help"],
            capture_output=True, text=True, timeout=60, check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        for flag in ("--json", "--folderoutput", "--top-sites", "--timeout", "--retries", "--no-recursion", "--no-autoupdate", "--no-color", "--no-progressbar"):
            self.assertIn(flag, result.stdout)


if __name__ == "__main__":
    unittest.main()
