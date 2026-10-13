# CLI Rust M4：模型协议验收

## 范围与所有权

范围仅为 `apps/zcode-cli-rust/crates/model` 与本 spec。`HttpModel` 是请求、重试、取消及 provider stream 的唯一所有者；`model_protocol::body` / `ProtocolStream` 分别负责三种请求序列化和响应事件解码，`SseDecoder` 负责仅按 SSE 帧边界分割数据。无产品功能扩展，不改变 core/state/CLI 接口。

M4 对照本仓 TS provider adapter：`apps/zcode-cli/packages/adapters/src/model/runner.ts`、`runner-retry.ts`、`retry-policy.ts`、`model-execution.ts` 及协议相关适配器（`transform.ts`、`anthropic-stream-compat.ts`、`openai-responses-json-compat.ts` 等），并参考 `packages/core` 仅作请求接口/abortSignal 上游边界。不能把 core 调用层描述为完整 provider adapter。验收仅覆盖 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 三种协议，不宣称其它 provider 完整兼容；若没有真实 TS adapter 执行形成的 oracle 对照，则只记录静态源码对照，不声称自动 parity。

## 必须维持的行为

- Chat、Responses、Anthropic 各自请求体、事件映射及终止标记由现有协议实现负责；SSE 可跨任意字节分片，包括 UTF-8 字符、CRLF 和多 event 帧。
- HTTP 非成功响应按 provider/status 错误分类；非 retryable 错误不再发请求。Retry-After、指数退避及最大尝试数遵循已有 RetryPolicy，取消在请求中、流读取中与退避等待期间均终止逻辑调用，不启动后续 attempt。
- 终止事件结束 stream；provider 错误事件成为失败而非成功文本；流结束但没有有效完成结果遵循空响应重试/失败语义，不伪造成功。
- 只用本地 fixture 或回环 mock HTTP，不需要凭据、不访问外网。测试断言请求次数、输出/失败结果和必要事件，不以编译通过替代协议验收。

## 状态 / 时序

```text
ModelPort::complete → HttpModel 构造一次请求体 → attempt 发 HTTP
  → HTTP/SSE 帧 → ProtocolStream → ModelOutput/EventSink
  → 成功：完成并返回；可重试失败：retry 事件 → 等待（可取消）→ 新 attempt
  → 不可重试/取消/次数耗尽：失败返回
```

取消 token 的调用方是 core，HttpModel 在 transport 与 backoff 上观察它；attempt/网络流不在其它层复制状态。一次逻辑调用最多运行 RetryPolicy 的 `max_retries + 1` 次 attempt；取消不得被错误归类为重试。

## 验收场景

- 三协议从本地 mock HTTP 返回拆成任意 packet 的 SSE，包含终止、错误和 usage/文本等关键帧，验证成功输出或明确失败。
- 请求/流中取消及 retry backoff 取消，验证 promptly 返回 cancelled 且后端观察不到多余 attempt。
- 可重试 HTTP 错误后成功、不可重试 HTTP 错误、attempt 上限与 Retry-After 语义；全程使用短可控 retry 配置，不依赖公网或认证凭据。
- 先运行既有针对性测试并登记差异，再补测试；仅确认真实漂移后才改实现，修复处以中文注释解释原因和依据。TS adapter 当前仅进行源码行为对照；除非能运行同输入的三协议 TS fixture 并比较输出/失败，否则不称为真实 TS oracle。

## 决策与边界

先固定 mock 验收与 TS 来源，再根据差异做最小修复。无差异时只补缺失的关键集成测试，不添加 fallback、超时兜底或产品行为。Rust workspace 边界检查仅针对当前变更并如实报告；此任务不修改总 spec、README、package、core、state 或 scripts。

## 当前验收记录

交接补充：本地 model 测试实际通过，但 mock 仍需补全 HTTP headers/body 的读取、三协议测试 server join 的 deadline、事件 channel 提前关闭的明确失败，以及在第二次连接到达时立即记录 Retry-After 计时。当前 Retry-After 断言包含第二次请求读取/响应写入耗时；不将它视为严格退避时长证明。请求已接收但未回响应头的取消尚未覆盖。以下各轮记录仅说明当时执行范围。

- 静态源码检查：TS provider retry 行为对照 `packages/adapters/src/model/runner-retry.ts` 与 `retry-policy.ts`；协议路径须对照 adapters 中实际 provider 执行及流适配代码，core 只提供上游请求/abortSignal 边界。当前未运行同输入、同 fixture 的三协议 TS adapter oracle，不能据此宣称协议全量一致或确认无差异。
- 新增无外网回环 HTTP 验收：3 协议流响应均得到 `ok`；Responses `response.failed` 是失败；503 后按 0ms 退避重试并成功，确认共 2 个请求；流进行中取消返回 `cancelled`。SSE 集成 fixture 使用真实有效的 HTTP 响应，并以收到模型文本事件作为已进入流读取的同步点；取消后验证仅 1 次请求、无 retry、server 干净结束。之前回环 TCP 的 3 字节 `write_all` 加 `yield_now` 不能保证客户端 TCP 读取分片，因此已移除该伪分片写法，不作为任意字节分片证据；确定性字节级覆盖由既有 `SseDecoder` bytewise 测试承担。
- 针对性结果：`cd apps/zcode-cli-rust && cargo test -p zcode-cli-model` 28 passed、0 failed；本轮增补 3 个回环 HTTP 测试，覆盖 backoff 取消（只收到 1 次请求）、400 不重试（1 次请求）、503 的 max_retries=2 尝试上限（3 次请求），以及正值 `Retry-After: 1` 后至少等待 900ms 再次请求并成功。对于 400/503 和取消用例，server 在逻辑调用完成前继续 accept 并计数，避免按预期次数退出而漏掉额外请求。SSE 原有 byte-wise UTF-8/CRLF/multi-event 与 frame limit 测试仍通过。
- 边界结果：`pnpm architecture:check --changed` 0 violations；`pnpm typecheck` 通过；`pnpm lint` 0 errors、50 warnings（仓库既有警告，未触及本次文件）；`cargo clippy -p zcode-cli-model --all-targets -- -D warnings` 通过。尝试 workspace `cargo fmt --check` 受无关的 `crates/app-server/src/stdio.rs` 非法 `b'\\n'` 字面量阻塞；本次 Rust 文件已单独 rustfmt。
- 剩余边界：没有同输入的 TS adapter 自动 oracle/fixture 比较，因此只完成静态源码对照，不宣称 TS/Rust parity；mock fixture 仍未覆盖每种协议所有事件与错误体；回环 HTTP 基于本地 socket，而非确定性测试 transport。TS 侧确认 retry policy 的 maxAttempts（含首次请求）、Retry-After 合法正值等待及 abortable sleep，Rust 本轮回环测试验证其请求次数/等待/取消语义；本轮未发现需修复的生产实现漂移，未改生产逻辑。
