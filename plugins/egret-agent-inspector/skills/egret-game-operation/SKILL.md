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

- 优先用 `egret_find`：`id`（EXML/代码绑定的属性名）最稳定，其次是 `text`、`className`、`name`；没有 id 的图片按钮用 `source`（图片资源名）。精确匹配用 `match: "exact"`。
- 不清楚界面结构时，用 `egret_get_tree` 从某个面板的 `hash` 开始浏览，并限制 `depth` 和 `maxNodes`；不要从舞台全量展开。
- 结果中的 `hash` 可在后续调用中直接使用，界面重建后会失效，需要重新查找。
- 只关心可操作对象时加 `touchableOnly: true`；`egret_hit_test` 用于查明某个坐标实际命中的对象。

## 操作

- 点击用 `egret_tap`，默认 `method: "touch"` 走引擎真实命中检测。返回的 `warnings` 表示目标被遮挡或不可见，应先关闭遮挡物，不要直接改用 `event`。
- 滚动列表或拖动用 `egret_drag`，以列表对象为起点并给出 `dy`/`dx`。
- 输入文本用 `egret_set_props` 设置 `text`，并加 `dispatchChange: true`。
- 每次操作后用 `egret_wait_for` 等待预期界面出现（`visible`）或消失（`hidden`/`gone`），不要用固定等待代替。面板有打开动画时加 `stableMs: 300`，等动画结束再操作其中的组件。
- 需要视觉确认时调用 `egret_screenshot`。
- `egret_evaluate` 只在上述工具无法完成时使用，例如读取模块数据；不要借它绕过界面流程修改游戏状态，除非用户明确要求。

## 坐标

`stageRect` 是 Egret 舞台坐标，`screenRect` 是页面视口 CSS 像素坐标，可交给其他浏览器工具使用。滚动容器的 `stageRect` 可能包含可视区域外的内容，点击容器时应改为点击其中的具体子项。
