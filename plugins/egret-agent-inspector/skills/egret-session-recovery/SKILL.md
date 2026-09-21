---
name: egret-session-recovery
description: 恢复浏览器闪退、关闭或扩展断连后的 Egret 游戏验收现场，并在重复闪退时采样运行态指标排查疑似内存泄漏。用于继续被中断的自动游玩、回归或缺陷排查；不用于普通首次安装。
---

# Egret 会话恢复与泄漏排查

## 恢复并继续

1. 从当前任务及 `egret_notes` 的 `checkpoint` / `route` 取原 URL、账号名、最近稳定界面和真实 UI 路线；不记录密码。
2. 调用 `egret_extension_status`。浏览器已退出且扩展目录仍为 `managed` 时，用 `egret_reopen_browser` 打开原 URL，不要重装扩展；等待重连后再 `egret_list_tabs`、`egret_status`。
3. 会话未保留时按原账号重新登录。用可见 UI 和已验证 `route` 回到最近检查点，不用调试接口直达；以当前 `egret_observe` 为准，避免重复不可逆操作。
4. 继续原验收目标。把恢复动作写成 `recovery`，稳定检查点写成 `checkpoint`；二者不算真实玩家入口证据。

恢复一次失败不要结束任务；同一步骤再次导致浏览器闪退时，先保留现场信息，再转入下方排查。

## 疑似内存泄漏

- 在同一稳定检查点调用 `egret_runtime_stats` 建基线；最小复现流程重复 3 次，每次界面稳定后采样，并在边界读取新增 `egret_get_errors`。
- 记录最后成功步骤、闪退时间、URL、浏览器/扩展版本，以及各轮 `jsHeap.usedBytes`、显示对象和监听数量。`jsHeap` 不可用时如实标注。
- 只有稳定后的多轮指标持续增长且无法回落，才报告“疑似泄漏”；单次峰值、一次闪退或 `performance.memory` 变化不能证明泄漏。JS 指标平稳但仍闪退时，注明可能在 GPU、原生进程或浏览器侧。
- 同一复现最多自动恢复两次；之后停止该复现分支并提交证据，其他可达验收分支继续。
