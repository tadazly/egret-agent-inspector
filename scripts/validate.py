#!/usr/bin/env python3
"""校验插件结构、版本一致性和 Skill 元数据。"""

import json
import py_compile
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NAME = "egret-agent-inspector"
PLUGIN = ROOT / "plugins" / NAME
SEMVER = re.compile(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$")


def load(path, errors):
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as e:
        errors.append(f"{path.relative_to(ROOT)}: {e}")
        return {}


def versions():
    """返回各处声明的版本号，供校验和 set_version.py 复用。"""
    errors = []
    result = {
        "extension/manifest.json": load(PLUGIN / "extension" / "manifest.json", errors).get("version"),
        ".codex-plugin/plugin.json": load(PLUGIN / ".codex-plugin" / "plugin.json", errors).get("version"),
        ".claude-plugin/plugin.json": load(PLUGIN / ".claude-plugin" / "plugin.json", errors).get("version"),
    }
    market = load(ROOT / ".claude-plugin" / "marketplace.json", errors)
    result[".claude-plugin/marketplace.json"] = next(
        (p.get("version") for p in market.get("plugins", []) if p.get("name") == NAME), None)
    return result, errors


def check_codex(errors):
    manifest = load(PLUGIN / ".codex-plugin" / "plugin.json", errors)
    if manifest.get("name") != NAME:
        errors.append(".codex-plugin/plugin.json: name mismatch")
    ui = manifest.get("interface", {})
    for field in ("displayName", "shortDescription", "longDescription", "developerName", "category", "websiteURL"):
        if not ui.get(field):
            errors.append(f".codex-plugin/plugin.json: interface.{field} is required")
    prompts = ui.get("defaultPrompt", [])
    if not prompts or len(prompts) > 3 or any(len(p) > 128 for p in prompts):
        errors.append(".codex-plugin/plugin.json: defaultPrompt must have 1-3 entries of <=128 chars")
    if manifest.get("mcpServers") != "./.mcp.json":
        errors.append(".codex-plugin/plugin.json: mcpServers must reference ./.mcp.json")
    mcp = load(PLUGIN / ".mcp.json", errors)
    server = mcp.get("mcpServers", {}).get(NAME, {})
    if not server:
        errors.append(f".mcp.json: mcpServers.{NAME} is required")
    elif server.get("command") != "python3":
        errors.append(f".mcp.json: mcpServers.{NAME}.command must be python3")
    for arg in server.get("args", []):
        if arg.startswith("./") and not (PLUGIN / arg).is_file():
            errors.append(f".mcp.json: missing {arg}")
    market = load(ROOT / ".agents" / "plugins" / "marketplace.json", errors)
    entry = next((p for p in market.get("plugins", []) if p.get("name") == NAME), None)
    if not entry or entry.get("source", {}).get("path") != f"./plugins/{NAME}":
        errors.append(".agents/plugins/marketplace.json: plugin entry missing or wrong path")


def check_claude(errors):
    manifest = load(PLUGIN / ".claude-plugin" / "plugin.json", errors)
    if manifest.get("name") != NAME:
        errors.append(".claude-plugin/plugin.json: name mismatch")
    market = load(ROOT / ".claude-plugin" / "marketplace.json", errors)
    entry = next((p for p in market.get("plugins", []) if p.get("name") == NAME), None)
    if not entry or entry.get("source") != f"./plugins/{NAME}":
        errors.append(".claude-plugin/marketplace.json: plugin entry missing or wrong source")
def check_skills(errors):
    skills = sorted(p for p in (PLUGIN / "skills").iterdir() if p.is_dir())
    if not skills:
        errors.append("skills/: no skills found")
    for skill in skills:
        text = (skill / "SKILL.md").read_text(encoding="utf-8") if (skill / "SKILL.md").is_file() else ""
        match = re.match(r"^---\n(.*?)\n---\n", text, re.S)
        meta = dict(re.findall(r"^(\w+):\s*(.+)$", match.group(1), re.M)) if match else {}
        if meta.get("name") != skill.name:
            errors.append(f"skills/{skill.name}: frontmatter name must equal directory name")
        if not meta.get("description"):
            errors.append(f"skills/{skill.name}: description is required")
        for link in re.findall(r"\]\(([^)#]+)(?:#[^)]*)?\)", text):
            if not link.startswith("http") and not (skill / link).exists():
                errors.append(f"skills/{skill.name}: broken link {link}")


def check_python(errors):
    for path in list((PLUGIN / "server").glob("*.py")) + list((PLUGIN / "scripts").glob("*.py")):
        try:
            py_compile.compile(str(path), doraise=True, cfile=None)
        except py_compile.PyCompileError as e:
            errors.append(str(e))


def check_page_agent(errors):
    page = (PLUGIN / "extension" / "mcp" / "pageAgent.js").read_text(encoding="utf-8")
    bridge = (PLUGIN / "extension" / "mcp" / "bridge.js").read_text(encoding="utf-8")
    page_version = re.search(r'var VERSION = "([^"]+)"', page)
    bridge_version = re.search(r'const AGENT_VERSION = "([^"]+)"', bridge)
    if not page_version or not bridge_version or page_version.group(1) != bridge_version.group(1):
        errors.append("extension/mcp: pageAgent.js VERSION must match bridge.js AGENT_VERSION")


def main():
    found, errors = versions()
    values = set(found.values())
    if len(values) != 1 or not SEMVER.match(str(next(iter(values)))):
        errors.append("versions must be identical semver: " + json.dumps(found))
    check_codex(errors)
    check_claude(errors)
    check_skills(errors)
    check_python(errors)
    check_page_agent(errors)
    if errors:
        print("validation failed:", *("- " + e for e in errors), sep="\n", file=sys.stderr)
        return 1
    print(f"validation passed ({NAME} {found['extension/manifest.json']})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
