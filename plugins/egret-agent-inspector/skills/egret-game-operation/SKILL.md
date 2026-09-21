---
name: egret-game-operation
description: 通过 egret_* MCP 工具查看和操作浏览器中的 Egret 游戏：读取带编号的动作表、点击、拖动滚动、输入文本、等待界面变化和截图。用户要求在游戏中点某个按钮、打开某个界面、查看界面上有什么、读取组件状态或排查点击无响应时使用。
---

# 操作 Egret 游戏

## 开始前

- 首次使用或工具报告扩展未连接时，先按 `egret-install-extension` skill 处理。
- 用 `egret_list_tabs` 确认目标标签页；需要打开页面时用 `egret_navigate`。游戏仍在加载时 `egret_observe` 会返回 `mode: transient`，短等后再看。

## 主循环：observe → act

一次操作就是一次往返，不要拆成「定位 → 点击 → 等待 → 再看一眼」四轮。

1. `egret_observe` 返回当前动作表。
2. 选中编号，`egret_act {"marker": "<上一步的 marker>", "steps": [{"i": 3}]}`。
3. `egret_act` 执行、等界面稳定、等过加载过场，然后**直接返回新的动作表**。下一次决策看这份返回值即可，不用再调 `egret_observe`。

动作表是紧凑文本，一行一个动作：

```
面板 newLogin.NewLogin | marker 1hgydqz
文案 v201703011614 / 1 天龙星
动作 4 条（省略 2，被遮挡 5 条未列出，* = 图片字弱标签，不确定就先 ocr 或截图）
1 btn_notice* button
2 btn_start* button
3 cb_agree* tab 已选
4 《健康游戏忠告》抵制不良游戏… text
```

- 首行是面板名、`mode` 和语义指纹 `marker`；`egret_act` 的返回会多一行「变化」，直接说明上一步把界面改成了什么样，不用自己 diff 两张表。
- `role` 为 `text` 的行是界面正文，不是按钮。
- 标签带 `*` 说明文字烘在图片里；整屏都是弱标签时工具会自动补一次本地 OCR（不上传图片），补过的行带 `alt=<原标签>`。OCR 对美术字体不可靠（实测「进入游戏」被识成「迸八湔懑」），`label` 读不通就看 `alt`，两个都定不下来就截图确认，不要照着乱码点。
- 被遮挡的条目点不了，默认只报数量；确实要看时传 `occluded: true`。
- `limit` 只决定显示几行，调小不会让顶层面板的按钮消失。
- 需要 `hash`、坐标或完整字段（截图定位、`egret_inspect_code`）时传 `format: "json"`。

规则：

- 用 `i` 编号必须带上 `marker`。界面已经变了会返回 `stale` 和新动作表且**不执行任何点击**，照新表重新选即可，这是设计好的行为，不是错误。
- 路线已经确认时一次给多步：`{"steps": [{"op": "dismiss", "optional": true}, {"qaName": "MainPanel__btn_pve"}]}`。**`i` 编号只对第一步有效**，后续步骤用 `hash`/`qaName`/`id`/`text` 查询条件或 `op`。
- 每步可加 `expect`（查询条件）校验结果，不满足就停在那一步；加 `optional` 则该步失败不影响后续。
- `egret_act` 已经等过界面稳定，普通点击后不要再补等待。只有明确的长加载、网络等待才用 `{"op": "wait", "until": {...}, "timeoutMs": 15000}`。

## mode 决定这一步能做什么

`mode: normal` 时按编号自由选择目标。其余状态下工具会指出该走哪一步：

| mode | 含义 | 该做什么 |
| --- | --- | --- |
| `guide-hole` | 新手引导挖洞，只有洞里能点 | `{"op": "recommended"}`，此时没有动作表 |
| `guide-continue` / `dialogue-continue` | 点任意处继续的引导或 NPC 对白 | `{"op": "advance"}` 一次推完，不要逐次点 |
| `modal-backdrop-dismiss` | 没识别到关闭控件，推测遮罩可点；动作表照常给出 | 先用表里的关闭/确定按钮，都没有才 `{"op": "recommended"}` |
| `transient` | 地图标题、章节标题、加载过场，没有安全点击目标 | `{"op": "wait", "ms": 800}`，不要点黑色区域 |
| `blocked` | 整张表被同一个对象挡住 | 有推荐就 `{"op": "recommended"}`（战斗入场演出这类点任意处跳过），否则短等 |

