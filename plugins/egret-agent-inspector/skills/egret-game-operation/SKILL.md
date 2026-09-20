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
- 不清楚界面结构时，用 `egret_get_tree` 从某个面板的 `hash` 开始浏览，并限制 `depth` 和 `maxNodes`；不要从舞台全量展开。
- 结果中的 `hash` 可在后续调用中直接使用，界面重建后会失效，需要重新查找。
- 不要用 `touchableOnly: true` 找按钮：弹窗关闭按钮常是 `touchEnabled` 为假的图片，点击由父容器接管，会被这个条件过滤掉。
- 位置已知而定位条件不明时，用 `egret_screenshot` 看清位置，再用 `egret_hit_test` 按 `clientX`/`clientY` 反查该点的对象，取其 `hash` 操作。

## 操作

- 点击用 `egret_tap`，默认 `method: "touch"` 走引擎真实命中检测。目标被遮挡时工具直接报错且不会点击，错误信息里会给出挡住它的对象：先关掉它再重试，不要改用 `force` 或 `event` 硬点。
- 滚动列表或拖动用 `egret_drag`，以列表对象为起点并给出 `dy`/`dx`。
- 输入文本用 `egret_set_props` 设置 `text`，并加 `dispatchChange: true`。
- 每次操作后用 `egret_wait_for` 等待预期界面出现（`visible`）或消失（`hidden`/`gone`），不要用固定等待代替。面板有打开动画时加 `stableMs: 300`，等动画结束再操作其中的组件。
- 需要视觉确认时调用 `egret_screenshot`，但判断界面状态一律以显示列表为准：浏览器窗口不在前台时截图可能是过期画面（此时结果会带 `warnings`）。
- `egret_evaluate` 用于读取模块数据、调用项目自身的调试接口；不要借它直接改写业务状态来“让界面看起来正确”，除非用户明确要求。
- 操作后如果界面没有预期变化，用 `egret_get_errors` 看这段时间页面是否报错，再决定是重试还是报告缺陷。

## 借助项目自身的调试接口

逐级点击进入深层面板既慢又容易被弹窗打断。若项目提供了调试或测试接口，优先用 `egret_evaluate` 直接到达目标界面，再用本插件的工具操作和断言：

- 模块/面板的打开与关闭事件（如按模块 id 派发全局事件），比点击导航稳定得多；
- 项目自带的 QA 查找、状态设置或跳转接口。

先用 `egret_evaluate` 探测这些接口是否存在再使用，不存在时回到点击流程。这类接口通常只在 debug 构建中可用，用例中要写明依赖。

## 弹窗

进入游戏后常有一串强制弹窗，压住主界面且命名各不相同。逐个处理，不要硬点被遮挡的目标：

1. 取界面层（多为 `uiLayer`）最后一个可见子节点，即当前最上层弹窗。
2. 在它内部找关闭控件：`source` 或 `name` 含 close、quit、cancel、confirm，或文案为“确认”“关闭”。
3. 都找不到时截图，对关闭按钮的位置用 `egret_hit_test` 反查，再按 `hash` 点击。
4. 点击后用 `egret_wait_for` 等该弹窗消失，再重复，直到主界面组件可见。

## 坐标

`stageRect` 是 Egret 舞台坐标，`screenRect` 是页面视口 CSS 像素坐标，可交给其他浏览器工具使用。滚动容器的 `stageRect` 可能包含可视区域外的内容，点击容器时应改为点击其中的具体子项。
