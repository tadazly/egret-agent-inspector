# Egret Agent Inspector

让 AI agent 读取和操作浏览器中的 Egret 游戏：查询显示对象树，定位组件，执行点击、拖动、输入和断言，并运行可复现的 E2E 用例。同时保留原有的 Chrome DevTools 调试面板。

## 安装

需要 Chromium 浏览器（Chrome、Edge、Brave）、Node.js 和 Python 3.8+。Codex 启动器会在 Windows 选择 `python` / `py -3`，在 macOS/Linux 选择 `python3` / `python`；Claude Code 当前配置使用 `python`。

### Claude Code

```text
/plugin marketplace add tadazly/egret-agent-inspector
/plugin install egret-agent-inspector@egret-agent-inspector
```

### Codex

按 [S Plugins 的“安装与使用”](https://github.com/tadazly/s-plugins#安装与使用) 添加市场并安装 `Egret Agent Inspector`，或直接添加本仓库：

```powershell
codex plugin marketplace add tadazly/egret-agent-inspector
```

### 浏览器扩展

安装插件后新建会话并提出需求即可。首次使用时 agent 会检测默认浏览器，准备扩展文件并打开扩展管理页，你只需打开“开发者模式”并加载 agent 给出的目录。之后可以要求 agent 为其他浏览器安装，插件更新后 agent 会自动重新加载扩展。

只使用 DevTools 面板时，可以在扩展管理页直接加载 `plugins/egret-agent-inspector/extension`。

## 使用示例

- `为我的默认浏览器安装 Egret Agent Inspector 扩展。`
- `列出当前游戏界面上所有可点击的按钮。`
- `测试登录页公告：打开公告、切换到第二个标签、滚动列表，保存为 E2E 用例。`

## Skills

| Skill | 用途 |
| --- | --- |
| `egret-install-extension` | 为默认或指定浏览器安装、更新扩展 |
| `egret-game-operation` | 查找组件并执行点击、拖动、输入、等待和截图 |
| `egret-e2e-test` | 编写、运行和报告 E2E 用例 |
| `egret-bug-hunt` | 探索式操作游戏，发现报错、异常界面和无响应交互 |
| `egret-session-recovery` | 浏览器闪退后恢复验收现场；重复闪退时采样运行态指标 |
| `splan-control` | Splan 项目专属：模块事件直达界面、qaName 定位、连关强弹（页面有全局 `MFC` 时适用） |
| `splan-test` | Splan 项目专属：生成并运行用例、自主探索找 bug、沉淀笔记 |

## MCP 工具

| 类别 | 工具 |
| --- | --- |
| 连接 | `egret_extension_status`、`egret_install_extension`、`egret_reload_extension`、`egret_reopen_browser`、`egret_list_tabs`、`egret_navigate` |
| 查询 | `egret_scene`（面板栈与控件状态）、`egret_locate`（自然语言语义定位与消歧）、`egret_status`、`egret_runtime_stats`、`egret_get_tree`、`egret_find`、`egret_get_node`、`egret_hit_test` |
| 操作 | `egret_tap`、`egret_advance`、`egret_drag`、`egret_dismiss_popups`、`egret_set_props`、`egret_wait_for`、`egret_evaluate`、`egret_screenshot` |
| 排错 | `egret_get_errors`：页面未捕获异常、Promise 拒绝、资源加载失败和 console.error/warn；`egret_inspect_code`：控件背后的事件回调与源码片段 |
| 记忆 | `egret_notes`：按游戏域名保存入口、定位条件、卡点解法、缺陷与耗时，跨会话复用 |
| 测试 | `egret_run_steps`：批量执行步骤并断言，失败时附截图，并报告运行期间的页面错误 |
| 项目专属 | `splan_call`：模块与 QA 能力；`splan_test_command`：仅明确授权且加载 `debug.js` 时执行测试命令 |

查询类工具限制返回规模；`egret_locate` 只有在唯一高置信匹配时才返回可直接点击的目标，`ocr: true` 会在结构化结果歧义后用 Windows/macOS 本地 OCR 批量识别候选按钮；`egret_wait_for` 支持带明确目标的 `changed/anyOf`，`egret_screenshot` 默认压缩并可用 `rect` 只截局部。

组件可按 `id`（代码/EXML 中绑定的属性名）、`qaName`、`text`、`className`、`name` 或图片 `source` 定位。
`qaName` 为 `宿主短类名__部件名`（如 `SignPanel__btn_sign`）：组件自身写了 qaName 时直接使用，否则由绑定关系推导，因此正式构建中同样可用。

## DevTools 面板

在 DevTools 的“Egret”面板中查看显示对象树、修改属性和高亮对象；Egret 2.4 及以上版本查看划过对象时需按住鼠标左键移动。勾选“显示id”后，列表以 `id ( name ) : 类名` 格式显示组件绑定的 id（黄色）。

## 开发

仓库根目录的 `.mcp.json` 会把本地这份 MCP server 挂进在本仓库打开的 Claude Code 会话，便于改完直接验证（改扩展文件后调用 `egret_reload_extension`）。

```powershell
python scripts/validate.py
python -m unittest discover -s tests -v
python scripts/set_version.py 3.4.0
```

发布：在本仓库中让 Codex 或 Claude Code “发布新版本”，由 `egret-agent-inspector-release` 技能完成。推送 `vX.Y.Z` tag 后，Release workflow 会创建 GitHub Release 并通知 [S Plugins](https://github.com/tadazly/s-plugins) 更新市场（需要仓库 Secret `S_PLUGINS_DISPATCH_TOKEN`）。
