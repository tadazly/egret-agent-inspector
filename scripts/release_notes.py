#!/usr/bin/env python3
"""从 CHANGELOG.md 提取指定版本的发布说明：python scripts/release_notes.py 3.2.0"""

import re
import sys
from pathlib import Path

text = (Path(__file__).resolve().parents[1] / "CHANGELOG.md").read_text(encoding="utf-8")
match = re.search(rf"^## {re.escape(sys.argv[1])}\b.*?\n(.*?)(?=^## |\Z)", text, re.M | re.S)
if not match:
    raise SystemExit(f"CHANGELOG.md has no section for {sys.argv[1]}")
sys.stdout.reconfigure(encoding="utf-8")
print(match.group(1).strip())
