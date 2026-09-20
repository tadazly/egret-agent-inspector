"""MCP server 协议测试：通过 stdio 驱动 server，并用模拟扩展连接其 WebSocket 桥。"""

import asyncio
import base64
import json
import os
import shutil
import struct
import sys
import tempfile
import unittest
from unittest import mock
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SERVER = ROOT / "plugins" / "egret-agent-inspector" / "server" / "egret_agent_inspector_mcp.py"
SCRIPTS = SERVER.parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
import browser_extension  # noqa: E402
PORT = 17890

NODES = {
    "btn_notice": {"hash": 11, "className": "eui.Button", "id": "btn_notice", "text": "公告", "onStageVisible": True},
    "txt_title": {"hash": 12, "className": "eui.Label", "id": "txt_title", "text": "系统公告", "onStageVisible": True},
}


class BrowserExtensionTest(unittest.TestCase):
    def test_status_tolerates_unreadable_browser_profiles(self):
        with mock.patch.object(browser_extension, "default_browser_raw", return_value="com.google.chrome"), \
                mock.patch.object(browser_extension, "find_executable", return_value="/test/browser"), \
                mock.patch.object(browser_extension, "loaded_extensions",
                                  side_effect=PermissionError("profile access denied")):
            status = browser_extension.status()
        chrome = next(browser for browser in status["browsers"] if browser["id"] == "chrome")
        self.assertEqual(chrome["loaded"], [])
        self.assertIn("profile access denied", chrome["loadedInspectionError"])


class FakeExtension:
    """模拟扩展 service worker：连接 server 并按 id 查询假数据应答页面请求。"""

    def __init__(self):
        self.calls = []

    async def connect(self):
        self.reader, self.writer = await asyncio.open_connection("127.0.0.1", PORT)
        key = base64.b64encode(os.urandom(16)).decode()
        self.writer.write((f"GET /egret-agent-inspector HTTP/1.1\r\nHost: 127.0.0.1:{PORT}\r\nUpgrade: websocket\r\n"
                           f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n"
                           "Origin: chrome-extension://test\r\n\r\n").encode())
        head = await self.reader.readuntil(b"\r\n\r\n")
        assert b" 101 " in head, head
        await self.send({"type": "hello", "extensionVersion": "0.0.1", "browser": "Test Browser"})
        self.task = asyncio.ensure_future(self.loop())

    async def send(self, obj):
        data = json.dumps(obj).encode()
        mask = os.urandom(4)
        n = len(data)
        head = bytes([0x81, 0x80 | n]) if n < 126 else bytes([0x81, 0x80 | 126]) + struct.pack("!H", n)
        self.writer.write(head + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))
        await self.writer.drain()

    async def loop(self):
        while True:
            b1, b2 = await self.reader.readexactly(2)
            n = b2 & 0x7F
            if n == 126:
                n = struct.unpack("!H", await self.reader.readexactly(2))[0]
            elif n == 127:
                n = struct.unpack("!Q", await self.reader.readexactly(8))[0]
            msg = json.loads(await self.reader.readexactly(n))
            if "id" in msg:
                await self.send(self.answer(msg))

    def answer(self, msg):
        params = msg["params"]
        self.calls.append((msg["method"], params.get("method")))
        if msg["method"] != "page":
            return {"id": msg["id"], "result": {"ok": True}}
        method, p = params["method"], params["params"]
        node = NODES.get(p.get("id"))
        if method == "find":
            result = {"total": 1 if node else 0, "results": [node] if node else []}
        elif method == "getNode":
            result = dict(node, props={})
        elif method == "tap":
            result = {"method": "touch", "target": node, "warnings": []}
        elif method == "waitFor":
            result = {"matched": bool(node), "elapsedMs": 5}
        elif method == "getErrors":
            errors = [{"type": "console.error", "message": "boom", "at": 1, "lastAt": 1, "count": 1, "stack": None}]
            result = {"total": len(errors), "now": 100, "collectingSince": 0,
                      "errors": errors if p.get("limit") else []}
        else:
            return {"id": msg["id"], "error": "unsupported"}
        return {"id": msg["id"], "result": {"tabId": 1, "frameId": 0, "result": result}}


class McpServerTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.install_dir = os.path.join(self.tmp.name, "extension")
        env = dict(os.environ, EGRET_MCP_PORT=str(PORT), EGRET_MCP_CONNECT_WAIT="2", PYTHONIOENCODING="utf-8",
                   EGRET_EXTENSION_DIR=self.install_dir, EGRET_NOTES_DIR=os.path.join(self.tmp.name, "notes"))
        self.proc = await asyncio.create_subprocess_exec(
            sys.executable, str(SERVER), stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL, env=env, limit=2 ** 24)
        self.ids = 0
        init = await self.rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                             "clientInfo": {"name": "test", "version": "0"}})
        self.assertEqual(init["serverInfo"]["name"], "egret-agent-inspector")

    async def asyncTearDown(self):
        self.proc.stdin.close()
        try:
            await asyncio.wait_for(self.proc.wait(), 5)
        except asyncio.TimeoutError:
            self.proc.kill()
        self.tmp.cleanup()

    async def rpc(self, method, params=None):
        self.ids += 1
        self.proc.stdin.write((json.dumps({"jsonrpc": "2.0", "id": self.ids, "method": method,
                                           "params": params or {}}) + "\n").encode())
        await self.proc.stdin.drain()
        while True:
            msg = json.loads(await asyncio.wait_for(self.proc.stdout.readline(), 30))
            if msg.get("id") == self.ids:
                self.assertNotIn("error", msg)
                return msg["result"]

    async def call(self, name, args=None):
        res = await self.rpc("tools/call", {"name": name, "arguments": args or {}})
        text = res["content"][0]["text"]
        return res, (text if res.get("isError") and not text.startswith("{") else json.loads(text))

    async def test_tools_listed(self):
        tools = {t["name"] for t in (await self.rpc("tools/list"))["tools"]}
        for name in ("egret_find", "egret_tap", "egret_extension_status", "egret_install_extension",
                     "egret_reload_extension", "egret_run_steps", "egret_scene", "egret_dismiss_popups",
                     "egret_inspect_code", "egret_notes", "splan_call"):
            self.assertIn(name, tools)

    async def test_status_without_extension(self):
        res, data = await self.call("egret_extension_status", {"waitSeconds": 0.2})
        self.assertFalse(data["connected"])
        self.assertTrue(data["bridgeAvailable"])
        self.assertTrue(data["bundledVersion"])
        self.assertIn("defaultBrowser", data["local"])
        res, _ = await self.call("egret_find", {"id": "x"})
        self.assertTrue(res["isError"])
        self.assertIn("egret-install-extension", res["content"][0]["text"])

    async def test_install_extension(self):
        res, data = await self.call("egret_install_extension", {"browser": "chrome", "openPage": False})
        self.assertFalse(res.get("isError"), data)
        self.assertTrue(data["ok"], data)
        self.assertEqual(os.path.normcase(data["installDir"]), os.path.normcase(self.install_dir))
        self.assertTrue(os.path.isfile(os.path.join(self.install_dir, "manifest.json")))
        self.assertTrue(data["nextSteps"])

    async def test_notes_roundtrip(self):
        """笔记要能跨会话复用：写入后按关键词查得到，删除后查不到。"""
        _, added = await self.call("egret_notes", {"action": "add", "scope": "demo", "entries": [
            {"kind": "pitfall", "key": "notice-close", "summary": "公告面板的关闭按钮不可 touch，点父容器"}]})
        self.assertEqual(added["added"], 1)
        _, found = await self.call("egret_notes", {"action": "search", "scope": "demo", "q": "公告"})
        self.assertEqual(found["notes"][0]["key"], "notice-close")
        self.assertNotIn("updated", found["notes"][0])
        await self.call("egret_notes", {"action": "remove", "scope": "demo", "key": "notice-close"})
        _, gone = await self.call("egret_notes", {"action": "search", "scope": "demo", "q": "公告"})
        self.assertEqual(gone["total"], 0)

    async def test_optional_and_retry_steps(self):
        """可选步骤失败不应判定用例失败：用于可能不出现的弹窗。"""
        ext = FakeExtension()
        await ext.connect()
        try:
            await self.call("egret_extension_status", {"waitSeconds": 2})
            res, report = await self.call("egret_run_steps", {"screenshotOnFailure": False, "steps": [
                {"action": "assert", "id": "missing", "optional": True},
                {"action": "tap", "id": "btn_notice", "retry": 1},
            ]})
            self.assertFalse(res.get("isError"), report)
            self.assertTrue(report["passed"])
            self.assertEqual(report["skipped"], [0])
            self.assertEqual(report["executed"], 2)
        finally:
            ext.task.cancel()
            ext.writer.close()

    async def test_run_steps_with_fake_extension(self):
        ext = FakeExtension()
        await ext.connect()
        try:
            _, status = await self.call("egret_extension_status", {"waitSeconds": 2})
            self.assertTrue(status["connected"])
            self.assertTrue(status["outdated"])
            res, report = await self.call("egret_run_steps", {"screenshotOnFailure": False, "steps": [
                {"action": "tap", "id": "btn_notice"},
                {"action": "waitFor", "id": "txt_title"},
                {"action": "assert", "id": "txt_title", "expect": {"visible": True, "textContains": "公告"}},
            ]})
            self.assertFalse(res.get("isError"), report)
            self.assertTrue(report["passed"])
            # 运行期间页面产生的错误要报出来，但不改变用例结论
            self.assertEqual(report["pageErrors"][0]["message"], "boom")
            res, report = await self.call("egret_run_steps", {"screenshotOnFailure": False, "steps": [
                {"action": "assert", "id": "txt_title", "expect": {"text": "活动"}},
                {"action": "tap", "id": "btn_notice"},
            ]})
            self.assertTrue(res["isError"])
            self.assertEqual(report["failed"], [0])
            self.assertEqual(report["executed"], 1)
        finally:
            ext.task.cancel()
            ext.writer.close()


class PluginRemovalTest(unittest.IsolatedAsyncioTestCase):
    async def test_plugin_dir_removable_while_running(self):
        """卸载插件时 server 可能仍在运行，插件目录不能被其占用（Windows 会锁定进程的 cwd）。"""
        with tempfile.TemporaryDirectory() as tmp:
            plugin = os.path.join(tmp, "plugin")
            shutil.copytree(SERVER.parents[1], plugin, ignore=shutil.ignore_patterns("__pycache__"))
            proc = await asyncio.create_subprocess_exec(
                sys.executable, os.path.join(".", "server", SERVER.name), cwd=plugin,
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
                env=dict(os.environ, EGRET_MCP_PORT=str(PORT + 1)))
            try:
                proc.stdin.write(b'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n')
                await proc.stdin.drain()
                await asyncio.wait_for(proc.stdout.readline(), 30)
                shutil.rmtree(plugin)
                self.assertFalse(os.path.exists(plugin))
            finally:
                proc.stdin.close()
                try:
                    await asyncio.wait_for(proc.wait(), 5)
                except asyncio.TimeoutError:
                    proc.kill()


if __name__ == "__main__":
    unittest.main()
