#!/usr/bin/env python3
"""Egret Agent Inspector MCP server.

stdio MCP server，仅依赖 Python 3.8+ 标准库。在 127.0.0.1 上开启 WebSocket 服务，
由浏览器中的 Egret Agent Inspector 扩展主动连接，把工具请求转发到游戏页面执行。

环境变量：
  EGRET_MCP_PORT          起始端口，默认 17800（扩展会依次尝试 17800-17815）
  EGRET_MCP_PORT_COUNT    端口数量，默认 16
  EGRET_MCP_TIMEOUT       单次请求超时秒数，默认 30
  EGRET_MCP_CONNECT_WAIT  扩展未连接时等待其连接的秒数，默认 20
  EGRET_NOTES_DIR         探索笔记目录，默认 ~/.egret-agent-inspector/notes
"""

import asyncio
import atexit
import base64
import hashlib
import itertools
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import time

SERVER_NAME = "egret-agent-inspector"
PLUGIN_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXTENSION_DIR = os.path.join(PLUGIN_ROOT, "extension")
# 宿主以插件目录为 cwd 启动本进程；Windows 会锁定进程的 cwd，导致卸载插件时目录删不掉，
# 由本进程拉起的浏览器也会继承该 cwd。启动后立即切走，并且不在插件目录写 __pycache__。
os.chdir(os.path.expanduser("~"))
sys.dont_write_bytecode = True


def read_bundled_version():
    try:
        with open(os.path.join(EXTENSION_DIR, "manifest.json"), encoding="utf-8-sig") as f:
            return json.load(f).get("version")
    except (OSError, ValueError):
        return None


SERVER_VERSION = read_bundled_version() or "0.0.0"
sys.path.insert(0, os.path.join(PLUGIN_ROOT, "scripts"))
import browser_extension  # noqa: E402  浏览器检测与扩展安装，在 MCP 进程中执行以避开 agent 命令沙箱


OCR_MACOS_SOURCE = os.path.join(PLUGIN_ROOT, "scripts", "ocr_macos.swift")
OCR_WINDOWS_SOURCE = os.path.join(PLUGIN_ROOT, "scripts", "ocr_windows.ps1")
_OCR_WORKER = None
_OCR_WORKER_ERROR = None
_OCR_WORKER_READY = threading.Event()
_OCR_WORKER_LOCK = threading.Lock()


def macos_ocr_binary():
    """编译并缓存 macOS Vision OCR helper；首轮较慢，后续直接复用临时目录中的二进制。"""
    if sys.platform != "darwin":
        raise RuntimeError("当前平台没有内置快速 OCR 后端")
    xcrun = shutil.which("xcrun")
    if not xcrun or not os.path.isfile(OCR_MACOS_SOURCE):
        raise RuntimeError("macOS Vision OCR 需要 Xcode Command Line Tools")
    with open(OCR_MACOS_SOURCE, "rb") as f:
        digest = hashlib.sha256(f.read()).hexdigest()[:12]
    binary = os.path.join(tempfile.gettempdir(), "egret-agent-inspector-ocr-" + digest)
    if os.path.isfile(binary) and os.access(binary, os.X_OK):
        return binary, False
    started = time.perf_counter()
    module_cache = os.path.join(tempfile.gettempdir(), "egret-agent-inspector-swift-cache")
    os.makedirs(module_cache, exist_ok=True)
    build_env = dict(os.environ, SWIFT_MODULECACHE_PATH=module_cache, CLANG_MODULE_CACHE_PATH=module_cache)
    built = subprocess.run([xcrun, "swiftc", "-O", OCR_MACOS_SOURCE, "-o", binary],
                           capture_output=True, text=True, timeout=90, env=build_env)
    if built.returncode:
        raise RuntimeError("编译 macOS OCR helper 失败：" + (built.stderr.strip() or built.stdout.strip()))
    os.chmod(binary, 0o700)
    return binary, int((time.perf_counter() - started) * 1000)


