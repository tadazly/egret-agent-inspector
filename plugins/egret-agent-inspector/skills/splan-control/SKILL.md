---
name: splan-control
description: 操作 Splan 项目的游戏页面（页面存在全局 MFC 对象时适用）：按 qaName 操作真实 UI、处理弹窗，并在定向调试时使用模块与项目接口；含进 PVE 战斗、战斗出招与换精灵、换技能等固定操作。用于打开界面、走游戏流程、打战斗或排查点击无响应。
---

# Splan 游戏操作

前提：`splan_call {"action":"probe"}` 返回 `MFC: true`。不满足说明不是本项目，改用 `egret-game-operation`。

## 开场三步

1. `egret_notes {"action":"search","q":"<模块或流程名>"}`：先看历史笔记里有没有入口、定位条件和已知坑。
2. `splan_call {"action":"probe"}`：确认模块、QA 与 debug 能力。
3. `egret_observe`：看清当前面板栈和可点目标，按编号用 `egret_act` 操作。被弹窗压住时 `egret_act {"steps":[{"op":"dismiss","until":{"qaName":"<主界面组件>"}}]}`。

## Splan 固定操作

下面是实测过的规则，照做即可，不用每次摸索。

**进 PVE 战斗（玩家路径）**：主城「星际探索」（`pve_rect`）→ `btn_go` 进星系（`galaxy_N` 换星系）→ 点正中间那颗星球 `planetImg`（点两边的只会把它转到中间）→ 点关卡行（「1 米斯特瑞星」）→ 关卡详情点 `fightBtn`。`sweepBtn*` 是扫荡，会消耗体力。

**战斗**：

- 左边是我方上场的精灵（「LV:100 克雷弗德」），右边是对手。文案里单独的小数字是回合倒计时（秒），一回合约 11 秒，超时游戏会替你出第一招。
- `egret_act` 在轮到你时才返回（写「轮到你了」），这时直接出招，不要再 observe / wait，倒计时经不起多想一轮。
- 出招点技能行（「nibaba 次数:50/50 威力:200」），同一招连出加 `repeat`。
- 主动换精灵一次发完：`{"steps":[{"id":"petBtn"},{"qaName":"PetListBarItem__headIcon","match":"exact","index":0}]}`。卡片要上滑才生效（表里标「按住上滑」，工具会自动滑）；换宠栏不含场上那只，`index` 选第几只。换成功的标志是**左边名字变了、换宠栏收起**；换宠栏还开着就是没换成。
- 精灵倒下时换宠栏自动弹出、技能栏锁住，直接点卡片。结算页用 `{"op":"close"}`。

**换技能**：精灵背包（主城 `btn_petBag`）→ 点精灵 →「技能」页签。左边 `st=enabled` 是已装备的，右边列表里 `st=blue` 是已学会没装上的（`canLearn` 要花学习力去学，`notLearn` 未解锁）。把右边的拖到左边要替换的那一格：`{"op":"drag","i":<右边>,"to":{"i":<左边>}}`，弹出 `SkillExchangePopup` 后点 `img_confirm`。

## 调试直达

仅在用户要求调试直达或测试不验证玩家入口时使用模块事件；真实游玩遵循 `splan-test`：

- `splan_call {"action":"listModules","filter":"<关键词>"}` 找模块常量名。
- `splan_call {"action":"openModule","module":"<常量名>"}`；返回的 `dispatched` 是实际派发的事件与载荷，`changed`/`top` 是界面结果。
- 界面没变时不要重复派发：用 `egret_inspect_code` 看入口按钮的点击回调，或 `egret_evaluate` 读项目接口，确认正确的事件名/载荷后用 `event`/`payload` 覆盖，并把结论写进 `egret_notes`。
- `closeModule` 可用于恢复无法通过 UI 关闭的阻塞界面，但不计入玩家路径验收。

## 定位与操作

- 定位优先 `qaName`（`宿主短类名__部件名`），其次 `id`、`text`、`source`；`splan_call {"action":"qa"}` 走项目自身的 QA 查找。
- 批量查询带 `fields`（如 `["hash","qaName","text","center"]`），默认输出很啰嗦，很容易把上下文撑满。
- 点击用 `egret_act`：入场动画期间加 `settleMs: 300`；中心点被挡住时工具会自动改点包围盒内未被遮挡的位置，仍报“目标被遮挡”说明真有东西压在上面——先 `{"op":"dismiss"}`，不要用 `force`。
- 每步之后用 `egret_act` 的 `{"op":"wait","until":{...}}` 等预期结果，不要用固定 sleep 代替。
- `egret_observe` 返回 `mode: "transient"` 时是地图标题或加载过场，短等复查，不点暗色区域。
- 普通弹窗（签到、活动、奖励）既有关闭按钮也能点遮罩关掉，优先点动作表里 `role: close` 的那一项；系统提示弹窗点遮罩关不掉，必须点确认按钮（`role: confirm`）。`mode: "modal-backdrop-dismiss"` 只是没找到关闭控件的推测，点一次遮罩没反应就回动作表找按钮，别重复点。
- 界面没有预期变化时先 `egret_get_errors`，再决定重试还是报缺陷。
- 主动结合截图理解实际画面、图片字、布局和半透明遮罩，结合显示列表判断组件状态、层级与命中；窗口未前台本身不表示截图陈旧。截图默认已压缩，需要细节时用 `rect` 只截目标区域。

## 记录

每解决一个卡点立刻写一条笔记，下次省掉一轮摸索：

```json
{"action":"add","entries":[{"kind":"pitfall","key":"<界面>-<现象>","summary":"一句话：现象 + 解法"}]}
```

`kind` 取 `entry`（入口怎么进）、`locator`（好用的定位条件）、`pitfall`（卡点与解法）、`timing`（实测动画耗时）、`fact`（已知噪音等事实）。一条一句话，同 key 覆盖，不要越记越长。

真实 UI 路线用 `route`，模块直达用 `shortcut`，恢复操作用 `recovery`，不要混写。
