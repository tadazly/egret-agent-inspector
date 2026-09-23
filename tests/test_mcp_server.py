"""MCP server 协议测试：通过 stdio 驱动 server，并用模拟扩展连接其 WebSocket 桥。"""

import asyncio
import base64
import json
import os
import re
import shutil
import subprocess
import struct
import sys
import tempfile
import unittest
from unittest import mock
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SERVER = ROOT / "plugins" / "egret-agent-inspector" / "server" / "egret_agent_inspector_mcp.py"
LAUNCHER = SERVER.parents[1] / "scripts" / "start_mcp.js"
SCRIPTS = SERVER.parents[1] / "scripts"
WINDOWS_OCR = SCRIPTS / "ocr_windows.ps1"
PAGE_AGENT = SERVER.parents[1] / "extension" / "mcp" / "pageAgent.js"
BRIDGE = SERVER.parents[1] / "extension" / "mcp" / "bridge.js"
sys.path.insert(0, str(SCRIPTS))
import browser_extension  # noqa: E402
PORT = 17890

NODES = {
    "btn_notice": {"hash": 11, "className": "eui.Button", "id": "btn_notice", "text": "公告", "onStageVisible": True},
    "txt_title": {"hash": 12, "className": "eui.Label", "id": "txt_title", "text": "系统公告", "onStageVisible": True},
}


class BrowserExtensionTest(unittest.TestCase):
    def test_unfocused_window_does_not_mark_screenshot_stale(self):
        source = BRIDGE.read_text(encoding="utf-8")
        self.assertNotIn("if (!win.focused)", source)
        self.assertIn('win.state === "minimized"', source)

    def test_windows_ocr_source_is_windows_powershell_compatible(self):
        source = WINDOWS_OCR.read_bytes()
        self.assertTrue(source.startswith(b"\xef\xbb\xbf") or source.isascii())
        if sys.platform == "win32" and shutil.which("powershell"):
            result = subprocess.run(
                ["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
                 "-File", str(WINDOWS_OCR), str(ROOT / "missing-ocr-spec.json")],
                capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=10)
            self.assertNotIn("ParserError", result.stderr)
            self.assertNotEqual(result.returncode, 0)

    def test_status_tolerates_unreadable_browser_profiles(self):
        with mock.patch.object(browser_extension, "default_browser_raw", return_value="com.google.chrome"), \
                mock.patch.object(browser_extension, "find_executable", return_value="/test/browser"), \
                mock.patch.object(browser_extension, "loaded_extensions",
                                  side_effect=PermissionError("profile access denied")):
            status = browser_extension.status()
        chrome = next(browser for browser in status["browsers"] if browser["id"] == "chrome")
        self.assertEqual(chrome["loaded"], [])
        self.assertIn("profile access denied", chrome["loadedInspectionError"])

    def test_open_url_uses_selected_browser_and_rejects_other_schemes(self):
        with mock.patch.object(browser_extension, "status", return_value={"defaultBrowser": "chrome"}), \
                mock.patch.object(browser_extension, "find_executable", return_value="/test/chrome"), \
                mock.patch.object(browser_extension.subprocess, "Popen") as popen:
            result = browser_extension.open_url("default", "https://example.test/game")
        self.assertTrue(result["ok"])
        self.assertEqual(result["browser"], "chrome")
        popen.assert_called_once()
        self.assertFalse(browser_extension.open_url("chrome", "file:///tmp/private")["ok"])


class LauncherTest(unittest.TestCase):
    def test_page_agent_story_semantics(self):
        node = shutil.which("node")
        self.assertTrue(node, "node is required")
        script = r'''
const fs = require("fs");
const vm = require("vm");
let source = fs.readFileSync(process.argv[1], "utf8");
source = source.replace("\n    installErrorHooks();", "\n    window.__pageAgentTest = { semanticTerms, locateSemantic, dialogueHasDecision, semanticActionOwner, sceneInfo, findCloseControl, maskPointOutside, backdropDismissTargetOf, transientOverlayOf };\n    installErrorHooks();");
const stage = { __class: "egret.Stage", hashCode: 1, stageWidth: 800, stageHeight: 480,
    visible: true, alpha: 1, touchEnabled: true, touchChildren: true, parent: null, children: [],
    get numChildren() { return this.children.length; }, getChildAt(i) { return this.children[i]; } };
const player = { stage };
global.window = { addEventListener() {}, devicePixelRatio: 1, innerWidth: 800, innerHeight: 480,
    egret: { getQualifiedClassName(o) { return o.__class || "Object"; } } };
global.document = { documentElement: { clientLeft: 0, clientTop: 0 },
    querySelector(s) { return s === ".egret-player" ? { "egret-player": player } : null; } };
vm.runInThisContext(source, { filename: process.argv[1] });
let serial = 10;
function item(cls, name, text, parent, listener, bounds, alpha) {
    const o = { __class: cls, hashCode: serial++, name: name || null, text: text || "", parent,
        stage, visible: true, alpha: alpha === undefined ? 1 : alpha, touchEnabled: true, touchChildren: true, children: [],
        get numChildren() { return this.children.length; }, getChildAt(i) { return this.children[i]; },
        getTransformedBounds() { return bounds || { x: 0, y: 360, width: 600, height: cls.indexOf("Dialogue") >= 0 ? 120 : 40 }; } };
    if (listener) o.$EventDispatcher_props_ = { 1: { touchTap: [{ listener() {}, thisObject: o }] } };
    if (parent) parent.children.push(o);
    return o;
}
const t = window.__pageAgentTest;
const named = t.semanticTerms("任务目标萨帕尼克 NPC").terms;
const travel = t.semanticTerms("前往新白沙罗域的地图入口或传送点").terms;
const panel = item("dialogueIntegration.DialogueButtomMixed", null, null, stage, true);
item("eui.Label", "talk_txt", "这里好像不一样了", panel, true);
const passive = t.dialogueHasDecision(panel);
item("eui.Label", null, "接受", panel, true);
const decision = t.dialogueHasDecision(panel);
const npc = item("mapStory.StoryInteractObject", "npc_Hamo_3", null, stage, false);
const pet = item("iconManager.PetContainer", "1921_body", null, npc, true);
const canonical = t.semanticActionOwner(pet, stage) === npc;
const login = item("newLogin.NewLogin", "newLogin", null, stage, false, { x: 0, y: 0, width: 800, height: 480 });
const notice = item("eui.Image", "btn_notice", null, login, true, { x: 680, y: 20, width: 80, height: 40 });
notice.source = "new_entry_panel_img_btn_notice_png";
const noticeIsClose = !!t.findCloseControl(login);
const popup = item("ui.ModalPopup", "rewardPopup", null, stage, false, { x: 0, y: 0, width: 800, height: 480 });
const dim = item("eui.Rect", "dimMask", null, popup, true, { x: 0, y: 0, width: 800, height: 480 }, 0.55);
const content = item("eui.Group", "acceptanceContent", null, popup, false, { x: 150, y: 80, width: 500, height: 320 });
stage.$touchHandler = { findTarget(x, y) { return x >= 150 && x <= 650 && y >= 80 && y <= 400 ? content : dim; } };
const modalScene = t.sceneInfo();
const backdrop = t.backdropDismissTargetOf(modalScene.top);
const transition = item("egret.DisplayObjectContainer", "mapTitleOverlay", null, stage, false, { x: 0, y: 0, width: 800, height: 480 });
const transitionDim = item("eui.Rect", "transitionDim", null, transition, false, { x: 0, y: 0, width: 800, height: 480 }, 0.65);
const transitionTitle = item("eui.Group", "locationTitle", "《黑色漩涡》", transition, false, { x: 300, y: 200, width: 200, height: 80 });
stage.$touchHandler = { findTarget(x, y) { return x >= 300 && x <= 500 && y >= 200 && y <= 280 ? transitionTitle : transitionDim; } };
const transitionScene = t.sceneInfo();
const transientOverlay = t.transientOverlayOf(transitionScene.top);
const transitionDismiss = t.backdropDismissTargetOf(transitionScene.top);
const scene = item("game.MainScene", "mainScene", null, stage, false, { x: 0, y: 0, width: 800, height: 480 });
const sceneBg = item("eui.Image", "sceneBackground", null, scene, true, { x: 0, y: 0, width: 800, height: 480 }, 1);
const sceneContent = item("eui.Group", "content", null, scene, false, { x: 120, y: 60, width: 560, height: 360 });
stage.$touchHandler = { findTarget(x, y) { return x >= 120 && x <= 680 && y >= 60 && y <= 420 ? sceneContent : sceneBg; } };
const opaqueSceneBackdrop = t.maskPointOutside(scene);
// 工具栏的图标按钮只有英文实例名；「精灵背包」不能被旁边带「精灵」二字的活动入口抢走
const toolbar = item("ui.ToolbarNew", "toolbar", null, stage, false, { x: 0, y: 380, width: 800, height: 100 });
item("eui.Label", "txt_label", "至臻精灵", toolbar, true, { x: 20, y: 400, width: 66, height: 17 });
item("eui.Component", "btn_petBag", null, toolbar, true, { x: 700, y: 420, width: 42, height: 47 });
const bagHit = t.locateSemantic({ description: "精灵背包", rootHash: toolbar.hashCode }).candidates[0];
process.stdout.write(JSON.stringify({ named, travel, passive, decision, canonical, noticeIsClose, bagHit: bagHit && bagHit.name,
    modalTop: modalScene.top && modalScene.top.name, backdropReason: backdrop && backdrop.reason, backdropPoint: backdrop && backdrop.stagePoint,
    transientReason: transientOverlay && transientOverlay.reason, transientAction: transientOverlay && transientOverlay.action,
    transitionDismiss: !!transitionDismiss, opaqueSceneBackdrop: !!opaqueSceneBackdrop }));
'''
        result = subprocess.run([node, "-e", script, str(PAGE_AGENT)], capture_output=True, text=True,
                                encoding="utf-8", errors="replace", timeout=10, check=True)
        data = json.loads(result.stdout)
        self.assertTrue({"任务目标", "npc", "萨帕尼克"}.issubset(data["named"]))
        self.assertTrue({"地图", "传送", "新白沙罗域"}.issubset(data["travel"]))
        self.assertEqual(data["bagHit"], "btn_petBag")
        self.assertFalse(data["passive"])
        self.assertTrue(data["decision"])
        self.assertTrue(data["canonical"])
        self.assertFalse(data["noticeIsClose"])
        self.assertEqual(data["modalTop"], "acceptanceContent")
        self.assertEqual(data["backdropReason"], "modal-backdrop-dismiss")
        self.assertLess(data["backdropPoint"]["y"], 80)
        self.assertEqual(data["transientReason"], "transient-overlay")
        self.assertEqual(data["transientAction"], "wait")
        self.assertFalse(data["transitionDismiss"])
        self.assertFalse(data["opaqueSceneBackdrop"])

    def test_python_candidate_order(self):
        node = shutil.which("node")
        self.assertTrue(node, "node is required")
        script = ("const x=require(" + json.dumps(str(LAUNCHER)) + ");"
                  "process.stdout.write(JSON.stringify({win:x.pythonCandidates('win32',{}),mac:x.pythonCandidates('darwin',{})}));")
        result = subprocess.run([node, "-e", script], capture_output=True, text=True, check=True)
        candidates = json.loads(result.stdout)
        self.assertEqual([x["command"] for x in candidates["win"]], ["python", "py", "python3"])
        self.assertEqual([x["command"] for x in candidates["mac"]], ["python3", "python"])

    def test_launcher_initializes_mcp(self):
        node = shutil.which("node")
        env = dict(os.environ, EGRET_PYTHON=sys.executable, EGRET_MCP_PORT=str(PORT + 2),
                   PYTHONIOENCODING="utf-8")
        request = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}) + "\n"
        result = subprocess.run([node, str(LAUNCHER)], cwd=SERVER.parents[1], env=env, input=request,
                                capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=15, check=True)
        response = json.loads(result.stdout.splitlines()[0])
        self.assertEqual(response["result"]["serverInfo"]["name"], "egret-agent-inspector")


class FakeExtension:
    """模拟扩展 service worker：连接 server 并按 id 查询假数据应答页面请求。"""

    def __init__(self):
        self.calls = []
        self.page_params = []
        self.project = None
        self.panel = None
        self.tabs = None

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
        if msg["method"] == "listTabs" and self.tabs is not None:
            return {"id": msg["id"], "result": [{"tabId": t, "active": True, "url": "http://game/"} for t in self.tabs]}
        if msg["method"] != "page":
            return {"id": msg["id"], "result": {"ok": True}}
        method, p = params["method"], params["params"]
        self.page_params.append((method, p))
        node = NODES.get(p.get("id"))
        if method == "find":
            result = {"total": 1 if node else 0, "results": [node] if node else []}
        elif method == "getNode":
            result = dict(node, props={})
        elif method == "tap":
            result = {"method": "touch", "target": node, "warnings": []}
        elif method == "waitFor":
            result = {"matched": bool(node), "elapsedMs": 5}
        elif method == "advance":
            result = {"advanced": 1, "stopped": "done", "steps": []}
        elif method == "runtimeStats":
            result = {"jsHeap": {"usedBytes": 10}, "egret": {"displayObjects": 2}}
        elif method == "getTree":
            result = {"nodeCount": 1, "truncated": False, "tree": NODES["btn_notice"]}
        elif method in ("observe", "act"):
            action = {"i": 1, "hash": 7, "role": "button", "label": "btn_notice", "from": "qaName",
                      "size": [40, 40], "point": {"x": 10, "y": 10}}
            if p.get("rects"):
                action["screenRect"] = {"x": 0, "y": 0, "width": 40, "height": 40}
            result = {"stageSize": [976, 480], "mode": "normal", "scope": "panel",
                      "marker": "m1", "actions": [action], "text": ["hi"], "omitted": 0}
            if p.get("rects"):
                result.update(devicePixelRatio=1, viewportSize={"width": 100, "height": 100},
                              captureSize={"width": 100, "height": 100})
            if self.project:
                result["project"] = self.project
            if self.panel:
                result["panel"] = self.panel
            if method == "act":
                result.update(executed=[{"op": "tap"}], stopped="done", elapsedMs=12)
        elif method == "locate":
            result = {"description": p["description"], "matched": 1, "ambiguous": False,
                      "recommendedTarget": NODES["btn_notice"], "candidates": [NODES["btn_notice"]]}
        elif method == "getErrors":
            errors = [{"type": "console.error", "message": "boom", "at": 1, "lastAt": 1, "count": 1, "stack": None}]
            result = {"total": len(errors), "now": 100, "collectingSince": 0,
                      "errors": errors if p.get("limit") else []}
        else:
            return {"id": msg["id"], "error": "unsupported"}
        return {"id": msg["id"], "result": {"tabId": 1, "frameId": 0, "result": result}}


