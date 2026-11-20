"""运行扩展 bridge 的后台操作回归用例。"""

import shutil
import subprocess
import unittest
from pathlib import Path

from test_mcp_server import BRIDGE


@unittest.skipUnless(shutil.which("node"), "bridge 行为测试需要 Node.js")
class BackgroundTabTest(unittest.TestCase):
    def test_background_operations(self):
        fixture = Path(__file__).parent / "fixtures" / "background_tabs.cjs"
        result = subprocess.run(["node", str(fixture), str(BRIDGE)], capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
