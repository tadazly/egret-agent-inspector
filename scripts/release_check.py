#!/usr/bin/env python3
"""发版只读预检。

  python scripts/release_check.py            开始前：输出上一个 tag 之后的提交，检查分支、工作区、同步状态和 git 身份
  python scripts/release_check.py X.Y.Z      提交前：检查版本号已同步为 X.Y.Z、tag 未被占用、CHANGELOG 已有对应章节
"""

import re
import subprocess
import sys
from pathlib import Path

from validate import SEMVER, versions

ROOT = Path(__file__).resolve().parents[1]


def git(*args):
    return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, encoding="utf-8").stdout.strip()


def parse(version):
    return tuple(int(x) for x in version.split("-")[0].split("."))


def main():
    target = sys.argv[1] if len(sys.argv) > 1 else None
    problems = []
    found, errors = versions()
    problems += errors
    current = found.get("extension/manifest.json")
    if len(set(found.values())) != 1:
        problems.append("各处版本号不一致：%s" % found)

    git("fetch", "origin", "--tags", "--quiet")
    branch = git("rev-parse", "--abbrev-ref", "HEAD")
    if branch != "main":
        problems.append("当前分支是 %s，发版必须在 main 上进行" % branch)
    if not target and git("status", "--porcelain"):
        problems.append("工作区有未提交的改动")
    behind = git("rev-list", "--count", "HEAD..origin/main")
    if behind not in ("", "0"):
        problems.append("本地落后 origin/main %s 个提交，先同步" % behind)
    email = git("config", "user.email")
    if not email.endswith("@users.noreply.github.com"):
        problems.append("git 身份 %s 不是 GitHub noreply 邮箱" % email)

    tags = sorted((t for t in git("tag", "--list", "v*").split() if SEMVER.match(t[1:])), key=lambda t: parse(t[1:]))
    last = tags[-1] if tags else None
    log = git("log", "--format=- %h %s", f"{last}..HEAD" if last else "HEAD")

    if target:
        if not SEMVER.match(target):
            problems.append("目标版本 %s 不是合法的 SemVer" % target)
        else:
            if last and parse(target) <= parse(last[1:]):
                problems.append("目标版本 %s 必须大于上一个 tag %s" % (target, last))
            if git("ls-remote", "--tags", "origin", f"refs/tags/v{target}") or f"v{target}" in tags:
                problems.append("tag v%s 已存在" % target)
            if current != target:
                problems.append("版本号仍为 %s，先运行 python scripts/set_version.py %s" % (current, target))
            changelog = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")
            if not re.search(rf"^## {re.escape(target)}\s*$", changelog, re.M):
                problems.append("CHANGELOG.md 缺少 ## %s 章节" % target)

    sys.stdout.reconfigure(encoding="utf-8")
    print("当前版本：%s" % current)
    print("上一个 tag：%s" % (last or "无"))
    print("之后的提交：\n%s" % (log or "（无）"))
    if problems:
        print("\n预检未通过：", *("- " + p for p in problems), sep="\n")
        return 1
    print("\n预检通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