class OcrLabelTest(unittest.TestCase):
    def test_apply_ocr_labels_only_replaces_weak_labels(self):
        sys.path.insert(0, str(SERVER.parent))
        try:
            import egret_agent_inspector_mcp as server
        finally:
            sys.path.pop(0)
        table = {"actions": [
            {"hash": 1, "label": "btn_start", "from": "qaName"},
            {"hash": 2, "label": "开始", "from": "text"},
            {"hash": 3, "label": "img_x", "from": "source"},
        ]}
        filled = server.apply_ocr_labels(table, {"1": " 进入游戏 ", "2": "别动我", "9": "无关"})
        self.assertEqual(filled, 1)
        # 美术字常被 OCR 认错，原结构化标签保留在 alt 里兜底
        self.assertEqual(table["actions"][0],
                         {"hash": 1, "label": "进入游戏", "from": "ocr", "alt": "btn_start"})
        self.assertEqual(table["actions"][1]["label"], "开始")
        self.assertEqual(table["actions"][2]["from"], "source")


class McpServerTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.install_dir = os.path.join(self.tmp.name, "extension")
        env = dict(os.environ, EGRET_MCP_PORT=str(PORT), EGRET_MCP_CONNECT_WAIT="2", PYTHONIOENCODING="utf-8",
                   EGRET_EXTENSION_DIR=self.install_dir, EGRET_NOTES_DIR=os.path.join(self.tmp.name, "notes"),
                   EGRET_OCR_PREWARM="0")
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

    async def call_text(self, name, args=None):
        res = await self.rpc("tools/call", {"name": name, "arguments": args or {}})
        return res, res["content"][0]["text"]

    async def test_tools_listed(self):
        listed = (await self.rpc("tools/list"))["tools"]
        tools = {t["name"] for t in listed}
        for name in ("egret_find", "egret_extension_status", "egret_install_extension",
                     "egret_reload_extension", "egret_reopen_browser", "egret_run_steps", "egret_observe",
                     "egret_act", "egret_runtime_stats",
                     "egret_inspect_code", "egret_locate", "egret_notes", "splan_call",
                     "splan_test_command"):
            self.assertIn(name, tools)
        self.assertNotIn("egret_interactables", tools)
        # egret_observe 是 egret_scene 的超集，旧工具不再暴露，减少 agent 的选择面
        self.assertNotIn("egret_scene", tools)
        # 默认 core 档位：完全能被 egret_act / egret_observe 顶掉的工具不出现在工具面上
        for name in ("egret_tap", "egret_advance", "egret_dismiss_popups", "egret_wait_for",
                     "egret_get_tree", "egret_get_node", "egret_hit_test", "egret_status", "egret_set_props"):
            self.assertNotIn(name, tools)
        observe = next(tool for tool in listed if tool["name"] == "egret_observe")["inputSchema"]["properties"]
        self.assertIn("ocr", observe)
        self.assertIn("rootHash", observe)
        act = next(tool for tool in listed if tool["name"] == "egret_act")["inputSchema"]["properties"]
        self.assertIn("steps", act)
        self.assertIn("marker", act)
        self.assertIn("format", observe)
        # 隐藏的工具只是不出现在工具面上，schema 本身照旧（EGRET_MCP_PROFILE=full 时会列出来）
        wait = load_server().TOOLS["egret_wait_for"][1]["properties"]
        self.assertIn("changed", wait["state"]["enum"])
        self.assertIn("anyOf", wait)
        self.assertIn("interruptOnOverlay", wait)
        locate = next(tool for tool in listed if tool["name"] == "egret_locate")["inputSchema"]["properties"]
        self.assertIn("ocr", locate)
        self.assertIn("ocrLimit", locate)
        command = next(tool for tool in listed if tool["name"] == "splan_test_command")["inputSchema"]
        self.assertIn("authorized", command["required"])

    async def test_requests_go_to_the_browser_that_owns_the_tab(self):
        # Chrome 和 agent 专用的 Edge 都装了扩展：谁后连上谁是 active，按 tabId 找对浏览器
        chrome, edge = FakeExtension(), FakeExtension()
        chrome.tabs, edge.tabs = [11], [22, 23]
        await chrome.connect()
        try:
            await self.call("egret_extension_status", {"waitSeconds": 2})
            # 刚启动时另一个浏览器还没连上：等它连上再发，不去问手上这个
            late = asyncio.ensure_future(self.call_text("egret_observe", {"tabId": 22}))
            await asyncio.sleep(0.5)
            await edge.connect()
            await late
            self.assertIn(("page", "observe"), edge.calls)
            self.assertNotIn(("page", "observe"), chrome.calls)
            _, tabs = await self.call("egret_list_tabs", {"probe": False})
            self.assertEqual(sorted(t["tabId"] for t in tabs), [11, 22, 23])
            await self.call_text("egret_observe", {"tabId": 11})
            self.assertIn(("page", "observe"), chrome.calls)
            # 之后不带 tabId 的请求跟着上一次的浏览器走
            await self.call_text("egret_observe", {})
            self.assertEqual(chrome.calls.count(("page", "observe")), 2)
            self.assertEqual(edge.calls.count(("page", "observe")), 1)
        finally:
            for ext in (chrome, edge):
                ext.task.cancel()
                ext.writer.close()

    async def test_observe_and_act_use_the_action_table(self):
        ext = FakeExtension()
        await ext.connect()
        try:
            await self.call("egret_extension_status", {"waitSeconds": 2})
            _, text = await self.call_text("egret_observe", {})
            # 默认是一行一个动作的紧凑文本，不是 JSON
            self.assertIn("marker m1", text)
            self.assertIn("1 btn_notice* button", text.splitlines())
            self.assertIn("文案 hi", text.splitlines())
            self.assertNotIn("screenRect", text)
            self.assertNotIn("splan-control", text)

            # Splan 项目的页面（有全局 MFC）：observe 指向 splan-control，act 不再每步重复
            ext.project = "splan"
            _, text = await self.call_text("egret_observe", {})
            self.assertTrue(text.splitlines()[1].startswith("技能 这是 Splan 项目页面"), text)
            self.assertIn("splan-control", text)
            self.assertIn("splan-battle", text)
            self.assertNotIn("splan-login", text)
            # 登录页才提换号技能
            ext.panel = {"className": "newLogin.NewLogin"}
            _, text = await self.call_text("egret_observe", {})
            self.assertIn("splan-login", text)
            ext.panel = None
            _, text = await self.call_text("egret_act", {"marker": "m1", "steps": [{"i": 1}]})
            self.assertNotIn("splan-control", text)
            ext.project = None

            _, table = await self.call("egret_observe", {"format": "json"})
            self.assertEqual(table["marker"], "m1")
            # 几何信息只在 format=json 时带回，紧凑文本里不占上下文
            self.assertNotIn("screenRect", table["actions"][0])
            self.assertNotIn("captureSize", table)

            _, acted = await self.call("egret_act", {"marker": "m1", "steps": [{"i": 1}], "format": "json"})
            self.assertEqual(acted["stopped"], "done")
            sent = [p for m, p in ext.page_params if m == "act"][0]
            self.assertEqual(sent["steps"], [{"i": 1}])
            self.assertEqual(sent["marker"], "m1")

            # 渲染和 OCR 都在 server 侧做，页面一律返回完整字段
            self.assertTrue(all(p.get("detail") and p.get("rects")
                                for m, p in ext.page_params if m in ("observe", "act")))

            # OCR 后端不可用时只降级成 ocr.available=false，不影响动作表
            _, with_ocr = await self.call("egret_observe", {"ocr": True, "format": "json"})
            self.assertIn("ocr", with_ocr)
            self.assertNotIn("screenRect", with_ocr["actions"][0])

            _, report = await self.call("egret_run_steps", {"screenshotOnFailure": False, "steps": [
                {"action": "scene"}, {"action": "observe"}, {"action": "act", "steps": [{"i": 1}]}]})
            self.assertTrue(report["passed"], report)
            recent = [m for m, _ in ext.page_params if m in ("observe", "act")][-3:]
            self.assertEqual(recent, ["observe", "observe", "act"])
        finally:
            ext.task.cancel()
            ext.writer.close()

    async def test_status_without_extension(self):
        res, data = await self.call("egret_extension_status", {"waitSeconds": 0.2})
        self.assertFalse(data["connected"])
        self.assertTrue(data["bridgeAvailable"])
        self.assertTrue(data["bundledVersion"])
        self.assertIn("defaultBrowser", data["local"])
        res, _ = await self.call("egret_find", {"id": "x"})
        self.assertTrue(res["isError"])
        self.assertIn("egret-install-extension", res["content"][0]["text"])

    async def test_missing_required_argument_is_named(self):
        # 参数名写错时页面拿到 undefined 会悄悄返回 null，agent 以为接口不能用
        res, message = await self.call("egret_evaluate", {"text": "1 + 1"})
        self.assertTrue(res["isError"])
        self.assertIn("缺少必填参数 expression", message)
        self.assertIn("text", message)

    async def test_repeated_dialogue_taps_are_rejected(self):
        res, message = await self.call("egret_run_steps", {"screenshotOnFailure": False, "steps": [
            {"action": "tap", "qaName": "DialogueButtomMixed__talk_txt", "optional": True},
            {"action": "tap", "qaName": "DialogueButtomMixed__talk_txt", "optional": True},
            {"action": "tap", "qaName": "DialogueButtomMixed__talk_txt", "optional": True},
        ]})
        self.assertTrue(res["isError"])
        self.assertIn("advance", message)

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
        _, route = await self.call("egret_notes", {"action": "add", "scope": "demo", "entries": [{
            "kind": "route", "key": "main-story", "summary": "从主场景进入主线",
            "start": "主场景", "steps": [{"tap": {"qaName": "ToolbarNew__btn_task"}}],
            "expect": {"text": "立即前往"}}]})
        self.assertEqual(route["added"], 1)
        self.assertNotIn("file", route)
        _, multi = await self.call("egret_notes", {"action": "search", "scope": "demo", "q": "不存在 主线"})
        self.assertEqual(multi["notes"][0]["steps"][0]["tap"]["qaName"], "ToolbarNew__btn_task")
        rejected, message = await self.call("egret_notes", {"action": "add", "scope": "demo", "entries": [{
            "kind": "route", "key": "bad", "summary": "错误路线", "steps": [{"action": "openModule", "module": "TASK_PANEL"}]}]})
        self.assertTrue(rejected["isError"])
        self.assertIn("真实 UI", message)
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
            _, _ = await self.call("egret_get_tree", {"depth": 99, "maxNodes": 999})
            method, params = ext.page_params[-1]
            self.assertEqual(method, "getTree")
            self.assertEqual(params["depth"], 8)
            self.assertEqual(params["maxNodes"], 120)
            _, located = await self.call("egret_locate", {"description": "公告按钮", "limit": 999})
            self.assertFalse(located["ambiguous"])
            self.assertEqual(ext.page_params[-1][1]["limit"], 20)
            _, advanced = await self.call("egret_advance", {"max": 999, "waitMs": 99999,
                                                              "paceMs": 99999, "stableMs": 99999})
            self.assertEqual(advanced["advanced"], 1)
            self.assertEqual(ext.page_params[-1][1]["max"], 12)
            self.assertEqual(ext.page_params[-1][1]["waitMs"], 5000)
            self.assertEqual(ext.page_params[-1][1]["paceMs"], 2000)
            self.assertEqual(ext.page_params[-1][1]["stableMs"], 1500)
            _, stats = await self.call("egret_runtime_stats")
            self.assertEqual(stats["egret"]["displayObjects"], 2)
        finally:
            ext.task.cancel()
            ext.writer.close()


def load_server():
    """server 模块只在用到时导入，和其它用例保持一致，避免影响 stdio 子进程测试。"""
    sys.path.insert(0, str(SERVER.parent))
    try:
        import egret_agent_inspector_mcp as module
    finally:
        sys.path.pop(0)
    return module


class PageAgentLintTest(unittest.TestCase):
    def test_no_local_shadows_a_top_level_helper(self):
        # 页面代理整体是一个 IIFE，var 会提升到函数作用域：局部变量叫 round 就把 round() 遮住了，
        # op=close 曾经因此一调就报 "round is not a function"，而单测完全没覆盖到那条路径
        src = PAGE_AGENT.read_text(encoding="utf-8")
        tops = set(re.findall(r"^    (?:async )?function (\w+)\s*\(", src, re.M))
        self.assertIn("round", tops)
        shadows = []
        for m in re.finditer(r"\b(?:var|let|const)\s+(\w+)\b", src):
            if m.group(1) in tops:
                shadows.append("%s @ line %d" % (m.group(1), src.count("\n", 0, m.start()) + 1))
        for m in re.finditer(r"function\s*\w*\s*\(([^)]*)\)", src):
            for param in (x.strip() for x in m.group(1).split(",")):
                if param in tops:
                    shadows.append("%s (param) @ line %d" % (param, src.count("\n", 0, m.start()) + 1))
        self.assertEqual(shadows, [])


