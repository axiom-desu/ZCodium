# 上游 3.18.2 模型请求面（C6：F11 provider 内置工具回放 + F12 session features 头）

父片：`.agents/specs/upstream-3.18-sync.md`（C6 组）。上游固定 `.cache/upstream-3.18.2@fec97590`
（区间 `3c5b2276..fec97590`）。Rust 参考 `.cache/upstream-rust-reference` 只读；Rust 侧冷恢复由 R2 负责，
本片不改 Rust。C1 已合入的 `core/src/agent/{message-history,message-history-entries}.ts`、
`session-history-hydrator.ts` 是共享 seam：本片只追加，不重排 C1 的指令公告/快照逻辑。

## 1. 范围与唯一所有者

| 项  | 行为                                                            | 唯一所有者                                                                  |
| --- | --------------------------------------------------------------- | --------------------------------------------------------------------------- |
| F11 | 服务端内置工具（GLM analyze_image / webReader）线协议与多轮回放 | adapters SSE/JSON 改写；core `provider-tool-rounds` 切轮/卡片/持久化/分组键 |
| F12 | 会话能力标签 `x-zcode-session-features`（只增不减）             | runtime 内存集合；session entry 只是冷恢复捷径；adapter 只写 header         |

不恢复：归因遥测、off-peak、request-auth/highspeed 执行分叉、CUA 休眠帧、官方账号端点。F12 的 header
**只**发往当前配置的模型 endpoint（`resolved.baseURL`），不新增任何额外网络请求或采集端点。

## 2. F11 线协议（adapters）

```text
provider SSE frame
  → ProviderBuiltinToolStreamRewriter（按 message 维护缓冲/配对状态）
      · server_tool_use(非 SDK 名单) → mcp_tool_use
      · 裸 tool_result（必须与已下发调用配对） → mcp_tool_result；未配对整块丢弃
      · 与结构化块重复的 markdown 渲染副本（调用头 **🌐 / 结果 ** / 摘要 **Output:**+工具标签）
        按结构确认后丢弃
      · 上游原生 mcp_tool_use 缺 server_name 时补齐
  → 既有 thinking signature 兼容 → AI SDK
```

非流式 JSON 走 `rewriteProviderBuiltinToolContent`，规则一致（结果副本必须夹在服务端调用与其配对
`tool_result` 之间）。改写只在 Anthropic fetch 边界发生，不改 Provider/Model 配置。

## 3. F11 多轮切分与持久化（core）

```text
stream tool_call(providerExecuted=true)
  → 收起当前轮 {messageId, reasoning, text, toolCall}
  → 先按顺序落盘本轮 reasoning/text part，再写 tool part(metadata.providerExecuted=true)
  → 卡片 Scheduled → Started
stream provider_tool_result(toolCallId)
  → 填入 round.result（文本归一）→ 卡片 Result
流结束/失败/取消
  → 未完成轮次按中断收口（isError=true），卡片补 Result
model result
  → text/reasoning 只保留最后一轮；providerToolRounds 带前序轮
turn 提交
  → 每轮 assistant(text, reasoning, toolCall) + tool(result)，最后一轮照旧
  → 同一持久化 assistant 拆出的 assistant entry 打 compactGroupKey = messageId
```

冷恢复：消息里存在 `metadata.providerExecuted === true` 的 tool part 时，按 part 顺序切轮
（tool part 之前的 text/reasoning 属于该轮），回放 assistant+tool；剩余 part 走原逻辑。有服务端轮次时
不把 provider usage 挂到 assistant entry（多轮合计不是上下文估算锚点）。

无 provider 轮次时必须保持原行为：正文/reasoning/tool part 全空、但持久化 usage 合法
（`persistedTokenUsageBaseline` 非空）的 assistant **仍然保留**为上下文估算锚点；它不因“抑制服务端
多轮 usage”的分支被连带丢弃，否则热历史与冷恢复的 context estimate 会不一致。
回归：`apps/zcode-cli/packages/core/test/provider-tool-rounds.test.ts`（空正文 + usage 保留），
以及 Rust 状态夹具 `node-cold.json` 的真实 TS 重放。

compact：`compactGroupKey` 参与 runtime entry 分组，保证「同一数据库消息拆出的多条 assistant」在
runtime 与持久化边界上的组数一致；无 provider 轮次时行为不变。

## 4. F12 会话能力标签

- 契约：`ModelRequestSessionFeature`（`browser_use`、`computer_use`、`tool_search_called`、
  `tool_search_local`、`tool_search_native`、`workflow_auto`、`workflow_auto_attempt`、`workflow_cmd`），
  `SESSION_ENTRY_SESSION_FEATURES = "runtime/session_features"`。
- 状态：`runtime.sessionFeatures: Set` 是唯一事实源；**放在 runtime 字段而不是 config**，workflow 子 actor
  展开父 config 时不会继承父会话标签。子 runtime 从空集合开始。
- 打点（只经 `recordSessionFeature`）：
  - 工具结果结算后按结果派生（`CreateWorkflow` 尝试/后台化、ToolSearch 成功调用、
    node_repl 浏览器/Computer Use、官方 CUA 认证组）；
  - 主循环请求准备后按 ToolSearch **实际生效模式**（local/native）；
  - 冷恢复：`entry ∪ 从全部持久化消息推导`，只增不减；fork 靠复制历史继承 fork 点前的标签。
- 读取：每次模型调用前由 runtime 读当前集合快照放进 `ModelInvocationContext`；adapter 合并进
  `x-zcode-session-features`（去重、字典序、总长 ≤256，非法值整头省略）。Provider 静态 header 里同名项
  被剔除，不允许覆盖调用上下文。compact/rewind/冷恢复不清空。

## 5. 验收与边界

- `node:test`（本仓 runner，不用上游 vitest）：
  - `adapters/test/provider-builtin-tool-compat.test.ts`：真实 loopback Anthropic SSE，经 AI SDK
    stream 断言 `mcp_tool_use`/`provider_tool_result`、markdown 副本不重复；真实 loopback 断言
    `x-zcode-session-features` 只出现在配置 endpoint 的请求头。
  - `core/test/provider-tool-rounds.test.ts`：轮次 entries、compact 分组键、冷恢复切轮、
    `selectCompactEntries` 组数不拆轮。
  - `core/test/session-features.test.ts`：结果派生、ToolSearch 模式、entry 解析/合并、冷恢复并集、
    fork/子 runtime 不继承。
- `pnpm --filter @zcode/{contracts,adapters,core,bootstrap} typecheck`、根 `pnpm typecheck`、
  `pnpm lint`、`pnpm architecture:check --changed`。

## 6. 明确差异/缺口

- 未移植上游 `ModelTextContentBlock` / `blockIndex` 有序块机制（属另一片）：本片用 part 顺序切轮，
  正常（无 provider part）消息完全走原逻辑。
- 上游 `provider_tool_result` 依赖 AI SDK `tool-result`/`tool-error` chunk；本片已在 adapter 归一化。
- Rust 侧仍按现有 `anthropic_stream.rs` 跳过服务端块；冷恢复由 R2 处理，本片不改 Rust。
- 旧会话（3.17 及以前）无 `providerExecuted` part metadata，行为不变。
