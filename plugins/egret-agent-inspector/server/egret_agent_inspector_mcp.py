#!/usr/bin/env python3
"""Egret Agent Inspector MCP server.

stdio MCP server，仅依赖 Python 3.8+ 标准库。在 127.0.0.1 上开启 WebSocket 服务，
由浏览器中的 Egret Agent Inspector 扩展主动连接，把工具请求转发到游戏页面执行。

环境变量：
  EGRET_MCP_PORT          起始端口，默认 17800（扩展会依次尝试 17800-17804）
  EGRET_MCP_TIMEOUT       单次请求超时秒数，默认 30
  EGRET_MCP_CONNECT_WAIT  扩展未连接时等待其连接的秒数，默认 20
"""

import asyncio
import base64
import hashlib
import itertools
import json
import os
import struct
import sys
import time

SERVER_NAME = "egret-agent-inspector"
PLUGIN_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXTENSION_DIR = os.path.join(PLUGIN_ROOT, "extension")


def read_bundled_version():
    try:
        with open(os.path.join(EXTENSION_DIR, "manifest.json"), encoding="utf-8-sig") as f:
            return json.load(f).get("version")
    except (OSError, ValueError):
        return None


SERVER_VERSION = read_bundled_version() or "0.0.0"
SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"]
BASE_PORT = int(os.environ.get("EGRET_MCP_PORT", "17800"))
PORT_COUNT = 5
REQUEST_TIMEOUT = float(os.environ.get("EGRET_MCP_TIMEOUT", "30"))
CONNECT_WAIT = float(os.environ.get("EGRET_MCP_CONNECT_WAIT", "20"))
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

INSTRUCTIONS = """Egret Agent Inspector：读取并操作浏览器中 Egret 游戏的显示对象，依赖浏览器中的 Egret Agent Inspector 扩展。
- 首次使用或工具提示扩展未连接时，先调用 egret_extension_status；未连接则按 egret-install-extension skill 为用户安装扩展。
- 显示对象以 hash（Egret hashCode）标识；id 是组件在代码/EXML 中绑定的属性名。stageRect 为舞台坐标，screenRect 为页面视口 CSS 像素坐标。
- 常用流程：egret_status → egret_find / egret_get_tree → egret_tap / egret_drag → egret_wait_for → egret_screenshot；可复现的用例用 egret_run_steps 批量执行。
- 未指定 tabId 时自动选用最近使用或当前激活的含 Egret 游戏的标签页。"""


def log(*args):
    print("[egret-agent-inspector]", *args, file=sys.stderr, flush=True)


# ---------------------------------------------------------------- 工具定义

TAB_PROP = {"tabId": {"type": "integer", "description": "目标标签页 id（可选，默认自动选择含 Egret 游戏的标签页）"}}
MATCH_PROPS = {
    "hash": {"type": "integer", "description": "显示对象 hashCode"},
    "id": {"type": "string", "description": "组件绑定 id（代码/EXML 中的属性名）"},
    "name": {"type": "string", "description": "显示对象 name"},
    "className": {"type": "string", "description": "类名，如 eui.Button、newLogin.NewLoginPanel"},
    "text": {"type": "string", "description": "文本内容（Label/TextField 的 text 或 Button 的 label）"},
    "source": {"type": "string", "description": "图片资源名（eui.Image 的 source），用于定位没有 id 的图片按钮"},
    "match": {"type": "string", "enum": ["contains", "exact", "regex"], "description": "字符串匹配方式，默认 contains（不区分大小写）"},
    "rootHash": {"type": "integer", "description": "仅在该对象的子树中查找"},
    "visibleOnly": {"type": "boolean", "description": "只匹配在舞台上可见的对象，默认 true"},
    "touchableOnly": {"type": "boolean", "description": "只匹配可接收点击的对象"},
}
TARGET_PROPS = dict(MATCH_PROPS)
TARGET_PROPS["index"] = {"type": "integer", "description": "按查询条件匹配到多个对象时取第几个，默认 0"}


def obj(props, required=None):
    schema = {"type": "object", "properties": dict(props, **TAB_PROP)}
    if required:
        schema["required"] = required
    return schema


