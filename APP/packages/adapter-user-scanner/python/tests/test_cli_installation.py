"""Installation-only checks: never pass a target or contact account providers."""
import importlib.metadata
import subprocess
import sys
import unittest


class ScannerInstallationTests(unittest.TestCase):
    def test_pinned_release_and_required_cli_flags(self):
        self.assertEqual(importlib.metadata.version("user-scanner"), "1.5.2.1")
        result = subprocess.run(
            [sys.executable, "-B", "-m", "user_scanner", "--help"],
            capture_output=True, text=True, timeout=30, check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        for flag in ("--email", "--allow-loud", "--cross-scan", "--cross-links", "--cross-emails", "--cross-depth", "--cross-sweep", "--verbose", "--format", "--output"):
            self.assertIn(flag, result.stdout)


if __name__ == "__main__":
    unittest.main()
