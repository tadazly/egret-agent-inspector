---
name: egret-install-extension
description: 为用户的浏览器安装、更新或检查 Egret Agent Inspector 扩展。首次使用本插件、egret_* 工具提示扩展未连接、egret_extension_status 返回 outdated，或用户要求为某个浏览器（Chrome、Edge、Brave）安装扩展时使用。
---

# 安装 Egret Agent Inspector 扩展

egret_* 工具通过浏览器扩展操作游戏页面。Chromium 浏览器不允许静默安装未上架扩展：由 `egret_install_extension` 准备文件并打开扩展管理页，用户完成“加载已解压的扩展程序”。

优先通过 MCP 工具 `egret_install_extension` 完成安装。只有当前会话完全没有暴露 `egret_extension_status` / `egret_install_extension` 时，才使用下方“工具缺失降级”；不要仅因扩展未连接就改走 shell。

## 流程

1. 调用 `egret_extension_status`：
   - `connected=true` 且 `outdated=false`：已就绪，结束。
   - `connected=true` 且 `outdated=true`：调用 `egret_install_extension`（`browser` 取对应浏览器）更新文件，再调用 `egret_reload_extension` 并确认版本。
   - `error=bridge_port_unavailable`：不要安装扩展；关闭不再使用的 Codex 会话后重试，或把原始错误报告给用户。
2. 未连接时查看返回的 `local`，确定目标浏览器：
   - 用户指定了浏览器则用指定的；否则用 `local.defaultBrowser`。
   - `local.defaultBrowserSupported=false`（如 Firefox、Safari）：说明仅支持 Chromium 浏览器，从 `local.browsers` 中列出可选项让用户选择。
3. 目标浏览器的 `loaded` 中已有 `managed=true` 且 `exists=true` 的条目：扩展已安装，请用户打开该浏览器（或在扩展管理页启用扩展），再回到第 1 步。
4. 否则调用 `egret_install_extension`：
   - `ok=false`：如实告知用户 `error`，不要声称已准备好。
   - `ok=true`：把 `nextSteps` 简洁转告用户，目录以返回的 `installDir` 为准；`legacyLoads` 非空时提醒先移除旧扩展。
5. 用户确认完成后调用 `egret_extension_status` 验证 `connected=true`；仍未连接时请用户检查开发者模式、所选目录，以及是否在同一个浏览器中加载。

## 工具缺失降级

当 Skill 已加载、但当前会话中根本没有 `egret_*` MCP tools 时：

1. 明确说明 MCP 未加载，不要把它误报为浏览器扩展未安装。
2. 从本 `SKILL.md` 所在目录向上两级定位插件根目录，确认存在 `scripts/browser_extension.py` 和 `extension/manifest.json`。
3. 用当前系统可用的 Python 3 执行脚本：macOS/Linux 优先 `python3`，Windows 优先 `python`；先运行 `browser_extension.py status`，再按同一判断流程决定是否运行 `browser_extension.py install --browser <browser>`。
4. 若命令沙箱拒绝写入 `installDir`、找不到 Python 3 或脚本路径不在已安装插件内，停止并报告原始错误；不要声称安装成功，也不要搜索或执行其他同名脚本。
5. 降级安装只能准备扩展文件并打开管理页，无法恢复本会话的 MCP tools。用户完成浏览器加载后，还需修复插件加载问题并新建 Codex 会话才能操作游戏。

## 约束

- 不修改浏览器偏好文件、注册表或策略，不使用 `--load-extension` 等启动参数代替用户操作。
- 扩展固定安装在 `installDir`，插件升级后只需调用 `egret_install_extension` 和 `egret_reload_extension`，无需用户重新加载。
- agent 操作的浏览器必须是已加载扩展的那个。
