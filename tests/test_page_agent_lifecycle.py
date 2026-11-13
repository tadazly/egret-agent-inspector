"""验证页面代理卸载、重注入和真实 V8 GC 后的引用释放。"""

import json
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
AGENT = ROOT / "plugins/egret-agent-inspector/extension/mcp/pageAgent.js"
FIXTURE = Path(__file__).parent / "fixtures/page_agent_lifecycle.cjs"


class PageAgentLifecycleTest(unittest.TestCase):
    def run_case(self, case):
        node = shutil.which("node")
        if not node:
            self.skipTest("node is required")
        result = subprocess.run(
            [node, "--expose-gc", str(FIXTURE), str(AGENT), case],
            capture_output=True, text=True, encoding="utf-8", timeout=20,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_reinjection_disposes_caches_timers_and_hooks(self):
        self.assertTrue(self.run_case("lifecycle")["passed"])

    def test_error_hooks_remain_single_bounded_and_safe_to_remove(self):
        self.assertTrue(self.run_case("errors")["passed"])

    def test_legacy_anonymous_hooks_require_reload_without_layering(self):
        self.assertTrue(self.run_case("legacy")["passed"])

    def test_retired_console_hook_does_not_retain_display_objects_after_gc(self):
        self.assertEqual(self.run_case("gc")["survivingRemovedObjects"], 0)

    def test_error_hook_scope_does_not_own_an_abandoned_agent_cache(self):
        self.assertEqual(self.run_case("hook_gc")["survivingRemovedObjects"], 0)


if __name__ == "__main__":
    unittest.main()
