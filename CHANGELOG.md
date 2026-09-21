# 更新日志

## 4.1.0

- 新增高速操作主循环 `egret_observe` / `egret_act`：`egret_observe` 一次快照产出带编号的动作表（角色、标签、状态、已解遮挡的点击点）和语义指纹 `marker`；`egret_act` 按编号执行，内部等界面稳定并等过加载过场，直接返回执行后的新动作表。原本「定位 → 点击 → 等待 → 再看一眼」四次往返压缩成一次。
- 动作表用语义指纹而不是几何变化判断页面是否还是决策时那一页：循环播放的待机动画不会让编号作废；界面确实变了则返回 `stale: true` 和新动作表且不执行任何点击。
- `egret_act` 支持一次多步与 `op`：`tap` / `text` / `recommended` / `advance` / `dismiss` / `scroll` / `wait`，每步可带 `expect` 校验和 `optional`。
- `egret_observe` 的 `ocr: true` 在同一次调用里对图片字按钮批量本地 OCR 并替换标签，不上传图片；结构化定位、OCR 与截图视觉分析三层兜底都保留。
- 顶层只是浮动提示时动作表覆盖整个舞台，地图上的 NPC 与入口不再被漏掉；整表被同一对象挡住时返回 `mode: "blocked"`，可点的全屏接管层（战斗入场演出）直接给出 `recommendedTarget`。
- 页面在后台被浏览器节流时动作表返回 `warnings`，避免 agent 误以为游戏卡死而空等。
- 改进引导与对白识别：GuideMask 挂在同级图层下也能找到，没有 `imgKuang` 时由 `shapN` 遮罩碎片反推挖洞区域；`NPCDialogUI` 这类命名也识别为对白，未规范命名的对白正文不再被当成选项；有带文字可点控件的界面不再被误判成加载过场。
- 移除 `egret_scene`：其输出是 `egret_observe` 的子集。`egret_run_steps` 里的 `scene` 步骤自动落到 `egret_observe`，并新增 `observe` / `act` 步骤。

## 4.0.3

- 修复 Windows 上 Node MCP 启动器占用插件缓存目录，导致运行中的 Egret 插件无法卸载或更新。

## 4.0.2

- 移除“浏览器窗口未前台即可能截到旧帧”的推测性提示，截图与 OCR 不再因此被无条件降级。
- 识别全屏弹窗内部及内容面板外的大面积半透明遮罩；无关闭控件时向 agent 提供安全的遮罩关闭点并验证弹窗确实消失。
- 区分有点击监听的弹窗 backdrop 与自动消失的地图标题/加载过场；后者返回 `transientOverlay` 并提示短等复查，避免误点或长时间犹豫。
- 收紧关闭控件名称匹配，避免把 `btn_notice` 等普通入口误判成 `btn_no` 关闭按钮。

## 4.0.1

- 修复对白正文被误判为剧情选项导致 `egret_advance` 空操作；无操作时返回明确状态和下一步提示，并拒绝批量脚本连续盲点对白。
- 合并同一 `StoryInteractObject` 的 NPC 子控件，识别任务气泡与任务追踪角色，改进中文任务目标、地图和传送语义拆分。
- 修复 Windows PowerShell 5.1 无法解析本地 OCR 脚本，并加入兼容性回归校验。

## 4.0.0

- 新增 `egret_locate`：一次综合组件标识、可见文字、资源名、层级语义与点击监听定位目标，仅在唯一高置信匹配时推荐点击。
- 支持 Windows 与 macOS 本地快速 OCR；结构化信息无法消歧时才识别候选区域中的图片文字。
- 对话与引导改为稳定节奏推进，遇到选项、面板切换或点击后无变化会立即停止。
- 删除容易产生大量候选和误点的 `egret_interactables`，普通按钮、地图入口和 NPC 统一使用 `egret_find` 或 `egret_locate`。
- 收紧自动验收规则：禁止按候选顺序盲点、无目标等待和根据非阻断告警推断不存在的缺陷。

## 3.5.1

- 修复扩展重载后已打开页面仍复用旧页面代理的问题，并统一 `MFC` 探测字段命名。

## 3.5.0

