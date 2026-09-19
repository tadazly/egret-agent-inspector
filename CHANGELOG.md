# 更新日志

## 3.2.4

- 修复在 Codex 桌面版（Windows）中安装扩展后浏览器找不到扩展目录的问题；Windows 安装目录改为 `%USERPROFILE%\.egret-agent-inspector\extension`，旧目录加载的扩展需按提示移除后重新加载。

## 3.2.3

- 精简 DevTools 面板开屏公告，只保留当前主要更新并链接到完整更新日志；普通发版不再重复弹出。

## 3.2.2

- DevTools 面板的“位置缩放编辑”仅在游戏项目提供 `AxesHelper` 时显示；项目稍后注册或移除时，右键菜单自动同步，缺失时不再报错。

## 3.2.1

- 修复在 Codex 中安装扩展时目录未生成的问题：安装改由 MCP 工具 `egret_install_extension` 执行，不再受 agent 命令沙箱限制。
- 安装完成后校验目录和版本，失败时如实返回错误；`egret_extension_status` 在未连接时附带本机浏览器与扩展加载情况。

## 3.2.0

- 更名为 Egret Agent Inspector，并提供 Codex / Claude Code 插件：MCP 工具、扩展安装、游戏操作和 E2E 测试 Skills。
- 新增 MCP 服务：查询显示对象，执行点击、拖动、输入、等待、断言和截图，并可用 `egret_run_steps` 批量运行 JSON 用例。
- 支持按图片资源名 `source` 定位组件；`waitFor` 新增 `stableMs`，用于等待面板动画结束。
- DevTools 面板新增“显示id”，以黄色显示组件在代码/EXML 中绑定的 id；搜索支持按 id 匹配。

## 3.1.1

- 优化 `name`、`hashCode` 搜索：命中后自动展开祖先节点，并选中、滚动到对应组件。

## 3.1.0

- 显示树改用迭代遍历、扁平化传输和虚拟列表，支持超深层级和大量节点。
- 优化高亮绘制和命中检测的性能，清理重复启动产生的定时器和监听器。
