---
name: egret-install-extension
description: 为用户的浏览器安装、更新或检查 Egret Agent Inspector 扩展。首次使用本插件、egret_* 工具提示扩展未连接、egret_extension_status 返回 outdated，或用户要求为某个浏览器（Chrome、Edge、Brave）安装扩展时使用。
---

# 安装 Egret Agent Inspector 扩展

egret_* 工具通过浏览器扩展操作游戏页面。Chromium 浏览器不允许静默安装未上架扩展，因此由脚本准备文件并打开扩展管理页，用户完成“加载已解压的扩展程序”。

安装脚本：`<插件根>/scripts/browser_extension.py`，插件根是本文件往上两级的目录。Windows 用 `python`，macOS/Linux 用 `python3` 运行。

## 流程

1. 调用 `egret_extension_status`：
   - `connected=true` 且 `outdated=false`：已就绪，结束。
   - `connected=true` 且 `outdated=true`：运行 `install --browser <对应浏览器>` 更新文件，再调用 `egret_reload_extension` 并确认版本。
2. 未连接时运行 `browser_extension.py status`，确定目标浏览器：
   - 用户指定了浏览器则用指定的；否则用 `defaultBrowser`。
   - `defaultBrowserSupported=false`（如 Firefox、Safari）：说明仅支持 Chromium 浏览器，从 `browsers` 中列出可选项让用户选择。
3. 目标浏览器的 `loaded` 中已有 `managed=true` 的条目：扩展已安装，请用户打开该浏览器（或在扩展管理页启用扩展），再回到第 1 步。
4. 否则运行 `browser_extension.py install --browser <id>`，把输出中的 `nextSteps` 简洁转告用户；`legacyLoads` 非空时提醒先移除旧扩展。
5. 用户确认完成后调用 `egret_extension_status` 验证 `connected=true`；仍未连接时请用户检查开发者模式和所选目录。

## 约束

- 不修改浏览器偏好文件、注册表或策略，不使用 `--load-extension` 等启动参数代替用户操作。
- 扩展固定安装在 `installDir`，插件升级后只需重新运行 `install` 并调用 `egret_reload_extension`，无需用户重新加载。
- 同一台机器可为多个浏览器分别加载同一目录；agent 操作的浏览器必须是已加载扩展的那个。
