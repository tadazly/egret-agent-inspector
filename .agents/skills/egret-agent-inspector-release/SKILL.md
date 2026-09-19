---
name: egret-agent-inspector-release
description: 发布 Egret Agent Inspector 新版本。用户要求“发布新版本”“发版”“发个 patch/minor”或发布插件更新时使用；负责版本推断、CHANGELOG、版本同步、提交推送、tag、GitHub Release 与 S Plugins 市场更新的核验。不用于普通提交或只查看版本。
---

# 发布 Egret Agent Inspector

用户要求发版即授权：提交并推送 `origin/main`、创建并推送 `vX.Y.Z` tag，由此触发 GitHub Release 和 S Plugins 市场更新。只推送 `origin`（GitHub），不推送其他 remote。

## 流程

1. **预检**：运行 `python scripts/release_check.py`，不通过则先解决或告知用户。查看输出的“之后的提交”，没有需要发布的改动时停止。
2. **定版本**（SemVer）：
   - patch：缺陷修复、文案或体验微调。
   - minor：新增工具、Skill、面板功能或参数，且向后兼容。
   - major：重命名或删除 MCP 工具/参数、改变用例格式等不兼容变更。
   - 用户已指定版本则直接使用；在 minor 与 major 之间拿不准时先询问。
3. **写 CHANGELOG**：在 `CHANGELOG.md` 顶部新增 `## X.Y.Z`，只写用户可感知的变化，每条一句，不罗列提交或实现细节。
4. **同步版本**：`python scripts/set_version.py X.Y.Z`。
5. **开屏公告**：只有值得让面板用户看到的重要新功能才更新 `extension/ipt/panel/index.html` 的 `#changes` 内容，并提升 `Loader.js` 中 `showChanges` 的公告版本；普通发版不改。
6. **提交前检查**：
   ```bash
   python scripts/release_check.py X.Y.Z
   python scripts/validate.py
   python -m unittest discover -s tests -v
   ```
   改动涉及页面操作或面板时，先在真实 Egret 页面验收。
7. **提交推送**：提交信息用中文概括本版本（如“位置缩放编辑仅在项目提供 AxesHelper 时显示（3.2.2）”），推送 `main` 后用 `gh run watch` 等待 CI 通过。
8. **打 tag**：`git tag -a vX.Y.Z -m "Egret Agent Inspector vX.Y.Z"`，推送该 tag。
9. **核验**：
   - Release workflow 的 `release` 与 `notify-s-plugins` 均成功，Release 含 `egret-agent-inspector-extension-vX.Y.Z.zip`。
   - `tadazly/s-plugins` 的 “Update plugin marketplace” 运行成功，其 `.agents/plugins/marketplace.json` 中本插件版本为 X.Y.Z。

## 报告

给出版本号、主要变化、Release 链接和市场版本；任何一步失败都如实说明停在哪一步。提醒已安装用户更新插件后让 agent 调用 `egret_install_extension` 与 `egret_reload_extension` 更新浏览器扩展。

## 禁止

- 不移动、覆盖或删除已推送的 tag，不强推 `main`；发布出错时发新的 patch 版本修正。
- 不在未通过 CI 的提交上打 tag。
- 不在提交、tag、CHANGELOG 或 Release 中写入内部域名、内部邮箱、本机路径或凭据。
