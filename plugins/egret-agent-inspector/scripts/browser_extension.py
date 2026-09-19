#!/usr/bin/env python3
"""检测浏览器并安装 Egret Agent Inspector 扩展（仅依赖 Python 标准库）。

  python browser_extension.py status               输出默认浏览器、已安装浏览器及扩展加载情况（JSON）
  python browser_extension.py install [--browser chrome|edge|brave|default] [--no-open]
                                                   把扩展复制到固定目录，打开浏览器扩展管理页并复制目录路径到剪贴板

Chromium 系浏览器不允许静默安装未上架扩展，最后一步“加载已解压的扩展程序”需要用户在浏览器中完成；
扩展已加载时 install 只更新固定目录中的文件，之后调用 egret_reload_extension 即可生效。
"""

import argparse
import json
import os
import platform
import shutil
import subprocess
import sys
import tempfile

PLUGIN_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUNDLED_DIR = os.path.join(PLUGIN_ROOT, "extension")
EXTENSION_NAMES = ("Egret Agent Inspector", "Egret Inspector")
SYSTEM = platform.system()
HOME = os.path.expanduser("~")
LOCALAPPDATA = os.environ.get("LOCALAPPDATA", os.path.join(HOME, "AppData", "Local"))


def windows_exe(*relative):
    roots = [os.environ.get("ProgramFiles", r"C:\Program Files"),
             os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"), LOCALAPPDATA]
    return [os.path.join(root, *relative) for root in roots]


# id -> 名称、扩展管理页、各平台的可执行文件候选、用户数据目录、默认浏览器标识
BROWSERS = {
    "chrome": {
        "name": "Google Chrome", "page": "chrome://extensions/",
        "Windows": windows_exe("Google", "Chrome", "Application", "chrome.exe"),
        "Darwin": ["/Applications/Google Chrome.app"],
        "Linux": ["google-chrome", "google-chrome-stable"],
        "data": {"Windows": os.path.join(LOCALAPPDATA, "Google", "Chrome", "User Data"),
                 "Darwin": os.path.join(HOME, "Library", "Application Support", "Google", "Chrome"),
                 "Linux": os.path.join(HOME, ".config", "google-chrome")},
        "ids": ("chromehtml", "com.google.chrome", "google-chrome"),
    },
    "edge": {
        "name": "Microsoft Edge", "page": "edge://extensions/",
        "Windows": windows_exe("Microsoft", "Edge", "Application", "msedge.exe"),
        "Darwin": ["/Applications/Microsoft Edge.app"],
        "Linux": ["microsoft-edge", "microsoft-edge-stable"],
        "data": {"Windows": os.path.join(LOCALAPPDATA, "Microsoft", "Edge", "User Data"),
                 "Darwin": os.path.join(HOME, "Library", "Application Support", "Microsoft Edge"),
                 "Linux": os.path.join(HOME, ".config", "microsoft-edge")},
        "ids": ("msedgehtm", "com.microsoft.edgemac", "microsoft-edge"),
    },
    "brave": {
        "name": "Brave", "page": "brave://extensions/",
        "Windows": windows_exe("BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
        "Darwin": ["/Applications/Brave Browser.app"],
        "Linux": ["brave-browser", "brave"],
        "data": {"Windows": os.path.join(LOCALAPPDATA, "BraveSoftware", "Brave-Browser", "User Data"),
                 "Darwin": os.path.join(HOME, "Library", "Application Support", "BraveSoftware", "Brave-Browser"),
                 "Linux": os.path.join(HOME, ".config", "BraveSoftware", "Brave-Browser")},
        "ids": ("bravehtml", "com.brave.browser", "brave-browser"),
    },
}


def install_dir():
    if SYSTEM == "Windows":
        base = os.path.join(LOCALAPPDATA, "EgretAgentInspector")
    elif SYSTEM == "Darwin":
        base = os.path.join(HOME, "Library", "Application Support", "EgretAgentInspector")
    else:
        base = os.path.join(os.environ.get("XDG_DATA_HOME", os.path.join(HOME, ".local", "share")), "egret-agent-inspector")
    return os.path.join(base, "extension")


def manifest_of(path):
    try:
        with open(os.path.join(path, "manifest.json"), encoding="utf-8-sig") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def version_of(path):
    manifest = manifest_of(path)
    return manifest.get("version") if manifest else None


def find_executable(browser_id):
    for candidate in BROWSERS[browser_id].get(SYSTEM, []):
        if os.path.isabs(candidate):
            if os.path.exists(candidate):
                return candidate
        else:
            found = shutil.which(candidate)
            if found:
                return found
    return None


def default_browser_raw():
    try:
        if SYSTEM == "Windows":
            import winreg
            key = winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                                 r"Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice")
            return winreg.QueryValueEx(key, "ProgId")[0]
        if SYSTEM == "Darwin":
            import plistlib
            path = os.path.join(HOME, "Library", "Preferences", "com.apple.LaunchServices",
                                "com.apple.launchservices.secure.plist")
            with open(path, "rb") as f:
                for handler in plistlib.load(f).get("LSHandlers", []):
                    if handler.get("LSHandlerURLScheme") in ("https", "http"):
                        return handler.get("LSHandlerRoleAll")
            return "com.apple.safari"
        return subprocess.run(["xdg-settings", "get", "default-web-browser"], capture_output=True,
                              text=True, timeout=5).stdout.strip()
    except Exception:  # noqa: BLE001
        return None


def default_browser_id(raw):
    raw = (raw or "").lower()
    for browser_id, info in BROWSERS.items():
        if any(raw.startswith(i) for i in info["ids"]):
            return browser_id
    return None


def loaded_extensions(browser_id):
    """读取浏览器各 profile 的偏好文件，找出已加载的 Egret Inspector 系列扩展（只读）。"""
    data_dir = BROWSERS[browser_id]["data"].get(SYSTEM)
    found = []
    if not data_dir or not os.path.isdir(data_dir):
        return found
    target = os.path.normcase(os.path.normpath(install_dir()))
    for profile in sorted(os.listdir(data_dir)):
        for pref_name in ("Secure Preferences", "Preferences"):
            pref = os.path.join(data_dir, profile, pref_name)
            if not os.path.isfile(pref):
                continue
            try:
                with open(pref, encoding="utf-8") as f:
                    settings = json.load(f).get("extensions", {}).get("settings", {})
            except (OSError, ValueError):
                continue
            for ext_id, item in settings.items():
                path = item.get("path") if isinstance(item, dict) else None
                if not path or not os.path.isabs(path):
                    continue
                manifest = manifest_of(path) or item.get("manifest") or {}
                norm = os.path.normcase(os.path.normpath(path))
                # 目录已移动的旧开发副本读不到 manifest，按目录名识别
                legacy = manifest.get("name") in EXTENSION_NAMES or (not manifest and "egret" in os.path.basename(norm))
                if norm != target and not legacy:
                    continue
                entry = {"profile": profile, "extensionId": ext_id, "path": path,
                         "version": manifest.get("version"), "exists": os.path.isdir(path),
                         "managed": norm == target}
                if item.get("disable_reasons") or item.get("state") == 0:
                    entry["disabled"] = True
                if entry not in found:
                    found.append(entry)
    return found


def status():
    raw = default_browser_raw()
    default_id = default_browser_id(raw)
    browsers = []
    for browser_id, info in BROWSERS.items():
        exe = find_executable(browser_id)
        if not exe and not os.path.isdir(info["data"].get(SYSTEM) or ""):
            continue
        browsers.append({"id": browser_id, "name": info["name"], "executable": exe,
                         "isDefault": browser_id == default_id, "extensionsPage": info["page"],
                         "loaded": loaded_extensions(browser_id)})
    target = install_dir()
    return {
        "platform": SYSTEM,
        "defaultBrowser": default_id,
        "defaultBrowserRaw": raw,
        "defaultBrowserSupported": default_id is not None,
        "browsers": browsers,
        "installDir": target,
        "installedVersion": version_of(target),
        "bundledVersion": version_of(BUNDLED_DIR),
    }


def copy_extension():
    target = install_dir()
    parent = os.path.dirname(target)
    os.makedirs(parent, exist_ok=True)
    staging = tempfile.mkdtemp(prefix="extension-", dir=parent)
    shutil.copytree(BUNDLED_DIR, os.path.join(staging, "extension"),
                    ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    if os.path.isdir(target):
        # 原地覆盖文件而不删除目录，避免浏览器因目录短暂消失而移除扩展
        shutil.copytree(os.path.join(staging, "extension"), target, dirs_exist_ok=True)
    else:
        shutil.move(os.path.join(staging, "extension"), target)
    shutil.rmtree(staging, ignore_errors=True)
    return target


def copy_to_clipboard(text):
    try:
        if SYSTEM == "Windows":
            subprocess.run(["powershell", "-NoProfile", "-Command", "Set-Clipboard -Value $env:EAI_CLIP"],
                           env=dict(os.environ, EAI_CLIP=text), check=True, timeout=10)
        elif SYSTEM == "Darwin":
            subprocess.run(["pbcopy"], input=text, text=True, check=True, timeout=5)
        else:
            tool = shutil.which("wl-copy") or shutil.which("xclip")
            if not tool:
                return False
            args = [tool] if tool.endswith("wl-copy") else [tool, "-selection", "clipboard"]
            subprocess.run(args, input=text, text=True, check=True, timeout=5)
        return True
    except Exception:  # noqa: BLE001
        return False


def open_extensions_page(browser_id):
    exe = find_executable(browser_id)
    if not exe:
        return False
    page = BROWSERS[browser_id]["page"]
    try:
        if SYSTEM == "Darwin":
            subprocess.Popen(["open", "-a", exe, page])
        else:
            subprocess.Popen([exe, page], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return True
    except OSError:
        return False


def install(browser, open_page):
    info = status()
    browser_id = info["defaultBrowser"] if browser == "default" else browser
    if browser_id not in BROWSERS:
        return {"ok": False, "error": "默认浏览器（%s）不是受支持的 Chromium 浏览器，请用 --browser 指定 chrome、edge 或 brave"
                % (info["defaultBrowserRaw"] or "未知")}
    previous = info["installedVersion"]
    target = copy_extension()
    entry = next((b for b in info["browsers"] if b["id"] == browser_id), None)
    loaded = [x for x in (entry or {}).get("loaded", []) if x["managed"]]
    legacy = [x for x in (entry or {}).get("loaded", []) if not x["managed"]]
    result = {"ok": True, "browser": browser_id, "browserName": BROWSERS[browser_id]["name"],
              "installDir": target, "version": version_of(target), "previousVersion": previous,
              "alreadyLoaded": bool(loaded), "legacyLoads": legacy}
    if loaded:
        result["nextSteps"] = ["扩展已从该目录加载：调用 egret_reload_extension（或在扩展管理页点击“重新加载”）使新文件生效。"]
        return result
    page = BROWSERS[browser_id]["page"]
    result["clipboard"] = copy_to_clipboard(target)
    result["openedExtensionsPage"] = open_page and open_extensions_page(browser_id)
    steps = []
    if legacy:
        steps.append("先在扩展管理页移除旧的 Egret Inspector 扩展：" + "、".join(x["path"] for x in legacy))
    steps += [
        "在 %s 打开 %s（%s）" % (BROWSERS[browser_id]["name"], page, "已自动打开" if result["openedExtensionsPage"] else "请手动打开"),
        "打开右上角（Edge 为左侧）的“开发者模式”",
        "点击“加载已解压的扩展程序”，选择目录 %s%s" % (target, "（路径已复制到剪贴板，可粘贴到地址栏）" if result["clipboard"] else ""),
        "完成后告知 agent，agent 调用 egret_extension_status 确认连接",
    ]
    result["nextSteps"] = steps
    return result


def main():
    parser = argparse.ArgumentParser(description="Egret Agent Inspector 浏览器扩展安装工具")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("status")
    p_install = sub.add_parser("install")
    p_install.add_argument("--browser", default="default", choices=["default"] + list(BROWSERS))
    p_install.add_argument("--no-open", action="store_true", help="不自动打开扩展管理页")
    args = parser.parse_args()
    result = status() if args.command == "status" else install(args.browser, not args.no_open)
    sys.stdout.reconfigure(encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result.get("ok", True) else 1


if __name__ == "__main__":
    raise SystemExit(main())
