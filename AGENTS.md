# AGENTS.md

## 结构

- `plugins/egret-agent-inspector/`：同时是 Codex 与 Claude Code 插件根目录。
  - `extension/`：浏览器扩展（Manifest V3），`extension/mcp/` 为 MCP 桥接和页面代理。
  - `server/`：stdio MCP server，只用 Python 标准库。
  - `scripts/browser_extension.py`：浏览器检测与扩展安装。
  - `skills/`：插件 Skills。
- `.agents/plugins/marketplace.json`、`.claude-plugin/marketplace.json`：两个平台的市场入口。
- `.agents/skills/egret-agent-inspector-release/`：仓库级发版技能；`.claude/skills/` 下同名技能只做转发。

## 约定

- 文档使用简体中文，技术术语和标识符保留英文；保持精炼，不写实现细节。
- Codex 的 `.codex-plugin/plugin.json` 通过 `mcpServers: "./.mcp.json"` 引用插件根目录的 MCP 配置；Claude Code 在 `.claude-plugin/plugin.json` 中声明 MCP server，命令指向 `${CLAUDE_PLUGIN_ROOT}/bin/egret-mcp`（sh 用 LF 且可执行，`.cmd` 只用 ASCII、CRLF），不要写死解释器名。
- 版本号用 `scripts/set_version.py` 同步修改；修改 `extension/mcp/pageAgent.js` 时同步提升其与 `bridge.js` 中的 agent 版本。
- MCP stdio 的 stdout 只输出协议消息，日志写 stderr。
- 不提交凭据、本地绝对路径或内部地址。

## 验证

```powershell
python scripts/validate.py
python -m unittest discover -s tests -v
```

涉及页面操作的改动还需在真实 Egret 页面中验收。
