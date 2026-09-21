---
name: egret-game-operation
description: 通过 egret_* MCP 工具查看和操作浏览器中的 Egret 游戏：读取带编号的动作表、点击、拖动滚动、输入文本、等待界面变化和截图。用户要求在游戏中点某个按钮、打开某个界面、查看界面上有什么、读取组件状态或排查点击无响应时使用。
---

# 操作 Egret 游戏

## 开始前

- 首次使用或工具报告扩展未连接时，先按 `egret-install-extension` skill 处理。
- 用 `egret_list_tabs` 确认目标标签页；需要打开页面时用 `egret_navigate`。
- 用 `egret_status` 确认舞台已就绪；游戏仍在加载时 `egret_observe` 会返回 `mode: "transient"`，短等后再看。

## 主循环：observe → act

一次操作就是一次往返，不要拆成「定位 → 点击 → 等待 → 再看一眼」四轮。

1. `egret_observe` 返回当前动作表：`actions` 里每项有编号 `i`、`role`、`label`、状态和已解遮挡的点击点，外加整页 `text` 和语义指纹 `marker`。
2. 选中要点的编号，调用 `egret_act {"marker": "<上一步的 marker>", "steps": [{"i": 3}]}`。
3. `egret_act` 会执行、等界面稳定、等过加载过场，然后**直接返回新的动作表**。下一次决策看这份返回值即可，不用再调 `egret_observe`。

规则：

- 用 `i` 编号必须带上 `marker`。界面已经变了会返回 `stale: true` 和新动作表且**不执行任何点击**，照新表重新选即可，这是设计好的行为，不是错误。
- 路线已经确认时一次给多步：`{"steps": [{"op": "dismiss", "optional": true}, {"qaName": "MainPanel__btn_pve"}]}`。**`i` 编号只对第一步有效**，后续步骤用 `hash`/`qaName`/`id`/`text` 查询条件或 `op`。
- 每步可加 `expect`（查询条件）校验结果，不满足就停在那一步；加 `optional` 则该步失败不影响后续。
- `egret_act` 已经等过界面稳定，普通点击后不要再补 `egret_wait_for`。只有明确的长加载、网络等待才用 `{"op": "wait", "until": {...}, "timeoutMs": 15000}`。

## 动作表怎么读

- `label` 的 `from` 是 `text` / `childText` 时才是界面上的真实文案；`qaName` / `id` / `name` / `source` / `className` 是弱标签，说明文字烘在图片里。
- 需要按按钮文字选目标时，给 `egret_observe` 传 `ocr: true`：工具会截一次图，对弱标签控件批量做本地 OCR（Windows / macOS，不上传图片），把 `label` 换成识别出的文字、`from` 标为 `ocr`。
- `occluded: true` 的条目被 `blocker` 挡着，`egret_act` 会拒绝点它。先关掉遮挡物再点，不要 `force`。
- `omitted` 大于 0 表示还有没列出的控件：缩小 `rootHash` 或提高 `limit`。
- `scope` 为 `stage` 时表示顶层不是模态面板，整个舞台（含地图上的 NPC、入口）都在表里；为 `panel` 时只看当前模态面板。

## mode 决定这一步能做什么

只有 `mode: "normal"` 时才按编号自由选择目标。其余状态下工具只给一个合法动作：

| mode | 含义 | 该做什么 |
| --- | --- | --- |
| `guide-hole` | 新手引导挖洞，只有洞里能点 | `egret_act {"steps": [{"op": "recommended"}]}` |
| `guide-continue` / `dialogue-continue` | 点任意处继续的引导或 NPC 对白 | `{"op": "advance"}` 一次推完，不要逐次点 |
| `modal-backdrop-dismiss` | 弹窗没有关闭控件，但遮罩可点 | `{"op": "recommended"}` |
| `transient` | 地图标题、章节标题、加载过场，没有安全点击目标 | `{"op": "wait", "ms": 800}`，不要点黑色区域 |
| `blocked` | 整张表被同一个对象挡住 | 有 `recommendedTarget` 就 `{"op": "recommended"}`（战斗入场演出这类点任意处跳过），否则短等 |

`advance` 返回 `advanced: 0` 时看 `stopped` / `hint`：这表示工具明确没有点击。不要空等，也不要改点 `AUTO` 或重复点 `talk_txt`；按返回的动作表定位选项或下一目标。

## 目标不在动作表里

- 自然语言描述的目标先用一次 `egret_locate`：它会聚合 `id/name/qaName/text/source`、子树标签和真实监听评分，`ambiguous: false` 才能直接用 `recommendedTarget`。可能是图片字时传 `ocr: true`。
- 已知稳定标识用 `egret_find`。`qaName`（`宿主短类名__部件名`，如 `SignPanel__btn_sign`）和 `id` 最稳定，其次 `text`、`name`、`source`，最后才是 `className`。定位条件因项目而异，一种找不到就换一种。
- 结果里的 `path` 是给人看的，不能当查询条件；要精确定位用 `hash`。
- 不要用 `touchableOnly: true` 找按钮：弹窗关闭按钮常是 `touchEnabled` 为假的图片，点击由父容器接管。
- 只知道位置时用 `egret_screenshot` 看清，再用 `egret_hit_test` 按 `clientX`/`clientY` 反查对象，取 `hash` 操作。

## 截图与视觉兜底

结构化动作表覆盖不了游戏里的一切：文字烘进图片的按钮、没有监听但可交互的 NPC 模型、靠颜色区分的状态、战斗画面。这些情况主动截图，不要硬猜：

- 动作表 + OCR 仍然定不下来目标；
- 要理解整体布局、颜色、半透明遮罩、战斗进程；
- `mode: "blocked"` 且短等后仍不变。

`egret_screenshot` 默认压缩并可用 `rect` 只截局部（传查询结果里的 `screenRect`）。`egret_observe` / `egret_act` 传 `screenshot: true` 可以在同一次调用里附带一张图。浏览器窗口未前台本身不表示截图陈旧；只有结果明确带 `warnings` 时才恢复窗口后重截。动作表返回 `warnings` 说页面在后台时，让用户把浏览器窗口恢复到前台，否则动画和加载会被浏览器节流。

## 其他操作

- 拖动/滚动列表：动作表里的 `scrollers` 给出可滚容器，用 `{"op": "scroll", "hash": <容器 hash>, "dy": -200}`；需要精确控制时用 `egret_drag`。
- 输入文本：`{"i": 3, "text": "abc"}`，或用 `egret_set_props` 设 `text` 并加 `dispatchChange: true`。
- `egret_evaluate` 用于读取模块数据、调用项目自身的调试接口；不要借它直接改写业务状态来「让界面看起来正确」，除非用户明确要求。
- 操作后界面没有预期变化时，`egret_act` 会返回 `newErrors`；需要细节用 `egret_get_errors`，想知道控件背后是哪段代码用 `egret_inspect_code`。

## 借助项目自身的调试接口

仅在用户明确要求调试直达，或测试不包含入口验收时，才用项目调试接口到达目标界面：

- 模块/面板的打开与关闭事件（如按模块 id 派发全局事件），比点击导航稳定得多；
- 项目自带的 QA 查找、状态设置或跳转接口。

真实玩家路径禁止用调试接口打开模块。界面无法通过 UI 关闭且阻塞任务时，可用模块关闭接口恢复，但要保留卡点证据。

## 坐标

`stageRect` 是 Egret 舞台坐标，`screenRect` 是页面视口 CSS 像素坐标，可交给其他浏览器工具使用。滚动容器的 `stageRect` 可能包含可视区域外的内容，点击容器时应改为点击其中的具体子项。
