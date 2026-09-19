"""MCP server 协议测试：通过 stdio 驱动 server，并用模拟扩展连接其 WebSocket 桥。"""

import asyncio
import base64
import json
import os
import struct
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SERVER = ROOT / "plugins" / "egret-agent-inspector" / "server" / "egret_agent_inspector_mcp.py"
PORT = 17890

NODES = {
    "btn_notice": {"hash": 11, "className": "eui.Button", "id": "btn_notice", "text": "公告", "onStageVisible": True},
    "txt_title": {"hash": 12, "className": "eui.Label", "id": "txt_title", "text": "系统公告", "onStageVisible": True},
}


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
        else:
            return {"id": msg["id"], "error": "unsupported"}
        return {"id": msg["id"], "result": {"tabId": 1, "frameId": 0, "result": result}}


class McpServerTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        env = dict(os.environ, EGRET_MCP_PORT=str(PORT), EGRET_MCP_CONNECT_WAIT="2", PYTHONIOENCODING="utf-8")
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
        for name in ("egret_find", "egret_tap", "egret_extension_status", "egret_reload_extension", "egret_run_steps"):
            self.assertIn(name, tools)

    async def test_status_without_extension(self):
        res, data = await self.call("egret_extension_status", {"waitSeconds": 0.2})
        self.assertFalse(data["connected"])
        self.assertTrue(data["bundledVersion"])
        res, _ = await self.call("egret_find", {"id": "x"})
        self.assertTrue(res["isError"])
        self.assertIn("egret-install-extension", res["content"][0]["text"])

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


if __name__ == "__main__":
    unittest.main()
