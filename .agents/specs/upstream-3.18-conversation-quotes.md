# 会话选区引用（conversationQuotes）完整契约（CQ6）

上游来源：`.cache/upstream-3.18.2` @ `fec97590`。
前置：CQ5 已接通 `selection → Composer → sendText.conversationQuotes → TurnInputIntentMetadata`
→ 模型材料 → 持久化 user message → userInput row。本 spec 补齐**同一 intent 的编辑/队列/重放/幂等**
与**批注输入框**，并把 CQ5 的留账收口。CQ5 的 owner 表仍然是唯一口径，本文件只追加语义。

## 1. 唯一事实与所有者

| 事实                                 | 唯一所有者                                                                                            | 复制方向                                       |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 合法 quotes 线格式（限长、strict）   | `packages/shared/src/conversationSelection.ts`                                                        | 只被读取                                       |
| 一次输入的 accepted quotes           | `TurnInputIntentMetadata.conversationQuotes`（runtime intent）                                        | 队列项 / canonical fact / 投影 row 都从它派生  |
| 已公告/已入队 quotes 的 durable 副本 | `session_input.payload.conversationInputIntent` 与 user message 的 `metadata.conversationInputIntent` | 写入只能经既有 admission / edit / promote 路径 |
| Composer 待发送引用（含批注）        | `conversationSelectionReference` 的 scope 表（composer 草稿 owner）                                   | 发送时一次读取，不二次存储                     |
| 编辑目标的原 quotes                  | canonical fact → `ConversationEditTarget.intent.conversationQuotes`                                   | 只读快照                                       |

不新增第二 accepted store、第二队列、第二草稿表。quotes 从不进入可见正文。

## 2. 契约不变量

1. **同一 strict 契约贯穿全链路**：`sendText`、`createSession.firstInput`、`editUserQuery`、
   `editQueueItem`、`TurnSteerQueued/Drained.intent`、persisted intent、projection row、模型边界
   全部使用 `conversationQuotesSchema`（≤8 条、单条 ≤8000、总量 ≤16000、`comment` ≤2000、
   `agent` ≤200、未知字段拒绝）。
2. **正文与材料分离**：`intent.text` 与 `row.text` 只含用户正文；`<conversation_quote>` 只在模型
   边界渲染一次（`withConversationQuotes`）。任何层都不得再拼 `# userselect:` 尾块。
3. **编辑语义与附件一致**：`editUserQuery.conversationQuotes` / `editQueueItem.conversationQuotes`
   `undefined` = 保留原值，`[]` = 显式清空。显式值优先于 canonical 值。
4. **重放不丢**：`retryTurn` 用 canonical quotes 重发；冷恢复用持久化 intent 的 quotes 重建行、
   edit target 与模型材料。
5. **锚点准入**（renderer，唯一判定点）：`sourceSessionId` 必须等于目标会话；
   `sourceRowId` 必须在当前投影窗口；引用捕获时记录的投影代际（`logEpoch`）必须与发送时一致。
   空投影不误判，markdown 选区无会话锚点直接放行。
6. **批注只随确认生效**：批注输入框属于“选中动作”的确认步骤。取消/Esc/失焦关闭 = 不入草稿、
   不入 accepted；确认 = 以 `dispatchConversationSelectionAdd` 写入同一草稿 owner。
7. **幂等身份包含 quotes**：同一 `commandId` 携带不同 payload（含 quotes）不是重试，而是
   `proto.commandConflict`；相同 payload 仍是 `duplicate`。冷回源只有 ACK 时维持原 replay 语义。

## 3. 事件与重放顺序

```text
选中 → 批注输入（草稿 owner 之外）→ 确认 → dispatchConversationSelectionAdd(含 comment)
  → Composer 发送前 admit(quotes)：跨会话/越代/陈旧锚点拒绝，草稿保留
  → sendText.conversationQuotes → CommandInbox(身份冲突检查) → admission 固化 intent
  → [idle] 模型边界渲染 + 持久化 user message
  → [busy] queue item.intent (durable session_input) → drain/guide 消费时同源渲染
  → 投影 row.conversationQuotes → 历史芯片
```

编辑/重试：

```text
row → resolveRowActionTarget → ConversationEditTarget.intent(含 quotes)
  → editUserQuery.conversationQuotes ?? canonical  → rewind → prompt turn(intent 带 quotes)
  → retryTurn 直接用 canonical quotes
队列撤回编辑（UI 生产路径）：deleteQueueItem → ComposerRestoreRequest.conversationSelections
  → composer 草稿 owner → 再次发送仍带同一批注
队列原地编辑（协议路径）：editQueueItem.conversationQuotes → core pendingInput.intent
  → session_input patch（conversationInputIntent.conversationQuotes）→ 冷恢复同源
```

## 4. 失败语义

| 场景                           | 结果                                                   |
| ------------------------------ | ------------------------------------------------------ |
| 线格式越界/未知字段            | zod 拒绝整条命令（`proto.invalidPayload`），不静默剥离 |
| 编辑时正文、附件与 quotes 全空 | `proto.invalidPayload`，rewind 前拒绝                  |
| 跨会话 / 陈旧锚点 / 越代引用   | renderer toast + `blocked`，草稿与引用保留             |
| 同 commandId 不同 quotes       | `proto.commandConflict`（`rejected`），不复用旧 ACK    |
| quotes 读取失败（旧转录）      | 按没有 quotes 处理，不阻断历史显示与恢复               |
| Rust runtime 收到 quotes       | 显式 `unsupported`，不静默丢弃（见 §6）                |

## 5. 验收

1. 真实 SQLite + loopback：`editUserQuery` 带新 quotes → 请求体只含新 quotes，持久 user message
   与模型一致；`retryTurn` 复用 canonical quotes。
2. 真实 SQLite 冷恢复：排队项原地 `editQueueItem` 改 quotes → 关闭 store → 重开 → drain 后请求体
   含新 quotes（`session_input` 里 `conversationInputIntent` 已更新）。
3. 幂等：同 commandId 相同 payload → `duplicate`；改 quotes → `proto.commandConflict`。
4. UI：批注确认后 `quotes[0].comment` 在场；取消后不带 comment 且不新增引用；
   跨会话/越代/陈旧锚点发送前拒绝。
5. 负向：未知字段、超限数组/单条/总量在 schema 层拒绝。

## 6. Rust 边界（显式不支持）

Rust CLI 目前没有 quotes 的材料渲染与持久化 owner。为避免“命令成功但批注丢失”的假支持：

- `runtime/capabilities.conversationQuotes` 是发送端的唯一门禁；Rust 不声明该能力，
  Host（`zcodeAgentService`）在转发前剔除 quotes 并记一次 warn。
- Rust `parse_command` 对携带 `conversationQuotes` 的 payload 显式返回 unsupported，
  而不是静默剥离后继续执行。
- 生成产物 `crates/protocol/schema/v4-command.json` 由生成脚本维护，禁止手改：`forkAssistant.targetCwd`
  与 `conversationQuotes`（`sendText` / `editUserQuery` / `editQueueItem` / `createSession.firstInput`）
  已由生成器写入 schema 与 trim oracle，所以 Rust 侧对 quotes 的拒绝来自 `refinements`，
  而不是“schema 不认识该字段所以被剥离”。schema 接受线格式 + refinement 显式拒绝这一组合是
  该边界的唯一表达，任何一侧放宽都会退化成假支持。

## 7. 未实现留账

- 手机/Web 频道仍默认不放行 quotes（沿用既有未审查频道策略）。
- `session_input` 之外的历史审计（例如按 quote 检索）不新增索引表。
