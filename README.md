# Egret Agent Inspector

让 AI agent 读取和操作浏览器中的 Egret 游戏：查询显示对象树，定位组件，执行点击、拖动、输入和断言，并运行可复现的 E2E 用例。同时保留原有的 Chrome DevTools 调试面板。

## 安装

需要 Chromium 浏览器（Chrome、Edge、Brave）和 Python 3.8+。macOS/Linux 需保证 `python` 命令指向 Python 3。

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

## MCP 工具

| 类别 | 工具 |
| --- | --- |
| 连接 | `egret_extension_status`、`egret_reload_extension`、`egret_list_tabs`、`egret_navigate` |
| 查询 | `egret_status`、`egret_get_tree`、`egret_find`、`egret_get_node`、`egret_hit_test` |
| 操作 | `egret_tap`、`egret_drag`、`egret_set_props`、`egret_wait_for`、`egret_evaluate`、`egret_screenshot` |
| 测试 | `egret_run_steps`：批量执行步骤并断言，失败时附截图 |

组件可按 `id`（代码/EXML 中绑定的属性名）、`text`、`className`、`name` 或图片 `source` 定位。

## DevTools 面板

在 DevTools 的“Egret”面板中查看显示对象树、修改属性和高亮对象。勾选“显示id”后，列表以 `id ( name ) : 类名` 格式显示组件绑定的 id（黄色）。

## 开发

```powershell
python scripts/validate.py
python -m unittest discover -s tests -v
python scripts/set_version.py 3.3.0
```

发布：在 [CHANGELOG.md](CHANGELOG.md) 写好版本说明，同步版本号后推送 `vX.Y.Z` tag。Release workflow 会校验、创建 GitHub Release，并通知 [S Plugins](https://github.com/tadazly/s-plugins) 更新市场（需要仓库 Secret `S_PLUGINS_DISPATCH_TOKEN`）。
