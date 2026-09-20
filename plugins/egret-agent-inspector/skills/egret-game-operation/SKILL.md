---
name: egret-game-operation
description: 通过 egret_* MCP 工具查看和操作浏览器中的 Egret 游戏：查找组件、读取属性、点击、拖动滚动、输入文本、等待界面变化和截图。用户要求在游戏中点某个按钮、打开某个界面、查看界面上有什么、读取组件状态或排查点击无响应时使用。
---

# 操作 Egret 游戏

## 开始前

- 首次使用或工具报告扩展未连接时，先按 `egret-install-extension` skill 处理。
- 用 `egret_list_tabs` 确认目标标签页；需要打开页面时用 `egret_navigate`。
- 用 `egret_status` 确认舞台已就绪；游戏仍在加载时用 `egret_wait_for` 等待首个界面组件出现。

## 定位组件

- 优先用 `egret_find`：`qaName`（`宿主短类名__部件名`，如 `SignPanel__btn_sign`）和 `id`（绑定的属性名）最稳定，其次是 `text`、`name`、`source`（图片资源名），最后才是 `className`。精确匹配用 `match: "exact"`，用 `props` 一次带出需要的属性。
- `qaName` 在结果中总会给出：组件自身写了 qaName 就用它，否则由绑定关系推导，因此与项目测试用例中的写法一致，可直接抄进用例。
- 定位条件因项目而异，一种找不到就换一种：文字做在图片里时 `text` 无效，类名被压缩或组件自定义时 `className` 无效，`id` 也可能整个项目都是空。
- 结果里的 `path` 是给人看的，其中的层级名可能来自 id、`name` 或类名，不能原样当查询条件；要精确定位就用 `hash`。
- 只知道“剧情按钮”“第二个 NPC”这类自然语言描述时，先调用一次 `egret_locate`。它会同时分析 `id/name/qaName/text/source`、子树标签和点击监听；用户描述的是可见按钮文字、文字可能烘焙在图片里时同一次调用传 `ocr: true`，结构化结果歧义后才会在 Windows/macOS 本地批量 OCR 候选区域。
- `ambiguous: false` 才能直接使用 `recommendedTarget`；歧义时先根据 `evidence/labels` 缩小 `rootHash` 或补充描述。结构化信息与 OCR 仍无法消歧时，才用 `egret_screenshot` 截候选区域做视觉确认；禁止按第一项盲点，也不要用多轮 `find/get_tree` 枚举猜测。
- `egret_scene` 的 `recommendedTarget` 只允许用于 `guide-hole`、`guide-continue`、`dialogue-continue` 或 `modal-backdrop-dismiss`；最后一种表示顶层弹窗没有关闭控件、但已找到内容区外的安全遮罩点。普通按钮、地图入口和 NPC 必须用 `egret_find` 或 `egret_locate` 定位，不能从场景顺序推断目标。连续的对话/引导用 `egret_advance`；不要逐个尝试 `shap1/2/3/4`、箭头或遮罩碎片。
- `egret_scene` 返回 `transientOverlay` 时，当前是没有安全点击目标的全屏暗化、地图/章节标题或加载过场。按其 `waitMs` 短等后重新看场景，不调用 `egret_dismiss_popups`，也不点击黑色区域；同一 `panel.hash` 超过 3 秒仍存在才截图并用 `egret_hit_test` 排查。
- `egret_advance` 返回 `advanced: 0` 时看 `stopped/current/hint`：这表示工具明确没有点击，不要空等，也不要改点 `AUTO` 或生成重复 `talk_txt` 点击。重新调用一次 `egret_scene`，按返回状态定位选项或下一目标。
- `egret_locate` 的 `role: task-tracker` 表示可先点任务追踪触发游戏导航；`role: quest-npc` 表示带任务气泡的 NPC。主线找人优先描述为“任务目标 NPC”，避免猜测中文角色名对应的内部英文资源名。
- 结果中的 `hash` 可在后续调用中直接使用，界面重建后会失效，需要重新查找。
- 不要用 `touchableOnly: true` 找按钮：弹窗关闭按钮常是 `touchEnabled` 为假的图片，点击由父容器接管，会被这个条件过滤掉。
- 位置已知而定位条件不明时，用 `egret_screenshot` 看清位置，再用 `egret_hit_test` 按 `clientX`/`clientY` 反查该点的对象，取其 `hash` 操作。

## 操作

- 点击用 `egret_tap`，默认 `method: "touch"` 走引擎真实命中检测。目标被遮挡时工具直接报错且不会点击，错误信息里会给出挡住它的对象：先关掉它再重试，不要改用 `force` 或 `event` 硬点。
- 滚动列表或拖动用 `egret_drag`，以列表对象为起点并给出 `dy`/`dx`。
- 输入文本用 `egret_set_props` 设置 `text`，并加 `dispatchChange: true`。
- 每次操作后用 `egret_wait_for` 等待明确目标；普通点击限 2–3 秒，只有明确的加载、网络或战斗切换才延长。`changed` 必须带具体 `hash/id/qaName/text`，禁止无目标等待；多种结果用 `anyOf`。返回 `interrupted` 时处理 `overlay.recommendedTarget` 或顶层弹窗。面板有动画时加 `stableMs: 300`。
- 主动参考 `egret_screenshot` 理解实际画面、图片字、整体布局、颜色和半透明遮罩；显示列表用于组件状态、层级和精确命中，两类证据互补。浏览器窗口未前台本身不表示截图陈旧；只有截图结果明确带 `warnings`（如窗口最小化）时才恢复窗口后重截。
- `egret_evaluate` 用于读取模块数据、调用项目自身的调试接口；不要借它直接改写业务状态来“让界面看起来正确”，除非用户明确要求。
- 操作后如果界面没有预期变化，用 `egret_get_errors` 看这段时间页面是否报错，再决定是重试还是报告缺陷。

## 借助项目自身的调试接口

仅在用户明确要求调试直达，或测试不包含入口验收时，才用项目调试接口到达目标界面：

- 模块/面板的打开与关闭事件（如按模块 id 派发全局事件），比点击导航稳定得多；
- 项目自带的 QA 查找、状态设置或跳转接口。

真实玩家路径禁止用调试接口打开模块。界面无法通过 UI 关闭且阻塞任务时，可用模块关闭接口恢复，但要保留卡点证据。

## 弹窗

进入游戏后常有一串强制弹窗，压住主界面且命名各不相同。逐个处理，不要硬点被遮挡的目标：

1. 先用 `egret_scene` 确认最上层界面；半透明黑色区域可能是弹窗 backdrop，也可能是地图标题/加载过场，不能只凭颜色判断。
2. 优先使用可见关闭/返回/确认控件；找不到且没有 `transientOverlay` 时调用 `egret_dismiss_popups {"max":1}`。它只会选择内容面板之外有真实点击监听的遮罩点，也能识别全屏弹窗根节点内部的遮罩。
3. `egret_scene` 若返回 `reason: "modal-backdrop-dismiss"`，可直接点其 `stagePoint`，不要枚举或点击遮罩碎片。
4. 每次点击后确认原弹窗 `hash` 消失；工具返回 `stuck` 时再截图并用 `egret_hit_test` 检查，不要连续盲点背景。

## 坐标

`stageRect` 是 Egret 舞台坐标，`screenRect` 是页面视口 CSS 像素坐标，可交给其他浏览器工具使用。滚动容器的 `stageRect` 可能包含可视区域外的内容，点击容器时应改为点击其中的具体子项。
