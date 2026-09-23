"""MCP server 协议测试：通过 stdio 驱动 server，并用模拟扩展连接其 WebSocket 桥。"""

import asyncio
import base64
import json
import os
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
source = source.replace("\n    installErrorHooks();", "\n    window.__pageAgentTest = { semanticTerms, dialogueHasDecision, semanticActionOwner, sceneInfo, findCloseControl, maskPointOutside, backdropDismissTargetOf, transientOverlayOf };\n    installErrorHooks();");
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
process.stdout.write(JSON.stringify({ named, travel, passive, decision, canonical, noticeIsClose,
    modalTop: modalScene.top && modalScene.top.name, backdropReason: backdrop && backdrop.reason, backdropPoint: backdrop && backdrop.stagePoint,
    transientReason: transientOverlay && transientOverlay.reason, transientAction: transientOverlay && transientOverlay.action,
    transitionDismiss: !!transitionDismiss, opaqueSceneBackdrop: !!opaqueSceneBackdrop }));
'''
        result = subprocess.run([node, "-e", script, str(PAGE_AGENT)], capture_output=True, text=True,
                                encoding="utf-8", errors="replace", timeout=10, check=True)
        data = json.loads(result.stdout)
        self.assertTrue({"任务目标", "npc", "萨帕尼克"}.issubset(data["named"]))
        self.assertTrue({"地图", "传送", "新白沙罗域"}.issubset(data["travel"]))
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

    def test_claude_launcher_initializes_mcp(self):
        # Claude 插件的 MCP 配置不分平台：Windows 走 .cmd，其他平台走 sh，都要挑到 Python 并完成 initialize
        launcher = SERVER.parents[1] / "bin" / ("egret-mcp.cmd" if os.name == "nt" else "egret-mcp")
        env = dict(os.environ, EGRET_PYTHON=sys.executable, EGRET_MCP_PORT=str(PORT + 3), PYTHONIOENCODING="utf-8")
        request = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}) + "\n"
        result = subprocess.run([str(launcher)], env=env, input=request, capture_output=True, text=True,
                                encoding="utf-8", errors="replace", timeout=15, check=True)
        response = json.loads(result.stdout.splitlines()[0])
        self.assertEqual(response["result"]["serverInfo"]["name"], "egret-agent-inspector")


class FakeExtension:
    """模拟扩展 service worker：连接 server 并按 id 查询假数据应答页面请求。"""

    def __init__(self):
        self.calls = []
        self.page_params = []

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

    async def test_tools_listed(self):
        listed = (await self.rpc("tools/list"))["tools"]
        tools = {t["name"] for t in listed}
        for name in ("egret_find", "egret_tap", "egret_extension_status", "egret_install_extension",
                     "egret_reload_extension", "egret_reopen_browser", "egret_run_steps", "egret_observe",
                     "egret_act", "egret_advance", "egret_runtime_stats", "egret_dismiss_popups",
                     "egret_inspect_code", "egret_locate", "egret_notes", "splan_call",
                     "splan_test_command"):
            self.assertIn(name, tools)
        self.assertNotIn("egret_interactables", tools)
        # egret_observe 是 egret_scene 的超集，旧工具不再暴露，减少 agent 的选择面
        self.assertNotIn("egret_scene", tools)
        observe = next(tool for tool in listed if tool["name"] == "egret_observe")["inputSchema"]["properties"]
        self.assertIn("ocr", observe)
        self.assertIn("rootHash", observe)
        act = next(tool for tool in listed if tool["name"] == "egret_act")["inputSchema"]["properties"]
        self.assertIn("steps", act)
        self.assertIn("marker", act)
        wait = next(tool for tool in listed if tool["name"] == "egret_wait_for")["inputSchema"]["properties"]
        self.assertIn("changed", wait["state"]["enum"])
        self.assertIn("anyOf", wait)
        self.assertIn("interruptOnOverlay", wait)
        locate = next(tool for tool in listed if tool["name"] == "egret_locate")["inputSchema"]["properties"]
        self.assertIn("ocr", locate)
        self.assertIn("ocrLimit", locate)
        command = next(tool for tool in listed if tool["name"] == "splan_test_command")["inputSchema"]
        self.assertIn("authorized", command["required"])

    async def test_observe_and_act_use_the_action_table(self):
        ext = FakeExtension()
        await ext.connect()
        try:
            await self.call("egret_extension_status", {"waitSeconds": 2})
            _, table = await self.call("egret_observe", {})
            self.assertEqual(table["marker"], "m1")
            # 平时不向页面索取几何信息，返回里也不该出现 screenRect，省上下文
            self.assertNotIn("screenRect", table["actions"][0])
            self.assertNotIn("captureSize", table)
            self.assertEqual([p.get("rects") for m, p in ext.page_params if m == "observe"], [None])

            _, acted = await self.call("egret_act", {"marker": "m1", "steps": [{"i": 1}]})
            self.assertEqual(acted["stopped"], "done")
            sent = [p for m, p in ext.page_params if m == "act"][0]
            self.assertEqual(sent["steps"], [{"i": 1}])
            self.assertEqual(sent["marker"], "m1")

            # ocr=true 才要 rects；OCR 后端不可用时也只降级成 ocr.available=false，不影响动作表
            _, with_ocr = await self.call("egret_observe", {"ocr": True})
            self.assertIn("ocr", with_ocr)
            self.assertNotIn("screenRect", with_ocr["actions"][0])
            self.assertEqual([p.get("rects") for m, p in ext.page_params if m == "observe"], [None, True])

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
