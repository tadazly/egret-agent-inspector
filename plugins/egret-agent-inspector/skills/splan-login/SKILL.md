---
name: splan-login
description: Splan 内网测试服切换账号、用新号从头跑新手流程（页面存在全局 MFC 且加载了 config/debug.js 时适用）。在登录页要换号、要用新号测新手，或掉线重开后要回到原来的号时读。
---

# Splan 切换账号

走 debug.js 的内网免密登录（`debugLogin`），不用输密码；不存在的账号服务端会自动建号。只在登录页能用，已经在游戏里就先 `egret_navigate` 重开当前页面。

- 换到指定账号：`splan_call {"action":"login","account":"agent051"}`。
- 用新号跑新手：`splan_call {"action":"login","newAccount":true}`，账号是 `agent` + 秒级时间戳，返回的 `account` 要写进报告。
- 掉线重开后回到原来的号：`splan_call {"action":"login"}`，不传 account 就是上次切换的号。
- 返回 `ok` 就已进服，接着 `egret_observe`。新号先播入场动画，表上出现「跳过动画」就点它。

报错时停下来告诉用户，不要自己绕：

- 「没有勾选同意用户协议」：请用户在登录页勾选，不要替用户点协议。
- 「没有 debugLogin」：页面的 debug.js 还没更新。
- 「不能免密切换」：当前服务器要校验账号密码，只能用户自己登录。