`advance` 返回 `推进 0 次` 时看后面的 `stopped` / 提示：这表示工具明确没有点击。不要空等，也不要改点 `AUTO` 或重复点 `talk_txt`；按返回的动作表定位选项或下一目标。

## 弹窗

游戏里两类弹窗的关法不一样，分清楚再动手：

- **普通弹窗**（签到、活动、奖励、商店）：既有关闭按钮，也能点内容区外的遮罩关掉。优先点动作表里 `role` 为 `close` 的那一项，它比遮罩稳。
- **系统提示弹窗**（一段文字加一个确认按钮的那种）：**点遮罩关不掉**，必须点「确定/确认/知道了」，动作表里通常是 `role: confirm`。

所以 `mode: modal-backdrop-dismiss` 只是「没找到关闭控件」的推测。点一次遮罩后「变化」那行说界面没变，就立刻停手回到动作表找 `close` / `confirm`，不要重复点同一个遮罩。

进入游戏后常有一串强制弹窗，逐个处理；每关一个都确认面板栈里原来那个已经不在了。批量清弹窗用 `{"steps": [{"op": "dismiss", "max": 3}]}`。

## 目标不在动作表里

- 自然语言描述的目标先用一次 `egret_locate`：它会聚合 `id/name/qaName/text/source`、子树标签和真实监听评分，`ambiguous: false` 才能直接用 `recommendedTarget`。可能是图片字时传 `ocr: true`。
- 已知稳定标识用 `egret_find`。`qaName`（`宿主短类名__部件名`，如 `SignPanel__btn_sign`）和 `id` 最稳定，其次 `text`、`name`、`source`，最后才是 `className`。定位条件因项目而异，一种找不到就换一种。
- 结果里的 `path` 是给人看的，不能当查询条件；要精确定位用 `hash`。
- 不要用 `touchableOnly: true` 找按钮：弹窗关闭按钮常是 `touchEnabled` 为假的图片，点击由父容器接管。
- 只知道大概位置时先 `egret_screenshot` 看清，再用 `egret_locate` 或 `egret_observe` 的 `format: "json"` 对照 `screenRect` 找到对象。

## 截图与视觉兜底

结构化动作表覆盖不了游戏里的一切：文字烘进图片的按钮、没有监听但可交互的 NPC 模型、靠颜色区分的状态、战斗画面。这些情况主动截图，不要硬猜：

- 动作表 + OCR 仍然定不下来目标；
- 要理解整体布局、颜色、半透明遮罩、战斗进程；
- `mode: blocked` 且短等后仍不变。

`egret_screenshot` 默认压缩并可用 `rect` 只截局部（传 `format: "json"` 拿到的 `screenRect`）。`egret_observe` / `egret_act` 传 `screenshot: true` 可以在同一次调用里附带一张图。动作表出现「警告 页面在后台」时让用户把浏览器窗口恢复到前台，否则动画和加载会被浏览器节流。

## 其他操作

- 拖动/滚动列表：动作表末尾的「可滚」行给出可滚容器和方向，按它给的 `{"op": "scroll", "hash": ..., "dy": -200}` 执行；需要精确控制时用 `egret_drag`。
- 输入文本：`{"i": 3, "text": "abc"}`。
- `egret_evaluate` 用于读取模块数据、调用项目自身的调试接口；不要借它直接改写业务状态来「让界面看起来正确」，除非用户明确要求。
- 操作后界面没有预期变化时，动作表会带「页面报错」一行；需要细节用 `egret_get_errors`，想知道控件背后是哪段代码用 `egret_inspect_code`（要先用 `format: "json"` 拿 `hash`）。

## 借助项目自身的调试接口

仅在用户明确要求调试直达，或测试不包含入口验收时，才用项目调试接口到达目标界面：

- 模块/面板的打开与关闭事件（如按模块 id 派发全局事件），比点击导航稳定得多；
- 项目自带的 QA 查找、状态设置或跳转接口。

真实玩家路径禁止用调试接口打开模块。界面无法通过 UI 关闭且阻塞任务时，可用模块关闭接口恢复，但要保留卡点证据。

## 坐标

`format: "json"` 里的 `stageRect` 是 Egret 舞台坐标，`screenRect` 是页面视口 CSS 像素坐标，可交给其他浏览器工具使用。滚动容器的 `stageRect` 可能包含可视区域外的内容，点击容器时应改为点击其中的具体子项。
