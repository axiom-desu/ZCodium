# Rust CLI runtime：本轮交接

## 已落地范围（不是 M2–M8 全面完成）

| 切片 | 实际交付                                                                                                                              | spec                             |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| M2   | 对齐 TS：已取消但尚未从 active 清理的 run，不再接受带 expected ID 的迟到 stop；no-op 不重复提交                                       | [状态机](cli-rust-m2-state.md)   |
| M3   | 冷读取前后比较全量非内部表/schema；重复读一致，显式 load 才恢复 interrupted compact / pending input                                   | [冷读](cli-rust-m3-cold-read.md) |
| M4   | 三协议本地 SSE、错误、503 重试、尝试上限、非 retryable 错误、流中/退避取消测试                                                        | [模型](cli-rust-m4-model.md)     |
| M5   | 真实当前 TS 工具 oracle 对照 Read/Write/Edit/Glob/Grep；修复 BOM、空文本统计、结果路径、patch context、空 pattern、Grep 排序/分页差异 | [工具](cli-rust-m5-tools.md)     |
| M6   | stdio 分帧/尾帧/大小边界；完整 serve loop 验证 RPC token、通知、两种 profile 的 ACK/frame，以及重订阅编码失败保留旧订阅               | [stdio](cli-rust-m6-stdio.md)    |

未启用默认 runtime，未操作用户库，未修改历史 SQL；`logs/` 保留但不纳入提交。

## 本轮实际重跑结果

主 agent 在收尾时重跑，输出保存在本机 `/tmp/zcode-cli-final/`（临时日志不是远程持久证据；命令可复跑）：

- `pnpm typecheck`：通过。
- `pnpm lint`：通过，50 warnings、0 errors。
- `pnpm check:zcode-cli-rust`：边界、fmt、workspace/all-targets clippy 通过。
- `pnpm test:zcode-cli-rust`：437 passed、1 ignored、0 failed。
- `pnpm test:zcode-cli-rust-drivers`：21/21（新增 M5 六项测试）。
- `node --test --test-isolation=none scripts/ci/*.test.mjs`：264/264。
- protocol schema、contract assets、domain fixtures 的三个 `--check` 入口：通过。
- `pnpm architecture:check --changed`：0 violations。
- 构建当前 Rust binary / node_read 后运行 `pnpm test:zcode-cli-rust-interop`：alternate 1/1/1、crash 4/4/4、concurrent 2/2/2（sessions/read/equal），source hash 不变。并发仍仅不同 workspace；不代表 mixed owner 同 workspace 并发验收。
- `pnpm fmt:check`：失败，仅未跟踪的 `logs/tmp/release-tag-monitor-38198935244/` 下 5 个 JSON 文件；本轮提交文件已定向格式化，未修改无关日志。
- `git diff --check`：通过。

## 接手优先级

1. **M4 测试可靠性 / 真差分**：model mock 当前单次读取 HTTP 请求，须补完整 headers/body、统一 deadline、事件通道提前关闭的明确失败；Retry-After 计时应停在第二次连接到达而不是响应写完。补响应头之前的取消与真实 TS adapter 自动 oracle。现有测试通过不等于三协议全量 parity。
2. **M5 剩余矩阵**：Grep 模型文案、完整分页/编码/大文件、multi-hunk diff；权限模式、hooks、Bash 沙箱/取消未由这批文件工具 oracle 验收。oracle 直接访问已有 handler 集合；根 barrel 的 type re-export 问题未改，未恢复删除模块。
3. **M6 后续 loop 场景**：resume、gap/resync、首次 subscribe 编码失败、HostReply bridge 等完整 loop 场景仍待补；既有 delivery 单测不能代替端到端 TS parity。
4. **M3/M8 原有阻碍**：mixed-runtime 同 workspace owner 协调；Desktop storage preparation capability / native transport 接线；Windows/macOS native runtime；MCP OAuth、CUA、Node REPL、memory 产品验收。沿用总 spec，不以 fallback 绕过 gate。
5. **性能**：[本地草稿](../../docs/reports/cli-rust-runtime-handoff-performance.md) 是子 agent 报告的样本，原始日志/入口当前不可复核；已纠正 RSS 中位数但不纳入性能验收。需重跑并保存可复现脚本及原始输出。

## 状态与顺序保持不变

```text
input → Core 唯一业务 owner → admission → durable commit → ACK / event
                                              ↓
                         SQLite 事实 → cold read / recovery projection
Desktop continuous ─ direct live ─┐
Web replayable ─ snapshot/replay ──┴─ 同一 owner / seq，不复制 accepted queue
```

本轮是五个 milestone 的受控切片推进，不将 M2–M8 或总体产品 parity 标为完成。
