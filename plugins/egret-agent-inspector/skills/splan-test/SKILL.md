---
name: splan-test
description: 为 Splan 项目的游戏（页面存在全局 MFC 对象）生成并运行自动化测试，或自主探索排查潜在缺陷并沉淀可复用的经验。用户要求测试某个模块流程、生成测试用例、跑回归，或让 agent 自己玩游戏找 bug 时使用。
---

# Splan 自动化测试

前提同 `splan-control`（`splan_call probe` 返回 `mfc: true`），定位与操作手法复用该 skill。开工前先 `egret_notes search` 查历史经验。

## 一、生成用例

1. **先验证再固化**：用例中的每个定位条件都要在真实页面上查到过（`egret_find` / `splan_call qa`），不要从源码猜 `qaName`。
2. **入口用模块事件**：`splan_call openModule` 作为用例起点，比点击导航稳定；用例说明里写清依赖调试接口。
3. **等待时长实测**：打开面板时用 `egret_wait_for` 带 `stableMs: 200`，返回的 `settledAfterMs` 就是该界面的动画耗时，按它设置等待和 `settleMs`，不要拍脑袋填。
4. 写成 `egret_run_steps` 用例（格式见 egret-e2e-test skill 的 references/test-case-format.md），保存到项目的 `e2e/<用例名>.json`：
   - 可能出现也可能不出现的步骤（开场弹窗、首充引导）加 `"optional": true`；偶发抖动加 `"retry": 1`。
   - 清场用 `{"action":"dismissPopups","until":{"qaName":"<主界面组件>"}}`。
5. 交付前完整跑一遍。

## 二、页面错误纳入结论

`egret_run_steps` 的报告带 `pageErrors`（本次运行期间页面产生的错误）。它不直接判定用例失败，但必须在结论中说明是真实缺陷还是既有报错。

已知噪音用 `exclude` 折叠，只保留计数：

```json
{"exclude": ["Warning #1009", "Skin not found", "未设置红点信息"]}
```

确认过的噪音写进 `egret_notes`（`kind: "fact"`），不要每次重新判断。

## 三、自主探索找 bug

一轮一个动作，动作前后各看一次状态（`egret_scene` + `egret_get_errors`），不要靠连续截图试探：

- **界面**：文字截断或重叠、资源缺失、按钮点不到（`egret_scene` 的 `occluded`）、关不掉的弹窗、状态没刷新。
- **代码**：可疑控件用 `egret_inspect_code` 拿到回调函数名与源码片段，再用该片段到项目源码里检索，定位到具体文件与方法。
- **判定**：区分真实缺陷、环境问题（网络、账号、配置）和工具局限，只报有证据、可复现的。

每发现一个缺陷写一条笔记，把代码位置一并记下：

```json
{"action":"add","entries":[{"kind":"bug","key":"<模块>-<现象>","summary":"现象 + 触发路径","detail":"<类名>.<方法>，源码检索串：<片段>"}]}
```

项目侧的改进建议（弹窗缺关闭控件、命名不统一、遮挡层级等）记 `kind: "suggestion"`，一条一句话，收尾时汇总给用户。

## 四、与项目现有测试的分工

- 本插件负责**界面语义层**：显示对象、定位、命中与遮挡、组件属性断言、运行期错误。
- 项目的 Playwright / AI Tester 负责**浏览器层**：固定环境、截图基线、OpenCV、内存与性能、弱网、多轮稳定性。
- 两边不重复建设。本插件验证过的定位条件与实测耗时可直接用作 flow JSON 的 `target` 和 `settle_ms`；动作对应关系：`tap→click`、`waitFor→wait_panel`、`assert→verify`、`dismissPopups→close_popup`。
