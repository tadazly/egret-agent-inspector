# E2E 用例格式

```json
{
  "name": "打开并关闭公告",
  "steps": [
    { "action": "navigate", "url": "https://example.com/game/" },
    { "action": "waitFor", "className": "MainPanel", "timeoutMs": 30000 },
    { "action": "tap", "qaName": "MainPanel__btn_notice" },
    { "action": "waitFor", "className": "NewNoticePanel", "stableMs": 300 },
    { "action": "assert", "qaName": "NewNoticePanel__txt_title", "expect": { "visible": true, "textContains": "公告" } },
    { "action": "tap", "id": "btn_close", "note": "关闭公告" },
    { "action": "waitFor", "className": "NewNoticePanel", "state": "gone" }
  ]
}
```

| action | 参数 | 说明 |
| --- | --- | --- |
| `navigate` | `url`、`newTab` | 打开页面并等待加载 |
| `tap` / `drag` / `setProps` | 同对应 `egret_*` 工具 | 操作组件 |
| `waitFor` | 查询条件、`state`、`timeoutMs`、`stableMs` | 未满足即判定失败 |
| `assert` | 查询条件、`index`、`expect` | 校验组件状态，见下表 |
| `evaluate` | `expression` | 执行页面脚本，只在必要时使用 |
| `sleep` | `ms` | 固定等待，最长 60000 |
| `screenshot` | — | 留存过程截图 |

`expect` 字段（省略时默认 `{ "visible": true }`）：

| 字段 | 含义 |
| --- | --- |
| `exists` | `false` 表示不应存在匹配对象 |
| `visible` | 在舞台上是否可见 |
| `count` | 匹配对象数量 |
| `text` / `textContains` | 文本完全相等 / 包含 |
| `props` | 属性值，如 `{ "selected": true, "enabled": false }` |

查询条件即 `egret_find` 的条件：`qaName`、`id`、`name`、`className`、`text`、`source`、`match`、`rootHash`。

每个步骤可加 `note` 说明意图，会原样出现在结果中。运行参数 `stopOnFailure`（默认 true）和 `screenshotOnFailure`（默认 true）在调用 `egret_run_steps` 时传入。

结果中的 `pageErrors` 为用例运行期间页面产生的错误（未捕获异常、资源加载失败、console.error 等），不影响 `passed`，需要在报告中单独说明。