class ActionTableTest(unittest.TestCase):
    """动作表的噪音过滤与扫描预算：limit 调小不能把顶层面板的按钮弄丢。"""

    def run_probe(self):
        node = shutil.which("node")
        self.assertTrue(node, "node is required")
        script = r'''const fs = require("fs");
let source = fs.readFileSync(process.argv[1], "utf8");
source = source.replace("\n    installErrorHooks();",
    "\n    window.__pageAgentTest = { buildActionTable, findCloseControl, itemsOf, pickWithinLimit, actionRoleOf };\n    installErrorHooks();");
const vm = require("vm");
const stage = { __class: "egret.Stage", hashCode: 1, stageWidth: 800, stageHeight: 480,
    visible: true, alpha: 1, touchEnabled: true, touchChildren: true, parent: null, children: [],
    get numChildren() { return this.children.length; }, getChildAt(i) { return this.children[i]; } };
const player = { stage };
global.window = { addEventListener() {}, devicePixelRatio: 1, innerWidth: 800, innerHeight: 480,
    egret: { getQualifiedClassName(o) { return o.__class || "Object"; } } };
global.document = { documentElement: { clientLeft: 0, clientTop: 0 },
    querySelector(s) { return s === ".egret-player" ? { "egret-player": player } : null; } };
vm.runInThisContext(source, { filename: process.argv[1] });

let serial = 10;
const painted = [];
function item(cls, name, parent, bounds, opts) {
    opts = opts || {};
    const o = { __class: cls, hashCode: serial++, name: name || null, text: opts.text || "",
        parent, stage, visible: true, alpha: 1, touchEnabled: true, touchChildren: true, children: [],
        get numChildren() { return this.children.length; }, getChildAt(i) { return this.children[i]; },
        getTransformedBounds() { return bounds; } };
    // 纯热区容器：没有子渲染对象，内容包围盒退化成 0，但 Egret 按 width/height 命中
    if (opts.layout) {
        o.width = opts.layout.width;
        o.height = opts.layout.height;
        o.localToGlobal = (x, y) => ({ x: opts.layout.x + (x || 0), y: opts.layout.y + (y || 0) });
    }
    if (opts.listener) o.$EventDispatcher_props_ = { 1: { touchTap: [{ listener() {}, thisObject: o }] } };
    if (parent) parent.children.push(o);
    if (!opts.offstage) painted.push({ o, bounds: opts.layout || bounds, solid: opts.solid !== false });
    return o;
}
function inside(b, x, y) { return x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height; }
stage.$touchHandler = { findTarget(x, y) {
    for (let i = painted.length - 1; i >= 0; i--) {
        if (painted[i].solid && inside(painted[i].bounds, x, y)) return painted[i].o;
    }
    return stage;
} };

// 底层地图：一堆装饰格子，用来吃掉扫描预算
const map = item("game.MapLayer", "mapLayer", stage, { x: 0, y: 0, width: 800, height: 480 }, { solid: false });
for (let k = 0; k < 60; k++) {
    item("eui.Image", "imgGrid", map, { x: (k % 10) * 80, y: Math.floor(k / 10) * 60, width: 70, height: 50 },
        { listener: true });
}
// 点落在舞台外的格子
item("eui.Image", "imgEdge", map, { x: -120, y: 100, width: 100, height: 50 }, { listener: true });
// 顶层弹窗：文字 + 外层容器 + 确定按钮（容器与按钮同矩形）
const alert = item("ui.SimpleAlert", "simpleAlert", stage, { x: 150, y: 115, width: 500, height: 250 },
    { listener: true });
item("eui.Label", "msg", alert, { x: 300, y: 200, width: 200, height: 20 },
    { listener: true, text: "您的账号重复登录！" });
// 返回键只有碰撞盒、箭头烘在背景图里：内容包围盒退化成 0x1，不回退到布局盒就整行丢掉
item("eui.Group", "grp_backArea", alert, { x: 160, y: 120, width: 0, height: 1 },
    { listener: true, layout: { x: 160, y: 120, width: 34, height: 25 } });
const grp = item("eui.Group", "grp_btn", alert, { x: 350, y: 280, width: 100, height: 40 }, { listener: true });
item("eui.Button", "confirm", grp, { x: 350, y: 280, width: 100, height: 40 }, { listener: true });
// 弱标签也可能很长：名字长不代表是正文，这种容器仍然可点
item("eui.Group", "grp_serverSelectLong", stage, { x: 20, y: 400, width: 160, height: 40 }, { listener: true });
// 列表项的名字放在同级 Label 里，压在背景图上：动作表该用这段文字当标签
const menuRow = item("eui.Group", "menuRow", stage, { x: 600, y: 400, width: 160, height: 50 }, {});
item("eui.Image", "tab_bg", menuRow, { x: 600, y: 400, width: 160, height: 50 }, { listener: true });
item("eui.Label", "menuName", menuRow, { x: 610, y: 415, width: 90, height: 20 }, { text: "限时特惠" });
// 红点角标：只是状态指示，不该占动作编号
item("eui.Image", "tab_red", menuRow, { x: 745, y: 402, width: 16, height: 16 }, { listener: true });
// 工具栏按钮：按钮本体套着一小块文字，留的必须是按钮本体而不是里面的 Label
const toolBtn = item("eui.Group", "grpTool", stage, { x: 700, y: 20, width: 54, height: 59 }, { listener: true });
item("eui.Label", "toolText", toolBtn, { x: 716, y: 44, width: 22, height: 11 }, { text: "福利" });

// 精灵背包那种列表：屏上只有几条，背后的 dataProvider 有 200 条，前 50 条满级
const petScroller = item("eui.Scroller", "petScroller", stage, { x: 20, y: 150, width: 200, height: 200 },
    { solid: false });
petScroller.height = 200;
petScroller.viewport = { __class: "eui.List", hashCode: serial++, name: "viewport", parent: petScroller, stage,
    visible: true, alpha: 1, children: [], get numChildren() { return this.children.length; },
    getChildAt(i) { return this.children[i]; }, getTransformedBounds() { return { x: 20, y: 150, width: 200, height: 200 }; },
    scrollV: 0, contentHeight: 4000, height: 200,
    dataProvider: { length: 200, getItemAt(i) {
        return { _cache: 1, exp: i * 10, nick: "pet" + i, level: i < 50 ? 100 : i % 7 + 1, petId: 1000 + i, skills: [1, 2] };
    } } };
petScroller.children.push(petScroller.viewport);

// 只有返回键的全屏面板（共创投票就是这样）：不挂到舞台上，免得干扰动作表
const backOnly = item("ui.FullPanel", "fullPanel", null, { x: 0, y: 0, width: 800, height: 480 },
    { offstage: true });
item("eui.Group", "grp_back", backOnly, { x: 10, y: 8, width: 0, height: 1 },
    { listener: true, offstage: true, layout: { x: 10, y: 8, width: 34, height: 25 } });

const t = window.__pageAgentTest;
function summarize(table) {
    return { labels: (table.actions || []).map(a => a.label), roles: (table.actions || []).map(a => a.role),
        alts: (table.actions || []).map(a => a.alt || null),
        weaks: (table.actions || []).map(a => !!a.weak),
        count: (table.actions || []).length,
        occludedHidden: table.occludedHidden || 0, omitted: table.omitted, text: table.text,
        mode: table.mode, scope: table.scope, panel: table.panel && (table.panel.name || table.panel.className),
        keys: Object.keys((table.actions || [])[0] || {}) };
}
process.stdout.write(JSON.stringify({
    small: summarize(t.buildActionTable({ limit: 10 })),
    big: summarize(t.buildActionTable({ limit: 30 })),
    detail: summarize(t.buildActionTable({ limit: 30, detail: true })),
    withOccluded: summarize(t.buildActionTable({ limit: 30, occluded: true })),
    closeStrict: (t.findCloseControl(backOnly, false) || {}).o ? "found" : null,
    closeBack: ((t.findCloseControl(backOnly, true) || {}).o || {}).name || null,
    scrollers: t.buildActionTable({ limit: 30 }).scrollers || [],
    notMax: t.itemsOf(petScroller, it => it.level < 100),
    byField: t.itemsOf(petScroller.viewport.hashCode, { nick: "pet7" }, { fields: ["nick", "level"] }),
    // 只写了 {limit} 的第二个参数是选项，不是「limit 字段等于 5」的筛选
    optsAsWhere: (r => ({ matched: r.matched, rows: r.rows.length }))(t.itemsOf(petScroller, { limit: 5 })),
    // 35 条列表小字排在前面，真正的按钮在后面：截断时按钮不能被挤掉
    picked: t.pickWithinLimit(Array.from({ length: 40 }, (_, k) => ({ label: "r" + k,
        role: k < 35 ? "text" : k === 38 ? "close" : "button", occluded: k === 36 })), 8).map(e => e.label),
    // 51×23 的扁按钮（精灵详情的升级键）不是小图标；22×22 的 buff 图标才排到最后
    flat: t.pickWithinLimit([{ label: "buff", role: "button", _w: 22, _h: 22 }]
        .concat(Array.from({ length: 5 }, (_, k) => ({ label: "t" + k, role: "text" })))
        .concat([{ label: "_btUpgrade", role: "button", _w: 51, _h: 23 }]), 3).map(e => e.label),
    backRoles: [
        ["toolBarExManager.SeerReturn2Component", "toolBarExManager_icon_32"],
        ["eui.Group", "grp_back_landscape"],
        ["eui.Image", "imgBackground"],
        ["eui.Button", "btnBack"],
        ["eui.Group", "btn_return"]
    ].map(([cls, name]) => t.actionRoleOf({ __class: cls, name, parent: null, children: [],
        get numChildren() { return 0; }, getChildAt() { return null; } }, "", "name"))
}));
'''
        result = subprocess.run([node, "-e", script, str(PAGE_AGENT)], capture_output=True, text=True,
                                encoding="utf-8", errors="replace", timeout=10, check=True)
        return json.loads(result.stdout)

    def test_small_limit_keeps_top_panel_actions(self):
        data = self.run_probe()
        # 60 个地图装饰格子在弹窗下面：扫描预算必须留得住顶层弹窗的确定按钮
        self.assertIn("confirm", data["small"]["labels"])
        self.assertIn("confirm", data["big"]["labels"])

    def test_noise_rows_are_dropped(self):
        data = self.run_probe()
        labels = data["big"]["labels"]
        # 点落在舞台外的条目、与子按钮同矩形的容器都不该占编号
        self.assertNotIn("imgEdge", labels)
        self.assertNotIn("grp_btn", labels)
        # 被遮挡的条目默认只报数量
        self.assertGreater(data["big"]["occludedHidden"], 0)
        self.assertNotIn("occluded", data["big"]["keys"])
        self.assertEqual(data["withOccluded"]["occludedHidden"], 0)
        self.assertGreater(data["withOccluded"]["count"], data["big"]["count"])
        # 重复的奖励格子折叠到三条
        self.assertEqual(labels.count("imgGrid"), 3)

    def test_rows_are_slim_unless_detail(self):
        data = self.run_probe()
        self.assertEqual(sorted(data["big"]["keys"]), ["i", "label", "role", "weak"])
        self.assertIn("hash", data["detail"]["keys"])
        self.assertIn("point", data["detail"]["keys"])

    def test_weak_row_borrows_the_text_sitting_on_it(self):
        data = self.run_probe()
        labels = data["big"]["labels"]
        # 名字在同级 Label 里时，行不该只显示 tab_bg 这种组件名
        self.assertIn("限时特惠", labels)
        self.assertEqual(data["big"]["alts"][labels.index("限时特惠")], "tab_bg")
        # 借来的文案算真文案，不打弱标签星号
        self.assertFalse(data["big"]["weaks"][labels.index("限时特惠")])
        # 红点角标不占编号
        self.assertNotIn("tab_red", labels)

    def test_button_wrapping_a_small_label_survives(self):
        data = self.run_probe()
        labels = data["big"]["labels"]
        # 「福利」这一行必须是 54x59 的按钮本体（role button），不是里面 22x11 的 Label
        self.assertIn("福利", labels)
        self.assertEqual(data["big"]["roles"][labels.index("福利")], "button")
        self.assertEqual(labels.count("福利"), 1)

    def test_pure_hit_area_keeps_its_row(self):
        data = self.run_probe()
        # 空 Group 的内容包围盒是 0x1，退化时要回退到布局盒，否则玩家点得到、动作表里却没有
        self.assertIn("grp_backArea", data["big"]["labels"])

    def test_scroller_reports_what_is_behind_the_screen(self):
        data = self.run_probe()
        pets = [s for s in data["scrollers"] if s.get("items")]
        self.assertEqual(len(pets), 1)
        # 屏上几条，背后 200 条：模型要看到总数和字段才会想到去读数据
        self.assertEqual(pets[0]["items"], 200)
        # 名字、等级这类能拿来筛选的字段排前面；私有字段和数组不列
        self.assertEqual(pets[0]["fields"][:3], ["nick", "level", "petId"])
        self.assertNotIn("_cache", pets[0]["fields"])
        self.assertNotIn("skills", pets[0]["fields"])

    def test_items_reads_the_whole_list(self):
        data = self.run_probe()
        not_max = data["notMax"]
        self.assertEqual(not_max["total"], 200)
        self.assertEqual(not_max["matched"], 150)
        # 默认只回 30 行，但 matched 给的是全量计数，不会让模型把「屏上看到的」当成总数
        self.assertEqual(len(not_max["rows"]), 30)
        self.assertTrue(not_max["truncated"])
        self.assertEqual(not_max["rows"][0]["index"], 50)
        by_field = data["byField"]
        self.assertEqual(by_field["matched"], 1)
        self.assertEqual(by_field["rows"], [{"index": 7, "nick": "pet7", "level": 100}])
        # 只写了 {limit} 的第二个参数按选项处理：全量匹配、只回 5 行
        self.assertEqual(data["optsAsWhere"], {"matched": 200, "rows": 5})

    def test_truncation_keeps_buttons_over_list_labels(self):
        data = self.run_probe()
        # 4 个没被遮挡的按钮全留下；被遮挡的那个排到文字后面；空位按阅读顺序给文字；输出仍是阅读顺序
        self.assertEqual(data["picked"], ["r0", "r1", "r2", "r3", "r35", "r37", "r38", "r39"])
        self.assertEqual(data["flat"], ["t0", "t1", "_btUpgrade"])

    def test_back_role_needs_a_real_back_name(self):
        roles = self.run_probe()["backRoles"]
        # 类名里的 Return 是「老兵回归」，background 只是背景图，都不是返回键
        self.assertNotEqual(roles[0], "back")
        self.assertEqual(roles[1], "back")
        self.assertNotEqual(roles[2], "back")
        self.assertEqual(roles[3], "back")
        self.assertEqual(roles[4], "back")

    def test_back_control_only_counts_when_asked(self):
        data = self.run_probe()
        # dismiss 保持严格：只有返回键的面板不当成弹窗去关，免得误点场景里的返回
        self.assertIsNone(data["closeStrict"])
        # op=close 明确要关掉当前面板，这时返回键才算数
        self.assertEqual(data["closeBack"], "grp_back")

    def test_prose_is_text_not_button(self):
        data = self.run_probe()
        labels = data["big"]["labels"]
        self.assertEqual(data["big"]["roles"][labels.index("您的账号重复登录！")], "text")
        # 已经作为动作列出来的文案不再在 text 里重复一遍
        self.assertNotIn("您的账号重复登录！", data["big"]["text"])
        # 长的 qaName/name 是弱标签，不是界面文案，不能把可点的容器降级成正文
        self.assertEqual(data["big"]["roles"][labels.index("grp_serverSelectLong")], "button")


