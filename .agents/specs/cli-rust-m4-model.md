# CLI Rust M4：模型协议验收

## 范围与所有权

`HttpModel` 是请求、attempt/retry、取消及 provider stream 的唯一所有者；`model_protocol::body` / `ProtocolStream` 分别负责请求序列化和响应事件解码，`SseDecoder` 按 SSE 帧边界分割数据。调用方 core 只拥有取消 token，不复制网络/重试状态。

TS oracle 直接执行本仓库 `apps/zcode-cli/packages/adapters/src/model/runner.ts::AiSdkModelAdapter`，经 `model-execution.ts` 及实际 AI SDK provider 的流式路径；`runner-retry.ts` / `retry-policy.ts` 是重试来源。core 仅提供上游请求/abortSignal 接口，不是完整 provider adapter。

本切片只覆盖 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 的所列场景，不改变生产模型逻辑、默认 runtime、协议或存储。测试包含 Rust model crate、`examples/model_fixture.rs` 与 `scripts/zcode-cli-rust-m4-model-oracle.mjs` / `scripts/tests/cli-rust-m4-model.test.mjs`。

## 必须维持的行为

- 请求体、事件映射及终止标记由既有协议实现负责；SSE 可跨任意字节边界，包括 UTF-8 与 CRLF。确定性分片由 `SseDecoder` bytewise 单测证明，TCP write 边界不是客户端 read 边界。
- 非 retryable 错误不重试；一次逻辑调用最多 `max_retries + 1` 次 attempt；取消在等响应头、流读取、退避期间返回 cancelled，不启动后续 attempt。
- Retry-After / 指数退避由既有 policy 拥有，测试不引入产品 timeout/fallback。
- provider 错误不得伪造有效成功文本；Responses `response.failed` 的跨实现分类差异见下方，未擅自选择新语义。

```text
ModelPort::complete → HttpModel 构造请求 → attempt 发 HTTP
  → HTTP/SSE → ProtocolStream → ModelOutput/EventSink
  → 成功返回，或 retry 事件 → 可取消等待 → 下一 attempt
  → 不可重试 / cancelled / 次数耗尽 → 失败

test → Node-owned loopback fixture
  ├─ 独立实例 → 真实 TS AiSdkModelAdapter.streamText
  └─ 独立实例 → Rust model_fixture → 真实 HttpModel.complete
                       ↓
        同一脚本响应，比较稳定语义；不比较随机 ID / 时长
```

## Rust fixture 与验收

唯一共享 mock 在 `crates/model/src/http_fixture/{mod,io}.rs`，仅 `cfg(test)` 编译；详细计数和生命周期契约见 [fixture 补充](cli-rust-m4-fixture.md)。

- 完整读取 `\r\n\r\n` 请求头和 Content-Length body，非法/重复/超上限长度失败，不以单次 read 代表完整请求。
- 分别统计 accepted TCP 连接与 complete 请求；finish drain accept backlog，取消用例同时断言两层无额外 attempt；Drop 取消/abort 避免 panic 泄漏。
- 有界 `Bounded` 覆盖模型调用、事件等待、server join；channel 提前关闭立即失败；通道/请求观测作同步，不固定 sleep。
- 三协议成功 SSE、Responses error、503 后成功、400 不重试、attempt 上限、退避取消、流中取消、收到请求未返回 headers 时取消。
- `Retry-After: 1` 检查 retry-scheduled 的 `delayMs == 1000`，并验证第一次完整请求至第二次完整请求至少 900ms。该区间包含第一响应读取/解析等开销，只是下界证据，不是精确退避时长证明；不包含第二次响应写入耗时。

Rust model 定向测试本轮实际通过 32 项；包含读取长度、迟到连接和 channel 提前关闭等回归。未改 `HttpModel` 生产逻辑。

## 真实 TS oracle 契约与验收

- Node 是差分 HTTP fixture 的唯一 owner，监听 `127.0.0.1:0`；TS/Rust 使用独立实例和相同响应脚本。JS 入口拒绝非 `http://127.0.0.1` endpoint。
- Rust example JSONL 输入 `{config,messages}`，用空 RuntimeEnv 构造 Egress，不调用读取进程 HOME 的 runtime egress 工厂；输出成功的 `{ok,text,reason,events}` 或失败 `{ok,reason,statusCode}`。
- TS 显式 `env:{}`，不继承用户模型/代理配置；Rust 子进程白名单环境只传临时 HOME。无真实凭据、用户库或外网模型调用。
- TS maxAttempts 包含首次，映射 `Rust maxRetries + 1`，baseDelayMs=0、jitter=false。
- 文本事件按 `{reasoning,text}` 合并连续同类增量；finish reason 取两侧 raw reason，无值为 null。不对 usage/status/tool events 或原始请求体作 parity 声明。
- 三协议成功流逐项比较 text/raw reason/events；503→success 两侧恰好 2 次 attempt；400 两侧恰好 1 次。
- fixture 同时记录 accepted 与 complete；强制 `Connection: close`，使这些场景每个 attempt 对应一个连接。只在该策略生效场景断言 accepted=complete，不将其当成 HTTP 通用不变量。
- 部分连接（accepted=1、complete=0）可观察；handler 捕获 teardown abort，但真实错误保留并返回 500，清理后重新抛出，不产生 unhandled rejection。不能用 `req.destroyed` 单独判断 abort，正常读完 body 该值也可能为 true。
- 子进程 deadline 到达后 POSIX kill 独立进程组，等待 close 再返回；Windows 只 kill 直接子进程，未验收其后代清理。临时 HOME/连接/server 在 finally 有界清理。详见 [driver lifecycle](cli-rust-driver-lifecycle.md)。

Node M4 driver 本轮实际通过 9 项，并多轮重跑。

## 已确认分歧与未完成边界

- Responses `response.failed`：真实 TS stream 结束为 finish（raw reason=`error`），Rust 返回 failure（reason=`unknown`）。测试明确记录两种结果，不把它归一化成 parity。要否采用同一业务失败语义，须先对齐产品规则，不在测试里掩盖差异。
- 目前证明的是三个协议所列文本/原始 reason/事件和 HTTP 重试次数，不是全部请求体、工具调用、usage、错误码、provider 或取消链路的跨实现 parity；取消三阶段目前为 Rust loopback 验收。
- mock 基于 loopback socket，不是确定性 transport；精确字节分片证据来自 decoder 单测。

## 验证入口

- `cargo test --locked --manifest-path apps/zcode-cli-rust/Cargo.toml -p zcode-cli-model`
- `node --import tsx --test --test-isolation=none scripts/tests/cli-rust-m4-model.test.mjs`
- `pnpm check:zcode-cli-rust` / `pnpm test:zcode-cli-rust-drivers`

整体结果见 [handoff](cli-rust-handoff.md)，不以本切片宣称 M4 全面完成。
