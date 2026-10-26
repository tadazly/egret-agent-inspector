"""页签关闭的真实 bridge 逻辑、连接隔离与 MCP 回执测试；不访问真实浏览器。"""

import asyncio
import json
import shutil
import subprocess
import unittest
from unittest import mock

import test_mcp_server as protocol_tests
from test_mcp_server import BRIDGE, FakeExtension, load_server


BRIDGE_PROBE = r'''
const fs = require("fs"), vm = require("vm");
const config = JSON.parse(process.argv[2]);
let tabs = (config.tabs || []).map(t => ({ ...t })), queries = 0;
const calls = [], removed = [];
const event = () => ({ addListener() {}, removeListener() {} });
const chrome = {
    tabs: {
        onRemoved: event(), onUpdated: event(),
        async query(p) {
            calls.push(["query", p]);
            if (++queries === config.queryErrorAt) throw new Error("query failed");
            return tabs.filter(t => p.windowId === undefined || t.windowId === p.windowId).map(t => ({ ...t }));
        },
        async create(p) {
            calls.push(["create", p]);
            if (config.createError) throw new Error("create failed");
            const keeper = { ...p, id: 99 };
            if (!config.lostKeeper) tabs.push(keeper);
            return keeper;
        },
        async remove(id) {
            calls.push(["remove", id]);
            if (config.removeError) throw new Error("remove failed");
            removed.push(id);
            if (!config.noop) tabs = tabs.filter(t => t.id !== id);
        }
    },
    alarms: { create() {}, onAlarm: event() },
    runtime: { onStartup: event(), onInstalled: event() }
};
const ctx = vm.createContext({ chrome, console: { debug() {} } });
const source = fs.readFileSync(process.argv[1], "utf8").replace(/\nconnectAll\(\);\s*$/, "");
vm.runInContext(source, ctx);
vm.runInContext("lastTabId = 17; frameCache.set(17, 0); frameCache.set(18, 1)", ctx);
(async () => {
    let result, error;
    try { result = await vm.runInContext("handleRequest('closeTab', " + JSON.stringify(config.params || {}) + ")", ctx); }
    catch (e) { error = String(e.message || e); }
    const cache = vm.runInContext("({lastTabId, frames: [...frameCache.keys()]})", ctx);
    process.stdout.write(JSON.stringify({ result, error, tabs, calls, removed, cache }));
})().catch(e => { process.stderr.write(String(e.stack || e)); process.exitCode = 1; });
'''


@unittest.skipUnless(shutil.which("node"), "bridge 行为测试需要 Node.js")
class CloseTabBridgeTest(unittest.TestCase):
    def probe(self, **config):
        result = subprocess.run([shutil.which("node"), "-e", BRIDGE_PROBE, str(BRIDGE), json.dumps(config)],
                                capture_output=True, text=True, encoding="utf-8", timeout=10, check=True)
        return json.loads(result.stdout)

    def tabs(self):
        return [{"id": 17, "windowId": 2, "url": "https://game.test/", "title": "任务"},
                {"id": 18, "windowId": 2}, {"id": 19, "windowId": 3}]

    def test_requires_explicit_integer_and_never_uses_current_tab(self):
        for params in ({}, {"tabId": None}, {"tabId": "17"}, {"tabId": True},
                       {"tabId": -1}, {"tabId": 1.5}, {"tabId": [17]}, {"tabId": 2**53}):
            with self.subTest(params=params):
                data = self.probe(tabs=self.tabs(), params=params)
                self.assertIn("tabId", data["error"])
                self.assertEqual(data["calls"], [])

    def test_removes_only_named_tab_then_reads_back_and_clears_its_cache(self):
        data = self.probe(tabs=self.tabs(), params={"tabId": 17})
        self.assertEqual(data["removed"], [17])
        self.assertEqual([t["id"] for t in data["tabs"]], [18, 19])
        self.assertEqual(data["calls"], [["query", {}], ["query", {"windowId": 2}],
                                         ["remove", 17], ["query", {}]])
        self.assertEqual(data["result"], {"tabId": 17, "ok": True, "status": "closed", "verified": True,
                                          "absent": True, "windowId": 2, "url": "https://game.test/", "title": "任务"})
        self.assertEqual(data["cache"], {"lastTabId": None, "frames": [18]})

    def test_absent_tab_is_idempotent_without_mutation(self):
        data = self.probe(tabs=self.tabs()[1:], params={"tabId": 17})
        self.assertEqual(data["result"]["status"], "alreadyAbsent")
        self.assertTrue(data["result"]["verified"])
        self.assertEqual(data["calls"], [["query", {}]])
        self.assertEqual(data["cache"], {"lastTabId": None, "frames": [18]})

    def test_last_tab_preserves_window_with_one_blank_page(self):
        data = self.probe(tabs=self.tabs()[:1], params={"tabId": 17})
        self.assertEqual(data["result"]["status"], "closed")
        self.assertEqual(data["result"]["keptOpenTabId"], 99)
        self.assertEqual(data["tabs"], [{"id": 99, "windowId": 2, "url": "about:blank", "active": False}])
        create = next(i for i, call in enumerate(data["calls"]) if call[0] == "create")
        remove = next(i for i, call in enumerate(data["calls"]) if call[0] == "remove")
        self.assertLess(create, remove)

    def test_failed_or_unconfirmed_blank_page_does_not_remove_target(self):
        for option in ("createError", "lostKeeper"):
            with self.subTest(option=option):
                data = self.probe(tabs=self.tabs()[:1], params={"tabId": 17}, **{option: True})
                self.assertFalse(data["result"]["ok"])
                self.assertEqual(data["removed"], [])
                self.assertIn(17, [t["id"] for t in data["tabs"]])

    def test_browser_error_or_failed_readback_never_reports_success(self):
        for options, status in (({"removeError": True}, "error"), ({"noop": True}, "stillOpen"),
                                ({"queryErrorAt": 3}, "unconfirmed")):
            with self.subTest(options=options):
                data = self.probe(tabs=self.tabs(), params={"tabId": 17}, **options)
                self.assertFalse(data["result"]["ok"])
                self.assertFalse(data["result"]["verified"])
                self.assertEqual(data["result"]["status"], status)
        data = self.probe(tabs=self.tabs(), params={"tabId": 17}, queryErrorAt=1)
        self.assertIn("query failed", data["error"])
        self.assertEqual(data["removed"], [])


class CloseTabServerTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.server = load_server()
        self.bridge = self.server.Bridge()
        self.bridge.port = 17890
        self.chrome = self.connection("Chrome")
        self.edge = self.connection("Edge")
        self.bridge.connections = [self.chrome, self.edge]

    def connection(self, browser):
        conn = self.server.ExtensionConnection(None, None, {"browser": browser, "extensionId": browser,
                                                           "capabilities": ["closeTab"]})
        conn.ready = True
        conn.request = mock.AsyncMock()
        return conn

    def receipt(self, **values):
        return dict({"ok": True, "tabId": 17, "status": "closed", "verified": True, "absent": True}, **values)

    def args(self, conn=None):
        return {"tabId": 17, "connectionId": (conn or self.chrome).connection_id}

    async def test_same_tab_id_in_two_browsers_uses_only_named_connection(self):
        self.chrome.tabs = self.edge.tabs = {17}
        self.chrome.request.side_effect = [self.receipt(), [{"tabId": 18}]]
        result = await self.bridge.request("closeTab", self.args())
        self.assertTrue(result["ok"])
        self.assertTrue(result["serverVerified"])
        self.assertEqual(result["connectionId"], self.chrome.connection_id)
        self.assertEqual(result["browser"], "Chrome")
        timeout = self.server.REQUEST_TIMEOUT
        self.assertEqual(self.chrome.request.call_args_list, [mock.call("closeTab", {"tabId": 17}, timeout),
                                                            mock.call("listTabs", {"probe": False}, timeout)])
        self.edge.request.assert_not_awaited()

    async def test_explicit_connection_can_confirm_already_absent(self):
        self.chrome.request.side_effect = [self.receipt(status="alreadyAbsent"), []]
        result = await self.bridge.request("closeTab", self.args())
        self.assertEqual(result["status"], "alreadyAbsent")
        self.assertTrue(result["serverVerified"])
        self.edge.request.assert_not_awaited()

    async def test_invalid_target_and_stale_connection_never_fall_back(self):
        for args in ({}, {"tabId": 17}, {"connectionId": self.chrome.connection_id},
                     dict(self.args(), tabId=True), dict(self.args(), tabId="17"),
                     dict(self.args(), tabId=-1), dict(self.args(), connectionId=" ")):
            with self.subTest(args=args), self.assertRaises(ValueError):
                await self.bridge.request("closeTab", args)
        self.chrome.closed = True
        with self.assertRaisesRegex(RuntimeError, "连接已断开"):
            await self.bridge.request("closeTab", self.args())
        with self.assertRaisesRegex(RuntimeError, "连接已断开"):
            await self.bridge.request("closeTab", dict(self.args(), connectionId="unknown"))
        self.chrome.request.assert_not_awaited()
        self.edge.request.assert_not_awaited()

    async def test_old_extension_fails_before_sending_close(self):
        self.chrome.info.pop("capabilities")
        with self.assertRaisesRegex(RuntimeError, "尚不支持"):
            await self.bridge.request("closeTab", self.args())
        self.chrome.request.assert_not_awaited()

    async def test_error_disconnect_timeout_or_bad_receipt_never_succeed(self):
        for response in (RuntimeError("disconnected"), asyncio.TimeoutError(), None, {"ok": True},
                         self.receipt(tabId=22), self.receipt(verified=False), self.receipt(absent=False),
                         self.receipt(status="unknown"), self.receipt(ok=False, status="error", serverVerified=True)):
            with self.subTest(response=response):
                self.chrome.request.side_effect = [response]
                result = await self.bridge.request("closeTab", self.args())
                self.assertFalse(result["ok"])
                self.assertFalse(result.get("serverVerified"))
        self.edge.request.assert_not_awaited()

    async def test_independent_readback_rejects_remaining_tab_errors_and_malformed_lists(self):
        for readback in ([{"tabId": 17}], RuntimeError("disconnected during readback"), {},
                         [None], [{"tabId": "17"}], [{"tabId": True}], [{"url": "missing id"}]):
            with self.subTest(readback=readback):
                self.chrome.request.side_effect = [self.receipt(), readback]
                result = await self.bridge.request("closeTab", self.args())
                self.assertFalse(result["ok"])
                self.assertFalse(result["verified"])
                self.assertFalse(result.get("serverVerified"))
        self.edge.request.assert_not_awaited()

    async def test_listing_and_navigation_expose_connection_identity(self):
        for connections in ([self.chrome], [self.chrome, self.edge]):
            self.bridge.connections = connections
            for conn in connections:
                conn.request.side_effect = None
                conn.request.return_value = [{"tabId": 17}]
            tabs = await self.bridge.request("listTabs", {"probe": False})
            self.assertEqual({t["connectionId"] for t in tabs}, {c.connection_id for c in connections})
            self.assertTrue(all("closeTab" in t["capabilities"] for t in tabs))
        self.bridge.connections = [self.chrome]
        self.chrome.alive = mock.AsyncMock(return_value=True)
        self.chrome.request.return_value = {"tabId": 17, "url": "https://game.test/"}
        nav = await self.bridge.request("navigate", {"url": "https://game.test/", "newTab": True})
        self.assertEqual(nav["connectionId"], self.chrome.connection_id)

    async def test_mcp_schema_profiles_and_error_flag(self):
        schema = self.server.TOOLS["egret_close_tab"][1]
        self.assertEqual(set(schema["required"]), {"tabId", "connectionId"})
        for profile in ("minimal", "core", "full"):
            with mock.patch.object(self.server, "TOOL_PROFILE", profile):
                self.assertIn("egret_close_tab", self.server.visible_tools())
        mcp = self.server.McpServer(self.bridge)
        result = await mcp.call_tool("egret_close_tab", {"tabId": 17})
        self.assertTrue(result["isError"])
        self.chrome.request.assert_not_awaited()
        self.chrome.request.side_effect = [self.receipt(), []]
        result = await mcp.call_tool("egret_close_tab", self.args())
        self.assertFalse(result["isError"])
        self.assertTrue(json.loads(result["content"][0]["text"])["serverVerified"])
        self.chrome.request.side_effect = [self.receipt(), [{"tabId": 17}]]
        self.assertTrue((await mcp.call_tool("egret_close_tab", self.args()))["isError"])


