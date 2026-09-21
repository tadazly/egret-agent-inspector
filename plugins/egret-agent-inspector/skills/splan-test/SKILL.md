---
name: splan-test
description: 为 Splan 项目的游戏（页面存在全局 MFC 对象）生成和运行自动化测试，或按真实玩家路径自主游玩、发现缺陷并沉淀路线。用户要求测试流程、跑回归或让 agent 自己玩游戏找 bug 时使用。
---

# Splan 测试

前提同 `splan-control`。开始前用 `egret_notes` 查询相关 `route`、定位与已知问题。

## 选择模式

- **真实游玩**：自由探索、自动游玩、验证玩家入口时默认使用。只操作当前界面可见控件，不用 `openModule`、`dispatch`、`evaluate` 或 `setProps` 进入玩法。
- **定向回归**：用户只关心模块内部行为时，可用模块事件作为起点，并在结论中标明不是入口验收。

## 真实游玩

1. 用 `egret_observe` 看当前动作表；`mode` 不是 `normal` 时只走工具给出的那一个动作（`guide-hole` / `blocked` 用 `egret_act {"steps":[{"op":"recommended"}]}`，`guide-continue` / `dialogue-continue` 用 `{"op":"advance"}`，`transient` 用 `{"op":"wait"}`），点完确认原界面已消失。`modal-backdrop-dismiss` 仍会给出动作表：普通弹窗优先点 `role: close`，系统提示弹窗点遮罩关不掉、必须点 `role: confirm` 的确认按钮，点一次遮罩没反应就回动作表找按钮。按任务描述找普通按钮、列表项或 NPC 时只调用一次 `egret_locate`，可能是图片字时传 `ocr: true`，由工具先依据 `id/name/qaName/text/source` 推理、歧义后再用 Windows/macOS 本地 OCR 补证据；仍歧义才截候选区域视觉确认，禁止枚举候选乱点。主线找人统一描述为“任务目标 NPC”，优先使用 `role: quest-npc`；不要猜中文名对应哪个内部英文资源名。
2. 连续的 `dialogue-continue` / `guide-continue` 用一次 `egret_advance max: 6, paceMs: 320, stableMs: 180` 均匀推进；工具会等待逐字文本稳定，并在选项或面板切换时停下。禁止用 `egret_run_steps` 重复点击 `talk_txt/bg`；工具也会拒绝这种脚本。`advanced: 0` 时立即读取 `stopped/current/hint` 并重新看一次场景，不做空等待。
3. 未知或不可逆操作逐步验证；已确认的安全路线用短 `egret_run_steps` 批量跑到下一个检查点。
4. 默认不点对白的“自动/AUTO”；手动快速推进只用 `egret_advance`。只有用户明确要求自动播放时才读取 `selected` 后开启一次，并等待正文变化验证。普通点击只等 2–3 秒；等待内容变化必须指定目标，不用空条件 `changed`。`interrupted` 后处理返回的 `overlay.recommendedTarget` 或关闭控件。
5. 任务文字变化后先用 `egret_locate` 定位完整任务文案；返回 `role: task-tracker` 且不歧义时直接点击它触发游戏导航，再等待任务文字、地图位置或对白界面变化。不要先截图搜索整张地图。结束前检查进度 `x/y`、可见的“立即前往/继续”和未锁定章节；仍有可达入口就继续。未达到完成条件必须报告 `INCOMPLETE`，不得把局部推进描述为完整验收。
6. 非阻断 warning 只记录，不能仅凭 warning 推断“配置缺失”等根因。只有预期后置条件持续不满足且同一错误可复现、时间上相关时，才报告为缺陷；否则标记为噪音或待确认。崩溃、掉线或恢复后仍无法推进时才停止当前分支。

浏览器闪退或扩展断连时改用 `egret-session-recovery`，恢复最近检查点后继续原目标。

关闭卡住界面时先走可见关闭/返回；没有关闭控件时用 `egret_dismiss_popups {"max":1}` 尝试半透明遮罩并确认面板消失；仍阻塞才可用 `closeModule` 恢复，并记录该动作，不把它算作正常玩家验收。

用户在当前任务明确允许测试命令，且 `splan_call probe` 返回 `debug.loaded: true` 时，才可调用 `splan_test_command` 补充货币、道具或能量。允许消耗已有资源不等于允许测试命令。

走通新玩法后写 `kind: "route"`：记录环境、起点、稳定 UI 定位步骤和完成条件，不保存临时 `hash`；复用前核对环境。调试直达另记 `shortcut`，恢复动作记 `recovery`。

## 定向回归

- 每个定位条件先在真实页面验证；等待时长用 `stableMs` 实测。
- 用例写成 `egret_run_steps`；可选弹窗用 `optional`，偶发抖动用一次 `retry`，交付前完整跑一遍。
- `pageErrors` 不直接判失败；区分真实缺陷、环境问题和已知噪音。

本插件负责显示对象、命中、属性和运行期错误；固定环境、视觉基线、性能和弱网继续交给项目的 Playwright / AI Tester。