- Codex MCP 改用跨平台 Node 启动器，自动选择 Windows 与 macOS/Linux 可用的 Python 3.8+ 命令。
- 引导与 NPC 对话会返回可立即点击的目标，并支持短批量推进；等待复用中的对话面板消失也不再空等完整超时。
- 新增浏览器闪退恢复与疑似内存泄漏排查技能，以及重开页面、轻量运行态采样工具。

## 3.4.2

- 修复只有 `python3`、没有 `python` 命令的系统无法启动 Codex MCP server，导致 marketplace 安装后只加载 Skills、不暴露 `egret_*` tools 的问题。
- 浏览器 profile 因 macOS 权限限制不可读时，状态查询和扩展安装不再整体失败，并返回明确的降级提示。

## 3.4.1

- 修复从 Codex 插件市场安装后只加载 Skills、未加载 `egret_*` MCP tools，导致 agent 无法安装浏览器扩展的问题。
- 改进浏览器扩展安装 Skill：能区分 MCP bridge 端口冲突与扩展未安装，并在 tools 未加载时提供受限的 Python 3 降级流程。
- 提升多 Codex 任务并行使用时的 bridge 容量，并改进 FairyGUI/UIContainer 弹窗、关闭控件与可见对象的识别。

## 3.4.0

- 新增 `egret_scene`：一次拿到面板/弹窗栈与最上层面板里的可交互控件（含中心点和遮挡判定），替代反复截图试探。
- 新增 `egret_dismiss_popups`：连续关闭强制弹窗，没有关闭控件时点面板之外的遮罩，并确认每个弹窗确实消失。
- 新增 `egret_inspect_code`：查看控件的事件回调、函数源码片段和所属面板方法，用于定位业务代码与缺陷位置。
- 新增 `egret_notes`：按游戏域名保存入口、定位条件、卡点解法、缺陷和动画耗时，跨会话复用。
- 新增 `splan_call` 与 `splan-control`、`splan-test` 两个 skill：页面存在全局 `MFC` 时，用模块事件直达界面并生成测试。
- 降低上下文与截图消耗：`egret_find`/`egret_get_tree` 支持 `fields`，截图默认 jpeg 限宽 900 并支持 `rect` 局部截取。
- `egret_tap` 支持 `settleMs` 等动画结束，中心点被遮挡时自动改点包围盒内未被遮挡的位置。
- `egret_wait_for` 返回 `settledAfterMs`（实测动画耗时）；`egret_get_errors` 支持 `exclude` 折叠已知噪音。
- `egret_run_steps` 步骤支持 `optional` 和 `retry`，新增 `dismissPopups`、`scene` 两种 action。
- 定位支持 FairyGUI 等框架：`name`/`text`/`source` 会回落到显示对象的 `$owner`。

## 3.3.0

- 新增 `qaName` 定位：结果中总会给出 `宿主短类名__部件名` 形式的标识，组件自身写了 qaName 时直接使用，可直接用于测试用例。
- 新增 `egret_get_errors`：读取页面未捕获异常、Promise 拒绝、资源加载失败和 console.error/warn；`egret_run_steps` 的报告附带运行期间的页面错误。
- 新增 `egret-bug-hunt` skill：自主操作游戏排查缺陷。
- `egret_tap` 在目标被遮挡时不再照点，直接报错并指出遮挡对象，需要时用 `force` 跳过。
- 修复扩展重载后旧连接仍被使用导致请求干等超时的问题。
- 修复插件自身遍历显示列表时触发 Egret `Warning #1009` 刷屏。

## 3.2.6

- `egret_screenshot` 在浏览器窗口不在前台或已最小化时给出警告，避免 agent 把过期画面当作当前界面。
- 修复点击 FairyGUI 等框架的组件时误报“目标不在舞台上不可见”。
- `egret_find` 支持 `props`，查找时一并读取所需属性。
- 操作与测试 skill 补充实战经验：定位条件的取舍、关闭按钮不可用 `touchableOnly` 过滤、连续强制弹窗的处理、`absent` 断言的假通过风险。

## 3.2.5

- 修复 Windows 上卸载插件失败、需重启 Codex 才能卸载的问题。

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