# name -> (描述, inputSchema, 桥接方法, 页面方法)
TOOLS = {
    "egret_list_tabs": (
        "列出浏览器标签页（probe=true 时检测每个标签页是否运行着 Egret 游戏）。",
        {"type": "object", "properties": {"probe": {"type": "boolean", "description": "是否探测 Egret，默认 true"}}},
        "listTabs", None),
    "egret_navigate": (
        "在浏览器中打开 URL（默认复用最近使用的标签页），并等待页面加载完成。",
        obj({"url": {"type": "string"}, "newTab": {"type": "boolean", "description": "在新标签页中打开"},
             "timeoutMs": {"type": "integer", "description": "等待加载完成的超时，默认 30000"}}, ["url"]),
        "navigate", None),
    "egret_status": (
        "获取页面中 Egret 引擎状态：引擎版本、舞台尺寸、canvas 在页面中的位置、显示对象数量等。",
        obj({}), "page", "status"),
    "egret_get_tree": (
        "获取显示对象树（从舞台或指定 hash 开始），每个节点包含 hash、className、id、name、text、可见性、坐标。",
        obj({"hash": {"type": "integer", "description": "子树根节点 hash，默认舞台"},
             "depth": {"type": "integer", "description": "展开深度，默认 3"},
             "maxNodes": {"type": "integer", "description": "最多返回节点数，默认 300"},
             "visibleOnly": {"type": "boolean", "description": "跳过不可见节点，默认 false"},
             "bounds": {"type": "boolean", "description": "是否计算坐标，默认 true"}}),
        "page", "getTree"),
    "egret_find": (
        "按 id / name / className / text / source / hash 查找显示对象，返回路径、可见性、可点击性及舞台/屏幕坐标。",
        obj(dict(MATCH_PROPS, limit={"type": "integer", "description": "最多返回条数，默认 20"})),
        "page", "find"),
    "egret_get_node": (
        "获取单个显示对象的详细信息：常用属性、祖先链、直接子节点；props 可额外读取任意属性（如 data、selectedIndex）。",
        obj(dict(TARGET_PROPS, props={"type": "array", "items": {"type": "string"}, "description": "额外读取的属性名"})),
        "page", "getNode"),
    "egret_tap": (
        "点击显示对象（按 hash/查询条件定位其中心，或直接给 stageX/stageY、clientX/clientY）。"
        "method: touch=经 Egret TouchHandler 走真实命中检测（默认），dom=向 canvas 派发鼠标事件，dom-touch=派发触摸事件，event=直接在目标上派发 TouchEvent（忽略遮挡）。"
        "返回实际命中的对象，若被遮挡会给出 warnings。",
        obj(dict(TARGET_PROPS,
                 stageX={"type": "number"}, stageY={"type": "number"},
                 clientX={"type": "number", "description": "页面视口坐标（CSS 像素）"}, clientY={"type": "number"},
                 offsetX={"type": "number", "description": "相对目标左上角的舞台坐标偏移，默认中心"},
                 offsetY={"type": "number"},
                 method={"type": "string", "enum": ["touch", "dom", "dom-touch", "event"]},
                 holdMs={"type": "integer", "description": "按下到抬起的间隔，默认 50"},
                 count={"type": "integer", "description": "连续点击次数，默认 1"})),
        "page", "tap"),
    "egret_drag": (
        "拖动/滑动：从目标对象中心（或 stageX/stageY、clientX/clientY）移动到 toStageX/toStageY、toClientX/toClientY 或偏移 dx/dy，可用于滚动列表。",
        obj(dict(TARGET_PROPS,
                 stageX={"type": "number"}, stageY={"type": "number"},
                 clientX={"type": "number"}, clientY={"type": "number"},
                 toStageX={"type": "number"}, toStageY={"type": "number"},
                 toClientX={"type": "number"}, toClientY={"type": "number"},
                 dx={"type": "number", "description": "舞台坐标 x 偏移"}, dy={"type": "number", "description": "舞台坐标 y 偏移"},
                 steps={"type": "integer", "description": "移动步数，默认 10"},
                 durationMs={"type": "integer", "description": "总时长，默认 300"},
                 method={"type": "string", "enum": ["touch", "dom", "dom-touch"]})),
        "page", "drag"),
    "egret_hit_test": (
        "查询某坐标处（clientX/clientY 页面坐标，或 stageX/stageY 舞台坐标）最上层的显示对象及其祖先链。",
        obj({"clientX": {"type": "number"}, "clientY": {"type": "number"},
             "stageX": {"type": "number"}, "stageY": {"type": "number"}}),
        "page", "hitTest"),
    "egret_set_props": (
        "设置显示对象属性，如 {\"text\":\"abc\"}、{\"visible\":false}、{\"selected\":true}；dispatchChange=true 时随后派发 egret.Event.CHANGE（用于输入框）。",
        obj(dict(TARGET_PROPS, props={"type": "object", "description": "要设置的属性与值"},
                 dispatchChange={"type": "boolean"}), ["props"]),
        "page", "setProps"),
    "egret_wait_for": (
        "等待满足查询条件的显示对象出现/消失。state: visible（默认，可见）、exists（存在于舞台）、hidden（没有可见的匹配对象）、gone（没有任何匹配对象）。",
        obj(dict(MATCH_PROPS,
                 state={"type": "string", "enum": ["visible", "exists", "hidden", "gone"]},
                 timeoutMs={"type": "integer", "description": "超时，默认 10000，最大 120000"},
                 intervalMs={"type": "integer", "description": "轮询间隔，默认 200"},
                 stableMs={"type": "integer", "description": "匹配对象的位置、尺寸和透明度保持不变多久才算满足，用于等待打开动画结束，如 300"})),
        "page", "waitFor"),
    "egret_evaluate": (
        "在页面中执行 JavaScript 表达式，或语句块（需显式 return，支持 await），可用辅助变量：$stage（舞台）、$obj(hash)（按 hash 取对象）、"
        "$find({id,name,className,text,...})（查询对象数组）、$describe(obj)。返回值会被安全序列化。",
        obj({"expression": {"type": "string"}, "depth": {"type": "integer", "description": "返回值序列化深度，默认 3"}},
            ["expression"]),
        "page", "evaluate"),
    "egret_screenshot": (
        "截取标签页当前可见区域（会先激活该标签页）。",
        obj({"format": {"type": "string", "enum": ["png", "jpeg"]}}),
        "screenshot", None),
    "egret_extension_status": (
        "检查浏览器扩展是否已连接：返回已连接的浏览器、扩展版本，以及与插件自带版本是否一致（outdated=true 时需更新扩展）。首次使用前调用。",
        {"type": "object", "properties": {"waitSeconds": {"type": "number", "description": "未连接时等待扩展连接的秒数，默认 8"}}},
        "extensionStatus", None),
    "egret_reload_extension": (
        "让已连接的扩展从磁盘重新加载（更新扩展文件后使用），随后等待其重新连接。",
        {"type": "object", "properties": {}},
        "reloadExtension", None),
    "egret_run_steps": (
        "按顺序批量执行 E2E 步骤并汇总结果，默认遇到失败即停止并附失败截图。steps 每项为 {action, ...参数}，"
        "action 取 navigate/tap/drag/setProps/waitFor/assert/evaluate/sleep/screenshot，其余参数与对应 egret_* 工具相同；"
        "waitFor 未满足即失败；assert 用查询条件定位对象并校验 expect：{exists, visible, count, text, textContains, props:{属性:值}}。"
        "也可用 file 传入 JSON 用例文件的绝对路径（格式 {name, steps}）。",
        obj({"steps": {"type": "array", "items": {"type": "object"}},
             "file": {"type": "string", "description": "JSON 用例文件绝对路径，与 steps 二选一"},
             "name": {"type": "string", "description": "用例名称"},
             "stopOnFailure": {"type": "boolean", "description": "失败后停止，默认 true"},
             "screenshotOnFailure": {"type": "boolean", "description": "失败时截图，默认 true"}}),
        "runSteps", None),
}

