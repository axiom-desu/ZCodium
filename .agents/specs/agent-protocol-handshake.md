# Agent 协议握手门禁与响应校验可读化

## 问题

真机截图里出现过一整段 Zod issues 原文被当作聊天消息渲染：`session/messages` 的严格 schema 要求
`sessionId/messageId/partId`，而远端 Agent 返回的是 `sessionID/messageID/id/time`。用户看到的是
schema 细节，既读不懂也无法自纠；真正的根因（对端协议版本/键名与桌面端不一致）被埋在文本里。

两处结构缺陷：

1. **握手层没有校验**：`zcodeAgentService.initialize` 只上报自身 `protocolName`/`protocolVersion`，
   从不读取对端协议身份，因此版本不匹配不会在握手期暴露，而是一路走到业务 schema 才炸。
2. **错误文本直接透传**：`zcodeProtocolClient.resolveResponse` 把 `ZodError` 原对象 reject 出去，
   其 `message` 就是 issues 的 JSON 文本，最终进入 UI。

## 规则

- **唯一所有者**：响应形状的校验只发生在 `zcodeProtocolClient.resolveResponse`（所有 method 共用同一
  响应解析点）。不得在各业务方法里重复拼协议错误。
- **握手期暴露**：`initialize` 在 client 就绪后做一次**只读探针**（`session/list`，`limit: 1`），
  用真实响应验证对端 wire 形状。探针失败且归类为协议不兼容时，`initialize` 返回
  `available: false` 并携带 `reasonCode: "agent_protocol_mismatch"`；探针因其它原因失败（存储未就绪、
  超时等）**不得**改变现有 `available: true` 的可恢复语义。
- **可读文本**：协议失败的错误消息必须包含「方法名 + 本机协议身份 + 对端协议身份（未知则明说）」，
  且长度有界（≤300 字符）。**禁止把 issues 原文、原始 JSON、对端返回体当消息文本。**
- **字段摘要允许保留**：最多 3 条 `path: message` 形式的字段摘要，用于自纠；超出部分丢弃。
- **不猜版本**：读不到对端协议块时写「未声明协议版本」，不推断、不伪造版本号。

## 接口

`packages/shared/src/zcode-protocol/handshake.ts`（纯函数，无 zod 依赖）

| 导出                                                                                  | 说明                                                                |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `readProtocolIdentity(value)`                                                         | 从任意响应体里读 `protocol: { name, version }`；不合形状返回 `null` |
| `isProtocolIdentityCompatible(expected, actual)`                                      | name 与 version 同时相等才算兼容                                    |
| `summarizeProtocolIssues(error, limit = 3)`                                           | 鸭子类型读 `issues`，拼 `path: message`，有界                       |
| `formatZcodeProtocolMismatchMessage({method, expected, actual})`                      | 版本不匹配的可读文本                                                |
| `formatZcodeResponseInvalidMessage({method, expected, issues})`                       | 形状不符的可读文本                                                  |
| `ZCODE_PROTOCOL_MISMATCH_REASON_CODE` / `ZCODE_PROTOCOL_RESPONSE_INVALID_REASON_CODE` | 稳定错误码                                                          |

`packages/services/src/zcode-agent/protocolResponseValidation.ts`

| 导出                                                     | 说明                                                                        |
| -------------------------------------------------------- | --------------------------------------------------------------------------- |
| `ZCodeProtocolResponseError`                             | 携带 `code`、`reasonCode`、`details`（method / expected / actual / issues） |
| `normalizeResponseParseFailure({method, result, error})` | 响应解析失败 → 上表的可读错误；版本不匹配优先判为 mismatch                  |

## 事件顺序

```
initialize
  → getClient（启动/复用进程）
  → probe: session/list(limit=1)  ── 校验失败且属协议类 → available=false + agent_protocol_mismatch
                                  └─ 其它失败 → available=true（沿用既有可恢复路径）
业务请求
  → client.request(method, params, schema)
      → resolveResponse → schema.parse 失败
          → normalizeResponseParseFailure → ZCodeProtocolResponseError（可读消息，含 method 与双方身份）
```

## 验收

1. 对端返回 camelCase/大小写不一致的 `session/messages` 键：错误消息包含方法名与本机协议版本，
   **不含** `issues` 的 JSON 原文，长度 ≤300。
2. 响应携带 `protocol: { name: "ZCode Protocol", version: 3 }`（本机 v1）：判为 mismatch，
   `details.actual.version === 3`，消息里同时出现 `v1` 与 `v3`。
3. 响应没有 `protocol` 块且解析失败：消息写「未声明协议版本」，不出现 `undefined`/`NaN`。
4. `summarizeProtocolIssues`：超过 3 条 issue 只保留 3 条；非对象 issue 跳过；无 `issues` 返回空数组。
5. `initialize` 探针遇到非协议错误（如 storage 未就绪）：仍返回 `available: true`。

## 范围外

- 不做协议自动降级/自动翻译对端字段（拒绝以兼容层掩盖版本不匹配）。
- 不改 `ZCODE_PROTOCOL_VERSION` 数值，不引入 V4 wire 语义变化。
- 上游 3.17.2 没有这套门禁（`zcodeAgentService.initialize` 同样只上报自身版本），这是本仓新增约束。
