---
name: splan-control
description: 操作 Splan 项目的游戏页面（页面存在全局 MFC 对象时适用）：按 qaName 操作真实 UI、处理弹窗、换技能，并在定向调试时使用模块与项目接口。用于打开界面、走游戏流程或排查点击无响应；打战斗另见 splan-battle。
---

# Splan 游戏操作

前提：`egret_observe` 写着「这是 Splan 项目页面」，或 `splan_call {"action":"probe"}` 返回 `MFC: true`。都不是就改用 `egret-game-operation`。

## 开场

1. `egret_observe`：看清当前面板栈和可点目标，按编号用 `egret_act` 操作。被弹窗压住时 `egret_act {"steps":[{"op":"dismiss","until":{"qaName":"<主界面组件>"}}]}`。
2. 要去不熟的界面时先 `egret_notes {"action":"search","q":"<模块或流程名>"}`，看历史笔记里的入口和已知坑。

## Splan 固定操作

下面是实测过的规则，照做即可，不用每次摸索。

**打战斗**（进 PVE、出招、换精灵、结算）：先读 `splan-battle` 技能。

**换技能**：精灵背包（主城 `btn_petBag`）→ 点精灵 →「技能」页签。左边 `st=enabled` 是已装备的，右边列表里 `st=blue` 是已学会没装上的（`canLearn` 要花学习力去学，`notLearn` 未解锁）。把右边的拖到左边要替换的那一格：`{"op":"drag","i":<右边>,"to":{"i":<左边>}}`，弹出 `SkillExchangePopup` 后点 `img_confirm`。

## 主城与界面

- 主城底栏：`btn_petBag` 精灵背包、`btn_shop` 商店、`btn_task` 任务、`btn_book` 图鉴、`btn_petStrong` 精灵强化、`btn_eggExchange` 融合。其他功能先点 `ToolbarNew__btn_qiuck`（快捷入口），里面按文字点。顶栏 `add_diamond`、`add_coin`、`add_ticket` 是充值购买。
- 点入口弹出 `FunUnlock` 是功能没解锁：点面板外关掉，报告上面写的解锁条件，别点它的 `btnGo`（会跳去 PVE）。
- 花钱确认：`SimpleAlert` 文案含「是否消耗 / 花费 / 购买」加数量时，`SimpleAlert__confirm` 会立即扣资源，没授权就点 `SimpleAlert__cancel`；`PopupConsumeConfirm` 同理点 `btn_cancel`。
- 服务器提示：`SimpleAlert` 末尾带「（NoNo检测服务…）」是服务器报错，只能点确认。掉线时表上会出「掉线」一行，照它重开页面，登录页点「进入游戏」，登录弹窗是一个接一个弹的，dismiss 到主城再继续；「系统忙,稍后再试」是原操作没生效，稍等重试一次；「…不足」停下来报告。
- 点了没反应先 `egret_get_errors`：有「未收到 cs_xxx 返回」是在等服务器，别重点（消耗类会扣两次）。
- 系统提示框点遮罩关不掉，点 `role: confirm`；普通弹窗点 `role: close`，没有就用 `{"op":"close"}`。
- 定位优先 `qaName`（`宿主短类名__部件名`），其次 `id`、`text`。动作表定不下来再截图，用 `rect` 只截目标区域。

## 调试直达

仅在用户要求调试直达或测试不验证玩家入口时使用模块事件；真实游玩遵循 `splan-test`：

- `splan_call {"action":"listModules","filter":"<关键词>"}` 找模块常量名。
- `splan_call {"action":"openModule","module":"<常量名>"}`；返回的 `dispatched` 是实际派发的事件与载荷，`changed`/`top` 是界面结果。
- 界面没变时不要重复派发：用 `egret_inspect_code` 看入口按钮的点击回调，或 `egret_evaluate` 读项目接口，确认正确的事件名/载荷后用 `event`/`payload` 覆盖，并把结论写进 `egret_notes`。
- `closeModule` 可用于恢复无法通过 UI 关闭的阻塞界面，但不计入玩家路径验收。

## 记录

每解决一个卡点立刻写一条笔记，下次省掉一轮摸索：

```json
{"action":"add","entries":[{"kind":"pitfall","key":"<界面>-<现象>","summary":"一句话：现象 + 解法"}]}
```

`kind` 取 `entry`（入口怎么进）、`locator`（好用的定位条件）、`pitfall`（卡点与解法）、`timing`（实测动画耗时）、`fact`（已知噪音等事实）。一条一句话，同 key 覆盖，不要越记越长。

真实 UI 路线用 `route`，模块直达用 `shortcut`，恢复操作用 `recovery`，不要混写。
