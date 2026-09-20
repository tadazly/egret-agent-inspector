---
name: splan-control
description: 操作 Splan 项目的游戏页面（页面存在全局 MFC 对象时适用）：用模块事件直达界面、按 qaName 定位组件、连关开场强弹、借项目自身调试接口完成操作。在该项目中打开某个模块、走一段游戏流程或排查点击无响应时使用。
---

# Splan 游戏操作

前提：`splan_call {"action":"probe"}` 返回 `mfc: true`。不满足说明不是本项目，改用 `egret-game-operation`。

## 开场三步

1. `egret_notes {"action":"search","q":"<模块或流程名>"}`：先看历史笔记里有没有入口、定位条件和已知坑。
2. `splan_call {"action":"probe"}`：确认本次可用的调试接口；`toolMethods` 是项目自己的方法名，可直接用 `egret_evaluate` 调。
3. `egret_scene`：看清当前面板栈。被弹窗压住时 `egret_dismiss_popups {"until":{"qaName":"<主界面组件>"}}`。

## 直达目标界面

逐级点击慢且容易被强弹打断，优先用模块事件：

- `splan_call {"action":"listModules","filter":"<关键词>"}` 找模块常量名。
- `splan_call {"action":"openModule","module":"<常量名>"}`；返回的 `dispatched` 是实际派发的事件与载荷，`changed`/`top` 是界面结果。
- 界面没变时不要重复派发：用 `egret_inspect_code` 看入口按钮的点击回调，或 `egret_evaluate` 读项目接口，确认正确的事件名/载荷后用 `event`/`payload` 覆盖，并把结论写进 `egret_notes`。
- 关闭用 `closeModule`。确实没有模块事件的界面才回到点击流程。

## 定位与操作

- 定位优先 `qaName`（`宿主短类名__部件名`），其次 `id`、`text`、`source`；`splan_call {"action":"qa"}` 走项目自身的 QA 查找。
- 批量查询带 `fields`（如 `["hash","qaName","text","center"]`），默认输出很啰嗦，很容易把上下文撑满。
- 点击用 `egret_tap`：入场动画期间加 `settleMs: 300`；中心点被挡住时工具会自动改点包围盒内未被遮挡的位置，仍报“目标被遮挡”说明真有东西压在上面——先 `egret_dismiss_popups`，不要用 `force`。
- 每步之后用 `egret_wait_for` 等预期结果，不要用固定 sleep 代替。
- 界面没有预期变化时先 `egret_get_errors`，再决定重试还是报缺陷。
- 判断状态一律以显示列表为准；截图只用于看清画面，且默认已压缩，需要细节时用 `rect` 只截目标区域。

## 记录

每解决一个卡点立刻写一条笔记，下次省掉一轮摸索：

```json
{"action":"add","entries":[{"kind":"pitfall","key":"<界面>-<现象>","summary":"一句话：现象 + 解法"}]}
```

`kind` 取 `entry`（入口怎么进）、`locator`（好用的定位条件）、`pitfall`（卡点与解法）、`timing`（实测动画耗时）、`fact`（已知噪音等事实）。一条一句话，同 key 覆盖，不要越记越长。
