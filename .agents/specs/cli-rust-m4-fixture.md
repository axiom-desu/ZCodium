# CLI Rust M4 补充：共享 `http_fixture` 可靠性与计数约定

## 范围与所有权

本 spec 是 `.agents/specs/cli-rust-m4-model.md` 的独立补充，只覆盖 `apps/zcode-cli-rust/crates/model` 下 `#[cfg(test)]` 的共享回环 HTTP fixture（`http_fixture`）。它不修改主 M4 spec，也不改变 `HttpModel` 的请求、重试、取消与 stream 所有权；不新增生产行为、不引入 feature、不改 `scripts/**` 与 `examples/**`。

M4 共享 fixture 是 `provider_tests` / `provider_retry_tests` 的唯一 mock 实现（`crates/model/src/http_fixture/`）。本 spec 修正 reviewer 指出的计数、取消、长度解析与 Retry-After 语义缺口，并把它们固定为可回归的验收。

## 修订背景（相对主 M4 spec 的补强）

主 M4 spec 的 fixture 约定存在以下已确认问题，本 spec 逐条取代：

1. `finish()` 取消 shutdown 后直接 abort handler，只统计“已完整读取请求”的次数。取消后若仍出现迟到连接，该连接在读完请求前被 abort，不会被 `requests` 计数，造成 under-count，测试断言 `== expected` 无法发现多余 attempt。
2. `finish()` 只返回单一 `usize`，用例无法同时断言 accept 层与完整读取层。
3. fixture 未实现 `Drop`，用例在 `finish` 前 panic 会遗留 server/handler 任务与连接。
4. `Content-Length` 解析把“存在但非法”的值当成 0，且没有请求头/请求体大小上限。
5. Retry-After 断言注释声称“不含响应写入耗时”，但观测点本来就是第二次请求完整读取时刻，区间必然包含首响应处理耗时；该区间只能是 Retry-After 的下界，需要明确措辞并可校验排定的 `delayMs`。
6. 事件 channel 提前关闭的立即失败语义缺少直接单测。

## 计数与 `finish` 约定

- fixture 分别维护两个计数：
  - `accepted`：`accept(2)` 层成功接受的连接数，在 accept 循环内递增。
  - `complete`：已读到 `\r\n\r\n` 且按 `Content-Length` 读完请求体的连接数，在 handler 完成读取后递增；只有 `complete` 触发 `observed`。
- `finish()` 的时序：取消 shutdown → server 循环退出 → 在关闭 listener 前**非阻塞 drain accept backlog**（每个被接受的连接计入 `accepted`）→ `JoinSet::shutdown()` 中止仍阻塞在 shutdown 上的 handler → join server。
- `finish()` 返回 `FixtureStats { accepted, complete }`。`accepted` 与 `complete` 都是最终值，用例必须同时断言两者等于期望 attempt 数，才能发现“被接受但未读完”或“读完但未观测”的多余 attempt。
- 正常取消路径下，同步点（例如 `seen()` 或模型首个文本事件）保证首个请求已 `complete`，因此取消用例的 `accepted == complete == 1`；任何 `accepted > complete` 都是迟到/多余 attempt，测试必须失败。
- `FixtureStats` 提供 `assert_attempts(label, accepted, complete)` 便捷断言，字段仍公开给需要区分两者的专门用例（如 drain 回归）。

```text
client attempt #n ──connect──▶ accept(2)                       [accepted += 1]
                                   │
                          handler 读 \r\n\r\n + Content-Length body
                                   │
                          完整请求                             [complete += 1,
                                   │                            arrivals.push,
                                   │                            observed.send]
                          responder(seq) → Close/Hold/Pending

finish() 事件顺序（所有者：Fixture 拥有 shutdown 与 server JoinHandle）:
  shutdown.cancel()
      │
  accept loop break（此处已无 accept future 借用 listener）
      │
  drain_accepts(listener): backlog 中迟到连接                   [accepted += 1]
      │                      ← 关键：不再直接 abort 造成 under-count
      │
  JoinSet::shutdown(): 中止阻塞在 shutdown 上的 Hold/Pending handler
      │
  server join
      │
  FixtureStats { accepted, complete }  → 用例同时断言两者
```

