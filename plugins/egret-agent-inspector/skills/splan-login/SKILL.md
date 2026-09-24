---
name: splan-login
description: Splan 内网测试服切换账号、用新号从头跑新手流程、按条件挑已有测试账号并登记账号状态（页面存在全局 MFC 且加载了 config/debug.js 时适用）。在登录页要换号、要干净的或满足条件的测试号、要用新号测新手，或掉线重开后要回到原来的号时读。
---

# Splan 切换账号

走 debug.js 的内网免密登录（`debugLogin`），不用输密码；不存在的账号服务端会自动建号。只在登录页能用，已经在游戏里就先 `egret_navigate` 重开当前页面。

- 换到指定账号：`splan_call {"action":"login","account":"agent051"}`。
- 用新号跑新手：`splan_call {"action":"login","newAccount":true}`，账号是 `agent` + 秒级时间戳，返回的 `account` 要写进报告。
- 掉线重开后回到原来的号：`splan_call {"action":"login"}`，不传 account 就是这个标签页上次切换的号。
- 返回 `ok` 就已进服，接着 `egret_observe`。新号先播入场动画，表上出现「跳过动画」就点它。

## 要号先查，用完登记

测试账号登记在本机的 `egret_notes`（`kind: "account"`）里：`splan_call login` 成功、新手进度变化会自动记下。

- 要号：`egret_notes {"action":"search","kind":"account","q":"干净 新手已走完"}`，或按需要的状态搜（如「主宠 Lv20」）。有合适的就 `splan_call login` 那个号；没有再建新号，新号跟 `{"op":"guide"}` 走完新手才算干净。
- 用完：号的状态变了（加了经验、花了道具、推进了关卡）就记一句，标成用过：`egret_notes {"action":"add","entries":[{"kind":"account","key":"<号>","state":"<一句话现状>","clean":false,"usedBy":"<测试名>"}]}`。

报错时停下来告诉用户，不要自己绕：

- 「没有勾选同意用户协议」：请用户在登录页勾选，不要替用户点协议。
- 「没有 debugLogin」：页面的 debug.js 还没更新。
- 「不能免密切换」：当前服务器要校验账号密码，只能用户自己登录。