class CloseTabProtocolTest(unittest.IsolatedAsyncioTestCase):
    # 复用 stdio/WebSocket 测试装置，避免再运行基类中无关的测试。
    asyncSetUp = protocol_tests.McpServerTest.asyncSetUp
    asyncTearDown = protocol_tests.McpServerTest.asyncTearDown
    rpc = protocol_tests.McpServerTest.rpc
    call = protocol_tests.McpServerTest.call

    async def test_tools_list_and_multi_browser_close_over_stdio_websocket(self):
        class ClosingExtension(FakeExtension):
            async def connect(self):
                await super().connect()
                await self.send({"type": "hello", "capabilities": ["closeTab"]})

            def answer(self, msg):
                if msg["method"] == "closeTab":
                    self.calls.append(("closeTab", msg["params"]))
                    tab_id = msg["params"]["tabId"]
                    absent = tab_id not in self.tabs
                    self.tabs = [t for t in self.tabs if t != tab_id]
                    return {"id": msg["id"], "result": {"tabId": tab_id, "ok": True,
                            "status": "alreadyAbsent" if absent else "closed", "verified": True, "absent": True}}
                return super().answer(msg)

        chrome, edge = ClosingExtension(), ClosingExtension()
        chrome.tabs, edge.tabs = [17, 18], [17, 19]
        await chrome.connect()
        await edge.connect()
        try:
            listed = (await self.rpc("tools/list"))["tools"]
            self.assertIn("egret_close_tab", {tool["name"] for tool in listed})
            # 等两边 hello 到达，再通过真实协议取得当前连接身份。
            for _ in range(20):
                _, tabs = await self.call("egret_list_tabs", {"probe": False})
                if len(tabs) == 4:
                    break
                await asyncio.sleep(0.01)
            self.assertEqual(len(tabs), 4)
            identity = next(t["connectionId"] for t in tabs if t["tabId"] == 18)
            args = {"tabId": 17, "connectionId": identity}
            result, receipt = await self.call("egret_close_tab", args)
            self.assertFalse(result["isError"])
            self.assertTrue(receipt["serverVerified"])
            self.assertEqual(chrome.tabs, [18])
            self.assertEqual(edge.tabs, [17, 19])
            _, receipt = await self.call("egret_close_tab", args)
            self.assertEqual(receipt["status"], "alreadyAbsent")
            self.assertFalse(any(call[0] == "closeTab" for call in edge.calls))
        finally:
            for ext in (chrome, edge):
                ext.task.cancel()
                ext.writer.close()


if __name__ == "__main__":
    unittest.main()
