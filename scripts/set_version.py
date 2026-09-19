#!/usr/bin/env python3
"""同步修改扩展、插件清单、marketplace 和面板中的版本号：python scripts/set_version.py 3.3.0"""

import re
import sys
from pathlib import Path

from validate import PLUGIN, ROOT, SEMVER

FILES = [
    PLUGIN / "extension" / "manifest.json",
    PLUGIN / ".codex-plugin" / "plugin.json",
    PLUGIN / ".claude-plugin" / "plugin.json",
    ROOT / ".claude-plugin" / "marketplace.json",
]
PANEL = PLUGIN / "extension" / "ipt" / "panel" / "index.html"


def replace(path: Path, pattern: str, repl: str) -> None:
    raw = path.read_bytes()
    text = raw.decode("utf-8-sig")
    updated, count = re.subn(pattern, repl, text)
    if count != 1:
        raise SystemExit(f"{path.relative_to(ROOT)}: expected exactly one version field, found {count}")
    bom = b"\xef\xbb\xbf" if raw.startswith(b"\xef\xbb\xbf") else b""
    path.write_bytes(bom + updated.encode("utf-8"))


def main() -> int:
    if len(sys.argv) != 2 or not SEMVER.match(sys.argv[1]):
        raise SystemExit("usage: set_version.py <semver>")
    version = sys.argv[1]
    for path in FILES:
        replace(path, r'"version":\s*"[^"]+"', f'"version": "{version}"')
    replace(PANEL, r"<h2>Egret Agent Inspector [^<]+</h2>", f"<h2>Egret Agent Inspector {version}</h2>")
    print(f"version set to {version}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