STEP_ACTIONS = {
    "navigate": "egret_navigate", "tap": "egret_tap", "drag": "egret_drag", "setProps": "egret_set_props",
    "waitFor": "egret_wait_for", "evaluate": "egret_evaluate", "screenshot": "egret_screenshot",
}
QUERY_KEYS = ("hash", "id", "name", "className", "text", "source", "match", "rootHash", "index")


# ---------------------------------------------------------------- WebSocket 服务端

class ExtensionConnection:
    def __init__(self, reader, writer, info):
        self.reader = reader
        self.writer = writer
        self.info = info
        self.pending = {}
        self.ids = itertools.count(1)
        self.closed = False
        self.ready = False
        self.on_ready = None
        self.send_lock = asyncio.Lock()

    async def send_text(self, text):
        data = text.encode("utf-8")
        header = bytearray([0x81])
        n = len(data)
        if n < 126:
            header.append(n)
        elif n < 65536:
            header.append(126)
            header += struct.pack("!H", n)
        else:
            header.append(127)
            header += struct.pack("!Q", n)
        async with self.send_lock:
            self.writer.write(bytes(header) + data)
            await self.writer.drain()

    async def send_control(self, opcode, payload=b""):
        async with self.send_lock:
            self.writer.write(bytes([0x80 | opcode, len(payload)]) + payload)
            await self.writer.drain()

    async def request(self, method, params, timeout):
        req_id = next(self.ids)
        fut = asyncio.get_running_loop().create_future()
        self.pending[req_id] = fut
        try:
            await self.send_text(json.dumps({"id": req_id, "method": method, "params": params}, ensure_ascii=False))
            return await asyncio.wait_for(fut, timeout)
        finally:
            self.pending.pop(req_id, None)

    def on_message(self, text):
        try:
            msg = json.loads(text)
        except ValueError:
            return
        if msg.get("type") == "hello":
            self.info.update(msg)
            self.ready = True
            if self.on_ready:
                self.on_ready()
            log("extension connected:", msg.get("extensionVersion"), msg.get("userAgent", "")[:80])
            return
        fut = self.pending.get(msg.get("id"))
        if fut and not fut.done():
            if "error" in msg:
                fut.set_exception(RuntimeError(msg["error"]))
            else:
                fut.set_result(msg.get("result"))

    def close(self):
        self.closed = True
        for fut in self.pending.values():
            if not fut.done():
                fut.set_exception(RuntimeError("与浏览器扩展的连接已断开"))
        try:
            self.writer.close()
        except Exception:
            pass


