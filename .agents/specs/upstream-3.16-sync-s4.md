# S4：模型失败分类与失败 usage 结算（TS + Rust）

父规格：`.agents/specs/upstream-3.16-sync.md`「模型失败与 usage」。上游来源
`3c5b2276`（3.16.2）；TS 以 `adapters/src/model/{runner-diagnostics,errors,runner-generate,runner-stream}.ts`
与 `contracts/src/{events/session.events.ts,model/contracts/status-contracts.ts}` 为准。
Rust 没有同名文件，按本仓已提取的 typed ports 适配。

## 唯一的分类与入账链路

```text
provider 终态 + 原始 finish reason + usage（含 provider metadata 回退）
  → 分类（adapters/model 分类器）
      ├─ 空输出 + 上下文超窗 → ModelContextExceeded（带 usage），进入既有失败链
      ├─ refusal / content-filter → 明确原因，不进空响应重试
      └─ 有 partial 输出 → 保留上游语义（成功截断仍归 Core 的 Continue）
  → 终止失败事件 model_request_failed（必带 usage 当 provider 报告时）
  → 事件账本 createModelUsageSummaryFromEvents（TS）/ RunUsage::on_status（Rust）
      只统计 ModelComplete 成功 + 终止失败 usage；重试不重复
```

不变量：

1. 只有 `hasAssistantContent == false && toolCallCount == 0` 的空输出才转成上下文错误；
   带推理签名帧也算内容。任何 partial 都不迁移 Core 的续写策略。
2. 上下文错误在成功终态**之前**抛出，因此一次请求只有一个终态；重试中的 `model_request_failed`
   不带 usage，成功仍只有 `ModelComplete` 一次入账。
3. usage 缺省即缺失（TS `undefined`、Rust `None`），不补 0。
4. 原始 finish reason 优先取协议翻译字段，其次 provider metadata（`rawFinishReason` /
   `raw_finish_reason`），最后才用归一化 finish reason。
   **协议翻译字段一旦存在（包括显式 `null`），它就是该协议对原始 finish reason 的完整事实**：
   OpenAI Responses 的 `response.completed` 没有原始原因，翻译帧写入 `_zcode_raw_finish: null`；
   此时输出 `raw_finish_reason` 必须为缺失（TS `providerMetadata.rawFinishReason ?? null` 同为 null），
   不能回落到归一化 `stop`，也不再查 provider metadata。只有该字段**不存在**（Chat Completions
   原生帧）才走 provider metadata → 归一化原因的回落。

   回归证据：`scripts/tests/cli-rust-m4-model.test.mjs` 的
   「OpenAI Responses streamed text/reason/events」真实回环差分（TS null == Rust null）；
   `crates/model/src/provider_tests.rs` 的协议原始 finish 用例固定两种键形态。

## TS 落点

- `contracts/src/model/contracts/status-contracts.ts`：
  `ModelRequestFailedStatusEvent.usage?: ModelUsage`（唯一契约来源）。
- `contracts/src/events/session.events.ts`：仅 `createModelUsageSummaryFromEvents`
  追加终止失败 usage；`ModelComplete` 仍是成功唯一入口。
- `adapters/src/model/errors.ts`：`AiSdkModelAdapterError.usage`。
- `adapters/src/model/runner-diagnostics.ts`：`createEmptyContextExceededError`、
  `isZeroOutputModelCompletion` 的排除集合（上下文超窗/refusal/content-filter）、
  `hasReasoningContent`、finish chunk 的 `providerMetadata.rawFinishReason` 回退。
- `adapters/src/model/runner-generate.ts` / `runner-stream.ts`：空输出超窗在 yield finish
  之前抛错，每个请求一个失败终态。
- `adapters/src/model/runner-failure-status.ts`：`failureUsageFields` 统一投影失败 usage；
  `runner-status-publish.ts`：`publishRetryBackoffCancellation` 收拢退避取消（同时把
  `runner-generate.ts` 压回 max-lines 400 以内）。

TS 的 ToolSearch 请求准备/转换（`transform`、`tool-transform`、`tool-search.ts`）不属于本切片。

## Rust 冻结的公开 API（供后续 Core ToolSearch 切片消费）

`domain::model`（经 `core-api` 重新导出）：

```rust
pub struct ToolSearchCapability { pub protocol_supported: bool, pub default_enabled: bool }
impl ToolSearchCapability {
    pub fn new(protocol_supported: bool, default_enabled: bool) -> Self;
    pub fn for_access(anthropic: bool, access_type: &str, access_mode: Option<&str>) -> Self;
}
pub struct ModelRequestOptions { pub tool_search_enabled: bool }
impl ModelRequestOptions { pub fn native_tool_search() -> Self; }
```

`ModelPort`（`core-api`）：

```rust
fn tool_search_capability(&self) -> Option<ToolSearchCapability> { None }
async fn complete_with_options(
    &self, messages: Vec<Value>, tools: &[Value],
    options: &ModelRequestOptions, sink: &EventSink, cancel: &CancellationToken,
) -> Result<ModelOutput, ModelFailure>;  // 默认：false 委托 complete，true 拒绝
```

既有 `complete(...)` 签名与全部既有调用/测试保持不变；`HttpModel::complete` 现为
`complete_with_options(default)` 的薄委托。默认实现在 `tool_search_enabled == true`
时返回 `ModelFailure::new("tool_search_unsupported", false)`（`invalid_model_request`，
发送前拒绝），不退化成普通请求。