class SceneAndTurnTest(unittest.TestCase):
    """主城 HUD 穿透、地图入口借标题、列表项合并，以及回合制界面的等锁 / 连出判定。"""

    probe = None

    @classmethod
    def run_probe(cls):
        if cls.probe is not None:
            return cls.probe
        node = shutil.which("node")
        if not node:
            raise unittest.SkipTest("node is required")
        script = r'''const fs = require("fs");
let source = fs.readFileSync(process.argv[1], "utf8");
source = source.replace("\n    installErrorHooks();",
    "\n    window.__pageAgentTest = { buildActionTable, waitForTurn, waitForUnlock, rowDiff, describeRowDiff, handlers, actionRoleOf, knownLockable };\n    installErrorHooks();");
const vm = require("vm");
const stage = { __class: "egret.Stage", hashCode: 1, stageWidth: 800, stageHeight: 480,
    visible: true, alpha: 1, touchEnabled: true, touchChildren: true, parent: null, children: [],
    get numChildren() { return this.children.length; }, getChildAt(i) { return this.children[i]; },
    getChildIndex(c) { return this.children.indexOf(c); } };
const player = { stage };
// debug 版 Egret 读舞台的 visible / alpha 会打 Warning #1009，每次 act 都冒出「页面报错」
const stageReads = [];
// 和 Egret 一样挂在原型上：for…in 遍历实例属性时碰不到，只有直接读才算
const stageProto = {};
// Egret 的 $markCannotUse：舞台上这些属性一读就警告
const STAGE_CANNOT_USE = { alpha: 1, visible: true, x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, touchEnabled: true,
    cacheAsBitmap: false, scrollRect: null, filters: null, blendMode: null, matrix: null };
Object.keys(STAGE_CANNOT_USE).forEach(k => Object.defineProperty(stageProto, k, { get() {
    stageReads.push(k + " " + new Error().stack.split(String.fromCharCode(10))[2].trim()); return STAGE_CANNOT_USE[k]; } }));
Object.keys(STAGE_CANNOT_USE).forEach(k => { delete stage[k]; });
Object.setPrototypeOf(stage, stageProto);
global.window = { addEventListener() {}, devicePixelRatio: 1, innerWidth: 800, innerHeight: 480,
    egret: { getQualifiedClassName(o) { return o.__class || "Object"; } } };
global.document = { documentElement: { clientLeft: 0, clientTop: 0 },
    querySelector(s) { return s === ".egret-player" ? { "egret-player": player } : null; } };
vm.runInThisContext(source, { filename: process.argv[1] });

let serial = 10;
let painted = [];
function item(cls, name, parent, bounds, opts) {
    opts = opts || {};
    const o = { __class: cls, hashCode: serial++, name: name || null, text: opts.text || "",
        parent, stage, visible: true, alpha: 1, touchEnabled: true, touchChildren: true, children: [],
        get numChildren() { return this.children.length; }, getChildAt(i) { return this.children[i]; },
        getChildIndex(c) { return this.children.indexOf(c); }, getTransformedBounds() { return bounds; } };
    if (opts.itemIndex !== undefined) o.itemIndex = opts.itemIndex;
    if (opts.listener) o.$EventDispatcher_props_ = { 1: { touchTap: [{ listener() {}, thisObject: o }] } };
    if (parent) parent.children.push(o);
    painted.push({ o, bounds, solid: opts.solid !== false });
    return o;
}
function remove(o) {
    o.parent.children.splice(o.parent.children.indexOf(o), 1);
    o.stage = null;
    painted = painted.filter(p => p.o !== o);
}
function inside(b, x, y) { return x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height; }
stage.$touchHandler = { findTarget(x, y) {
    for (let i = painted.length - 1; i >= 0; i--) {
        if (painted[i].solid && inside(painted[i].bounds, x, y)) return painted[i].o;
    }
    return stage;
} };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const t = window.__pageAgentTest;

// 主城：地图上的飞船热区没有字，「星际探索」四个字摆在热区正下方，自己没有监听
const mapLayer = item("game.MapLayer", "mapLayer", stage, { x: 0, y: 0, width: 800, height: 480 }, { solid: false });
item("eui.Image", "mapBg", mapLayer, { x: 0, y: 0, width: 800, height: 480 });
item("eui.Group", "pve_rect", mapLayer, { x: 100, y: 100, width: 80, height: 60 }, { listener: true });
const capBox = item("eui.Group", "capBox", mapLayer, { x: 105, y: 165, width: 70, height: 18 }, { solid: false });
item("eui.Label", "capText", capBox, { x: 105, y: 165, width: 70, height: 18 }, { text: "星际探索" });
// 邮箱热区在上，名字在下；跟随精灵（只有类名的匿名对象）正好走到名字上面，不能把名字抢走
item("eui.Group", "downTarget", mapLayer, { x: 500, y: 150, width: 77, height: 60 }, { listener: true });
const mailBox = item("eui.Group", "mailCap", mapLayer, { x: 505, y: 212, width: 70, height: 18 }, { solid: false });
item("eui.Label", "mailText", mailBox, { x: 505, y: 212, width: 70, height: 18 }, { text: "星际邮箱" });
item("game.Pet", null, mapLayer, { x: 495, y: 195, width: 90, height: 60 }, { listener: true });
// 技能栏：一个技能是一个列表项，名字、次数各是一块，要合成一行
const uiLayer = item("eui.Group", "uiLayer", stage, { x: 0, y: 0, width: 800, height: 480 }, { solid: false });
// 全屏 HUD：按面积是「全屏面板」，但中间透明，点下去落在地图上
const hud = item("ui.ToolbarPanel", "toolbarPanel", uiLayer, { x: 0, y: 0, width: 800, height: 480 }, { solid: false });
item("eui.Button", "btn_bag", hud, { x: 720, y: 400, width: 60, height: 60 }, { listener: true });
const bar = item("ui.SkillListBar", "skillBar", hud, { x: 300, y: 380, width: 320, height: 90 }, { solid: false });
const skill = item("ui.SkillListBarItem", "skill0", bar, { x: 300, y: 380, width: 149, height: 90 },
    { solid: false, itemIndex: 0 });
item("eui.Image", "bg", skill, { x: 300, y: 380, width: 149, height: 90 }, { listener: true });
item("eui.Label", "skillName", skill, { x: 340, y: 385, width: 60, height: 20 }, { listener: true, text: "撞击" });
item("eui.Label", "skillCount", skill, { x: 320, y: 420, width: 100, height: 20 }, { listener: true, text: "次数: 35/35" });
const label = item("eui.Label", "tipLabel", hud, { x: 20, y: 20, width: 100, height: 20 }, { text: "提示文字" });
// 两个「返回」：grp_back_landscape 才是返回，btn_return 是「经验返还」
item("eui.Group", "grp_back_landscape", hud, { x: 10, y: 100, width: 40, height: 40 }, { listener: true });
item("eui.Group", "btn_return", hud, { x: 60, y: 100, width: 40, height: 40 }, { listener: true });
// 队伍栏：五只精灵的标签一模一样，少于七个不折叠
for (let k = 0; k < 5; k++) {
    item("ui.TeamSlot", "slot" + k, hud, { x: 250 + k * 80, y: 190, width: 70, height: 70 }, { listener: true, text: "等级:100" });
}
const input = item("eui.EditableText", "nameInput", hud, { x: 20, y: 60, width: 150, height: 30 }, { listener: true });

(async () => {
    const out = {};
    out.table = t.buildActionTable({ limit: 30 });
    out.table = { scope: out.table.scope, text: out.table.text,
        rows: out.table.actions.map(a => ({ label: a.label, role: a.role, alt: a.alt || null })) };
    out.diff = t.describeRowDiff(t.rowDiff(["tab|explore_normal", "text|1/3"], ["tab|explore_select", "text|2/3"]));
    out.diffTextOnly = t.describeRowDiff(t.rowDiff(["text|1/3"], ["text|2/3"]));

    // 点完一秒左右才上锁（等服务端回包），演出 0.6s 后解锁
    setTimeout(() => { bar.touchChildren = false; }, 300);
    setTimeout(() => { bar.touchChildren = true; }, 900);
    out.lateLock = await t.waitForTurn(skill, 5000, 1500);
    // 没有宽限期就不等：普通按钮点完不白等
    out.noGrace = await t.waitForTurn(skill, 5000, 0);

    // 演出里冒出来的 buff 小图标、一闪而过的出招名都不算新选项；一直摆着的换宠栏才算
    bar.touchChildren = false;
    let banner, cap, petPick;
    setTimeout(() => { cap = item("eui.Image", "cap_0", uiLayer, { x: 285, y: 30, width: 16, height: 17 }, { listener: true }); }, 100);
    setTimeout(() => { banner = item("eui.Label", "castName", uiLayer, { x: 350, y: 200, width: 60, height: 24 }, { listener: true, text: "冲顶" }); }, 150);
    setTimeout(() => remove(banner), 750);
    let petPickB;
    setTimeout(() => {
        petPick = item("ui.PetPickItem", "pet2", uiLayer, { x: 400, y: 300, width: 70, height: 70 }, { listener: true, text: "等级:57" });
        petPickB = item("ui.PetPickItem", "pet4", uiLayer, { x: 480, y: 300, width: 70, height: 70 }, { listener: true, text: "等级:56" });
    }, 1300);
    const unlockLater = setTimeout(() => { bar.touchChildren = true; }, 6000);
    out.newControls = await t.waitForTurn(skill, 8000, 0);
    // 提前停下后别让这个定时器在后面的用例里把技能栏解开
    clearTimeout(unlockLater);
    bar.touchChildren = true;
    remove(petPick);
    remove(petPickB);
    remove(cap);

    // 对手的招式名横幅：一段字加一个图标、停两秒。它不是要你做的决定，等回合要一直等到解锁
    bar.touchChildren = false;
    let castBg, castIcon;
    setTimeout(() => {
        castBg = item("ui.SkillTip", "bg_0", uiLayer, { x: 600, y: 120, width: 160, height: 40 }, { listener: true, text: "激励·铁碎阵" });
        castIcon = item("eui.Image", "icon", uiLayer, { x: 560, y: 120, width: 40, height: 40 }, { listener: true });
    }, 200);
    setTimeout(() => { remove(castBg); remove(castIcon); }, 2400);
    setTimeout(() => { bar.touchChildren = true; }, 3000);
    out.bannerTurn = await t.waitForTurn(skill, 6000, 0);

    // 淡出到几乎透明的对象：命中测试还点得中，但玩家看不见，不进表
    const ghost = item("eui.Group", "ghostBtn", hud, { x: 300, y: 20, width: 60, height: 40 }, { listener: true, text: "看不见的" });
    ghost.alpha = 0.03;
    out.ghostListed = t.buildActionTable({ limit: 60 }).actions.some(a => a.label === "看不见的");
    remove(ghost);

    // 点上去时还锁着：先等解锁
    bar.touchChildren = false;
    setTimeout(() => { bar.touchChildren = true; }, 400);
    out.unlock = await t.waitForUnlock(skill, bar, 3000);

    // 技能栏一直锁着是因为游戏在等你换宠：先等解锁也得看见换宠栏，不能干等到倒计时替你选
    bar.touchChildren = false;
    let petPick2, petPick3;
    setTimeout(() => {
        petPick2 = item("ui.PetPickItem", "pet3", uiLayer, { x: 480, y: 300, width: 70, height: 70 }, { listener: true, text: "等级:99" });
        petPick3 = item("ui.PetPickItem", "pet5", uiLayer, { x: 560, y: 300, width: 70, height: 70 }, { listener: true, text: "等级:98" });
    }, 300);
    out.unlockBlocked = await t.waitForUnlock(skill, bar, 5000);
    remove(petPick2);
    remove(petPick3);
    bar.touchChildren = true;

    // 只给 text 的步骤是按文字找来点；带 hash 的 text 是填字，但只往输入框里填
    const typedLabel = await t.handlers.act({ steps: [{ hash: label.hashCode, text: "abc" }], quietMs: 50, timeoutMs: 200 });
    out.labelText = label.text;
    out.labelError = typedLabel.executed[0].error || null;
    const typedInput = await t.handlers.act({ steps: [{ hash: input.hashCode, text: "abc", dispatchChange: false }],
        quietMs: 50, timeoutMs: 200 });
    out.inputText = input.text;
    out.inputOp = typedInput.executed[0].op;

    // 卡片栏：卡片只挂 touchBegin，按下时才挂松手回调，拖出卡片上沿（或在卡片外松手）才算选中，原地点一下不算
    function listenOn(o) {
        o.$EventDispatcher_props_ = { 1: {} };
        o.addEventListener = function (type, fn, self) { (this.$EventDispatcher_props_[1][type] = this.$EventDispatcher_props_[1][type] || []).push({ listener: fn, thisObject: self }); };
        o.removeEventListener = function (type, fn) { const m = this.$EventDispatcher_props_[1]; m[type] = (m[type] || []).filter(b => b.listener !== fn); if (!m[type].length) delete m[type]; };
    }
    function fire(target, type, x, y) {
        for (let cur = target; cur && cur !== stage; cur = cur.parent) {
            const bins = ((cur.$EventDispatcher_props_ || {})[1] || {})[type];
            (bins || []).slice().forEach(b => b.listener.call(b.thisObject, { type, target, currentTarget: cur, stageX: x, stageY: y }));
        }
    }
    let down = null;
    Object.assign(stage.$touchHandler, {
        onTouchBegin(x, y) { down = this.findTarget(x, y); fire(down, "touchBegin", x, y); },
        onTouchMove(x, y) { if (down) fire(down, "touchMove", x, y); },
        onTouchEnd(x, y) {
            const up = this.findTarget(x, y);
            fire(up, "touchEnd", x, y);
            fire(down, up === down ? "touchTap" : "touchReleaseOutside", x, y);
        }
    });
    const TE = { TOUCH_BEGIN: "touchBegin", TOUCH_END: "touchEnd", TOUCH_RELEASE_OUTSIDE: "touchReleaseOutside" };
    const cardBar = { __class: "ui.CardBar", picked: [],
        touchBeginHandler(e) {
            const card = e.currentTarget;
            card.addEventListener(TE.TOUCH_END, this.touchEndHandler, this);
            card.addEventListener(TE.TOUCH_RELEASE_OUTSIDE, this.touchOutsideHandler, this);
        },
        touchEndHandler(e) {
            const card = e.currentTarget;
            card.removeEventListener(TE.TOUCH_END, this.touchEndHandler, this);
            card.removeEventListener(TE.TOUCH_RELEASE_OUTSIDE, this.touchOutsideHandler, this);
            const pnt = card.globalToLocal(e.stageX, e.stageY);
            if (pnt.y < 0) this.picked.push(card.name);
        },
        touchOutsideHandler(e) {
            const card = e.currentTarget;
            card.removeEventListener(TE.TOUCH_END, this.touchEndHandler, this);
            card.removeEventListener(TE.TOUCH_RELEASE_OUTSIDE, this.touchOutsideHandler, this);
            this.picked.push(card.name);
        } };
    [["card0", 20, "等级:88"], ["card1", 100, "等级:77"]].forEach(([name, x, level]) => {
        const card = item("ui.CardBarItem", name, hud, { x, y: 300, width: 70, height: 70 }, { solid: false });
        listenOn(card);
        card.globalToLocal = (sx, sy) => ({ x: sx - x, y: sy - 300 });
        card.addEventListener(TE.TOUCH_BEGIN, cardBar.touchBeginHandler, cardBar);
        item("eui.Image", "headIcon", card, { x, y: 300, width: 70, height: 70 });
        item("eui.Label", "labelLevel", card, { x: x + 5, y: 350, width: 60, height: 16 }, { text: level });
    });
    // 项目通用按钮工具也是按下时挂松手回调：松手时在按钮范围内才算点击。四条边都判，不是拖动
    const btnUtil = { __class: "TMButtonUtil",
        onTouchBegin(e) {
            const btn = e.currentTarget;
            btn.addEventListener(TE.TOUCH_END, this.onTouchEnd, this);
            btn.addEventListener(TE.TOUCH_RELEASE_OUTSIDE, this.onTouchCancel, this);
        },
        onTouchEnd(e) {
            const p = e.currentTarget.globalToLocal(e.stageX, e.stageY);
            if (p.x < 0 || p.y < 0 || p.x > e.currentTarget.width || p.y > e.currentTarget.height) return;
            this.clicked = e.currentTarget.name;
        },
        onTouchCancel() {} };
    const pressBtn = item("eui.Button", "btn_press", hud, { x: 200, y: 300, width: 60, height: 40 }, { solid: true });
    listenOn(pressBtn);
    pressBtn.addEventListener(TE.TOUCH_BEGIN, btnUtil.onTouchBegin, btnUtil);
    // 只挂按下、松手回调里不看方向（按下缩放、松手复原）：也不是拖动
    const plainUtil = { __class: "ScaleEffect",
        onDown(e) { e.currentTarget.addEventListener(TE.TOUCH_END, this.onUp, this); },
        onUp(e) { e.currentTarget.scaleX = 1; } };
    const scaleBtn = item("eui.Button", "btn_scale", hud, { x: 280, y: 300, width: 60, height: 40 }, { solid: true });
    listenOn(scaleBtn);
    scaleBtn.addEventListener(TE.TOUCH_BEGIN, plainUtil.onDown, plainUtil);
    // 原地点一下：游戏不认
    stage.$touchHandler.onTouchBegin(55, 335);
    stage.$touchHandler.onTouchEnd(55, 335);
    out.pickedByTap = cardBar.picked.slice();
    const cardTable = t.buildActionTable({ limit: 60 });
    out.dragRows = cardTable.actions.filter(a => a.drag).map(a => ({ label: a.label, drag: a.drag }));
    out.pressRows = cardTable.actions.filter(a => /btn_press|btn_scale/.test(a.label)).map(a => ({ label: a.label, drag: a.drag || null }));
    const card0 = cardTable.actions.find(a => a.drag && a.label.indexOf("88") >= 0);
    const swiped = await t.handlers.act({ marker: cardTable.marker, steps: [{ i: card0.i }], quietMs: 50, timeoutMs: 200, turnMs: 0 });
    out.pickedByAct = cardBar.picked.slice();
    out.actDrag = swiped.executed[0].drag || null;

    // 多步里后面的目标晚一点才出来（进战斗后技能栏才滑进来）：等它，不马上判找不到
    setTimeout(() => item("eui.Button", "lateBtn", hud, { x: 600, y: 20, width: 60, height: 40 }, { listener: true }), 500);
    const late = await t.handlers.act({ steps: [{ op: "wait", ms: 10 }, { name: "lateBtn", match: "exact" }],
        quietMs: 50, timeoutMs: 200, turnMs: 0 });
    out.lateError = late.executed[1] && late.executed[1].error || null;
    let startedAt = Date.now();
    const never = await t.handlers.act({ steps: [{ op: "wait", ms: 10 }, { name: "neverThere", match: "exact" }],
        quietMs: 50, timeoutMs: 200, turnMs: 0 });
    out.neverError = never.executed[1] && never.executed[1].error || null;
    out.neverMs = Date.now() - startedAt;

    // 提示框的问句里带「确定」不是确定键；按钮字「确定」、实例名 confirm 才是
    const q = item("eui.Label", "tip", hud, { x: 300, y: 100, width: 200, height: 20 }, { text: "确定要返回基地吗？" });
    out.questionRole = t.actionRoleOf(q, "确定要返回基地吗？", "text");
    out.okRole = t.actionRoleOf(q, "确定", "text");
    remove(q);

    // 转场时整层界面锁一下又解开：不能因此让之后每次点击都多等宽限期；局部的一组（技能栏）锁上又解开才算回合锁
    const layer = item("eui.Group", "sceneLayer", stage, { x: 0, y: 0, width: 800, height: 480 }, { solid: false });
    const inLayer = item("eui.Group", "panelBox", layer, { x: 600, y: 100, width: 150, height: 150 }, { solid: false });
    const plainBtn = item("eui.Button", "btn_plain", inLayer, { x: 610, y: 110, width: 60, height: 40 }, { listener: true });
    layer.touchChildren = false;
    t.buildActionTable({ limit: 60, peek: true });
    layer.touchChildren = true;
    t.buildActionTable({ limit: 60, peek: true });
    out.plainGrace = t.knownLockable(plainBtn);
    const turnBar = item("ui.MoveBar", "moveBar", inLayer, { x: 600, y: 180, width: 150, height: 60 }, { solid: false });
    const move = item("eui.Button", "btn_move", turnBar, { x: 610, y: 190, width: 60, height: 40 }, { listener: true });
    turnBar.touchChildren = false;
    t.buildActionTable({ limit: 60, peek: true });
    turnBar.touchChildren = true;
    t.buildActionTable({ limit: 60, peek: true });
    out.turnGrace = t.knownLockable(move);
    remove(layer);

    // 委托：工具栏按 e.target 分发，外层 ps_grp 自己没监听、名字不像控件，里面显示的是 petBtn
    const toolbar = item("ui.Toolbar", null, hud, { x: 60, y: 330, width: 740, height: 140 }, { solid: false, listener: true });
    const psGrp = item("eui.Group", "ps_grp", toolbar, { x: 720, y: 350, width: 54, height: 54 }, { solid: false });
    item("eui.Image", "battle_petBtn", psGrp, { x: 720, y: 350, width: 54, height: 54 });
    out.shellRows = t.buildActionTable({ limit: 60 }).actions.map(a => a.label).filter(l => /ps_grp|petBtn/.test(l));
    remove(toolbar);

    // 拖到目标：长按满 1 秒才起步，拖到技能栏的槽位上松手才算换上
    const dragState = { dragging: false, dropped: null };
    const skillSrc = item("ui.SkillBar", "skillBar_20164", hud, { x: 600, y: 120, width: 120, height: 40 }, { text: "斗志" });
    listenOn(skillSrc);
    skillSrc.addEventListener("touchBegin", function () { dragState.t0 = Date.now(); dragState.dragging = false; }, null);
    skillSrc.addEventListener("touchMove", function () { if (Date.now() - dragState.t0 >= 1000) dragState.dragging = true; }, null);
    const slot = item("ui.SkillCell", "skillCell_1", hud, { x: 420, y: 120, width: 90, height: 40 }, { text: "突破" });
    listenOn(slot);
    slot.addEventListener("touchEnd", function () { if (dragState.dragging) dragState.dropped = this.name; }, slot);
    let dragTable = t.buildActionTable({ limit: 60 });
    let srcRow = dragTable.actions.find(a => a.label === "斗志"), slotRow = dragTable.actions.find(a => a.label === "突破");
    const dragged = await t.handlers.act({ marker: dragTable.marker, steps: [{ i: srcRow.i, op: "drag", to: { i: slotRow.i } }],
        quietMs: 50, timeoutMs: 200, turnMs: 0 });
    out.dropped = dragState.dropped;
    out.dragTo = dragged.executed[0].to || null;
    // 不按住直接拖：挪完就松手，长按门槛还没到，起不了步
    dragState.dropped = null;
    dragTable = t.buildActionTable({ limit: 60 });
    srcRow = dragTable.actions.find(a => a.label === "斗志"); slotRow = dragTable.actions.find(a => a.label === "突破");
    await t.handlers.act({ marker: dragTable.marker, steps: [{ i: srcRow.i, op: "drag", holdMs: 0, to: { i: slotRow.i } }],
        quietMs: 50, timeoutMs: 200, turnMs: 0 });
    out.droppedNoHold = dragState.dropped;
    remove(skillSrc); remove(slot);

    // 点进去之后列表是淡入的：交表那一刻关卡项几乎全透明，不能就这么交一张没有关卡的表回去
    const level = item("ui.ChooseLevelItem", "levelItem_1", hud, { x: 460, y: 200, width: 280, height: 70 }, { listener: true, text: "1 第一关" });
    level.alpha = 0.03;
    setTimeout(() => { level.alpha = 0.4; }, 250);
    setTimeout(() => { level.alpha = 1; }, 450);
    const fadedIn = await t.handlers.act({ steps: [{ op: "wait", ms: 10 }], quietMs: 50, timeoutMs: 200, turnMs: 0 });
    out.fadedInListed = fadedIn.actions.some(a => a.label === "1 第一关");
    remove(level);

    // 从竖着滚的列表里往外拖：先横着挪出去，斜着拖的竖直分量会被列表当成滚动
    const vlist = item("eui.Scroller", "skillScroller", hud, { x: 600, y: 60, width: 150, height: 200 }, { solid: false });
    vlist.viewport = { contentHeight: 600, contentWidth: 150, scrollV: 0, scrollH: 0 };
    vlist.width = 150; vlist.height = 200;
    const listSkill = item("ui.SkillBar", "skillBar_9", vlist, { x: 610, y: 200, width: 120, height: 40 }, { text: "暴风" });
    listenOn(listSkill);
    const moves = [];
    listSkill.addEventListener("touchBegin", function () {}, null);
    listSkill.addEventListener("touchMove", function (e) { moves.push([e.stageX, e.stageY]); }, null);
    const slot2 = item("ui.SkillCell", "skillCell_2", hud, { x: 420, y: 60, width: 90, height: 40 }, { text: "拍打" });
    listenOn(slot2);
    slot2.addEventListener("touchEnd", function () {}, slot2);
    const t2 = t.buildActionTable({ limit: 60 });
    const src2 = t2.actions.find(a => a.label === "暴风"), dst2 = t2.actions.find(a => a.label === "拍打");
    await t.handlers.act({ marker: t2.marker, steps: [{ i: src2.i, op: "drag", holdMs: 0, to: { i: dst2.i } }],
        quietMs: 50, timeoutMs: 200, turnMs: 0 });
    const firstMove = moves.find(m => m[0] !== 670 || m[1] !== 220);
    out.dragFirstLeg = firstMove ? (firstMove[1] === 220 ? "horizontal" : "diagonal") : null;
    out.dragEnd = moves[moves.length - 1];

    // 连关两层：上一层关掉后，退场特效层自己顶在最上面一会儿就没了；这次 close 要关的是下面的背包
    const bag = item("petBag.PetBagPanel", "petBag", uiLayer, { x: 0, y: 0, width: 800, height: 480 });
    item("eui.Image", "bagBg", bag, { x: 0, y: 0, width: 800, height: 480 });
    const bagClose = item("eui.Button", "_btnClose", bag, { x: 740, y: 10, width: 50, height: 50 });
    listenOn(bagClose);
    bagClose.addEventListener("touchTap", function () { remove(bag); }, null);
    const fx = item("plugin.applicationView.EffectContainer", null, uiLayer, { x: 0, y: 0, width: 800, height: 480 }, { solid: false });
    item("eui.Image", "fxImg", fx, { x: 0, y: 0, width: 800, height: 480 }, { solid: false });
    setTimeout(() => remove(fx), 150);
    const closed = await t.handlers.act({ steps: [{ op: "close" }], quietMs: 50, timeoutMs: 200, turnMs: 0 });
    out.closeResult = closed.executed[0].result;
    out.bagClosed = !bag.stage;

    // 战斗胜利页分两段：第一下点遮罩只跳过动画，第二下才关
    const endPanel = item("ui.BattleEndPopup", "battleEnd", uiLayer, { x: 0, y: 0, width: 800, height: 480 });
    listenOn(endPanel);
    let endTaps = 0;
    endPanel.addEventListener("touchTap", function () { if (++endTaps >= 2) remove(endPanel); }, null);
    item("eui.Group", "endContent", endPanel, { x: 200, y: 120, width: 400, height: 240 });
    const endClosed = await t.handlers.act({ steps: [{ op: "close" }], quietMs: 50, timeoutMs: 200, turnMs: 0 });
    out.endClose = endClosed.executed[0].result;
    out.endTaps = endTaps;

    // 只有页面有全局 MFC（Splan 项目）才标 project
    out.projectPlain = t.buildActionTable({}).project || null;
    window.MFC = {};
    out.projectSplan = t.buildActionTable({}).project || null;
    delete window.MFC;
    out.stageReads = Array.from(new Set(stageReads)).slice(0, 12);

    // 同一屏先点「随机」再点「确定」：各步的编号都指 agent 看到的那张表，第一步改了输入框的字也照点第二步
    const nickBox = item("eui.EditableText", "nickInput", hud, { x: 300, y: 300, width: 150, height: 30 }, { text: "旧名字" });
    const randBtn = item("eui.Button", "randomName", hud, { x: 460, y: 300, width: 40, height: 30 }, { text: "随机" });
    const nickOk = item("eui.Button", "nickOk", hud, { x: 510, y: 300, width: 60, height: 30 }, { text: "起好了" });
    listenOn(randBtn);
    listenOn(nickOk);
    const nickTaps = [];
    randBtn.addEventListener("touchTap", function () { nickTaps.push("rand"); nickBox.text = "新名字" + nickTaps.length; }, null);
    nickOk.addEventListener("touchTap", function () { nickTaps.push("ok"); }, null);
    let nickTable = t.buildActionTable({ limit: 60 });
    const rowOf = (tb, o) => tb._entries.filter(a => a.hash === o.hashCode)[0];
    const bothNick = await t.handlers.act({ marker: nickTable.marker, steps: [{ i: rowOf(nickTable, randBtn).i }, { i: rowOf(nickTable, nickOk).i }],
        quietMs: 50, timeoutMs: 200, turnMs: 0 });
    out.sameTableTaps = nickTaps.slice();
    out.sameTableErrors = bothNick.executed.map(e => e.error || null);
    // 第一步把第二步的目标关掉了：照实报「不在了」，不去点别的
    randBtn.addEventListener("touchTap", function () { remove(nickOk); }, null);
    nickTable = t.buildActionTable({ limit: 60 });
    const goneNick = await t.handlers.act({ marker: nickTable.marker, steps: [{ i: rowOf(nickTable, randBtn).i }, { i: rowOf(nickTable, nickOk).i }],
        quietMs: 50, timeoutMs: 200, turnMs: 0 });
    out.goneTaps = nickTaps.slice(2);
    out.goneError = goneNick.executed[1] && goneNick.executed[1].error || null;
    remove(nickBox);
    remove(randBtn);

    // 弹窗上的图片字按钮不借弹窗后面那层面板里的字：技能替换框的确认键曾被标成背后技能列表里的「挑拨」
    const backPanel = item("ui.PetProperty", "petProperty", uiLayer, { x: 0, y: 0, width: 800, height: 480 });
    item("eui.Label", "skillName", backPanel, { x: 420, y: 262, width: 40, height: 20 }, { text: "挑拨" });
    const exchange = item("ui.SkillExchangePopup", "exchange", uiLayer, { x: 250, y: 120, width: 300, height: 130 });
    item("eui.Image", "img_confirm", exchange, { x: 410, y: 225, width: 60, height: 30 }, { listener: true });
    out.popupLabels = t.buildActionTable({ limit: 60 }).actions.map(a => a.label).filter(l => l === "挑拨" || l === "img_confirm");
    remove(exchange);
    // 同一层里：弹窗和它的黑色遮罩直接加在技能页上，字被遮罩盖住，也不能借
    item("eui.Image", "common_color_black_png", backPanel, { x: 0, y: 0, width: 800, height: 480 });
    const sameLayerPopup = item("eui.Group", "exchange2", backPanel, { x: 250, y: 120, width: 300, height: 130 });
    item("eui.Image", "img_confirm", sameLayerPopup, { x: 410, y: 225, width: 60, height: 30 }, { listener: true });
    out.sameLayerLabels = t.buildActionTable({ limit: 60 }).actions.map(a => a.label).filter(l => l === "挑拨" || l === "img_confirm");
    remove(backPanel);

    // ---- Splan（有全局 MFC）：直接读游戏的对白、说明层、引导、会话状态
    const splanRoot = item("game.RootLayer", "rootLayer", stage, { x: 0, y: 0, width: 800, height: 480 }, { solid: false });
    window.MFC = { rootLayer: splanRoot };
    // NoNo 对白：逐字打出来，打完之前点了不算；打完点一下推进一条，三条推完就收起
    const nono = item("NoNoDialog", null, splanRoot, { x: 0, y: 0, width: 800, height: 480 });
    listenOn(nono);
    Object.assign(nono, { step: 0, typeIndex: 0, m_dict: ["嘀嘀嘀，目标已完全清醒", "检测到你没有精灵伙伴", "滴···确认完毕！"],
        mcMask: { alpha: 0.7 } });
    nono.contents = nono.m_dict;
    let earlyTaps = 0;
    const typing = setInterval(() => { const line = nono.m_dict[nono.step]; if (line && nono.typeIndex < line.length) nono.typeIndex++; }, 40);
    nono.addEventListener("touchTap", function () {
        if (nono.typeIndex < nono.m_dict[nono.step].length) { earlyTaps++; return; }
        nono.step++;
        nono.typeIndex = 0;
        if (nono.step >= nono.m_dict.length) remove(nono);
    }, null);
    window.NoNoManager = { _instance: { nonoDialog: nono } };
    out.nonoMode = t.buildActionTable({}).mode;
    const nonoAct = await t.handlers.act({ steps: [{ op: "advance" }], quietMs: 50, timeoutMs: 200, turnMs: 0 });
    clearInterval(typing);
    out.nonoAdvance = { advanced: nonoAct.executed[0].result.advanced, gone: !nono.stage, earlyTaps };
    delete window.NoNoManager;

    // 新手战斗的说明层：rootLayer 上拉满全屏的 Rect 压着技能，点技能时先替它点掉
    let skillTaps = 0;
    const skillBtn = item("eui.Group", "skill_10006", splanRoot, { x: 300, y: 380, width: 120, height: 80 });
    listenOn(skillBtn);
    skillBtn.addEventListener("touchTap", function () { skillTaps++; }, null);
    const introCover = item("eui.Rect", null, splanRoot, { x: 0, y: 0, width: 800, height: 480 });
    introCover.alpha = 0.7;
    listenOn(introCover);
    introCover.addEventListener("touchTap", function () { remove(introCover); }, null);
    out.coverMode = t.buildActionTable({}).mode;
    const coverAct = await t.handlers.act({ steps: [{ hash: skillBtn.hashCode }], quietMs: 50, timeoutMs: 200, turnMs: 0 });
    out.coverTap = { cleared: coverAct.executed[0].cleared || null, error: coverAct.executed[0].error || null,
        skillTaps, gone: !introCover.stage };

    // 引导：目标直接读 _guideTapTarget；遮罩还在淡入时 recommended 等它落定再点
    const guidePanel = item("guideMask.GuideMask", "GuideMask", splanRoot, { x: 0, y: 0, width: 800, height: 480 }, { solid: false });
    guidePanel.bg = { touchEnabled: false };
    window.GuideMaskManager = { _instance: { guidePanel, _guideTapTarget: skillBtn } };
    const guideRec = t.buildActionTable({}).recommendedTarget;
    out.guideTarget = guideRec && guideRec.reason === "guide-hole" && guideRec.target.hash === skillBtn.hashCode;
    guidePanel.alpha = 0.4;
    setTimeout(() => { guidePanel.alpha = 1; }, 500);
    const guideStart = Date.now();
    await t.handlers.act({ steps: [{ op: "recommended" }], quietMs: 50, timeoutMs: 200, turnMs: 0 });
    out.guideWait = { waited: Date.now() - guideStart >= 400, skillTaps };
    // 点完引导目标，下一处引导要等新界面打开才挂出来：act 等它出来再交表，不交回一张没有遮罩的表
    window.frame = { GuideController: { guideState: 1 } };
    const nextBtn = item("eui.Button", "btn_next", splanRoot, { x: 500, y: 100, width: 80, height: 40 }, { listener: true });
    skillBtn.addEventListener("touchTap", function () {
        guidePanel.visible = false;
        setTimeout(() => {
            window.GuideMaskManager._instance._guideTapTarget = nextBtn;
            guidePanel.visible = true;
        }, 600);
    }, null);
    const nextGuide = await t.handlers.act({ steps: [{ op: "recommended" }], quietMs: 50, timeoutMs: 200, turnMs: 0 });
    out.nextGuide = { mode: nextGuide.mode,
        target: !!(nextGuide.recommendedTarget && nextGuide.recommendedTarget.target.hash === nextBtn.hashCode) };
    delete window.frame;
    remove(nextBtn);
    delete window.GuideMaskManager;
    remove(guidePanel);
    remove(skillBtn);

    // 手势动画引导：一只手从 A 滑到 B，读出它的 Tween 路径，recommended 替你按住把 A 处的东西拖到 B
    let dropAt = null;
    const grabItem = item("eui.Group", "skillBarLearned", splanRoot, { x: 600, y: 180, width: 120, height: 70 });
    listenOn(grabItem);
    grabItem.addEventListener("touchBegin", function () {}, null);
    grabItem.addEventListener("touchReleaseOutside", function (e) { dropAt = [e.stageX, e.stageY]; }, null);
    const dropCell = item("ui.SkillCell", null, splanRoot, { x: 450, y: 170, width: 120, height: 70 }, { solid: false });
    const handBox = item("egret.Sprite", null, splanRoot, { x: 0, y: 0, width: 800, height: 480 }, { solid: false });
    handBox.localToGlobal = (x, y) => ({ x, y });
    const hand = item("eui.Image", null, handBox, { x: 660, y: 215, width: 59, height: 52 }, { solid: false });
    hand.source = "resource/guide/image/guide_hand.png";
    window.egret.Tween = { _tweens: [{ _target: hand, _steps: [
        { type: "step", d: 0, p0: { x: 660, y: 215, alpha: 0 }, p1: { x: 660, y: 215, alpha: 0 } },
        { type: "step", d: 1500, p0: { x: 660, y: 215 }, p1: { x: 510, y: 205 } }] }] };
    out.dragMode = t.buildActionTable({}).mode;
    await t.handlers.act({ steps: [{ op: "recommended" }], quietMs: 50, timeoutMs: 200, turnMs: 0 });
    out.dropAt = dropAt;
    delete window.egret.Tween;
    remove(handBox);
    remove(dropCell);
    remove(grabItem);

    // 被踢下线：表上直接给出重开页面的提示
    window.MFC.userInfo = {};
    window.MFC.inGameState = 0;
    out.session = t.buildActionTable({}).session || null;
    delete window.MFC.userInfo;

    // 图片字按钮的固定叫法：登录页的进入游戏、入场动画的跳过
    const startBtn = item("eui.Image", "btn_start", splanRoot, { x: 360, y: 400, width: 80, height: 40 }, { listener: true });
    startBtn.qaName = "NewLogin__btn_start";
    const skipBtn = item("eui.Image", null, splanRoot, { x: 700, y: 20, width: 60, height: 30 }, { listener: true });
    skipBtn.source = "resource/main/ui/common/new_seer_skipBtn.png";
    out.splanLabels = t.buildActionTable({ limit: 60 }).actions.map(a => a.label).filter(l => l === "进入游戏" || l === "跳过动画");
    remove(startBtn);
    remove(skipBtn);
    // 顶层是模块里的子面板、自己没有关闭键：点外层模块的返回键（主线任务面板、精灵背包）
    const taskModule = item("TaskModule", "taskModule", splanRoot, { x: 0, y: 0, width: 800, height: 480 });
    const taskBg = item("eui.Image", "taskBg", taskModule, { x: 0, y: 0, width: 800, height: 480 });
    const taskBack = item("eui.Group", "grp_back_landscape", taskModule, { x: 10, y: 10, width: 60, height: 40 });
    const mainTask = item("MainTaskPanel", "mainTask", taskModule, { x: 100, y: 60, width: 600, height: 400 });
    const mainTaskBg = item("eui.Image", "mainTaskBg", mainTask, { x: 100, y: 60, width: 600, height: 400 });
    listenOn(taskBack);
    taskBack.addEventListener("touchTap", function () { [mainTaskBg, mainTask, taskBg, taskBack, taskModule].forEach(remove); }, null);
    const outerRun = (await t.handlers.act({ steps: [{ op: "close" }], quietMs: 50, timeoutMs: 200, turnMs: 0 })).executed[0];
    out.outerClose = { via: outerRun.result && outerRun.result.via, gone: !taskModule.stage };
    // 战斗界面不能 close：返回键是暂停，退出直接判负；自动战斗键写明别点
    // 和实页一样：模块容器类名是 ApplicationViewAdvanced、名字叫 BattlePanel；工具栏类名是 Toolbar，autoOn 的 name 写死成 battle_autoBtn
    const battlePanel = item("plugin.applicationView.ApplicationViewAdvanced", "BattlePanel", splanRoot, { x: 0, y: 0, width: 800, height: 480 });
    const battleToolbar = item("Toolbar", null, battlePanel, { x: 600, y: 390, width: 200, height: 70 }, { solid: false });
    item("eui.Image", "battle_autoBtn", battleToolbar, { x: 700, y: 400, width: 50, height: 50 }, { listener: true });
    item("eui.Image", "pauseButton", battlePanel, { x: 10, y: 10, width: 40, height: 40 }, { listener: true });
    out.battleClose = (await t.handlers.act({ steps: [{ op: "close" }], quietMs: 50, timeoutMs: 200, turnMs: 0 })).executed[0].result;
    out.battleClose = { ok: out.battleClose.ok, stopped: out.battleClose.stopped, stillThere: !!battlePanel.stage };
    out.autoLabel = t.buildActionTable({ limit: 60 }).actions.some(a => a.label === "自动战斗（别点）");
    // 回合状态：轮到你时表上写明，新手战斗停了倒计时，不出招就一直僵着
    window.ClientOPManager = { getInstance() { return { canOP: true, selfInfo: { nextRoundOP: 1 } }; } };
    out.battleTurn = t.buildActionTable({}).battleTurn || null;
    delete window.ClientOPManager;
    remove(battlePanel);
    remove(splanRoot);
    delete window.MFC;

    // 窗口被挡住时游戏不刷新：observe、act 直接拒绝，别交回一张只剩图层的表
    document.hidden = true;
    let hiddenTaps = 0;
    const hiddenBtn = item("eui.Button", "hiddenBtn", hud, { x: 700, y: 300, width: 60, height: 40 }, { text: "去吧" });
    listenOn(hiddenBtn);
    hiddenBtn.addEventListener("touchTap", function () { hiddenTaps++; }, null);
    out.hiddenErrors = [];
    for (const call of [() => t.handlers.observe({}), () => t.handlers.act({ steps: [{ hash: hiddenBtn.hashCode }], quietMs: 50, timeoutMs: 200 })]) {
        try { await call(); out.hiddenErrors.push(null); } catch (e) { out.hiddenErrors.push(String(e.message).slice(0, 5)); }
    }
    out.hiddenTaps = hiddenTaps;
    document.hidden = false;
    process.stdout.write(JSON.stringify(out));
})().catch(e => { process.stderr.write(String(e && e.stack || e)); process.exit(1); });
'''
        # 脚本太长，`node -e` 会超出 Windows 命令行长度上限：写进临时文件跑，页面代理路径顺移成第二个参数
        with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8") as f:
            f.write(script.replace("process.argv[1]", "process.argv[2]"))
        try:
            result = subprocess.run([node, f.name, str(PAGE_AGENT)], capture_output=True, text=True,
                                    encoding="utf-8", errors="replace", timeout=40)
        finally:
            os.unlink(f.name)
        if result.returncode:
            raise AssertionError(result.stderr)
        cls.probe = json.loads(result.stdout)
        return cls.probe

    def test_hud_lets_map_entries_through(self):
        table = self.run_probe()["table"]
        # 中间透明的全屏 HUD 不是模态：地图上的入口要进动作表
        self.assertEqual(table["scope"], "stage")
        labels = [r["label"] for r in table["rows"]]
        self.assertIn("btn_bag", labels)
        self.assertTrue(any(r["alt"] == "pve_rect" for r in table["rows"]))

    def test_hotspot_borrows_the_caption_below_it(self):
        rows = self.run_probe()["table"]["rows"]
        pve = [r for r in rows if r["alt"] == "pve_rect"]
        self.assertEqual(pve[0]["label"], "星际探索")
        # 标题被借走后不再单独占一行，免得 agent 去点那个点了没反应的字
        self.assertEqual([r["label"] for r in rows].count("星际探索"), 1)

    def test_item_parts_merge_into_one_row(self):
        rows = self.run_probe()["table"]["rows"]
        merged = [r for r in rows if r["label"].startswith("撞击")]
        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0]["label"], "撞击 次数: 35/35")
        self.assertNotIn("次数: 35/35", [r["label"] for r in rows])

    def test_wandering_sprite_does_not_steal_a_building_name(self):
        rows = self.run_probe()["table"]["rows"]
        mail = [r for r in rows if r["label"] == "星际邮箱"]
        self.assertEqual(len(mail), 1)
        self.assertEqual(mail[0]["alt"], "downTarget")

    def test_return_is_not_back_when_a_real_back_exists(self):
        rows = {r["label"]: r["role"] for r in self.run_probe()["table"]["rows"]}
        self.assertEqual(rows["grp_back_landscape"], "back")
        self.assertEqual(rows["btn_return"], "button")

    def test_small_group_of_same_label_is_not_collapsed(self):
        rows = self.run_probe()["table"]["rows"]
        self.assertEqual([r["label"] for r in rows].count("等级:100"), 5)

    def test_row_diff_names_what_changed(self):
        data = self.run_probe()
        self.assertEqual(data["diff"], "少了 explore_normal；多了 explore_select")
        self.assertEqual(data["diffTextOnly"], "文字有变化")

    def test_lock_that_arrives_late_is_waited_out(self):
        data = self.run_probe()
        self.assertEqual(data["lateLock"]["reason"], "unlocked")
        self.assertLess(data["lateLock"]["waitedMs"], 2000)
        self.assertIsNone(data["noGrace"])

    def test_only_a_lasting_real_choice_interrupts_the_wait(self):
        turn = self.run_probe()["newControls"]
        self.assertEqual(turn["reason"], "new-controls")
        self.assertEqual(turn["added"], ["等级:57", "等级:56"])
        # 在解锁（6s）之前就停了，换宠倒计时还来得及
        self.assertLess(turn["waitedMs"], 3000)

    def test_opponent_skill_banner_is_not_a_decision(self):
        data = self.run_probe()
        # 招式名横幅停了两秒也不能打断等回合：一直等到 3s 解锁
        self.assertEqual(data["bannerTurn"]["reason"], "unlocked")
        self.assertGreaterEqual(data["bannerTurn"]["waitedMs"], 2500)
        # 几乎透明的对象玩家看不见，不进表
        self.assertFalse(data["ghostListed"])

    def test_card_that_only_works_when_dragged_out_is_swiped(self):
        data = self.run_probe()
        # 夹具本身：原地点一下游戏不认
        self.assertEqual(data["pickedByTap"], [])
        # 动作表标出「要按住上滑」，普通控件不标
        self.assertEqual(sorted(r["drag"] for r in data["dragRows"]), ["up", "up"])
        # 按下时也挂松手回调、但不看方向或四边都判的普通按钮不算拖动（主城一排按钮曾被误标）
        self.assertEqual([r["drag"] for r in data["pressRows"]], [None, None])
        self.assertTrue(all("等级" in r["label"] for r in data["dragRows"]))
        # 按编号点它，act 替它按住滑出上沿，游戏认了
        self.assertEqual(data["actDrag"], "up")
        self.assertEqual(data["pickedByAct"], ["card0"])

    def test_question_text_is_not_a_confirm_button(self):
        data = self.run_probe()
        self.assertNotEqual(data["questionRole"], "confirm")
        self.assertEqual(data["okRole"], "confirm")

    def test_whole_screen_lock_does_not_slow_every_tap(self):
        data = self.run_probe()
        self.assertFalse(data["plainGrace"])
        self.assertTrue(data["turnGrace"])

    def test_delegation_shell_shows_the_button_inside(self):
        self.assertEqual(self.run_probe()["shellRows"], ["battle_petBtn"])

    def test_drag_onto_another_control(self):
        data = self.run_probe()
        self.assertEqual(data["dropped"], "skillCell_1")
        self.assertEqual(data["dragTo"]["label"], "突破")
        # 先按住那一段是必要的：不按住直接拖，长按才起步的拖动起不来
        self.assertIsNone(data["droppedNoHold"])

    def test_drag_out_of_a_vertical_list_moves_sideways_first(self):
        data = self.run_probe()
        self.assertEqual(data["dragFirstLeg"], "horizontal")
        self.assertEqual(data["dragEnd"], [465, 80])

    def test_never_reads_visible_or_alpha_of_the_stage(self):
        self.assertEqual(self.run_probe()["stageReads"], [])

    def test_background_page_is_refused_instead_of_acted_on(self):
        data = self.run_probe()
        self.assertEqual(data["hiddenErrors"], ["页面在后台", "页面在后台"])
        self.assertEqual(data["hiddenTaps"], 0)


    def test_popup_button_does_not_borrow_text_behind_it(self):
        data = self.run_probe()
        self.assertEqual(data["popupLabels"], ["img_confirm"])
        self.assertEqual(data["sameLayerLabels"], ["img_confirm"])

    def test_splan_nono_dialog_advances_after_typing(self):
        data = self.run_probe()
        self.assertEqual(data["nonoMode"], "dialogue-continue")
        self.assertEqual(data["nonoAdvance"], {"advanced": 3, "gone": True, "earlyTaps": 0})

    def test_splan_fight_intro_cover_is_cleared_before_the_tap(self):
        data = self.run_probe()
        self.assertEqual(data["coverMode"], "guide-continue")
        self.assertEqual(data["coverTap"], {"cleared": "新手战斗说明层", "error": None, "skillTaps": 1, "gone": True})

    def test_splan_guide_target_and_fade_in_wait(self):
        data = self.run_probe()
        self.assertTrue(data["guideTarget"])
        self.assertEqual(data["guideWait"], {"waited": True, "skillTaps": 2})
        self.assertEqual(data["nextGuide"], {"mode": "guide-hole", "target": True})

    def test_splan_drag_guide_is_dragged_along_the_hand_path(self):
        data = self.run_probe()
        self.assertEqual(data["dragMode"], "guide-drag")
        self.assertEqual(data["dropAt"], [510, 205])

    def test_splan_lost_session_and_fixed_labels(self):
        data = self.run_probe()
        self.assertEqual(data["session"]["reason"], "kicked")
        self.assertTrue(data["session"]["lost"])
        self.assertEqual(sorted(data["splanLabels"]), ["跳过动画", "进入游戏"])
        self.assertEqual(data["battleClose"], {"ok": False, "stopped": "in-battle", "stillThere": True})
        self.assertEqual(data["outerClose"], {"via": "outer", "gone": True})
        self.assertTrue(data["autoLabel"])
        self.assertEqual(data["battleTurn"], {"canOP": True, "next": 1})

    def test_later_steps_resolve_numbers_against_the_table_the_agent_saw(self):
        data = self.run_probe()
        self.assertEqual(data["sameTableErrors"], [None, None])
        self.assertEqual(data["sameTableTaps"], ["rand", "ok"])
        self.assertEqual(data["goneTaps"], ["rand"])
        self.assertIn("已不在显示列表里", data["goneError"])
    def test_only_pages_with_mfc_are_marked_splan(self):
        data = self.run_probe()
        self.assertIsNone(data["projectPlain"])
        self.assertEqual(data["projectSplan"], "splan")

    def test_close_taps_the_backdrop_again_for_a_staged_panel(self):
        data = self.run_probe()
        self.assertTrue(data["endClose"]["ok"], data["endClose"])
        self.assertEqual(data["endClose"]["via"], "mask")
        self.assertEqual(data["endTaps"], 2)

    def test_close_skips_a_layer_that_is_already_leaving(self):
        data = self.run_probe()
        self.assertTrue(data["bagClosed"])
        self.assertEqual(data["closeResult"]["via"], "close")
        self.assertIn("EffectContainer", data["closeResult"]["passed"])

    def test_act_waits_for_a_list_that_is_fading_in(self):
        self.assertTrue(self.run_probe()["fadedInListed"])

    def test_later_step_waits_for_its_target_to_show_up(self):
        data = self.run_probe()
        self.assertIsNone(data["lateError"])
        self.assertIn("没有找到匹配的显示对象", data["neverError"])
        self.assertLess(data["neverMs"], 5000)

    def test_tap_on_a_locked_group_waits_for_unlock(self):
        unlock = self.run_probe()["unlock"]
        self.assertEqual(unlock["reason"], "unlocked")
        self.assertGreaterEqual(unlock["waitedMs"], 300)
        blocked = self.run_probe()["unlockBlocked"]
        self.assertEqual(blocked["reason"], "new-controls")
        self.assertEqual(blocked["added"], ["等级:99", "等级:98"])
        self.assertLess(blocked["waitedMs"], 3000)

    def test_text_is_only_typed_into_inputs(self):
        data = self.run_probe()
        self.assertEqual(data["labelText"], "提示文字")
        self.assertIn("不是输入框", data["labelError"])
        self.assertEqual(data["inputOp"], "text")
        self.assertEqual(data["inputText"], "abc")


