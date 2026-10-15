# Rust CLI runtime：增量交接

最新 M8 接线实现、局部 GUI 证据和用户接手待测清单见 [M8 报告](../../docs/reports/cli-rust-m8-desktop-handoff.md)。本页的 470/50 等计数是 M8 之前的验证基线，不是本轮 M8 的最终总数；runtime/review/README 中的早期 landing 记录亦为历史基线。仍未启用默认 Rust runtime，未访问用户库、未改历史 SQL、未迁移 HOME；`logs/` 保留且不提交。

## 当前进度（不等于 M2–M8 完成）

| 切片 | 实际交付                                                                                                                                     | spec                                                                                                    |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| M2   | 已取消但尚在 active 的 run 不再接受带 expected ID 的迟到 stop；no-op 不重复提交                                                              | [状态机](cli-rust-m2-state.md)                                                                          |
| M3   | 冷读前后全量用户表/schema 不变；重复读一致；显式 load 才执行 interrupted recovery                                                            | [冷读](cli-rust-m3-cold-read.md)                                                                        |
| M4   | Rust mock 完整 HTTP 读取、双层连接/请求计数、deadline、取消三阶段；真实 TS/Rust 三协议文本流 oracle、503/400 次数对照                        | [模型](cli-rust-m4-model.md)、[fixture](cli-rust-m4-fixture.md)                                         |
| M5   | 真实 TS Read/Write/Edit/Glob/Grep oracle；Grep 文案/分页/UTF-8/BOM/context 优先级；多 hunk jsdiff、重复行 tie-break、5s 预算与 blocking 边界 | [工具](cli-rust-m5-tools.md)、[diff](cli-rust-m5-diff.md)                                               |
| M6   | 两 profile 完整 serve loop 的 subscribe/resume/gap/resync/owner/bridge/EOF；修复 resync 编码失败后永久停摆                                   | [stdio](cli-rust-m6-stdio.md)                                                                           |
| 性能 | 独立 HOME/DB、交替顺序 6 轮；可复现入口、实际 artifact 哈希、raw JSON 与统计                                                                 | [性能规则](cli-rust-performance.md)、[报告](../../docs/reports/cli-rust-runtime-handoff-performance.md) |

本轮实现由多位 worker 分文件并行，经过独立 reviewer 多轮复核；review 发现的 resync 恢复停摆、diff 无预算/阻塞、suffix 预裁剪改变 tie-break、深 Rc 链递归析构均已有回归与修复。测试子进程 deadline / kill / close 契约见 [driver lifecycle](cli-rust-driver-lifecycle.md)。

## 本轮实际整体验证

输出存本机 `/tmp/zcode-cli-round2-final/`（临时日志不是远程持久证据；以下入口可重跑）：

- `pnpm typecheck`：通过。
- `pnpm lint`：通过，50 warnings、0 errors；不将警告写成零警告。
- `pnpm check:zcode-cli-rust`：16 crate 边界、workspace fmt、all-targets clippy `-D warnings` 通过。
- `pnpm test:zcode-cli-rust`：**470 passed、1 ignored、0 failed**（前轮 437 passed）。
- `pnpm test:zcode-cli-rust-drivers`：**50/50**（前轮 21）；包含真实三协议模型、文件工具、多 hunk、固定 seed 300 对重复行和性能/清理测试。
- `node --test --test-isolation=none scripts/ci/*.test.mjs`：264/264。
- `pnpm check:zcode-cli-rust-protocol-schema`、`pnpm check:zcode-cli-rust-contract-assets`、`pnpm check:zcode-cli-rust-domain-fixtures`：通过。
- `node --import tsx scripts/sync-zcode-cli-rust-node-migrations.mjs --check`：通过。
- `pnpm architecture:check --changed`：0 violations、0 new。目标 `zcode-cli` context 为 unmanaged，未杜撰 Rust 专属注册模块。
- 构建当前 Rust binary / node_read 后运行 `pnpm test:zcode-cli-rust-interop`：alternate 1/1/1、crash 4/4/4、concurrent 2/2/2（sessions/read/equal）；source hash 不变。并发仍仅不同 workspace，不代表 mixed owner 同 workspace 并发验收。
- `pnpm fmt:check`：仍失败，仅未跟踪 `logs/tmp/release-tag-monitor-38198935244/` 下 5 个 JSON；本轮文件定向格式检查通过，未修改无关日志。
- `git diff --check`：通过。

性能报告含六轮真实样本，Node dist / Rust debug 的中位数：startup 837.8725 / 205.1285 ms，RSS 407708 / 59622 KiB；subscribe 5.9375 / 6.6065 ms。只代表报告中哈希标识的样本 artifact，不是 release、最终 checkout 重新构建后相同哈希、跨平台或生成吞吐结论。

## 尚需对齐的产品语义 / 后续工作

1. **M4 Responses 错误分类**：真实 TS 对 `response.failed` 产生 finish(raw=`error`)，Rust 返回 failure(reason=`unknown`)。当前测试保留差异，需明确期望后才能改产品语义。请求体/usage/tool call/更多错误与跨实现取消仍未全部覆盖。
2. **M5 内容与展示面**：CRLF 的 `data.content` / diff 输入、display 相对/绝对路径、无 hunk 是否产生 display、checkpoint BOM summary 仍有已确认差异；详见 diff spec。blocking worker panic 发生在写入提交后时的错误语义亦未验收。
3. **M5 剩余工具矩阵**：multiline、NUL/UTF-16、更多遍历顺序与大输出；权限模式、hooks、Bash 沙箱/取消。文件 handler oracle 不等于 permission executor parity。Myers 对抗性输入在 5s 内仍可能高峰内存，不擅自新增任意硬上限。
4. **M6 端到端**：真实 Core router/启动/存储握手，UTF-8 分片/CRC 真实完整链路，TTFT、其它 topics 立即 flush、高水位/拥塞/drain。异常编码失败的具体帧序列尚未与真实 TS gateway oracle 对齐。
5. **M3/M8 原阻碍**：mixed-runtime 同 workspace owner 协调；Desktop capability/native transport 已接线但完整恢复/回退 E2E 待验收；Windows/macOS runtime；MCP OAuth、CUA、Node REPL、memory 产品验收。不能用 fallback 绕过 gate。
6. **性能限制**：Node dist vs Rust debug，6 轮且整机负载未控制；环境代理 guard 不是 OS 网络沙箱。fixture 排除 title sidecar，仅证明 0 个非标题模型请求，不宣称 0 个所有模型请求。

## 所有者与事件顺序保持不变

```text
input → Core 唯一业务 owner → admission → durable commit → ACK / event
                                              ↓
                         SQLite 事实 → cold read / recovery projection
Desktop continuous ─ direct live ─┐
Web replayable ─ snapshot/replay ──┴─ 同一 owner / seq，不复制 accepted queue

failed resync encode → Delivery 标记 resync + 非paused due
                     → 既有 flush 路径请求 TopicSnapshot → 恢复帧
paused               → 不 arm due → drain 才唤醒

Write/Edit 原子写 → 唯一 file_diff blocking worker → 5s预算 → hunks / 空hunks
```

本轮继续交付可验收切片，不将 milestone 或总体产品 parity 标为完成。