## 生命周期与 panic 安全

- `Fixture` 的 server handle 存为 `Option<JoinHandle<()>>`。
- 实现 `Drop for Fixture`：取消 `shutdown` 并 `abort()` server 任务。handler 由 server 持有的 `JoinSet` 管理，server 任务被 abort 时其 `JoinSet` 一起 drop 并中止全部 handler，避免用例 panic 时遗留任务/连接。
- `finish()` 先 `take()` server 再 join；即使 join 超时 panic，`shutdown` 已取消、server 会被 Drop 中止。

## 请求读取与严格解析

- 先读到请求头边界 `\r\n\r\n`，再按 `Content-Length` 读完请求体；连接在完整请求前关闭返回 `Ok(false)`，不计数。
- 请求头大小上限 `MAX_HEAD = 1 MiB`，超过返回 `InvalidData`，不再用 `assert!` panic。
- `Content-Length` 严格解析：
  - 存在即必须是合法非负十进制 `usize`，非法值返回 `InvalidData`，**不得默认成 0**。
  - 重复 `Content-Length` 头返回 `InvalidData`。
  - 值超过 `MAX_BODY = 1 MiB` 返回 `InvalidData`，避免无界分配。
  - 缺失 `Content-Length` 视为无 body（0）；本套模型请求均为带 JSON body 的 POST。
- 字节级 SSE 分片仍由 `SseDecoder` 单测覆盖，fixture 不制造伪分片。

## Retry-After 语义（取代主 spec 的措辞）

- fixture 在**完整读取**每个请求后记录 `arrivals[i]`。
- 因此 `arrivals[1] - arrivals[0]` 是“第一个完整请求被 fixture 观测到”到“第二个完整请求被 fixture 观测到”的墙钟区间；该区间**包含**首个响应的读取、解析与退避调度耗时，只能是 Retry-After 等待时长的**下界**，不能据此断言精确退避时长。
- 断言：`arrivals[1] - arrivals[0] >= Retry-After - 容差`（1s 用 900ms 容差），并额外校验 `model_retry_scheduled` 事件的 `delayMs == 1000`（`Retry-After: 1`、`baseDelayMs=0`、`jitter=false`）来证明排定值正确。
- 首个请求到达 fixture 的时刻与第二次 attempt 的发起时刻之间不存在“fixture 记录第二次请求时漏掉首响应耗时”的问题；区间是下界而非近似值。

## 事件 channel

- `wait_for_event` / `expect_text_event` 在 channel 提前关闭时必须立即 panic，不能把 `recv()` 返回 `None`（正常结束）当成事件命中。
- 新增单测直接 drop sender 后调用 `wait_for_event`，断言立即失败（远小于 `Bounded` 的 10s deadline）。

## 文件与模块边界

- `http_fixture` 主体保持 <400 行；字节级 IO（请求读取、严格长度解析、accept drain、响应写出）拆到子模块 `http_fixture/io.rs`。子模块可访问父模块 `Response` 的私有字段，避免为拆文件而放宽字段可见性。
- 只改 `crates/model/**` 与本 spec；不改主 M4 spec、oracle 脚本、example、生产逻辑。

## 验收场景

1. 计数：每个既有集成用例在 `finish()` 后同时断言 `accepted` 与 `complete` 等于期望 attempt 数。
2. 取消与迟到连接：正常取消用例 `accepted == complete == 1`；专门回归用例在 `finish` 前建立一条不发请求的迟到连接，断言 `accepted == 1 && complete == 0`，证明 drain 会计入 backlog。
3. 严格解析：`Content-Length` 合法、非法、负数、重复、超 cap、缺失各一组单测。
4. Retry-After：正值场景断言两次完整请求间隔下界并校验 `delayMs == 1000`。
5. channel：drop sender 后 `wait_for_event` 立即失败。
6. panic 安全：`Drop` 取消/abort（由取消与迟到连接用例的实际 join 行为间接验证）。

## 验证命令

从 `apps/zcode-cli-rust` 执行：

- `cargo test -p zcode-cli-model`（多轮，确认无 flake）
- `cargo clippy -p zcode-cli-model --all-targets -- -D warnings`
- `cargo fmt -p zcode-cli-model -- --check`
- 仓库根：`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`