class ScrollToIndexTest(unittest.TestCase):
    """op=scroll 的 toIndex：目标项要整项露出来，不能只露一条边。"""

    def test_last_item_is_fully_revealed_when_content_height_was_estimated(self):
        node = shutil.which("node")
        if not node:
            raise unittest.SkipTest("node is required")
        script = r"""const fs = require("fs");
let source = fs.readFileSync(process.argv[1], "utf8");
source = source.replace("\n    installErrorHooks();",
    "\n    window.__pageAgentTest = { scrollToIndex };\n    installErrorHooks();");
const stage = { __class: "egret.Stage", hashCode: 1, stageWidth: 800, stageHeight: 480, parent: null, children: [],
    get numChildren() { return this.children.length; }, getChildAt(i) { return this.children[i]; } };
global.window = { addEventListener() {}, devicePixelRatio: 1, innerWidth: 800, innerHeight: 480,
    egret: { getQualifiedClassName(o) { return o.__class || "Object"; } } };
global.document = { documentElement: { clientLeft: 0, clientTop: 0 },
    querySelector(s) { return s === ".egret-player" ? { "egret-player": { stage } } : null; } };
require("vm").runInThisContext(source, { filename: process.argv[1] });
// 13 个技能、每项 73 高、间距 79，视口 335 高：虚拟布局起初把内容高估成 970，校验一次才是真的 1021
const renderers = Array.from({ length: 13 }, (_, i) => ({ itemIndex: i, y: i * 79, height: 73, visible: true }));
const vp = { __class: "eui.List", scrollV: 0, contentHeight: 970, dataProvider: { length: 13, getItemAt(i) { return { skillId: i }; } },
    children: renderers, get numChildren() { return this.children.length; }, getChildAt(i) { return this.children[i]; },
    validateNow() { this.contentHeight = 1021; } };
const scroller = { __class: "eui.Scroller", height: 335, viewport: vp, parent: stage, children: [vp],
    get numChildren() { return 1; }, getChildAt() { return vp; } };
vp.parent = scroller;
(async () => {
    const res = await window.__pageAgentTest.scrollToIndex(scroller, 12);
    process.stdout.write(JSON.stringify({ scrollV: vp.scrollV, visible: res.visible }));
})().catch(e => { process.stderr.write(String(e && e.stack || e)); process.exit(1); });
"""
        result = subprocess.run([node, "-e", script, str(PAGE_AGENT)], capture_output=True, text=True,
                                encoding="utf-8", errors="replace", timeout=10)
        if result.returncode:
            raise AssertionError(result.stderr)
        data = json.loads(result.stdout)
        # 最后一项 948–1021 要整项落在 [scrollV, scrollV + 335] 里：只能滚到底 686
        self.assertEqual(data["scrollV"], 686)
        self.assertEqual(data["visible"]["hi"], 12)