def _prewarm_macos_ocr():
    global _OCR_WORKER, _OCR_WORKER_ERROR
    try:
        binary, _ = macos_ocr_binary()
        worker = subprocess.Popen([binary, "--daemon"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, text=True, bufsize=1)
        ready = json.loads(worker.stdout.readline())
        if not ready.get("ready"):
            raise RuntimeError("macOS OCR worker 未就绪")
        _OCR_WORKER = worker
        _OCR_WORKER_READY.set()
    except Exception as e:  # noqa: BLE001
        _OCR_WORKER_ERROR = str(e)


def start_ocr_prewarm():
    if sys.platform == "darwin" and os.environ.get("EGRET_OCR_PREWARM", "1") != "0" and not _OCR_WORKER_READY.is_set():
        threading.Thread(target=_prewarm_macos_ocr, name="egret-ocr-prewarm", daemon=True).start()


def stop_ocr_worker():
    if _OCR_WORKER and _OCR_WORKER.poll() is None:
        _OCR_WORKER.terminate()


atexit.register(stop_ocr_worker)


def run_fast_ocr(image_data, candidates, scale):
    """一次图片、多个候选区域批量 OCR，避免每个按钮各截一次图。"""
    compile_ms = 0
    if sys.platform == "darwin":
        use_worker = _OCR_WORKER_READY.is_set() and _OCR_WORKER and _OCR_WORKER.poll() is None
        if use_worker:
            binary = None
            backend = "macos-vision-accurate-warm"
        else:
            binary, compile_ms = macos_ocr_binary()
            backend = "macos-vision-fast"
        command = None
    elif sys.platform == "win32":
        powershell = shutil.which("powershell") or shutil.which("pwsh")
        if not powershell or not os.path.isfile(OCR_WINDOWS_SOURCE):
            raise RuntimeError("Windows OCR 需要 Windows PowerShell 与 Windows.Media.Ocr")
        backend = "windows-media-ocr"
        command = [powershell, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
                   "-File", OCR_WINDOWS_SOURCE]
    else:
        raise RuntimeError("当前平台没有内置快速 OCR 后端；目前支持 Windows 与 macOS")
    started = time.perf_counter()
    image_path = spec_path = None
    try:
        with tempfile.NamedTemporaryFile(prefix="egret-ocr-", suffix=".png", delete=False) as image_file:
            image_file.write(base64.b64decode(image_data))
            image_path = image_file.name
        ratio = float(scale or 1)
        regions = []
        for candidate in candidates:
            rect = candidate.get("screenRect") or {}
            if not rect.get("width") or not rect.get("height") or candidate.get("hash") is None:
                continue
            pad = 4 * ratio
            regions.append({
                "id": str(candidate["hash"]),
                "x": float(rect.get("x", 0)) * ratio - pad,
                "y": float(rect.get("y", 0)) * ratio - pad,
                "width": float(rect["width"]) * ratio + pad * 2,
                "height": float(rect["height"]) * ratio + pad * 2,
            })
        if not regions:
            return {"available": True, "backend": backend, "texts": {}, "elapsedMs": 0,
                    "compileMs": compile_ms or 0}
        spec = {"image": image_path, "regions": regions, "languages": ["zh-Hans", "en-US"]}
        with tempfile.NamedTemporaryFile(prefix="egret-ocr-", suffix=".json", mode="w",
                                         encoding="utf-8", delete=False) as spec_file:
            json.dump(spec, spec_file, ensure_ascii=False)
            spec_path = spec_file.name
        if sys.platform == "darwin" and use_worker:
            with _OCR_WORKER_LOCK:
                _OCR_WORKER.stdin.write(spec_path + "\n")
                _OCR_WORKER.stdin.flush()
                decoded = json.loads(_OCR_WORKER.stdout.readline())
            if decoded.get("error"):
                raise RuntimeError(decoded["error"])
        else:
            completed = subprocess.run(([binary, spec_path] if command is None else command + [spec_path]),
                                       capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=5)
            if completed.returncode:
                raise RuntimeError(completed.stderr.strip() or "本地 OCR 执行失败")
            decoded = json.loads(completed.stdout)
        texts, confidences = {}, {}
        for match in decoded.get("matches", []):
            text = (match.get("text") or "").strip()
            meaningful = re.sub(r"[^0-9A-Za-z\u3400-\u9fff]+", "", text)
            if len(meaningful) >= 2:
                texts[str(match["id"])] = text
                confidences[str(match["id"])] = round(float(match.get("confidence") or 0), 3)
        return {"available": True, "backend": backend, "texts": texts,
                "confidences": confidences, "regions": len(regions),
                "language": decoded.get("language"),
                "elapsedMs": int((time.perf_counter() - started) * 1000), "compileMs": compile_ms or 0}
    finally:
        for path in (image_path, spec_path):
            if path:
                try:
                    os.unlink(path)
                except OSError:
                    pass
WEAK_LABEL_SOURCES = ("qaName", "id", "name", "source", "className")


def apply_ocr_labels(table, texts):
    """把 OCR 结果写回动作表：只替换图片字造成的弱标签，返回替换了几个。

    美术字体经常被识别错（"进入游戏" → "迸八湔懑"），所以原来的结构化标签保留在 alt 里，
    识别结果不可信时 agent 还能退回去用它。
    """
    filled = 0
    for action in table.get("actions") or []:
        text = (texts.get(str(action.get("hash"))) or "").strip()
        if text and action.get("from") in WEAK_LABEL_SOURCES:
            action["alt"] = action["label"]
            action["label"] = text[:32]
            action["from"] = "ocr"
            action.pop("weak", None)
            filled += 1
    return filled


# 定位类字段：编号只在一张表里有效、hash 面板重开就变，路线复用时换成页面给的稳定选择器
ROUTE_LOCATORS = ("i", "hash", "qaName", "id", "name", "className", "text", "source", "match", "index")


def route_step(step, rec):
    """执行过的一步 → (下次照发的步骤, 比对键, 不看第几个的比对键)；失败或拿不到稳定选择器时步骤为 None。

    第三个键用来认「同一类操作的另一轮」：选第 1 只和选第 4 只精灵只差 index 或名字里的编号
    （petBag_PetBagCell_petId_130 和 _520）。
    """
    op = rec.get("op")
    if rec.get("error") or rec.get("skipped") or not isinstance(step, dict):
        return None, None, None
    params = {k: v for k, v in step.items() if k not in ROUTE_LOCATORS}
    if op in ("tap", "text", "swipe", "drag"):
        sel = dict((rec.get("target") or {}).get("sel") or {})
        if op == "drag":
            # 拖到哪也要换成稳定选择器：编号只在那一张表里有效
            to = rec.get("to") or {}
            if not to.get("sel") and "dx" not in (step.get("to") or {}) and "dy" not in (step.get("to") or {}):
                return None, None, None
            params["to"] = to.get("sel") or step.get("to")
        if op == "text":
            # 填字时 text 是要填的内容，不是查询条件
            if "text" in sel:
                return None, None, None
            params["text"] = step.get("text", rec.get("text"))
        if not sel:
            return None, None, None
        key = op + json.dumps(sel, ensure_ascii=False, sort_keys=True)
        loose = op + json.dumps({k: re.sub(r"\d+", "#", v) if isinstance(v, str) else v
                                 for k, v in sel.items() if k != "index"}, ensure_ascii=False, sort_keys=True)
        return dict(sel, **params), key, loose
    if any(k in step for k in ("i", "hash")):
        return None, None, None
    replay = dict(step)
    key = json.dumps(replay, ensure_ascii=False, sort_keys=True)
    return replay, key, key


SPLAN_SKILL_HINT = "这是 Splan 项目页面：通用操作和换技能见 splan-control，打战斗（进 PVE、出招、换精灵、结算）见 splan-battle；和任务相关的还没读过就先读，读过不用再读"

DRAG_WORDS = {"up": "上滑", "down": "下滑", "left": "左滑", "right": "右滑"}


def short_label(label, width=12):
    label = " ".join(str(label or "").split())
    return label if len(label) <= width else label[:width] + "…"


def render_action_table(table):
    """动作表渲染成一行一条的紧凑文本。

    同样的内容，嵌套 JSON 要多花两三倍 token，小模型还容易串行；这里只保留决策真正要用的东西。
    需要 hash / 坐标做二次定位时用 format="json"。
    """
    lines, head = [], []
    panel = table.get("panel") or {}
    title = panel.get("name") or panel.get("className")
    if title:
        head.append("面板 %s" % title)
    mode = table.get("mode")
    if mode and mode != "normal":
        head.append("mode %s" % mode)
    if table.get("scope") == "stage":
        head.append("scope stage（顶层不是模态面板，整个舞台都在表里）")
    if table.get("marker"):
        head.append("marker %s" % table["marker"])
    if head:
        lines.append(" | ".join(head))
    if table.get("skillHint"):
        lines.append("技能 %s" % table["skillHint"])
    if table.get("stale"):
        lines.append("stale 界面已经不是做决策时那一页，未执行任何操作；按下面这张新表重选")
    if table.get("reloaded"):
        lines.append("页面已重载 重载前的 i 编号、marker、hash 全部失效；别再用记下来的 hash，按这张新表重新定位")
    for warning in table.get("warnings") or []:
        lines.append("警告 %s" % warning)
    session = table.get("session") or {}
    if session.get("lost"):
        # 掉线提示框常被引导遮罩压住点不到，点了也只是让游戏自己刷新：直接重开最快
        what = session.get("text") or {"kicked": "被踢下线", "reconnect-gave-up": "重连失败",
                                       "disconnected": "连接断开"}.get(session.get("reason"), "掉线")
        lines.append("掉线 %s：别点提示框，直接 egret_navigate %s 重开页面，再从登录页进游戏" % (
            what, json.dumps({"url": session.get("url")}, ensure_ascii=False)))
    turn = table.get("battleTurn") or {}
    if turn.get("canOP"):
        # 新手战斗停了倒计时，轮到你时不出招就一直僵着；对面倒下后界面上还是那只 0 血的精灵
        lines.append("回合 只能换精灵：点换宠栏里的卡片" if turn.get("next") == 3 else
                     "回合 轮到你出招：点技能（对面显示 0 血也要出招，出现结算页才算打完）")
    for rec in table.get("executed") or []:
        target = rec.get("target") or {}
        label = target.get("label") or target.get("reason") or rec.get("text") or ""
        line = ("执行 %s %s" % (rec.get("op"), label)).strip()
        if rec.get("to"):
            line += " → %s" % (rec["to"].get("label") or "")
        elif rec.get("drag"):
            line += "（按住%s）" % DRAG_WORDS.get(rec["drag"], rec["drag"])
        if rec.get("cleared"):
            line += "（先点掉了%s）" % rec["cleared"]
        if rec.get("error"):
            line += " → 失败：%s" % rec["error"]
        elif rec.get("expectMatched") is False:
            line += " → expect 未满足"
        result = rec.get("result") or {}
        if isinstance(result, dict) and result.get("advanced") is not None:
            line += " → 推进 %s 次（%s）" % (result.get("advanced"), result.get("stopped"))
        if isinstance(result, dict) and isinstance(result.get("closed"), list):
            # 原来把整串 dict 直接拼进去，几百字节全是噪音；这里只留「关掉几个 + 卡在哪个」
            closed = result["closed"]
            line += " → 关掉 %d 个弹窗" % len([c for c in closed if c.get("ok")])
            stuck = [c for c in closed if not c.get("ok")]
            if stuck:
                line += "，%s 没关掉（%s）" % (stuck[0].get("panel") or "", stuck[0].get("note") or "")
        if rec.get("op") == "scroll" and isinstance(result, dict) and result.get("index") is not None:
            seen = result.get("visible") or {}
            shown = seen and seen.get("lo") is not None and seen["lo"] <= result["index"] <= seen.get("hi", -1)
            line += " → 第 %s/%s 条%s（屏上 %s–%s）" % (
                result["index"], result.get("total"), "已在屏上" if shown else "没能滚到屏上",
                seen.get("lo", "?"), seen.get("hi", "?"))
        unlock = rec.get("unlock")
        if isinstance(unlock, dict) and unlock.get("reason") == "unlocked":
            line += "（先等上一回合解锁 %.1fs）" % ((unlock.get("waitedMs") or 0) / 1000.0)
        turn = rec.get("turn")
        if isinstance(turn, dict):
            # 出招后整组按钮被锁：工具已经在这一次调用里等到能再操作了，不用再 observe / wait
            # 「可以再操作了」太含糊：验收里 agent 看到它仍然去 observe、wait 各一轮才敢出下一招
            why = {"unlocked": "轮到你了，技能栏已解锁，直接出下一招", "panel": "界面换了（结算或切换界面）",
                   "blocked": "解锁后被盖住了，可能弹出了结算或提示", "new-controls": "游戏在等你先做别的决定",
                   "rebuilt": "界面重建了", "timeout": "等满仍未解锁",
                   "budget": "这次调用快到时限，先返回；接着再发一次同样的步骤",
                   "no-lock": "点了没上锁，可能次数用完或不在回合内"}.get(turn.get("reason"), turn.get("reason"))
            if turn.get("added"):
                why += "：" + "、".join(str(a) for a in turn["added"])
            if rec.get("repeated"):
                line += " → 连出 %s 次，停在：%s" % (rec["repeated"], why)
            else:
                line += " → 等回合 %.1fs（%s）" % ((turn.get("waitedMs") or 0) / 1000.0, why)
        if rec.get("op") == "close" and isinstance(rec.get("result"), dict):
            if result.get("ok") and result.get("via") == "gone":
                line += " → %s 自己退场了" % (result.get("panel") or "")
            elif result.get("ok"):
                via = {"outer": "外层模块的关闭/返回键", "shell": "下层外壳的返回键"}.get(result.get("via"), result.get("via"))
                line += " → 点 %s 关掉了 %s" % (via, result.get("panel") or "")
            else:
                line += " → 没关掉（%s）：%s" % (result.get("stopped"), result.get("note") or "")
            if result.get("passed"):
                line += "（%s 是上一层正在退场，跳过）" % result["passed"]
        lines.append(line)
    if table.get("changed"):
        lines.append("变化 %s" % table["changed"])
    if table.get("stopped") == "budget":
        lines.append("中止 这次调用快到时限，后面的步骤没做；看完新表再发剩下的步骤")
    elif table.get("stopped") and table["stopped"] not in ("done", "stale"):
        lines.append("中止 %s" % table["stopped"])
    route = table.get("route")
    if route:
        # 同一段路线第二次出现：把上次接下来的几步摆出来，一样就一次发完，不用每步再看表想一轮
        lines.append("路线 上次这之后接着是：%s；路线一样就一次发 %s" % (
            " → ".join(route["labels"]),
            json.dumps({"steps": route["steps"]}, ensure_ascii=False, separators=(",", ":"))))
    if table.get("newErrors"):
        lines.append("页面报错 %s 条，首条：%s" % (table["newErrors"], table.get("firstError")))
    texts = [t for t in (table.get("text") or []) if t]
    if texts:
        lines.append("文案 " + " / ".join(texts[:12]))
    actions = table.get("actions") or []
    if actions:
        weak = any(a.get("weak") or a.get("from") in WEAK_LABEL_SOURCES for a in actions)
        extra = []
        if table.get("omitted"):
            extra.append("省略 %d" % table["omitted"])
        if table.get("occludedHidden"):
            extra.append("被遮挡 %d 条未列出" % table["occludedHidden"])
        if weak:
            extra.append("* = 图片字弱标签，不确定就先 ocr 或截图")
        lines.append("动作 %d 条%s" % (len(actions), ("（%s）" % "，".join(extra)) if extra else ""))
        for a in actions:
            flags = []
            if a.get("off"):
                flags.append("禁用")
            if a.get("on"):
                flags.append("已选")
            if a.get("st"):
                flags.append("st=%s" % a["st"])
            if a.get("occluded"):
                flags.append("被挡")
            if a.get("drag"):
                # 原地点一下不生效、要拖出去松手的控件（换宠卡）；点它会自动按住滑出去
                flags.append("按住%s" % DRAG_WORDS.get(a["drag"], a["drag"]))
            star = "*" if (a.get("weak") or a.get("from") in WEAK_LABEL_SOURCES) else ""
            if a.get("alt"):
                # OCR 识别美术字经常出错，原来的结构化标签留一手
                flags.append("alt=%s" % a["alt"])
            lines.append(" ".join(filter(None, [
                str(a.get("i")), "%s%s" % (a.get("label"), star), a.get("role"), " ".join(flags)])))
    elif mode in ("guide-hole", "guide-continue", "dialogue-continue", "transient", "empty"):
        lines.append("动作 无（按 mode 走 recommended / advance / wait）")
    if table.get("recommendedTarget"):
        rec = table["recommendedTarget"]
        reason = rec.get("reason")
        # 只能点遮罩的弹窗用 close：点完确认真关掉了，分阶段的面板（结算页先跳动画）还会再点一次；
        # 对白和「点任意处继续」用 advance 一次推完
        op = {"modal-backdrop-dismiss": "close", "dialogue-continue": "advance",
              "guide-continue": "advance"}.get(reason, "recommended")
        # 引导挖洞写出点的是什么：验收里 agent 每一步都先 format=json 再看一遍目标，白多一轮
        target = rec.get("target") or {}
        name = ""
        if reason == "guide-hole":
            text = " ".join(str(target.get("text") or "").split())
            name = text if 0 < len(text) <= 12 else str(target.get("qaName") or "").split("__")[-1] or \
                target.get("id") or target.get("name") or str(target.get("className") or "").split(".")[-1]
        if reason == "guide-drag":
            lines.append("推荐 {\"op\":\"recommended\"}（guide-drag，按住把 %s 拖到 %s）" % (
                short_label(rec.get("label") or "起点"), short_label(rec.get("dropLabel") or "引导终点")))
        else:
            lines.append("推荐 {\"op\":\"%s\"}（%s%s）" % (op, reason, "，点 %s" % name if name else ""))
    if table.get("transientOverlay"):
        lines.append("过场 %s：用 {\"op\":\"wait\",\"ms\":800} 短等" % table["transientOverlay"].get("reason"))
    for sc in table.get("scrollers") or []:
        dirs = "".join([d for d, k in (("↑", "canUp"), ("↓", "canDown"), ("←", "canLeft"), ("→", "canRight")) if sc.get(k)])
        lines.append("可滚 %s %s → {\"op\":\"scroll\",\"hash\":%s,\"dy\":-200}" % (sc.get("label"), dirs, sc.get("hash")))
        # 二十来条的短列表滚两下就看完了，再摆「先读数据」只会把 agent 引去读一堆 id
        if sc.get("items", 0) > 20 and sc.get("list") and dirs:
            # 模型靠滚动去「看」列表，一屏几条，数出来的总数能差几十倍；把全集入口直接摆在它眼前
            fields = "/".join(sc.get("fields") or [])
            lines.append("数据 共 %d 条%s，屏上只有几条：计数、筛选、找目标先读数据 egret_evaluate \"$items(%s, it => …)\"；"
                         "定位第 N 条 {\"op\":\"scroll\",\"hash\":%s,\"toIndex\":N}"
                         % (sc["items"], "（字段 %s）" % fields if fields else "", sc["list"], sc.get("hash")))
    ocr = table.get("ocr") or {}
    if ocr.get("filled"):
        # 全部命中缓存时没有耗时
        took = "（%sms）" % ocr["elapsedMs"] if ocr.get("elapsedMs") is not None else "（缓存）"
        lines.append("ocr 补了 %s 个标签%s" % (ocr["filled"], took))
    elif ocr.get("error"):
        lines.append("ocr 失败 %s" % ocr["error"])
    if table.get("hint"):
        lines.append("提示 %s" % table["hint"])
    timing = []
    if table.get("elapsedMs"):
        timing.append("%sms" % table["elapsedMs"])
    if table.get("waitedForLoadingMs"):
        timing.append("等加载 %sms" % table["waitedForLoadingMs"])
    if timing:
        lines.append("耗时 " + " ".join(timing))
    return "\n".join(lines)


SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"]
BASE_PORT = int(os.environ.get("EGRET_MCP_PORT", "17800"))
PORT_COUNT = int(os.environ.get("EGRET_MCP_PORT_COUNT", "16"))
REQUEST_TIMEOUT = float(os.environ.get("EGRET_MCP_TIMEOUT", "30"))
CONNECT_WAIT = float(os.environ.get("EGRET_MCP_CONNECT_WAIT", "20"))
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

# 工具越多，小模型越容易放着 observe/act 不用去挨个试别的工具。默认只暴露 core：
# 把完全能被 egret_act / egret_observe 顶掉的那几个收起来，用 EGRET_MCP_PROFILE=full 可以全放出来。
HIDDEN_IN_CORE = ("egret_tap", "egret_advance", "egret_dismiss_popups", "egret_wait_for",
                  "egret_get_tree", "egret_get_node", "egret_hit_test", "egret_status", "egret_set_props")
MINIMAL_TOOLS = ("egret_observe", "egret_act", "egret_screenshot", "egret_get_errors",
                 "egret_extension_status", "egret_install_extension", "egret_reload_extension",
                 "egret_list_tabs", "egret_navigate")
TOOL_PROFILE = (os.environ.get("EGRET_MCP_PROFILE") or "core").strip().lower()


def visible_tools():
    """tools/list 暴露的工具；隐藏的工具仍可被 egret_run_steps 等内部路径调用。"""
    if TOOL_PROFILE == "full":
        return list(TOOLS)
    if TOOL_PROFILE == "minimal":
        return [name for name in TOOLS if name in MINIMAL_TOOLS]
    return [name for name in TOOLS if name not in HIDDEN_IN_CORE]

INSTRUCTIONS = """Egret Agent Inspector：读取并操作浏览器中 Egret 游戏的显示对象，依赖浏览器中的 Egret Agent Inspector 扩展。
- 主循环只有两个工具：egret_observe 拿带编号的动作表 → egret_act 按编号执行并直接拿到执行后的新动作表。点完不要再单独调查询或等待工具，egret_act 已经等过界面稳定和加载过场。
- 用 i 编号时必须把上一次的 marker 传给 egret_act；界面已经变了会返回 stale 和新动作表且不执行，按新表重新决策即可。已确认的连续操作一次给多步 steps。
- 动作表是紧凑文本，一行一个动作：编号 标签 role 状态。标签带 * 是图片字弱标签，整屏都是弱标签时会自动补一次本地 OCR。需要 hash、坐标或完整字段时传 format="json"。
- 返回里的「变化」一行说明上一步把界面改成了什么样，不用自己 diff 两张表。
- 对白与引导用 op=advance 一次推完；弹窗用 op=dismiss；关掉当前这个界面用 op=close（关闭键→返回键→遮罩依次试，并确认它真的没了）；加载过场（mode=transient）用 op=wait。
- 要把一批同类目标挨个打开看一眼，一次 act 就给多组「打开 + op=close」步骤，不要一个来回只点一下。
- 表上出现「页面已重载」时，之前记下的 hash 和编号全部作废，按新表重新定位。
- 动作表标「按住上滑」这类的控件要拖出去松手才生效（例如把卡片拖上场），照常按编号点，act 会自动按住滑出去。
- act 返回里出现「路线」一行，说明这一步和之前走过的路线一样，后面给的就是上次紧接着的步骤；情况一样就照着一次发完，不一样（目标换了、弹窗不同）再按表决策。
- 回合制战斗：点技能后 act 会等到下一回合能操作再返回；同一招要连着出时给 repeat，停下时看它说停在哪（换宠栏、结算、时限）。
- 列表屏上只显示几条。要计数、筛选、挑目标时先用 egret_evaluate 的 $items(hash, it => …) 读全量数据，再用 op=scroll 的 toIndex 滚过去点；不要一屏屏滚着数。读数据可以，调业务方法改状态不行。
- 动作表和 OCR 都定不下来，或要看布局、颜色、半透明遮罩时用 egret_screenshot（回合制战斗里 act 已报回合状态和血量文字，不用截图）；游戏里图片按钮和可交互的非按钮对象（NPC 模型）很多，视觉兜底该用就用。
- 目标不在动作表里（在别的子树、需要语义消歧）用 egret_locate；已知稳定标识用 egret_find。显示对象以 hash 标识，id 是组件在代码/EXML 中绑定的属性名；stageRect 是舞台坐标，screenRect 是页面视口 CSS 像素坐标。
- 操作后界面没有预期变化时用 egret_get_errors 看页面报错；想知道某个控件背后是哪段代码用 egret_inspect_code。
- 页面是 Splan 项目（splan_call probe 返回 MFC: true）时，动手前先读相关技能：通用操作和换技能在 splan-control，打战斗（进 PVE、出招、换精灵、结算）在 splan-battle，照做比自己摸索快。
- 探索开始前先用 egret_notes 查已有笔记，踩坑、确认入口或测出动画耗时后写回。已确认的流程用 egret_run_steps 复跑。
- 首次使用或工具提示扩展未连接时，先调用 egret_extension_status；未连接则按 egret-install-extension skill 安装扩展。
- splan_test_command 仅在用户本轮明确授权且 probe 确认加载 debug.js 时使用。
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
    "qaName": {"type": "string", "description": "QA 定位标识：对象自身的 qaName，或按「宿主短类名__部件名」推导得到，如 SignPanel__btn_sign"},
    "match": {"type": "string", "enum": ["contains", "exact", "regex"], "description": "字符串匹配方式，默认 contains（不区分大小写）"},
    "rootHash": {"type": "integer", "description": "仅在该对象的子树中查找"},
    "visibleOnly": {"type": "boolean", "description": "只匹配在舞台上可见的对象，默认 true"},
    "touchableOnly": {"type": "boolean", "description": "只匹配可接收点击的对象"},
}
FIELDS_PROP = {"type": "array", "items": {"type": "string"},
               "description": "只返回这些字段以节省上下文，如 [\"hash\",\"qaName\",\"text\",\"center\"]；"
                              "可选 hash/className/id/name/qaName/text/source/visible/onStageVisible/touchable/enabled/selected/currentState/center/stageRect/screenRect/path"}
TARGET_PROPS = dict(MATCH_PROPS)
TARGET_PROPS["index"] = {"type": "integer", "description": "按查询条件匹配到多个对象时取第几个，默认 0"}
WAIT_CONDITION_PROPS = dict(MATCH_PROPS,
                            state={"type": "string", "enum": ["visible", "exists", "hidden", "gone", "changed"]},
                            watchProps={"type": "array", "items": {"type": "string"},
                                        "description": "changed 观察的属性，默认 text/selected/currentState/enabled"},
                            interruptOnOverlay={"type": "boolean", "description": "该条件等待时是否允许顶层界面提前中断"},
                            **{"from": {"type": "object", "description": "changed 的已知旧属性；省略时以开始等待时的状态为基线"}})


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
             "newWindow": {"type": "boolean", "description": "在新窗口中打开，新窗口铺右半边、原窗口收到左半边；给了 tabId 就把那个标签页挪进新窗口。"
                           "多个 agent 并行各占一个窗口：同一窗口里不在前台的标签页游戏会停止渲染"},
             "timeoutMs": {"type": "integer", "description": "等待加载完成的超时，默认 30000"}}, ["url"]),
        "navigate", None),
    "egret_status": (
        "获取页面中 Egret 引擎状态：引擎版本、舞台尺寸、canvas 在页面中的位置、显示对象数量等。",
        obj({}), "page", "status"),
    "egret_runtime_stats": (
        "采集轻量运行态指标：Chromium JS heap（可用时）、Egret 显示对象与交互监听数量。"
        "用于同一稳定检查点的多次对比；单次升高不能证明内存泄漏。",
        obj({}), "page", "runtimeStats"),
    "egret_get_tree": (
        "获取显示对象树（从舞台或指定 hash 开始），每个节点包含 hash、className、id、name、text、可见性、坐标。",
        obj({"hash": {"type": "integer", "description": "子树根节点 hash，默认舞台"},
             "depth": {"type": "integer", "description": "展开深度，默认 3"},
             "maxNodes": {"type": "integer", "description": "最多返回节点数，默认 80，硬上限 120"},
             "visibleOnly": {"type": "boolean", "description": "跳过不可见节点，默认 false"},
             "bounds": {"type": "boolean", "description": "是否计算坐标，默认 true"},
             "fields": FIELDS_PROP}),
        "page", "getTree"),
    "egret_find": (
        "按 id / qaName / name / className / text / source / hash 查找显示对象，返回 qaName、路径、可见性、可点击性及舞台/屏幕坐标。",
        obj(dict(MATCH_PROPS, limit={"type": "integer", "description": "最多返回条数，默认 20"},
                 props={"type": "array", "items": {"type": "string"}, "description": "额外读取的属性名，附在每条结果的 props 中"},
                 fields=FIELDS_PROP)),
        "page", "find"),
    "egret_get_node": (
        "获取单个显示对象的详细信息：常用属性、祖先链、直接子节点；props 可额外读取任意属性（如 data、selectedIndex）。",
        obj(dict(TARGET_PROPS, props={"type": "array", "items": {"type": "string"}, "description": "额外读取的属性名"})),
        "page", "getNode"),
    "egret_tap": (
        "点击显示对象（按 hash/查询条件定位其中心，或直接给 stageX/stageY、clientX/clientY）。"
        "method: touch=经 Egret TouchHandler 走真实命中检测（默认），dom=向 canvas 派发鼠标事件，dom-touch=派发触摸事件，event=直接在目标上派发 TouchEvent（忽略遮挡）。"
        "返回实际命中的对象。目标被其他对象遮挡时不执行点击并报错，应先关闭遮挡物（通常是弹窗或全屏遮罩）再重试。",
        obj(dict(TARGET_PROPS,
                 stageX={"type": "number"}, stageY={"type": "number"},
                 clientX={"type": "number", "description": "页面视口坐标（CSS 像素）"}, clientY={"type": "number"},
                 offsetX={"type": "number", "description": "相对目标左上角的舞台坐标偏移，默认中心"},
                 offsetY={"type": "number"},
                 method={"type": "string", "enum": ["touch", "dom", "dom-touch", "event"]},
                 holdMs={"type": "integer", "description": "按下到抬起的间隔，默认 50"},
                 count={"type": "integer", "description": "连续点击次数，默认 1"},
                 details={"type": "boolean", "description": "返回完整 target/hit 详情；默认 false，只返回操作所需字段"},
                 settleMs={"type": "integer", "description": "先等目标位置/透明度稳定这么久再点，用于入场动画期间，如 300"},
                 probe={"type": "boolean", "description": "中心点被遮挡时自动在包围盒内改点未被遮挡的位置，默认 true"},
                 force={"type": "boolean", "description": "被遮挡时仍然点击（点到的是遮挡物），默认 false"})),
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
        "等待显示对象出现、消失或内容变化。state: visible（默认）、exists、hidden、gone、changed；"
        "changed 必须带 hash/id/qaName/text 等目标，禁止无目标泛等；anyOf 可并行等待多个条件；"
        "等待 hidden/gone 时出现可推进的引导或顶层界面会提前返回 interrupted。普通点击建议 timeoutMs 2000-3000。",
        obj(dict(MATCH_PROPS,
                 state=WAIT_CONDITION_PROPS["state"],
                 watchProps=WAIT_CONDITION_PROPS["watchProps"],
                 **{"from": WAIT_CONDITION_PROPS["from"]},
                 anyOf={"type": "array", "items": {"type": "object", "properties": WAIT_CONDITION_PROPS},
                        "description": "候选条件数组，任一满足即返回 conditionIndex"},
                 interruptOnOverlay={"type": "boolean", "description": "检测到新的可交互顶层界面时提前返回；hidden/gone 默认 true"},
                 overlayGraceMs={"type": "integer", "description": "开始检测顶层界面的宽限时间，默认 600"},
                 timeoutMs={"type": "integer", "description": "超时，默认 10000，最大 120000"},
                 intervalMs={"type": "integer", "description": "轮询间隔，默认 200"},
                 stableMs={"type": "integer", "description": "匹配对象的位置、尺寸和透明度保持不变多久才算满足，用于等待打开动画结束，如 300"})),
        "page", "waitFor"),
    "egret_advance": (
        "仅推进当前可点任意处继续的 GuideMask 或 NPC 对话，自动使用这两类界面的 recommendedTarget；"
        "不用于选择普通按钮、地图入口或 NPC。"
        "max 默认 1；批量推进会等文本稳定并保持均匀节奏，遇到选项、面板切换或点击后无变化即停止。"
        "advanced=0 时会返回 stopped/current/hint 解释为何没有点击。",
        obj({"max": {"type": "integer", "description": "最多推进次数，默认 1，硬上限 12"},
             "waitMs": {"type": "integer", "description": "每次点击后等待界面变化，默认 1200，最大 5000"},
             "paceMs": {"type": "integer", "description": "连续两次点击的最小间隔，默认 320，最大 2000"},
             "stableMs": {"type": "integer", "description": "文本停止变化多久才继续，默认 180，最大 1500"},
             "method": {"type": "string", "enum": ["touch", "dom", "dom-touch"]}}),
        "page", "advance"),
    "egret_evaluate": (
        "在页面中执行 JavaScript 表达式，或语句块（需显式 return，支持 await），可用辅助变量：$stage（舞台）、$obj(hash)（按 hash 取对象）、"
        "$find({id,name,className,text,...})（查询对象数组）、$describe(obj)、"
        "$items(列表或 Scroller 的 hash, 可选筛选 it => … 或 {字段: 值}, 可选 {fields, limit})（读列表背后的全量数据，返回 total / matched / rows[{index, 字段…}]）。返回值会被安全序列化。"
        "读数据用来计数、筛选、找目标；不要用它调业务方法或改业务状态来代替界面操作。",
        obj({"expression": {"type": "string"}, "depth": {"type": "integer", "description": "返回值序列化深度，默认 3"}},
            ["expression"]),
        "page", "evaluate"),
    "egret_get_errors": (
        "读取页面运行期收集到的错误：未捕获异常、Promise 拒绝、资源加载失败和 console.error/warn。"
        "用于操作或测试过程中发现潜在缺陷；只包含扩展开始收集之后发生的错误。",
        obj({"sinceTs": {"type": "integer", "description": "只返回该时间戳（毫秒）之后的错误"},
             "types": {"type": "array", "items": {"type": "string"},
                       "description": "按类型过滤：error、unhandledrejection、resource、console.error、console.warn"},
             "limit": {"type": "integer", "description": "最多返回条数，默认 50"},
             "exclude": {"type": "array", "items": {"type": "string"},
                         "description": "折叠已知噪音：消息中包含这些片段的错误不返回，只在 excluded 里计数"},
             "clear": {"type": "boolean", "description": "返回后清空缓冲区"}}),
        "page", "getErrors"),
    "egret_screenshot": (
        "截取标签页当前可见区域（会先激活该标签页）。默认 jpeg 且限宽 900，以免占用过多上下文；"
        "只看某个区域时传 rect（页面视口 CSS 像素，可直接用查询结果里的 screenRect）。",
        obj({"format": {"type": "string", "enum": ["png", "jpeg"]},
             "quality": {"type": "integer", "description": "jpeg 质量 10-100，默认 70"},
             "maxWidth": {"type": "integer", "description": "输出最大宽度，默认 900，0 表示原尺寸"},
             "rect": {"type": "object", "description": "只截这个矩形：{x, y, width, height}，页面视口 CSS 像素"}}),
        "screenshot", None),
    "egret_observe": (
        "高速动作表快照：紧凑文本，一行一个可点的动作（编号 标签 role 状态），外加面板名、页面文案和语义指纹 marker。"
        "和 egret_act 配合构成主循环：看表 → 按编号执行 → 直接拿到新表。"
        "标签带 * 表示文字烘在图片里（弱标签），整屏都是弱标签时会自动补一次本地 OCR。"
        "mode=guide-continue/dialogue-continue 用 egret_act 的 op=advance 推进；mode=transient/blocked 用 op=wait 短等；"
        "mode=modal-backdrop-dismiss 先用表里的 close/confirm，都没有才用 {\"op\":\"recommended\"}。"
        "被遮挡的目标点不了，默认只报数量不列行；需要 hash/坐标做二次定位时传 format=\"json\"。",
        obj({"rootHash": {"type": "integer", "description": "限定在某个面板/容器子树内，默认当前顶层面板"},
             "limit": {"type": "integer", "description": "动作表最多多少行，默认 30（整个舞台进表时 60），硬上限 60；调小只少显示几行，不影响扫描范围"},
             "ocr": {"type": "boolean", "description": "强制或禁止本地 OCR 补标签；默认按需自动"},
             "ocrLimit": {"type": "integer", "description": "最多 OCR 多少个弱标签控件，默认 12，硬上限 20"},
             "occluded": {"type": "boolean", "description": "把被遮挡的条目也列出来，默认 false"},
             "format": {"type": "string", "enum": ["lines", "json"], "description": "默认 lines 紧凑文本；json 带 hash、坐标和完整字段"}}),
        "page", "observe"),
    "egret_act": (
        "按动作表执行并直接返回执行后的新动作表：把点击、等待界面稳定、重新观察合并成一次调用，"
        "加载过场也会在同一次调用里等过去。steps 每项："
        "{\"i\":3} 点动作表编号；{\"hash\"/\"qaName\"/\"id\"/\"name\"/\"text\":...} 直接定位（可加 match:\"exact\"）；"
        "{\"i\":3,\"text\":\"abc\"} 输入文本；{\"op\":\"advance\"} 推进对白/引导；{\"op\":\"dismiss\"} 关弹窗；"
        "回合制界面（出招后整组按钮被锁）点完会在这一次调用里等到下一回合再返回，返回里有「等回合」；"
        "要按同一招连出时给 {\"i\":3,\"repeat\":20}：解锁后立刻再点，遇到换界面、冒出新选项（换宠）、点了不再上锁或次数用完就停；"
        "回合倒计时往往只有几秒，每回合都靠 observe 决策会丢回合；"
        "动作表标「按住上滑」这类的控件要拖出去松手才生效（例如把卡片拖上场），按编号点它会自动按住滑出去；"
        "要自己指定方向时用 {\"op\":\"swipe\",\"i\":3,\"dir\":\"up\"}，dir 为 up/down/left/right；"
        "把一个控件拖到另一个控件上（技能拖进技能栏、卡片拖进格子）用 {\"op\":\"drag\",\"i\":3,\"to\":{\"i\":7}}，"
        "to 也可以是查询条件或 {\"dx\":-200,\"dy\":0}；默认先按住 700ms 再挪，长按才起步的拖动可用 holdMs 调；"
        "{\"op\":\"close\"} 关掉当前顶层面板：一次往返里依次试关闭键、返回键、遮罩，并确认面板真的消失，"
        "回报是哪条路子生效；打开一个界面看完就关的遍历用它，比 dismiss 更适合全屏面板；"
        "{\"op\":\"recommended\"} 点 observe 给出的 recommendedTarget（引导挖洞、只能点遮罩关闭的弹窗）；"
        "{\"op\":\"scroll\",\"i\":3,\"dy\":-200} 滚动列表，{\"op\":\"scroll\",\"hash\":<Scroller>,\"toIndex\":132} 直接滚到第 132 条（先用 $items 读数据找到下标）；{\"op\":\"wait\",\"ms\":800} 或 {\"op\":\"wait\",\"until\":{查询条件}} 等待。"
        "编号只有传了上一次的 marker 且界面没变时才有效：界面已变会原样返回 stale=true 和新动作表，不执行任何点击。"
        "每步可加 expect（查询条件）校验结果，失败即停止并返回当前动作表；加 optional 则该步失败不影响结论。"
        "已确认的连续操作可以一次给多步；各步的 i 都指这张表（同一屏先点 3 再点 4 就写 [{\"i\":3},{\"i\":4}]），要点前面步骤打开的新界面里的东西用查询条件或 op。"
        "返回的新表里「变化」一行直接说明这一步把界面改成了什么样，不用自己 diff 两张表。",
        obj({"steps": {"type": "array", "items": {"type": "object"},
                       "description": "1-10 个步骤，按顺序执行，失败即停止"},
             "marker": {"type": "string", "description": "上一次 observe/act 返回的 marker；用 i 编号时必须传"},
             "rootHash": {"type": "integer", "description": "动作表限定子树，与 egret_observe 一致"},
             "limit": {"type": "integer", "description": "返回动作表最多多少行，默认 30（整个舞台进表时 60）"},
             "method": {"type": "string", "enum": ["touch", "dom", "dom-touch"]},
             "stableMs": {"type": "integer", "description": "界面稳定多久算落定，默认 250"},
             "timeoutMs": {"type": "integer", "description": "每步等待界面变化的上限，默认 3000"},
             "quietMs": {"type": "integer", "description": "一直没变化就提前返回的时间，默认 600"},
             "loadingMs": {"type": "integer", "description": "结束时如果还在加载过场，最多再等多久，默认 6000"},
             "turnMs": {"type": "integer",
                        "description": "点完后整组按钮被锁住（回合制出招、提交后等结果）时最多等多久再返回，默认 15000，一般不用传；回合制战斗里出招、换宠别设成 0，否则不等下一回合就返回，得自己多看几轮"},
             "occluded": {"type": "boolean", "description": "把被遮挡的条目也列出来，默认 false"},
             "format": {"type": "string", "enum": ["lines", "json"], "description": "默认 lines 紧凑文本；json 带 hash、坐标和完整字段"},
             "screenshot": {"type": "boolean", "description": "附带一张压缩截图，默认 false"}}),
        "page", "act"),
    "egret_locate": (
        "按自然语言描述一次定位按钮、入口、列表项或 NPC。综合 id/name/qaName/text/source、子树标签和真实监听器评分，"
        "返回 evidence、labels、role/actionHint 与候选；任务追踪和带主线标记的 NPC 会明确标注。"
        "只有唯一高置信匹配才给 recommendedTarget。ocr=true 时仅在结构化结果仍歧义后，"
        "对候选区域做一次本地快速 OCR 并重新评分，不上传图片。",
        obj({"description": {"type": "string", "description": "目标描述，如“任务面板中的剧情按钮”或“萨帕尼克 NPC"},
             "rootHash": {"type": "integer", "description": "可选，限定在已知面板/容器子树中"},
             "limit": {"type": "integer", "description": "最多返回候选数，默认 8，硬上限 20"},
             "ocr": {"type": "boolean", "description": "结构化定位歧义时启用本地 OCR，默认 false"},
             "ocrLimit": {"type": "integer", "description": "最多 OCR 多少个候选，默认 12，硬上限 20"}}, ["description"]),
        "page", "locate"),
    "egret_dismiss_popups": (
        "连续关闭最上层弹窗：优先点面板内的关闭控件；没有关闭控件时只点击内容区外有真实点击监听的半透明/暗色遮罩，"
        "包括全屏弹窗根节点内部的遮罩。每关一个都确认它确实消失。"
        "until 给出查询条件时匹配到即停止（例如主界面的某个组件）。返回关掉了哪些、卡在哪个。",
        obj({"max": {"type": "integer", "description": "最多关闭几个，默认 6"},
             "until": {"type": "object", "description": "停止条件：{qaName/id/name/text/...} 匹配到可见对象就停"},
             "method": {"type": "string", "enum": ["touch", "dom", "dom-touch"]}}),
        "page", "dismissPopups"),
    "egret_inspect_code": (
        "查看显示对象背后的代码：类名、自身方法、注册的事件监听（含回调函数源码片段）和由父级接管的点击回调。"
        "用返回的函数名或源码片段到项目源码里检索即可定位实现与缺陷位置，比截图猜测快且准确。",
        obj(dict(TARGET_PROPS,
                 maxChars={"type": "integer", "description": "每段函数源码最多返回多少字符，默认 400"},
                 ancestorDepth={"type": "integer", "description": "向上查找接管点击的祖先层数，默认 4"})),
        "page", "inspectCode"),
    "egret_notes": (
        "跨会话的探索笔记（按页面域名分库，存在本机）：记录入口怎么进、可用的定位条件、踩过的坑与解法、"
        "缺陷和对应代码位置、动画耗时等，下次直接查，不必重新摸索。action：search（默认）/add/list/remove。",
        {"type": "object", "properties": {
            "action": {"type": "string", "enum": ["search", "add", "list", "remove"]},
            "q": {"type": "string", "description": "搜索关键词；空格分词，命中任一词并按相关度排序"},
            "kind": {"type": "string", "description": "按类型过滤：route 真实 UI 路线、checkpoint 稳定检查点、shortcut 调试直达、recovery 恢复、entry、locator、pitfall、bug、timing、fact、suggestion"},
            "entries": {"type": "array", "items": {"type": "object"},
                        "description": "add 用：[{kind,key,summary,detail,start,steps,expect,environment,lastVerifiedAt}]；route 的 steps 只记录稳定 UI 定位，不保存 hash"},
            "key": {"type": "string", "description": "remove 用：要删除的 key"},
            "scope": {"type": "string", "description": "笔记库名，默认按当前标签页域名"},
            "limit": {"type": "integer", "description": "最多返回条数，默认 20"}}},
        "notes", None),
    "splan_call": (
        "Splan 项目专属操作，仅当页面存在全局 MFC 对象时可用：probe 探测项目调试接口、listModules 列模块常量、"
        "openModule/closeModule 用模块事件直达界面（比逐级点击稳）、qa 用项目自身 QA 接口查找组件、dispatch 派发任意全局事件。"
        "先 probe 确认可用能力；openModule 会如实回报派发的事件名与载荷，不对时用 event/payload 覆盖。"
        "login 在登录页用 debug.js 的内网免密登录切换账号（account 指定账号，newAccount=true 用 agent+时间戳新号）。",
        obj({"action": {"type": "string", "enum": ["probe", "listModules", "openModule", "closeModule", "qa", "dispatch", "login"]},
             "account": {"type": "string", "description": "login 的账号；不传就是这个标签页上次切换的账号"},
             "newAccount": {"type": "boolean", "description": "login 用 agent+秒级时间戳的新号（服务端自动建号）"},
             "module": {"type": "string", "description": "模块常量名或 id"},
             "filter": {"type": "string", "description": "listModules 的名称过滤"},
             "qaName": {"type": "string"},
             "event": {"type": "string", "description": "覆盖默认事件名"},
             "payload": {"description": "覆盖默认事件载荷"},
             "waitMs": {"type": "integer", "description": "派发后等待界面变化的毫秒数，默认 2500"},
             "limit": {"type": "integer"}}),
        "page", "splan"),
    "splan_test_command": (
        "执行 Splan debug.js 提供的账号测试命令（如 addItem/addCoin/addEnergy）。仅当用户在当前任务明确授权，且页面确认加载 config/debug.js 时可用；会修改账号数据。",
        obj({"subCmd": {"type": "string", "description": "cs_test_cmd.subCmd"},
             "value1": {"description": "测试命令参数 1"},
             "value2": {"description": "测试命令参数 2"},
             "timeoutMs": {"type": "integer", "description": "等待服务端响应，默认 10000，最大 30000"},
             "authorized": {"type": "boolean", "description": "仅用户本轮明确允许测试命令时传 true"}},
            ["subCmd", "authorized"]),
        "page", "splanTestCommand"),
    "egret_extension_status": (
        "检查浏览器扩展是否已连接：返回已连接的浏览器、扩展版本及是否需要更新（outdated）；未连接时附带本机浏览器、默认浏览器和扩展加载情况（local）。首次使用前调用。",
        {"type": "object", "properties": {"waitSeconds": {"type": "number", "description": "未连接时等待扩展连接的秒数，默认 8"}}},
        "extensionStatus", None),
    "egret_reopen_browser": (
        "浏览器闪退或已关闭时，用本机已安装的 Chromium 浏览器重新打开原 http(s) 页面；随后用 egret_extension_status 等扩展重连。",
        {"type": "object", "properties": {
            "url": {"type": "string", "description": "要恢复的完整 http(s) URL"},
            "browser": {"type": "string", "enum": ["default", "chrome", "edge", "brave"], "description": "目标浏览器"}},
         "required": ["url"]},
        "reopenBrowser", None),
    "egret_install_extension": (
        "把插件自带的扩展复制到固定安装目录，并打开浏览器扩展管理页、复制目录路径到剪贴板。"
        "返回 ok=false 时安装失败；ok=true 时把 nextSteps 转告用户完成“加载已解压的扩展程序”。扩展已加载时只更新文件，随后调用 egret_reload_extension。",
        {"type": "object", "properties": {
            "browser": {"type": "string", "enum": ["default", "chrome", "edge", "brave"], "description": "目标浏览器，默认用户的默认浏览器"},
            "openPage": {"type": "boolean", "description": "是否打开扩展管理页，默认 true"}}},
        "installExtension", None),
    "egret_reload_extension": (
        "让已连接的扩展从磁盘重新加载（更新扩展文件后使用），随后等待其重新连接。",
        {"type": "object", "properties": {}},
        "reloadExtension", None),
    "egret_run_steps": (
        "按顺序批量执行 E2E 步骤并汇总结果，默认遇到失败即停止并附失败截图。steps 每项为 {action, ...参数}，"
        "action 取 navigate/tap/drag/advance/setProps/waitFor/assert/evaluate/sleep/screenshot/dismissPopups/scene/openModule/closeModule，"
        "其余参数与对应 egret_* 工具相同；步骤可加 optional（失败不影响结论）和 retry（失败重试次数）；"
        "waitFor 未满足即失败；assert 用查询条件定位对象并校验 expect：{exists, visible, count, text, textContains, props:{属性:值}}。"
        "也可用 file 传入 JSON 用例文件的绝对路径（格式 {name, steps}）。连续对白 tap 会被拒绝，必须用 advance。",
        obj({"steps": {"type": "array", "items": {"type": "object"}},
             "file": {"type": "string", "description": "JSON 用例文件绝对路径，与 steps 二选一"},
             "name": {"type": "string", "description": "用例名称"},
             "stopOnFailure": {"type": "boolean", "description": "失败后停止，默认 true"},
             "screenshotOnFailure": {"type": "boolean", "description": "失败时截图，默认 true"}}),
        "runSteps", None),
}

STEP_ACTIONS = {
    "navigate": "egret_navigate", "tap": "egret_tap", "drag": "egret_drag", "setProps": "egret_set_props",
    "advance": "egret_advance", "waitFor": "egret_wait_for", "evaluate": "egret_evaluate", "screenshot": "egret_screenshot",
    "dismissPopups": "egret_dismiss_popups", "scene": "egret_observe",
    "observe": "egret_observe", "act": "egret_act",
}
QUERY_KEYS = ("hash", "id", "name", "className", "text", "source", "qaName", "match", "rootHash", "index")


# ---------------------------------------------------------------- 探索笔记（跨会话记忆）

NOTES_ROOT = os.environ.get("EGRET_NOTES_DIR") or os.path.join(os.path.expanduser("~"), ".egret-agent-inspector", "notes")
NOTE_FIELDS = ("kind", "key", "summary", "detail", "start", "steps", "expect", "environment", "lastVerifiedAt")


def notes_file(scope):
    safe = "".join(c if c.isalnum() or c in "._-" else "_" for c in (scope or "default"))[:60] or "default"
    return os.path.join(NOTES_ROOT, safe + ".jsonl")


def read_notes(path):
    items = []
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        items.append(json.loads(line))
                    except ValueError:
                        pass
    except OSError:
        pass
    return items


def write_notes(path, items):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        for it in items:
            f.write(json.dumps(it, ensure_ascii=False) + "\n")


def validate_route_steps(steps):
    forbidden_actions = {"openModule", "closeModule", "dispatch", "evaluate", "setProps", "testCommand", "login"}

    def walk(value):
        if isinstance(value, dict):
            if "hash" in value or "rootHash" in value:
                raise ValueError("route.steps 不得保存临时 hash")
            if value.get("action") in forbidden_actions or any(key in forbidden_actions for key in value):
                raise ValueError("route.steps 只能记录真实 UI 操作")
            for child in value.values():
                walk(child)
        elif isinstance(value, list):
            for child in value:
                walk(child)

    walk(steps)


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
        self.last_seen = time.time()
        self.pong = None
        self.tabs = None

    async def alive(self, timeout=2.0):
        """确认连接对端仍在工作：扩展重载后旧 service worker 的连接可能仍然打开但不再应答。"""
        if self.closed:
            return False
        if time.time() - self.last_seen < 2.0:
            return True
        self.pong = asyncio.get_running_loop().create_future()
        try:
            await self.send_text('{"type":"ping"}')
            await asyncio.wait_for(self.pong, timeout)
            return True
        except Exception:  # noqa: BLE001
            return False
        finally:
            self.pong = None

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
        self.last_seen = time.time()
        try:
            msg = json.loads(text)
        except ValueError:
            return
        if msg.get("type") == "pong":
            if self.pong and not self.pong.done():
                self.pong.set_result(True)
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
        self.preferred = None
        self.started = time.time()
        self.port = None
        self.changed = asyncio.Event()

    @property
    def active(self):
        # 收到 hello 之后才算可用，保证状态中带有扩展版本等信息
        live = self.live()
        if self.preferred in live:
            return self.preferred
        return live[-1] if live else None

    def live(self):
        return [c for c in self.connections if c.ready and not c.closed]

    async def tabs_of(self, conn, params=None, timeout=5):
        tabs = await conn.request("listTabs", params or {"probe": False}, timeout)
        tabs = tabs if isinstance(tabs, list) else []
        conn.tabs = {t.get("tabId") for t in tabs if isinstance(t, dict)}
        return tabs

    async def owner_of(self, tab_id, refresh):
        for c in self.live():
            if refresh(c):
                try:
                    await self.tabs_of(c)
                except Exception:  # noqa: BLE001
                    continue
        return next((c for c in self.live() if c.tabs and tab_id in c.tabs), None)

    async def route(self, method, params, timeout):
        """好几个浏览器都装了扩展（比如 Chrome 和一个专给 agent 用的 Edge）时，每个都连上来，
        谁后连谁就成了 active。按 tabId 找到持有这个标签页的那个连接，listTabs 把各家的标签页合起来。"""
        live = self.live()
        if method == "listTabs":
            if len(live) < 2:
                return None
            merged = []
            for c in live:
                try:
                    merged.extend(await self.tabs_of(c, params, timeout))
                except Exception:  # noqa: BLE001
                    continue
            return {"merged": merged}
        tab_id = params.get("tabId") if isinstance(params, dict) else None
        if tab_id is None or not live:
            return None
        try:
            tab_id = int(tab_id)
        except (TypeError, ValueError):
            return None
        owner = next((c for c in live if c.tabs and tab_id in c.tabs), None)
        if owner is None:
            owner = await self.owner_of(tab_id, lambda c: True)
        # 刚启动时别的浏览器可能还没连上来（扩展对备用端口的重连会退避到 30 秒）：等一会儿新连接
        deadline = self.started + 45
        while owner is None and time.time() < deadline and any(c.tabs for c in self.live()):
            self.changed.clear()
            try:
                await asyncio.wait_for(self.changed.wait(), max(0.1, min(2.0, deadline - time.time())))
            except asyncio.TimeoutError:
                pass
            owner = await self.owner_of(tab_id, lambda c: c.tabs is None)
        if owner is not None:
            # 没带 tabId 的后续请求（自动选标签页、新开窗口）也跟着这个浏览器走
            self.preferred = owner
        return {"conn": owner} if owner is not None else None

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
        if not await conn.alive():
            # 多见于刚重载扩展：旧连接还在但已不再应答，丢弃它并等待新连接，避免干等到超时
            conn.close()
            self.connections = [c for c in self.connections if c is not conn]
            conn = self.active or await self.wait_connected(min(CONNECT_WAIT, 10))
            if conn is None:
                raise RuntimeError("与浏览器扩展的连接已失效，且没有新的连接接入；请重试或确认浏览器仍在运行。")
        routed = await self.route(method, params, timeout)
        if routed and "merged" in routed:
            return routed["merged"]
        if routed and routed.get("conn") is not None:
            conn = routed["conn"]
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
        self.scope = None
        # hash -> 识别出的文字（空串表示认过但没认出来），只在本进程内复用
        self.ocr_cache = {}
        # tabId -> 页面代理的 bootId，用来发现页面重载
        self.page_boots = {}
        # tabId -> 执行过的步骤流水，用来发现「同一段路线第二次出现」
        self.routes = {}
        # tabId -> 路线行摆出来之后 agent 照没照走，用来在自由探索时收起它
        self.route_gates = {}

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
                exposed = visible_tools()
                await self.reply(req_id, {"tools": [
                    {"name": name, "description": TOOLS[name][0], "inputSchema": TOOLS[name][1]}
                    for name in exposed
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
        # 必填参数写错名字（evaluate 传成 text）时页面拿到 undefined，悄悄返回 null，agent 以为接口不能用
        missing = [k for k in TOOLS[name][1].get("required") or [] if args.get(k) in (None, "")]
        if missing:
            return {"isError": True, "content": [{"type": "text", "text": "缺少必填参数 %s（收到的参数：%s）" % (
                "、".join(missing), "、".join(sorted(args)) or "无")}]}
        try:
            if name == "egret_run_steps":
                report, image = await self.run_steps(args)
                content = [{"type": "text", "text": json.dumps(report, ensure_ascii=False)}]
                if image:
                    content.append({"type": "image", "data": image["data"], "mimeType": image["mimeType"]})
                return {"isError": not report["passed"], "content": content}
            res = await self.invoke(name, args)
            if name == "egret_locate" and args.get("ocr") and res.get("ambiguous"):
                res = await self.enrich_locate_with_ocr(args, res)
            if name in ("egret_observe", "egret_act"):
                self.note_page_boot(args, res)
                if name == "egret_act":
                    self.note_route(args, res)
                # 整屏都是图片字按钮时自动补一次本地 OCR：让模型专门花一轮决定「要不要 OCR」不划算
                if args.get("ocr") or (args.get("ocr") is None and res.get("needOcr")):
                    res = await self.enrich_table_with_ocr(args, res, reuse=args.get("ocr") is None)
                for action in res.get("actions") or []:
                    action.pop("screenRect", None)
                # 只在 observe 里指路：agent 往往卡住以后才想起读技能；act 每步都带就成了重复噪音
                if res.pop("project", None) == "splan" and name == "egret_observe":
                    res["skillHint"] = SPLAN_SKILL_HINT
                    panel = res.get("panel") or {}
                    if "NewLogin" in "%s %s" % (panel.get("className") or "", panel.get("name") or ""):
                        res["skillHint"] += "；登录页换号、用新号跑新手见 splan-login"
                for key in ("devicePixelRatio", "viewportSize", "captureSize", "needOcr", "bootId", "topKey"):
                    res.pop(key, None)
                if args.get("format") == "json":
                    body = json.dumps(res, ensure_ascii=False)
                else:
                    body = render_action_table(res)
                if args.get("screenshot"):
                    shot = await self.invoke("egret_screenshot", {"tabId": args.get("tabId"), "maxWidth": 900})
                    return {"content": [
                        {"type": "text", "text": body},
                        {"type": "image", "data": shot["data"], "mimeType": shot["mimeType"]},
                    ]}
                return {"content": [{"type": "text", "text": body}]}
            if name == "egret_screenshot":
                note = {"tabId": res.get("tabId")}
                if res.get("warnings"):
                    note["warnings"] = res["warnings"]
                return {"content": [
                    {"type": "image", "data": res["data"], "mimeType": res["mimeType"]},
                    {"type": "text", "text": json.dumps(note, ensure_ascii=False)},
                ]}
            return {"content": [{"type": "text", "text": json.dumps(res, ensure_ascii=False)}]}
        except Exception as e:  # noqa: BLE001
            return {"isError": True, "content": [{"type": "text", "text": str(e)}]}

    def note_page_boot(self, args, table):
        """页面重载后，上一轮的 i 编号和 hash 全部作废，但报错只会说「找不到对象」。

        页面代理每次注入换一个 bootId，这里按标签页记住它：一变就在动作表上明说，
        省得 agent 拿着旧 hash 反复试。
        """
        boot = table.get("bootId")
        if not boot:
            return
        key = table.get("tabId", args.get("tabId"))
        previous = self.page_boots.get(key)
        self.page_boots[key] = boot
        if previous and previous != boot:
            table["reloaded"] = True

    def note_route(self, args, table):
        """同一段路线第二次出现时，把上次紧接着的几步拼成一次就能发完的 steps。

        升级第二只精灵、打第二关时，路线和第一次一模一样，模型却仍要每一步看表、想一轮。
        这里按标签页记下每一步「从哪个面板出发、落到哪个面板、点了什么（稳定选择器）」，
        当前这一步在同一个面板上出现过，就把上次它后面的几步摆出来。摆之前去掉三类不能照发的：
        失败的步骤、每轮都不一样的步骤（选哪只精灵）、点开又原路关掉的弯路（误点「经验返还」再关掉）。
        """
        tab = table.get("tabId", args.get("tabId"))
        log = self.routes.setdefault(tab, [])
        start = len(log)
        sent = args.get("steps") or [args]
        recs = (table.get("executed") or [])[:len(sent)]
        for k, (step, rec) in enumerate(zip(sent, recs)):
            replay, key, loose = route_step(step, rec)
            target = rec.get("target") or {}
            # agent 自己垫的干等、什么都没推进的 advance：act 本来就会等，照发只是把空转也复制一遍（战斗里曾经每回合都推荐「wait → advance → wait」）
            filler = (rec.get("op") == "wait" and not (isinstance(step, dict) and step.get("until"))) or \
                (rec.get("op") == "advance" and (rec.get("result") or {}).get("advanced") == 0)
            log.append({
                "from": rec.get("from"),
                "to": recs[k + 1].get("from") if k + 1 < len(recs) else table.get("topKey"),
                "key": key, "loose": loose, "step": replay,
                # 空转和失败一样：不回放，也不拿来认「又走到这一步了」
                "failed": bool(rec.get("error") or rec.get("skipped")) or filler,
                "closing": rec.get("op") in ("close", "dismiss", "recommended") or target.get("role") in ("close", "back"),
                # 落回了主场景（没有模态面板，整个舞台进表）：接下来去哪是新的决定
                "hub": k == len(recs) - 1 and table.get("scope") == "stage",
                "label": short_label(target.get("label")) or rec.get("op")})
        del log[:-300]
        start = min(start, len(log))
        done = [e for e in log[start:] if e["key"] and not e["failed"]]
        # 自由探索时反复进出同一个界面也会凑出「路线」，但每次想做的都不一样，摆出来只是多读一行、还可能把人带回老路。
        # 摆出来连着两次都没照走就先收起；收起后仍在后台比对，agent 自己连着两步走得和上次一样，说明又在重复了，再摆出来
        gate = self.route_gates.setdefault(tab, {"misses": 0, "hits": 0})
        # 一步都没执行（marker 过期被拒）不算没照走
        offered = gate.pop("offered", None) if log[start:] else None
        if offered:
            took = bool(done) and done[0]["key"] == offered
            if gate.pop("shown", False):
                gate["misses"] = 0 if took else gate["misses"] + 1
            else:
                gate["hits"] = gate["hits"] + 1 if took else 0
                if gate["hits"] >= 2:
                    gate["misses"] = gate["hits"] = 0
        if not done:
            return
        last = done[-1]
        for j in range(start - 1, -1, -1):
            if log[j]["loose"] == last["loose"] and log[j]["from"] == last["from"] and not log[j]["failed"]:
                break
        else:
            return
        # 回到主场景就是一段路线的终点：登录后关完同一串弹窗，上次接着去打了 PVE，这次未必（探索验收里就被推荐了上个任务的路线）
        if last["hub"] or log[j]["hub"]:
            return
        # 同一个面板上的同一类操作出现过不同的具体目标：这一步每轮都不一样，只能由 agent 自己挑
        variants = {}
        for e in log:
            if e["key"] and not e["failed"]:
                variants.setdefault((e["from"], e["loose"]), set()).add(e["key"])
        follow = []
        for e in log[j + 1:j + 25]:
            if e["failed"]:
                continue
            if not e["step"] or (e["loose"] == last["loose"] and e["from"] == last["from"]):
                break
            if len(variants.get((e["from"], e["loose"]), ())) > 1:
                break
            if e["closing"]:
                # 从某个面板点出去、又关回到那个面板：中间这段是弯路，整段不要
                back = [k for k, f in enumerate(follow) if f["from"] == e["to"] and f["to"] != e["to"]]
                if back:
                    del follow[back[-1]:]
                    continue
            follow.append(e)
            if len(follow) >= 8 or e["hub"]:
                break
        # 上次接下来那一步是在现在这个面板上做的，才算走在同一条路上
        if len(follow) >= 2 and follow[0]["from"] == table.get("topKey"):
            gate["offered"] = follow[0]["key"]
            if gate["misses"] < 2:
                gate["shown"] = True
                table["route"] = {"labels": [e["label"] for e in follow], "steps": [e["step"] for e in follow]}

    async def enrich_table_with_ocr(self, args, table, reuse=False):
        """动作表里图片字按钮的标签是 qaName/资源名；一次截图批量 OCR 把真实文案补上。

        自动触发时按 hash 复用上次的识别结果：同一个按钮的图片字不会变，
        否则每次 observe 都要多花一次截图和半秒 OCR。显式传 ocr=true 则强制重认。
        """
        weak = set(WEAK_LABEL_SOURCES)
        limit = min(max(int(args.get("ocrLimit", 12)), 1), 20)
        cached = 0
        if reuse:
            known = {}
            for action in table.get("actions") or []:
                hit = self.ocr_cache.get(str(action.get("hash")))
                if hit:
                    known[str(action["hash"])] = hit
            cached = apply_ocr_labels(table, known) if known else 0
        # 关闭 / 返回键多是 × 或箭头图标，OCR 只会认出「行 证」这类乱码，结构化标签反而更准
        candidates = [a for a in (table.get("actions") or [])
                      if a.get("from") in weak and not a.get("occluded") and a.get("screenRect")
                      and a.get("role") not in ("close", "back")
                      and not (reuse and str(a.get("hash")) in self.ocr_cache)][:limit]
        if not candidates:
            # 认过没认出字的也会进缓存；这时说「没有弱标签」会误导人去怀疑动作表
            missed = any(a.get("from") in weak and self.ocr_cache.get(str(a.get("hash"))) == ""
                         for a in (table.get("actions") or []))
            table["ocr"] = {"available": True, "filled": cached,
                            "skipped": "cached" if cached else "cached-miss" if missed else "no-weak-labels"}
            return table
        try:
            shot = await self.invoke("egret_screenshot", {"tabId": args.get("tabId"), "format": "png", "maxWidth": 1600})
            capture = table.get("captureSize") or table.get("viewportSize") or {}
            width = float(capture.get("width") or 0)
            if not width:
                width = float(shot.get("width") or 0) / float(table.get("devicePixelRatio") or 1)
            ratio = float(shot.get("width") or 0) / width if width else 1
            loop = asyncio.get_running_loop()
            ocr = await loop.run_in_executor(None, run_fast_ocr, shot["data"], candidates, ratio)
        except Exception as e:  # noqa: BLE001
            table["ocr"] = {"available": False, "error": str(e)}
            return table
        texts = ocr.pop("texts", None) or {}
        # 认出来的和没认出来的都记下来，避免同一屏反复截图重认
        for action in candidates:
            key = str(action.get("hash"))
            if len(self.ocr_cache) < 800:
                self.ocr_cache[key] = texts.get(key, "")
        ocr["filled"] = apply_ocr_labels(table, texts) + cached
        if shot.get("warnings"):
            ocr["warnings"] = shot["warnings"]
        table["ocr"] = ocr
        return table

    async def enrich_locate_with_ocr(self, args, initial):
        """结构化定位歧义时，在一次 MCP 调用内截图、批量 OCR、重新语义评分。"""
        candidates = initial.get("candidates") or []
        ocr_limit = min(max(int(args.get("ocrLimit", 12)), 1), 20)
        try:
            shot = await self.invoke("egret_screenshot", {"tabId": args.get("tabId"), "format": "png", "maxWidth": 1600})
            viewport = initial.get("captureSize") or initial.get("viewportSize") or {}
            viewport_width = float(viewport.get("width") or 0)
            viewport_height = float(viewport.get("height") or 0)
            if not viewport_width or not viewport_height:
                fallback_ratio = float(initial.get("devicePixelRatio") or 1)
                viewport_width = float(shot.get("width") or 0) / fallback_ratio
                viewport_height = float(shot.get("height") or 0) / fallback_ratio
            ratio = float(shot.get("width") or 0) / viewport_width if viewport_width else 1
            candidates = [c for c in candidates if c.get("screenRect") and not c.get("occluded") and
                          0 < float(c["screenRect"].get("width") or 0) <= viewport_width * 0.8 and
                          0 < float(c["screenRect"].get("height") or 0) <= viewport_height * 0.5 and
                          float(c["screenRect"].get("x") or 0) < viewport_width and
                          float(c["screenRect"].get("y") or 0) < viewport_height and
                          float(c["screenRect"].get("x") or 0) + float(c["screenRect"].get("width") or 0) > 0 and
                          float(c["screenRect"].get("y") or 0) + float(c["screenRect"].get("height") or 0) > 0][:ocr_limit]
            if not candidates:
                initial["ocr"] = {"available": True, "skipped": "no-visible-candidates"}
                return initial
            loop = asyncio.get_running_loop()
            ocr = await loop.run_in_executor(None, run_fast_ocr, shot["data"], candidates,
                                             ratio)
        except Exception as e:  # noqa: BLE001
            initial["ocr"] = {"available": False, "error": str(e)}
            return initial
        texts = ocr.get("texts") or {}
        if not texts:
            initial["ocr"] = ocr
            return initial
        refine_args = dict(args)
        refine_args.pop("ocr", None)
        refine_args.pop("ocrLimit", None)
        refine_args["ocrByHash"] = texts
        refined = await self.invoke("egret_locate", refine_args)
        refined["ocr"] = ocr
        if shot.get("warnings"):
            refined["ocr"]["warnings"] = shot["warnings"]
            refined["ambiguous"] = True
            refined["recommendedTarget"] = None
            refined["reason"] = "当前截图状态被扩展明确标记为不可用，OCR 只返回文字参考；恢复窗口后重试才能用于点击消歧"
        return refined

    async def invoke(self, name, args):
        """执行单个工具，返回结果对象；失败时抛出异常。"""
        _, _, bridge_method, page_method = TOOLS[name]
        timeout = REQUEST_TIMEOUT
        args = dict(args)
        try:
            if bridge_method == "notes":
                return await self.notes(args)
            if bridge_method == "screenshot" and isinstance(args.get("rect"), dict) and not args["rect"].get("dpr"):
                # rect 用的是 CSS 像素，截图是物理像素，需要页面的 devicePixelRatio 换算
                try:
                    st = await self.invoke("egret_status", {"tabId": args.get("tabId")} if args.get("tabId") else {})
                    args["rect"] = dict(args["rect"], dpr=st.get("devicePixelRatio") or 1)
                except Exception:  # noqa: BLE001
                    args["rect"] = dict(args["rect"], dpr=1)
            if bridge_method == "extensionStatus":
                return await self.extension_status(float(args.get("waitSeconds", 8)))
            if bridge_method == "installExtension":
                loop = asyncio.get_running_loop()
                return await loop.run_in_executor(None, browser_extension.install,
                                                  args.get("browser", "default"), args.get("openPage", True) is not False)
            if bridge_method == "reopenBrowser":
                loop = asyncio.get_running_loop()
                return await loop.run_in_executor(None, browser_extension.open_url,
                                                  args.get("browser", "default"), args["url"])
            if bridge_method == "reloadExtension":
                res = await self.bridge.request("reloadExtension", {}, timeout)
                await asyncio.sleep(1)
                status = await self.extension_status(15)
                status["reloadedFrom"] = res.get("extensionVersion")
                return status
            if bridge_method == "page":
                tab_id = args.pop("tabId", None)
                if page_method == "getTree":
                    args["depth"] = min(max(int(args.get("depth", 3)), 0), 8)
                    args["maxNodes"] = min(max(int(args.get("maxNodes", 80)), 1), 120)
                elif page_method == "find":
                    args["limit"] = min(max(int(args.get("limit", 20)), 1), 50)
                elif page_method in ("observe", "act"):
                    # 没指定时交给页面：面板 30 行，整个舞台进表（主城 HUD + 地图）时给到 60 行
                    if args.get("limit") is not None:
                        args["limit"] = min(max(int(args["limit"]), 1), 60)
                    args.pop("screenshot", None)
                    args.pop("ocr", None)
                    args.pop("ocrLimit", None)
                    args.pop("format", None)
                    # 渲染和 OCR 都在 server 侧做，页面一律返回完整字段
                    args["detail"] = True
                    args["rects"] = True
                elif page_method == "locate":
                    requested = int(args.get("limit", 8))
                    if args.get("ocr"):
                        requested = max(requested, int(args.get("ocrLimit", 12)))
                    args["limit"] = min(max(requested, 1), 20)
                elif page_method == "advance":
                    args["max"] = min(max(int(args.get("max", 1)), 1), 12)
                    args["waitMs"] = min(max(int(args.get("waitMs", 1200)), 100), 5000)
                    args["paceMs"] = min(max(int(args.get("paceMs", 320)), 0), 2000)
                    args["stableMs"] = min(max(int(args.get("stableMs", 180)), 0), 1500)
                elif page_method == "splan" and args.get("action") == "listModules":
                    args["limit"] = min(max(int(args.get("limit", 60)), 1), 200)
                if page_method == "waitFor":
                    args["timeoutMs"] = min(int(args.get("timeoutMs", 10000)), 120000)
                    timeout = args["timeoutMs"] / 1000.0 + 15
                if page_method in ("tap", "drag", "advance", "act", "dismissPopups", "splan", "splanTestCommand"):
                    # 这些方法内部会等界面变化（动画、弹窗消失、模块 js 加载），比普通查询慢得多
                    timeout = REQUEST_TIMEOUT + 30
                if page_method == "act":
                    # 页面侧留出收尾（等加载过场、扫表）的余量，连出、等回合到点就先返回，不让整次调用超时白跑
                    args["budgetMs"] = int(max(timeout - 15, 10) * 1000)
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

    async def notes_scope(self):
        """笔记按游戏域名分库：同一个游戏的经验才有复用价值。"""
        if self.scope:
            return self.scope
        try:
            res = await self.bridge.request("listTabs", {"probe": False}, 5)
            tabs = res.get("tabs") if isinstance(res, dict) else res
            tab = next((t for t in tabs if t.get("lastUsed")), None) or next((t for t in tabs if t.get("active")), None)
            host = (tab or {}).get("url", "").split("//", 1)[-1].split("/", 1)[0].split(":")[0]
            if host:
                self.scope = host
        except Exception:  # noqa: BLE001
            pass
        return self.scope

    async def notes(self, args):
        action = args.get("action", "search")
        scope = args.get("scope") or await self.notes_scope()
        limit = int(args.get("limit", 20))
        if action in ("search", "list") and not scope:
            # 还不知道当前是哪个游戏时，把所有笔记库一起翻一遍，总比什么都查不到强
            paths = [os.path.join(NOTES_ROOT, n) for n in sorted(os.listdir(NOTES_ROOT))] if os.path.isdir(NOTES_ROOT) else []
        else:
            paths = [notes_file(scope or "default")]
        items = [it for path in paths for it in read_notes(path)]
        if action in ("search", "list"):
            q = (args.get("q") or "").lower()
            kind = args.get("kind")
            terms = [term for term in re.split(r"\s+", q) if term]
            scored = []
            for item in items:
                if kind and item.get("kind") != kind:
                    continue
                text = json.dumps(item, ensure_ascii=False).lower()
                score = sum(1 for term in terms if term in text)
                if terms and not score:
                    continue
                scored.append((score, item))
            scored.sort(key=lambda pair: (pair[0], pair[1].get("updated", 0)), reverse=True)
            hits = [item for _, item in scored]
            return {"scope": scope, "total": len(hits), "notes": [{k: v for k, v in it.items() if k in NOTE_FIELDS}
                                                                   for it in hits[:limit]]}
        path = notes_file(scope or "default")
        items = read_notes(path)
        if action == "add":
            entries = args.get("entries") or []
            if not entries:
                raise ValueError("add 需要提供 entries")
            now = int(time.time())
            for e in entries:
                if not e.get("summary"):
                    raise ValueError("每条笔记都需要 summary")
                key = e.get("key") or e["summary"][:40]
                item = {"kind": e.get("kind", "fact"), "key": key, "summary": e["summary"], "updated": now}
                for field in NOTE_FIELDS:
                    if field not in ("kind", "key", "summary") and e.get(field) is not None:
                        value = e[field]
                        if field == "steps" and (not isinstance(value, list) or len(value) > 30):
                            raise ValueError("route.steps 必须是最多 30 项的数组")
                        if field == "steps" and item["kind"] == "route":
                            validate_route_steps(value)
                        if len(json.dumps(value, ensure_ascii=False)) > 8000:
                            raise ValueError("笔记字段过长：%s" % field)
                        item[field] = value
                # 同一个 key 直接覆盖：笔记要越记越准，不是越记越多
                items = [it for it in items if it.get("key") != key or it.get("kind") != item["kind"]]
                items.append(item)
            write_notes(path, items)
            return {"scope": scope, "added": len(entries), "total": len(items)}
        if action == "remove":
            key = args.get("key")
            kept = [it for it in items if it.get("key") != key]
            write_notes(path, kept)
            return {"scope": scope, "removed": len(items) - len(kept), "total": len(kept)}
        raise ValueError("未知的 action：%s" % action)

    async def extension_status(self, wait):
        status = {"port": self.bridge.port, "bridgeAvailable": self.bridge.port is not None,
                  "bundledVersion": SERVER_VERSION, "installDir": browser_extension.install_dir()}
        if self.bridge.port is None:
            status.update(connected=False, error="bridge_port_unavailable",
                          hint="MCP bridge 端口 %d-%d 均被占用；关闭不再使用的 Codex 会话后重试，安装扩展无法解决此问题。"
                               % (BASE_PORT, BASE_PORT + PORT_COUNT - 1))
            try:
                status["local"] = await asyncio.get_running_loop().run_in_executor(None, browser_extension.status)
            except Exception as e:  # noqa: BLE001
                status["local"] = {"error": str(e)}
            return status
        conn = await self.bridge.wait_connected(wait)
        if conn is None:
            status.update(connected=False, hint="扩展未连接：浏览器未打开，或尚未安装扩展（使用 egret_install_extension 安装）")
            try:
                status["local"] = await asyncio.get_running_loop().run_in_executor(None, browser_extension.status)
            except Exception as e:  # noqa: BLE001
                status["local"] = {"error": str(e)}
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
        dialogue_taps = 0
        for step in steps:
            target = " ".join(str(step.get(key, "")) for key in ("qaName", "id", "name"))
            if step.get("action") == "tap" and re.search(
                    r"dialogue.*(?:talk_txt|bg)|(?:talk_txt|dialogue_text)", target, re.I):
                dialogue_taps += 1
                if dialogue_taps >= 3:
                    raise ValueError(
                        "连续对白不能用重复 tap 步骤；改用 "
                        "{\"action\":\"advance\",\"max\":6,\"paceMs\":320,\"stableMs\":180}")
            else:
                dialogue_taps = 0
        tab_id = args.get("tabId")
        stop = args.get("stopOnFailure", True)
        results, image = [], None
        started = time.time()
        base = {"tabId": tab_id} if tab_id is not None else {}
        # 记录运行前的时间基准，运行结束后只取这期间新产生的页面错误
        try:
            since_ts = (await self.invoke("egret_get_errors", dict(base, limit=0)))["now"]
        except Exception:  # noqa: BLE001
            since_ts = None
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
            attempts = max(1, int(step.pop("retry", 0)) + 1)
            optional = bool(step.pop("optional", False))
            for attempt in range(attempts):
                try:
                    item["result"] = await self.run_step(action, step)
                    item["ok"] = True
                    break
                except Exception as e:  # noqa: BLE001
                    item.update(ok=False, error=str(e))
                    if attempt + 1 < attempts:
                        await asyncio.sleep(0.5)
            if attempts > 1:
                item["attempts"] = attempts
            if not item["ok"] and optional:
                # optional 步骤失败不影响用例结论：用于「可能出现也可能不出现」的弹窗之类
                item.update(ok=True, skipped=True)
            item["ms"] = int((time.time() - t0) * 1000)
            results.append(item)
            if item.get("skipped"):
                continue
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
                  "skipped": [r["index"] for r in results if r.get("skipped")],
                  "durationMs": int((time.time() - started) * 1000), "steps": results}
        if since_ts is not None:
            try:
                errors = await self.invoke("egret_get_errors", dict(base, sinceTs=since_ts, limit=20))
                # 页面报错不直接判定用例失败，但必须报出来供排查
                if errors.get("errors"):
                    report["pageErrors"] = errors["errors"]
            except Exception:  # noqa: BLE001
                pass
        return report, image

    async def run_step(self, action, step):
        if action == "sleep":
            await asyncio.sleep(min(float(step.get("ms", 500)), 60000) / 1000.0)
            return {"slept": step.get("ms", 500)}
        if action == "assert":
            return await self.assert_step(step)
        if action in ("openModule", "closeModule"):
            # 用例常以“直接打开某个模块”为起点，比点击导航稳定
            return compact(await self.invoke("splan_call", dict(step, action=action)))
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
    for key in ("matched", "interrupted", "reason", "conditionIndex", "elapsedMs", "settledAfterMs", "total", "truncated", "method", "warnings",
                "advanced", "hint", "current", "next",
                "value", "url", "title", "props", "closed", "stopped", "stackDepth", "panelStack", "via", "moduleId", "ok",
                "before", "after", "overlay"):
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
    start_ocr_prewarm()
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