`ModelFailure.usage: Option<Box<Value>>`：provider 原始 usage；状态投影时经
`domain::usage::model_usage` 归一（`inputTokens` 等）。装箱只为不放大
`Result<_, ModelFailure>`（clippy `result_large_err`）。

## Rust wire 约定（native ToolSearch）

- 工具目录来自既有 `tools: &[Value]`；**内部字段** `deferLoading: true`（camelCase，
  与 TS `ModelToolContract.deferLoading` 对齐）在 Anthropic wire 上编码为 `defer_loading: true`，
  且只对已发现 deferred 工具生效（Core 决定谁被曝光，适配层不猜）。
- 工具结果内容块 `{"type":"tool_reference","toolName":X}` → `{"type":"tool_reference","tool_name":X}`；
  `toolName` 绝不落到 HTTP；引用只允许出现在 tool_result 内。
- `anthropic-beta` 大小写无关查找、按逗号去重追加 `advanced-tool-use-2025-11-20`，
  保留既有 `code-execution-web-tools-2026-02-09` 等其它 beta。
- 能力（`tool_search_capability`）只读非秘密配置：`api.type == anthropic-messages`
  为 `protocol_supported`；`default_enabled` 还要求 `access.type == zhipu-coding-plan-api-key`
  或 `zhipu-account` 的 `individual-/team-coding-plan`。不恢复 requestAuth/highspeed/offpeak。
- 非 Anthropic 协议携带 native 选项 → 发送前 `tool_search_unsupported`（0 次 HTTP）。

## Rust 失败分类落点

- `model/src/model_stream.rs`：`Assembly` 增加 `reasoning_frames`（签名/加密推理帧），
  raw finish 回退链，以及「空输出 + 上下文超窗 → `context_exceeded` + usage」。
  `model_context_window_exceeded` 等仍在 `output_limit` 集合内，partial 时保持续写语义。
- `anthropic_stream.rs` / `responses_stream.rs`：thinking/redacted/reasoning item 置
  `reasoning_frames`。
- `network_status.rs`：仅终止失败（`retryable == false`）投影归一化 usage。
- `domain/src/usage/tracker.rs`：终止失败事件的 usage 记账一次；turn 汇总同源。

`core/src/app/agent_loop.rs` 及请求准备属后续 ToolSearch 切片，本切片未改。

## 验收证据（实际执行）

TS：

- `packages/adapters/test/model-failure-usage.test.ts`（真实 127.0.0.1 `node:http`
  server）：非流式空输出超窗 → `ModelContextExceeded` + 单次失败事件带 usage；
  流式空输出超窗 → 无 `finish`、一次失败终态；partial 超窗 → 保留 `finish` 不报失败；
  refusal → 单次请求、无 `model_retry_scheduled`。
- `packages/contracts/test/model-usage-failure-summary.test.ts`：失败 usage 只计一次、
  成功仍只由 `ModelComplete` 计入、事件 JSON 往返（冷恢复）与 store append/读回一致。
- `packages/contracts`、`packages/adapters` 包级 `tsc --noEmit` 与 oxlint（改动文件）通过。

Rust：

- `scripts/tests/cli-rust-m4-model.test.mjs`（真实 TS `AiSdkModelAdapter` ↔ Rust
  `model_fixture` 回环差分）：OpenAI Chat/Responses、Anthropic 三种流的
  `text/reason/events` 完全一致；Responses `completed` 的 raw reason 两侧均为 null。
- `crates/model/src/provider_tests.rs`：同一回环 fixture 固定三种协议的原始 finish 形状
  （Chat 无翻译字段 → 归一化 `stop`；Responses 显式 null → 缺失；Anthropic 字段 →
  `end_turn`），防止再次用归一化原因覆盖显式 null。
- `crates/model/src/tool_search_wire_tests.rs`（真实回环 HTTP fixture，断言真实字节）：
  native Anthropic wire 的 `defer_loading`/`tool_name`/beta、非 Anthropic 发送前拒绝、
  空输出超窗失败带 usage 且只有一个终态、partial 保留 `output_limit`、
  refusal/content_filter 不按空响应重试、provider metadata 的 raw finish 回退。
- `crates/model/src/tool_search_tests.rs`：能力矩阵（不含 highspeed/offpeak）、
  `anthropic_tools` defer 规则、`tool_reference` 字段映射、beta 合并去重。
- `crates/domain/src/usage/failed_usage_tests.rs`：终止失败 usage 一次入账 + 重试不重复。
- `crates/state/src/usage_tests.rs`：失败 usage 写入 → 关库重开（冷恢复）仍是一条事实。
- `cargo test -p zcode-cli-model -p zcode-cli-domain`、隔离 worktree 的
  `cargo test --workspace`、`cargo clippy -p zcode-cli-model -p zcode-cli-domain
-p zcode-cli-core-api --all-targets`（0 warning）、`cargo fmt --check` 通过。

不在本切片范围、工作树中由并行 worker 造成的失败在此不计入：
`crates/core/src/app/event_projection.rs` 超 400 行、`crates/core/tests/runtime_consistency`
在共享工作树失败（隔离 worktree 上同样用例通过）、`crates/state/src/node/fixture_tests.rs`
编译错误、contracts 导出面 fixture 未含 S1 新导出。