class RenderTableTest(unittest.TestCase):
    def test_renders_one_line_per_action(self):
        server = load_server()
        table = {"panel": {"name": "newLogin.NewLogin"}, "mode": "normal", "marker": "abc123",
                 "text": ["1 天龙星"],
                 "actions": [{"i": 1, "label": "btn_start", "role": "button", "weak": True},
                             {"i": 2, "label": "确定", "role": "confirm"},
                             {"i": 3, "label": "cb_agree", "role": "tab", "on": True, "weak": True}],
                 "occludedHidden": 4, "omitted": 4,
                 "changed": "打开 SignPanel；顶层 SignPanel", "elapsedMs": 820}
        text = server.render_action_table(table)
        lines = text.splitlines()
        self.assertIn("面板 newLogin.NewLogin", lines[0])
        self.assertIn("marker abc123", lines[0])
        self.assertIn("变化 打开 SignPanel；顶层 SignPanel", lines)
        self.assertIn("1 btn_start* button", lines)
        self.assertIn("2 确定 confirm", lines)
        self.assertIn("3 cb_agree* tab 已选", lines)
        self.assertTrue(any("被遮挡 4 条未列出" in line for line in lines))
        # 同样内容的 JSON 要长得多
        self.assertLess(len(text), len(json.dumps(table, ensure_ascii=False)))

    def test_reload_and_close_results_are_spelled_out(self):
        server = load_server()
        table = {"panel": {"name": "ui.ToolbarNew"}, "mode": "normal", "marker": "m2", "reloaded": True,
                 "executed": [{"op": "close", "result": {"ok": True, "via": "back", "panel": "tenVote.TenVote"}},
                              {"op": "close", "result": {"ok": True, "via": "close", "panel": "petBag.PetBag",
                                                         "passed": "EffectContainer"}},
                              {"op": "dismiss", "result": {"closed": [
                                  {"ok": True, "panel": "petBag.PetBag", "via": "close"},
                                  {"ok": False, "panel": "ui.ToolbarNew", "note": "没有可识别的关闭控件"}]}}],
                 "actions": [{"i": 1, "label": "福利", "role": "button"}]}
        text = server.render_action_table(table)
        self.assertIn("页面已重载", text)
        self.assertIn("点 back 关掉了 tenVote.TenVote", text)
        self.assertIn("点 close 关掉了 petBag.PetBag（EffectContainer 是上一层正在退场，跳过）", text)
        # dismiss 的结果原来把整串 dict 拼进去，几百字节全是噪音
        self.assertIn("关掉 1 个弹窗", text)
        self.assertNotIn("'ok': True", text)

    def test_scroller_with_data_points_at_items(self):
        server = load_server()
        table = {"panel": {"name": "petBag.PetBag"}, "marker": "m4", "actions": [],
                 "scrollers": [{"hash": 540688, "label": "LV.100 里奥斯", "canDown": True, "items": 531,
                                "list": 540690, "fields": ["nick", "level", "petId"]},
                               # 列表已经全在屏上、滚不动时不用提示读数据
                               {"hash": 12, "label": "tabs", "items": 4, "list": 13, "fields": ["name"]},
                               # 十几条的短列表滚两下就看完，不引去读一堆 id
                               {"hash": 14, "label": "skills", "canDown": True, "items": 13, "list": 15, "fields": ["skillId"]}],
                 "executed": [{"op": "scroll", "result": {"index": 132, "total": 531, "visible": {"lo": 128, "hi": 139}}}]}
        text = server.render_action_table(table)
        self.assertIn("数据 共 531 条（字段 nick/level/petId）", text)
        self.assertIn("$items(540690, it => …)", text)
        self.assertIn("\"toIndex\":N", text)
        self.assertEqual(text.count("数据 共"), 1)
        self.assertIn("第 132/531 条已在屏上", text)

    def test_page_reload_is_detected_per_tab(self):
        server = load_server()
        mcp = server.McpServer.__new__(server.McpServer)
        mcp.page_boots = {}
        first = {"tabId": 7, "bootId": "aaa"}
        mcp.note_page_boot({}, first)
        self.assertNotIn("reloaded", first)
        same = {"tabId": 7, "bootId": "aaa"}
        mcp.note_page_boot({}, same)
        self.assertNotIn("reloaded", same)
        after_reload = {"tabId": 7, "bootId": "bbb"}
        mcp.note_page_boot({}, after_reload)
        self.assertTrue(after_reload["reloaded"])
        # 另一个标签页第一次见到，不算重载
        other = {"tabId": 9, "bootId": "ccc"}
        mcp.note_page_boot({}, other)
        self.assertNotIn("reloaded", other)

    def test_turn_wait_and_repeat_are_spelled_out(self):
        server = load_server()
        table = {"panel": {"name": "BattlePanel"}, "marker": "m5", "actions": [],
                 "executed": [
                     {"op": "tap", "target": {"label": "撞击"}, "unlock": {"reason": "unlocked", "waitedMs": 1476},
                      "repeated": 2, "turn": {"reason": "new-controls", "added": ["等级:100"], "waitedMs": 2800}},
                     {"op": "tap", "target": {"label": "nibaba"}, "turn": {"reason": "unlocked", "waitedMs": 3032}}]}
        text = server.render_action_table(table)
        self.assertIn("先等上一回合解锁 1.5s", text)
        self.assertIn("连出 2 次，停在：游戏在等你先做别的决定：等级:100", text)
        self.assertIn("等回合 3.0s（轮到你了，技能栏已解锁，直接出下一招）", text)
        # 快到桥接时限就先返回：说清楚没做完、接着怎么办，而不是整次调用超时什么都拿不回来
        budget = server.render_action_table({"marker": "m6", "actions": [], "stopped": "budget",
                                             "executed": [{"op": "tap", "repeated": 6,
                                                           "turn": {"reason": "budget", "waitedMs": 0}}]})
        self.assertIn("连出 6 次，停在：这次调用快到时限", budget)
        self.assertIn("后面的步骤没做", budget)

    def test_second_time_on_a_route_offers_the_rest_of_it(self):
        server = load_server()
        mcp = server.McpServer.__new__(server.McpServer)
        mcp.routes, mcp.route_gates = {}, {}

        def tap(sel, label, frm, to, **step):
            return {"i": 3, **step}, {"tabId": 1, "topKey": to, "executed": [
                {"op": "tap", "from": frm, "target": {"label": label, "sel": sel}}]}

        bag, up = "PetBag:petBag", "UpPanel:upPanel"
        history = [
            tap({"qaName": "PetBag__item", "match": "exact", "index": 0}, "里奥斯", bag, bag),
            tap({"qaName": "PetBag__btn_up", "match": "exact"}, "升级", bag, up),
            tap({"text": "确定", "match": "exact"}, "确定", up, up, repeat=1),
            ({"steps": [{"op": "close"}]}, {"tabId": 1, "topKey": bag,
                                             "executed": [{"op": "close", "from": up, "result": {"ok": True}}]}),
            # 第二只精灵：选的不是同一只，但点「升级」和上次一样，而且现在也在升级面板上
            tap({"qaName": "PetBag__item", "match": "exact", "index": 3}, "缪斯", bag, bag),
        ]
        for args, table in history:
            mcp.note_route(args, table)
            self.assertNotIn("route", table)
        args, table = tap({"qaName": "PetBag__btn_up", "match": "exact"}, "升级", bag, up)
        mcp.note_route(args, table)
        self.assertEqual(table["route"]["labels"], ["确定", "close"])
        # 编号换成稳定选择器，其他参数照带
        self.assertEqual(table["route"]["steps"], [{"text": "确定", "match": "exact", "repeat": 1}, {"op": "close"}])
        text = server.render_action_table(dict(table, marker="m7", actions=[]))
        self.assertIn("路线 上次这之后接着是：确定 → close", text)
        self.assertIn('{"steps":[{"text":"确定"', text)

        # 这次点完落在别的面板上：不在同一条路上，不给
        args, table = tap({"qaName": "PetBag__btn_up", "match": "exact"}, "升级", bag, bag)
        mcp.note_route(args, table)
        self.assertNotIn("route", table)

    def test_route_drops_detours_failures_and_the_per_round_pick(self):
        server = load_server()
        mcp = server.McpServer.__new__(server.McpServer)
        mcp.routes, mcp.route_gates = {}, {}
        bag, prop, exp, alert, supply = "PetBag:bag", "PetProperty:prop", "ExpDevice:exp", "SimpleAlert:alert", "Supply:s"

        def step(sel, label, frm, role="button", op="tap"):
            rec = {"op": op, "from": frm}
            if sel is not None:
                rec["target"] = {"label": label, "sel": sel, "role": role}
            return ({"i": 1} if sel is not None else {"op": op}), rec

        def act(to, *pairs):
            args = {"steps": [p[0] for p in pairs]}
            table = {"tabId": 1, "topKey": to, "executed": [p[1] for p in pairs]}
            mcp.note_route(args, table)
            return table

        up = {"qaName": "PetPropertyNor__grp_evolUpgrade", "match": "exact"}
        act(prop, step({"name": "petBag_PetBagCell_petId_130", "match": "exact"}, "朵拉格", bag, "item"))
        act(exp, step(up, "升级", prop))
        act(exp, step({"qaName": "ExpDevice__imgFastLevelUp", "match": "exact"}, "快速升级", exp))
        act(alert, step({"text": "至100级", "match": "exact"}, "至100级", exp, "tab"))
        act(exp, step({"qaName": "SimpleAlert__confirm", "match": "exact"}, "confirm", alert, "confirm"))
        # 误点「经验返还」，再点遮罩关掉：弯路
        act(supply, step({"qaName": "ExpDevice__btn_return", "match": "exact"}, "btn_return", exp))
        act(exp, step(None, None, supply, op="recommended"))
        act(prop, step({"name": "grp_back_landscape", "match": "exact"}, "返回", exp, "back"))
        act(bag, step({"name": "grp_back_landscape", "match": "exact"}, "返回", prop, "back"))
        act(prop, step({"name": "petBag_PetBagCell_petId_520", "match": "exact"}, "古林斯特", bag, "item"))
        # 第二只：点升级成功，后面一步写错了编号失败
        failed = ({"i": 26}, {"op": "tap", "from": exp, "error": "第 2 步用了编号 i"})
        table = act(exp, step(up, "升级", prop), failed)
        self.assertEqual(table["route"]["labels"], ["快速升级", "至100级", "confirm", "返回", "返回"])
        self.assertNotIn("btn_return", json.dumps(table["route"]["steps"]))
        self.assertNotIn("petId", json.dumps(table["route"]["steps"]))

    def test_route_leaves_out_idle_waits_and_empty_advances(self):
        server = load_server()
        mcp = server.McpServer.__new__(server.McpServer)
        mcp.routes, mcp.route_gates = {}, {}
        bag, up = "PetBag:petBag", "UpPanel:upPanel"

        def tap(sel, label, frm, to):
            args = {"i": 3}
            table = {"tabId": 1, "topKey": to, "executed": [{"op": "tap", "from": frm, "target": {"label": label, "sel": sel}}]}
            mcp.note_route(args, table)
            return table

        def idle(at, until=None):
            steps = [{"op": "wait", "ms": 2000}, {"op": "advance"}]
            if until:
                steps.append({"op": "wait", "until": until})
            recs = [{"op": "wait", "from": at}, {"op": "advance", "from": at, "result": {"advanced": 0}}]
            if until:
                recs.append({"op": "wait", "from": at})
            table = {"tabId": 1, "topKey": at, "executed": recs}
            mcp.note_route({"steps": steps}, table)
            return table

        tap({"qaName": "PetBag__item", "index": 0}, "里奥斯", bag, bag)
        tap({"qaName": "PetBag__btn_up"}, "升级", bag, up)
        idle(up)
        tap({"text": "确定"}, "确定", up, up)
        idle(up, until={"text": "升级成功"})
        tap({"qaName": "UpPanel__close"}, "close", up, bag)
        tap({"qaName": "PetBag__item", "index": 3}, "缪斯", bag, bag)
        table = tap({"qaName": "PetBag__btn_up"}, "升级", bag, up)
        # 干等和推进 0 次不回放；等某个结果出现（until）是有意义的，照带
        self.assertEqual(table["route"]["labels"], ["确定", "wait", "close"])
        self.assertEqual(table["route"]["steps"][1], {"op": "wait", "until": {"text": "升级成功"}})

    def test_route_ends_where_it_returns_to_the_main_scene(self):
        server = load_server()
        mcp = server.McpServer.__new__(server.McpServer)
        mcp.routes, mcp.route_gates = {}, {}
        sign, gift, ret, main, pve = "WeekSign:w", "FirstCharge:f", "Return:r", "Toolbar:t", "Pve:p"

        def tap(name, frm, to, scene=False):
            table = {"tabId": 1, "topKey": to, "scope": "stage" if scene else "panel", "executed": [
                {"op": "tap", "from": frm, "target": {"label": name, "sel": {"name": name}}}]}
            mcp.note_route({"i": 3}, table)
            return (table.get("route") or {}).get("labels")

        # 上个任务：登录后关掉三个弹窗回到主场景，接着去打 PVE
        for step in [("sign_close", sign, gift), ("gift_close", gift, ret), ("ret_close", ret, main, True),
                     ("pve_rect", main, pve), ("galaxy_1", pve, pve), ("boss_1", pve, pve)]:
            tap(*step)
        # 这个任务登录后是同一串弹窗：路线到回主场景为止，不带上个任务的 PVE
        self.assertEqual(tap("sign_close", sign, gift), ["gift_close", "ret_close"])
        tap("gift_close", gift, ret)
        self.assertIsNone(tap("ret_close", ret, main, True))

    def test_route_goes_quiet_while_exploring_and_comes_back_when_repeating(self):
        server = load_server()
        mcp = server.McpServer.__new__(server.McpServer)
        mcp.routes, mcp.route_gates = {}, {}
        main, bag, mail, shop = "Main:m", "Bag:b", "Mail:l", "Shop:s"

        def go(name, frm, to):
            if name == "close":
                args, rec = {"steps": [{"op": "close"}]}, {"op": "close", "from": frm, "result": {"ok": True}}
            else:
                args, rec = {"i": 3}, {"op": "tap", "from": frm,
                                       "target": {"label": name, "sel": {"name": name, "match": "exact"}}}
            table = {"tabId": 1, "topKey": to, "executed": [rec]}
            mcp.note_route(args, table)
            return (table.get("route") or {}).get("labels")

        # 自由探索：反复进背包，每次点的都不一样。路线摆了两次都没照走，之后收起
        explore = [("btn_bag", main, bag), ("tab_equip", bag, bag), ("close", bag, main),
                   ("btn_mail", main, mail), ("close", mail, main),
                   ("btn_bag", main, bag), ("tab_skin", bag, bag), ("btn_sort", bag, bag), ("close", bag, main),
                   ("btn_shop", main, shop), ("close", shop, main),
                   ("btn_bag", main, bag), ("tab_pet", bag, bag), ("close", bag, main)]
        shown = [(k, labels) for k, step in enumerate(explore) for labels in [go(*step)] if labels]
        self.assertEqual([k for k, _ in shown], [5, 8])
        self.assertEqual(shown[0][1], ["tab_equip", "close"])

        # marker 过期被拒、一步没执行：不算没照走
        mcp.note_route({"i": 3}, {"tabId": 1, "topKey": main, "executed": []})
        # 开始重复：自己连着两步走得和上次一样，路线重新摆出来
        self.assertIsNone(go("btn_mail", main, mail))
        self.assertIsNone(go("btn_read", mail, mail))
        self.assertIsNone(go("close", mail, main))
        self.assertIsNone(go("btn_mail", main, mail))
        self.assertEqual(go("btn_read", mail, mail), ["close", "btn_mail"])

    def test_drag_only_controls_are_flagged_and_reported(self):
        server = load_server()
        text = server.render_action_table({"marker": "m9", "executed": [
            {"op": "tap", "target": {"label": "等级:88"}, "drag": "up"}], "actions": [
            {"i": 1, "label": "等级:88", "role": "item", "drag": "up"},
            {"i": 3, "label": "技能", "role": "button"}]})
        self.assertIn("执行 tap 等级:88（按住上滑）", text)
        self.assertIn("1 等级:88 item 按住上滑", text)
        self.assertIn("3 技能 button\n", text + "\n")

    def test_lost_session_points_to_reload_and_cleared_cover_is_reported(self):
        server = load_server()
        text = server.render_action_table({"marker": "m10", "actions": [],
            "session": {"lost": True, "reason": "alert", "text": "您已掉线，请重新登录", "url": "http://game.test/index.html"},
            "executed": [{"op": "tap", "target": {"label": "抓"}, "cleared": "新手战斗说明层"}]})
        self.assertIn('掉线 您已掉线，请重新登录：别点提示框，直接 egret_navigate {"url": "http://game.test/index.html"} 重开页面', text)
        self.assertIn("执行 tap 抓（先点掉了新手战斗说明层）", text)
        kicked = server.render_action_table({"marker": "m11", "actions": [],
                                             "session": {"lost": True, "reason": "kicked", "url": "http://game.test/"}})
        self.assertIn("掉线 被踢下线：", kicked)
        turn = server.render_action_table({"marker": "m12", "actions": [], "battleTurn": {"canOP": True, "next": 1}})
        self.assertIn("回合 轮到你出招", turn)
        self.assertNotIn("回合", server.render_action_table({"marker": "m13", "actions": [],
                                                             "battleTurn": {"canOP": False, "next": 1}}))

    def test_close_failure_says_what_was_tried(self):
        server = load_server()
        table = {"mode": "normal", "marker": "m3",
                 "executed": [{"op": "close", "result": {"ok": False, "stopped": "stuck",
                                                         "note": "关闭/返回/遮罩都点过了，面板仍在最上层"}}],
                 "actions": []}
        text = server.render_action_table(table)
        self.assertIn("没关掉（stuck）", text)
        self.assertIn("面板仍在最上层", text)

    def test_mode_without_actions_points_at_the_only_legal_op(self):
        server = load_server()
        table = {"mode": "guide-hole", "marker": "m1", "recommendedTarget": {"reason": "guide-hole"},
                 "hint": "引导挖洞"}
        text = server.render_action_table(table)
        self.assertIn("mode guide-hole", text)
        self.assertIn("recommended", text)
        # 只能点遮罩的弹窗推荐 close：它会确认真关掉了，分阶段的结算页还会再点一次
        table = {"mode": "modal-backdrop-dismiss", "marker": "m1",
                 "recommendedTarget": {"reason": "modal-backdrop-dismiss"}, "actions": []}
        self.assertIn('推荐 {"op":"close"}（modal-backdrop-dismiss）', server.render_action_table(table))
        # 引导挖洞写出点的是谁，对白直接给 advance
        table = {"mode": "guide-hole", "marker": "m2", "actions": [], "recommendedTarget": {
            "reason": "guide-hole", "target": {"qaName": "ToolbarNew__btn_petBag", "className": "eui.Image"}}}
        self.assertIn('推荐 {"op":"recommended"}（guide-hole，点 btn_petBag）', server.render_action_table(table))
        table = {"mode": "dialogue-continue", "marker": "m3", "actions": [],
                 "recommendedTarget": {"reason": "dialogue-continue", "target": {"className": "NoNoDialog"}}}
        self.assertIn('推荐 {"op":"advance"}（dialogue-continue）', server.render_action_table(table))