class Bridge:
    def __init__(self):
        self.connections = []
        self.port = None
        self.changed = asyncio.Event()

    @property
    def active(self):
        # 收到 hello 之后才算可用，保证状态中带有扩展版本等信息
        live = [c for c in self.connections if c.ready and not c.closed]
        return live[-1] if live else None

    async def start(self):
        for port in range(BASE_PORT, BASE_PORT + PORT_COUNT):
            try:
                self.server = await asyncio.start_server(self.handle_client, "127.0.0.1", port, limit=2 ** 24)
                self.port = port
                log("waiting for Egret Agent Inspector extension on ws://127.0.0.1:%d" % port)
                return
            except OSError:
                continue
        log("ports %d-%d are all in use; the bridge is unavailable" % (BASE_PORT, BASE_PORT + PORT_COUNT - 1))

    async def handle_client(self, reader, writer):
        try:
            head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 10)
        except Exception:
            writer.close()
            return
        lines = head.decode("latin-1").split("\r\n")
        headers = {}
        for line in lines[1:]:
            if ":" in line:
                k, v = line.split(":", 1)
                headers[k.strip().lower()] = v.strip()
        if headers.get("upgrade", "").lower() != "websocket":
            body = json.dumps({"server": SERVER_NAME, "version": SERVER_VERSION, "extensionConnected": self.active is not None}).encode()
            writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: %d\r\nConnection: close\r\n\r\n" % len(body) + body)
            await writer.drain()
            writer.close()
            return
        origin = headers.get("origin", "")
        if not origin.startswith("chrome-extension://"):
            writer.write(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            await writer.drain()
            writer.close()
            return
        accept = base64.b64encode(hashlib.sha1((headers.get("sec-websocket-key", "") + WS_GUID).encode()).digest()).decode()
        writer.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                      "Sec-WebSocket-Accept: %s\r\n\r\n" % accept).encode())
        await writer.drain()

        conn = ExtensionConnection(reader, writer, {"origin": origin})
        conn.on_ready = self.changed.set
        self.connections.append(conn)
        heartbeat = asyncio.ensure_future(self.heartbeat(conn))
        try:
            await self.read_loop(conn)
        except (asyncio.IncompleteReadError, ConnectionError, OSError):
            pass
        finally:
            heartbeat.cancel()
            conn.close()
            self.connections = [c for c in self.connections if c is not conn]
            log("extension disconnected")

    async def heartbeat(self, conn):
        # 应用层心跳让 MV3 service worker 保持活跃
        while not conn.closed:
            await asyncio.sleep(20)
            try:
                await conn.send_text('{"type":"ping"}')
            except Exception:
                return

    async def read_loop(self, conn):
        reader = conn.reader
        fragments = []
        while True:
            b1, b2 = await reader.readexactly(2)
            fin, opcode = b1 & 0x80, b1 & 0x0F
            length = b2 & 0x7F
            if length == 126:
                length = struct.unpack("!H", await reader.readexactly(2))[0]
            elif length == 127:
                length = struct.unpack("!Q", await reader.readexactly(8))[0]
            mask = await reader.readexactly(4) if b2 & 0x80 else None
            payload = await reader.readexactly(length)
            if mask and length:
                key = (mask * (length // 4 + 1))[:length]
                payload = (int.from_bytes(payload, "big") ^ int.from_bytes(key, "big")).to_bytes(length, "big")
            if opcode == 0x8:
                await conn.send_control(0x8)
                return
            if opcode == 0x9:
                await conn.send_control(0xA, payload[:125])
                continue
            if opcode == 0xA:
                continue
            fragments.append(payload)
            if fin:
                data = b"".join(fragments)
                fragments = []
                conn.on_message(data.decode("utf-8", "replace"))

    async def request(self, method, params, timeout=REQUEST_TIMEOUT):
        if self.port is None:
            raise RuntimeError("MCP server 未能监听端口 %d-%d（都被占用），无法连接浏览器扩展" % (BASE_PORT, BASE_PORT + PORT_COUNT - 1))
        conn = self.active
        if conn is None:
            conn = await self.wait_connected(CONNECT_WAIT)
        if conn is None:
            raise RuntimeError(
                "Egret Agent Inspector 浏览器扩展未连接（ws://127.0.0.1:%d）。请确认浏览器已打开；"
                "若尚未安装扩展，按 egret-install-extension skill 为用户安装。" % self.port)
        return await conn.request(method, params, timeout)

    async def wait_connected(self, seconds):
        loop = asyncio.get_running_loop()
        deadline = loop.time() + seconds
        while self.active is None and loop.time() < deadline:
            self.changed.clear()
            try:
                await asyncio.wait_for(self.changed.wait(), max(0.1, deadline - loop.time()))
            except asyncio.TimeoutError:
                pass
        return self.active


# ---------------------------------------------------------------- MCP (stdio JSON-RPC)

class McpServer:
    def __init__(self, bridge):
        self.bridge = bridge
        self.write_lock = asyncio.Lock()

    async def send(self, msg):
        data = (json.dumps(msg, ensure_ascii=False) + "\n").encode("utf-8")
        async with self.write_lock:
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()

    async def reply(self, req_id, result=None, error=None):
        msg = {"jsonrpc": "2.0", "id": req_id}
        if error is not None:
            msg["error"] = error
        else:
            msg["result"] = result
        await self.send(msg)

    async def handle(self, msg):
        method = msg.get("method")
        req_id = msg.get("id")
        params = msg.get("params") or {}
        if req_id is None:
            return  # notification
        try:
            if method == "initialize":
                requested = params.get("protocolVersion")
                version = requested if requested in SUPPORTED_PROTOCOLS else SUPPORTED_PROTOCOLS[0]
                await self.reply(req_id, {
                    "protocolVersion": version,
                    "capabilities": {"tools": {"listChanged": False}},
                    "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
                    "instructions": INSTRUCTIONS,
                })
            elif method == "ping":
                await self.reply(req_id, {})
            elif method == "tools/list":
                await self.reply(req_id, {"tools": [
                    {"name": name, "description": desc, "inputSchema": schema}
                    for name, (desc, schema, _, _) in TOOLS.items()
                ]})
            elif method == "tools/call":
                await self.reply(req_id, await self.call_tool(params.get("name"), params.get("arguments") or {}))
            elif method in ("resources/list", "prompts/list"):
                await self.reply(req_id, {method.split("/")[0]: []})
            else:
                await self.reply(req_id, error={"code": -32601, "message": "Method not found: %s" % method})
        except Exception as e:  # noqa: BLE001
            await self.reply(req_id, error={"code": -32603, "message": str(e)})

    async def call_tool(self, name, args):
        if name not in TOOLS:
            return {"isError": True, "content": [{"type": "text", "text": "未知工具：%s" % name}]}
        try:
            if name == "egret_run_steps":
                report, image = await self.run_steps(args)
                content = [{"type": "text", "text": json.dumps(report, ensure_ascii=False)}]
                if image:
                    content.append({"type": "image", "data": image["data"], "mimeType": image["mimeType"]})
                return {"isError": not report["passed"], "content": content}
            res = await self.invoke(name, args)
            if name == "egret_screenshot":
                return {"content": [
                    {"type": "image", "data": res["data"], "mimeType": res["mimeType"]},
                    {"type": "text", "text": json.dumps({"tabId": res.get("tabId")})},
                ]}
            return {"content": [{"type": "text", "text": json.dumps(res, ensure_ascii=False)}]}
        except Exception as e:  # noqa: BLE001
            return {"isError": True, "content": [{"type": "text", "text": str(e)}]}

    async def invoke(self, name, args):
        """执行单个工具，返回结果对象；失败时抛出异常。"""
        _, _, bridge_method, page_method = TOOLS[name]
        timeout = REQUEST_TIMEOUT
        args = dict(args)
        try:
            if bridge_method == "extensionStatus":
                return await self.extension_status(float(args.get("waitSeconds", 8)))
            if bridge_method == "reloadExtension":
                res = await self.bridge.request("reloadExtension", {}, timeout)
                await asyncio.sleep(1)
                status = await self.extension_status(15)
                status["reloadedFrom"] = res.get("extensionVersion")
                return status
            if bridge_method == "page":
                tab_id = args.pop("tabId", None)
                if page_method == "waitFor":
                    args["timeoutMs"] = min(int(args.get("timeoutMs", 10000)), 120000)
                    timeout = args["timeoutMs"] / 1000.0 + 15
                if page_method in ("tap", "drag"):
                    timeout = REQUEST_TIMEOUT + 30
                res = await self.bridge.request("page", {"tabId": tab_id, "method": page_method, "params": args}, timeout)
                payload = dict(res.get("result") or {}) if isinstance(res.get("result"), dict) else {"value": res.get("result")}
                payload["tabId"] = res.get("tabId")
                return payload
            if bridge_method == "listTabs":
                args.setdefault("probe", True)
            if bridge_method == "navigate":
                timeout = args.get("timeoutMs", 30000) / 1000.0 + 10
            return await self.bridge.request(bridge_method, args, timeout)
        except asyncio.TimeoutError:
            raise RuntimeError("请求超时（%.0f 秒）" % timeout)

    async def extension_status(self, wait):
        status = {"port": self.bridge.port, "bundledVersion": SERVER_VERSION, "extensionDir": EXTENSION_DIR}
        if self.bridge.port is None:
            status.update(connected=False, hint="端口 %d-%d 均被占用" % (BASE_PORT, BASE_PORT + PORT_COUNT - 1))
            return status
        conn = await self.bridge.wait_connected(wait)
        if conn is None:
            status.update(connected=False, hint="扩展未连接：浏览器未打开，或尚未安装扩展（使用 egret-install-extension skill 安装）")
            return status
        info = conn.info
        status.update(connected=True, browser=info.get("browser"), extensionVersion=info.get("extensionVersion"),
                      extensionId=info.get("extensionId"), connections=len([c for c in self.bridge.connections if c.ready and not c.closed]))
        status["outdated"] = info.get("extensionVersion") != SERVER_VERSION
        return status

    async def run_steps(self, args):
        steps = args.get("steps")
        name = args.get("name")
        if args.get("file"):
            with open(args["file"], encoding="utf-8-sig") as f:
                spec = json.load(f)
            steps = spec.get("steps") if isinstance(spec, dict) else spec
            name = name or (spec.get("name") if isinstance(spec, dict) else None) or os.path.basename(args["file"])
        if not isinstance(steps, list) or not steps:
            raise ValueError("需要提供非空的 steps 数组或 file")
        tab_id = args.get("tabId")
        stop = args.get("stopOnFailure", True)
        results, image = [], None
        started = time.time()
        for index, step in enumerate(steps):
            step = dict(step)
            action = step.pop("action", None)
            note = step.pop("note", None)
            if tab_id is not None:
                step.setdefault("tabId", tab_id)
            t0 = time.time()
            item = {"index": index, "action": action}
            if note:
                item["note"] = note
            try:
                item["result"] = await self.run_step(action, step)
                item["ok"] = True
            except Exception as e:  # noqa: BLE001
                item.update(ok=False, error=str(e))
            item["ms"] = int((time.time() - t0) * 1000)
            results.append(item)
            if not item["ok"] and stop:
                break
        passed = all(r["ok"] for r in results) and len(results) == len(steps)
        if not passed and args.get("screenshotOnFailure", True):
            try:
                image = await self.invoke("egret_screenshot", {"tabId": tab_id} if tab_id is not None else {})
            except Exception:  # noqa: BLE001
                image = None
        report = {"name": name, "passed": passed, "total": len(steps), "executed": len(results),
                  "failed": [r["index"] for r in results if not r["ok"]],
                  "durationMs": int((time.time() - started) * 1000), "steps": results}
        return report, image

    async def run_step(self, action, step):
        if action == "sleep":
            await asyncio.sleep(min(float(step.get("ms", 500)), 60000) / 1000.0)
            return {"slept": step.get("ms", 500)}
        if action == "assert":
            return await self.assert_step(step)
        if action not in STEP_ACTIONS:
            raise ValueError("未知的 action：%s" % action)
        res = await self.invoke(STEP_ACTIONS[action], step)
        if action == "screenshot":
            return {"captured": True}
        if action == "waitFor" and not res.get("matched"):
            raise AssertionError("等待超时：%s 未满足（%d ms）" % (step.get("state", "visible"), res.get("elapsedMs", 0)))
        return compact(res)

    async def assert_step(self, step):
        expect = step.get("expect") or {"visible": True}
        query = {k: step[k] for k in QUERY_KEYS if k in step}
        # 期望可见时只在可见对象中匹配，避免 index 选中同名的隐藏对象
        base = {"tabId": step.get("tabId"), "visibleOnly": expect.get("visible") is True}
        found = await self.invoke("egret_find", dict(base, limit=50, **{k: v for k, v in query.items() if k != "index"}))
        total = found.get("total", len(found.get("results", [])))
        failures = []
        if expect.get("exists") is False:
            if total:
                failures.append("期望不存在，实际找到 %d 个" % total)
            return self.assert_result(failures, {"total": total})
        if "count" in expect and total != expect["count"]:
            failures.append("数量期望 %s，实际 %d" % (expect["count"], total))
        if not total:
            failures.append("未找到匹配对象")
            return self.assert_result(failures, {"total": 0})
        extra = list((expect.get("props") or {}).keys())
        node = await self.invoke("egret_get_node", dict(base, props=extra, **query))
        if "visible" in expect and bool(node.get("onStageVisible")) != bool(expect["visible"]):
            failures.append("可见性期望 %s，实际 %s" % (expect["visible"], node.get("onStageVisible")))
        if "text" in expect and node.get("text") != expect["text"]:
            failures.append("text 期望 %r，实际 %r" % (expect["text"], node.get("text")))
        if "textContains" in expect and expect["textContains"] not in (node.get("text") or ""):
            failures.append("text 期望包含 %r，实际 %r" % (expect["textContains"], node.get("text")))
        for key, value in (expect.get("props") or {}).items():
            actual = (node.get("props") or {}).get(key)
            if actual != value:
                failures.append("%s 期望 %r，实际 %r" % (key, value, actual))
        return self.assert_result(failures, {"total": total, "hash": node.get("hash"), "path": node.get("path"), "text": node.get("text")})

    @staticmethod
    def assert_result(failures, detail):
        if failures:
            raise AssertionError("；".join(failures))
        return detail


def compact(res):
    """精简批量步骤中的单步结果，只保留定位与判断所需字段。"""
    if not isinstance(res, dict):
        return res
    out = {}
    for key in ("matched", "elapsedMs", "total", "method", "warnings", "value", "url", "title", "props"):
        if key in res and res[key] not in (None, []):
            out[key] = res[key]
    target = res.get("target") or (res.get("results") or [None])[0]
    if isinstance(target, dict):
        out["target"] = {k: target.get(k) for k in ("hash", "className", "id", "path") if target.get(k) is not None}
    hit = res.get("hit")
    if isinstance(hit, dict):
        out["hit"] = hit.get("path")
    return out


async def main():
    bridge = Bridge()
    await bridge.start()
    server = McpServer(bridge)
    loop = asyncio.get_running_loop()
    tasks = set()
    while True:
        line = await loop.run_in_executor(None, sys.stdin.buffer.readline)
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line.decode("utf-8"))
        except ValueError:
            await server.send({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}})
            continue
        for m in msg if isinstance(msg, list) else [msg]:
            task = asyncio.ensure_future(server.handle(m))
            tasks.add(task)
            task.add_done_callback(tasks.discard)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