class ToolProfileTest(unittest.TestCase):
    def test_core_hides_tools_that_egret_act_already_covers(self):
        server = load_server()
        with mock.patch.object(server, "TOOL_PROFILE", "core"):
            names = server.visible_tools()
        self.assertIn("egret_observe", names)
        self.assertIn("egret_act", names)
        self.assertIn("egret_run_steps", names)
        self.assertNotIn("egret_tap", names)
        self.assertNotIn("egret_wait_for", names)
        self.assertLess(len(names), len(server.TOOLS))

    def test_minimal_keeps_only_the_main_loop_and_connection_tools(self):
        server = load_server()
        with mock.patch.object(server, "TOOL_PROFILE", "minimal"):
            names = server.visible_tools()
        self.assertEqual(set(names), set(server.MINIMAL_TOOLS))

    def test_full_exposes_everything(self):
        server = load_server()
        with mock.patch.object(server, "TOOL_PROFILE", "full"):
            self.assertEqual(len(server.visible_tools()), len(server.TOOLS))


class PluginRemovalTest(unittest.IsolatedAsyncioTestCase):
    async def test_plugin_dir_removable_while_running(self):
        """完整 Node→Python 启动链运行时也不能占用插件目录。"""
        with tempfile.TemporaryDirectory() as tmp:
            plugin = os.path.join(tmp, "plugin")
            shutil.copytree(SERVER.parents[1], plugin, ignore=shutil.ignore_patterns("__pycache__"))
            node = shutil.which("node")
            self.assertTrue(node, "node is required")
            proc = await asyncio.create_subprocess_exec(
                node, os.path.join(".", "scripts", "start_mcp.js"), cwd=plugin,
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
                env=dict(os.environ, EGRET_PYTHON=sys.executable, EGRET_MCP_PORT=str(PORT + 1)))
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
