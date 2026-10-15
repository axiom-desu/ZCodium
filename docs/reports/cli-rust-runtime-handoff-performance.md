# CLI Rust vs Node runtime 性能对照（受控本地 fixture）

> 交接状态：可复核。本报告由 `scripts/zcode-cli-rust-performance.mjs` 在本 checkout 上真实运行生成，原始逐轮 JSON、artifact 哈希/大小与中位数保存在 `docs/reports/cli-rust-runtime-handoff-performance.raw.json`（本次采样 `generatedAt` 为 `2026-10-15T10:22:31.057Z`）。替换此前无入口、不可复核的草稿数据。

## 可复现入口

在仓库根目录执行：

```bash
pnpm run build:zcode-cli-rust                       # Rust dev (unoptimized + debuginfo)
pnpm --filter @zcode/cli build                      # Node dist bundle
node scripts/zcode-cli-rust-performance.mjs         # 默认 6 轮，交替启动顺序
```

脚本默认写入 `docs/reports/cli-rust-runtime-handoff-performance.raw.json`，同时把同一 JSON 打印到 stdout。可用 `--rounds=N`、`--bundle=<path>`、`--binary=<path>`、`--output=<path>` 覆盖（只接受 `--flag=value` 形式）。`--bundle`/`--binary` 会改变被测 artifact，raw JSON 记录的是实际文件的 `sha256`/`sizeBytes`。规则与所有权见 `.agents/specs/cli-rust-performance.md`。

## 范围与结论边界

- 对照标签为 `Node dist` 与 `Rust debug`。两侧都不是 release 产物，结果**不构成 release 性能结论**。
- 构建标签是构建命令的声明值，脚本只校验文件存在并记录实际 `sha256`/`sizeBytes`，**没有从二进制独立核验优化级别**（raw JSON `profileSource` 已注明）。复核者可用哈希确认被测 artifact 与本次一致，但优化级别仍以构建命令为准。
- 每轮为每个 runtime 建立独立临时 root：独立 HOME、`ZCODE_STORAGE_DIR`、`ZCODE_SESSION_DB_PATH`、workspace 与独立 loopback OpenAI-compatible fixture；两个 runtime 不共享 DB/HOME/端口。每轮结束由 `finally` 清理 runtime、fixture 与临时 root；`mkdtemp`/fixture 启动失败也会删除已创建 root。
- 6 轮，启动顺序交替：奇数轮 `node → rust`，偶数轮 `rust → node`。
- 复用 `scripts/zcode-cli-rust-interop-runtime.mjs` 的 `prepareHome`、`modelServer`、`startRuntime`、`stopAllRuntimes`，未修改该文件。子进程只继承 PATH 等 OS 标准变量，driver 覆盖 HOME/USERPROFILE/XDG_CONFIG_HOME/`ZCODE_STORAGE_DIR`/`ZCODE_SESSION_DB_PATH` 与 fixture provider registry；未继承真实用户 provider/token/proxy，也未访问真实 HOME/DB。
- driver 只发送 `createSession` 与 `v4/conversation/subscribe`，不发送任何用户输入。fixture 的 `requests[]` 把标题 sidecar 请求排除在外，因此 raw JSON 用 `nonTitleModelRequests: 0` 而不是“无模型请求”来描述：它只证明 driver 未发送用户输入/非标题请求，不能证明模型侧完全没有任何请求。
- driver 把 `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`（含小写）显式指向进程内本地 fail-closed 代理（收到请求即 502/关闭），并设置 `NO_PROXY=127.0.0.1,localhost,::1` 让 fixture 直连。该 guard 只约束读取这些环境变量的 HTTP 客户端，**不是 OS 级网络沙箱**，不阻止直连 socket 或非 HTTP 流量；它用于避免继承外部代理并让意外 HTTP 出口 fail closed。

## 测量定义与同步边界

- `startupToReadyMs`：`performance.now()` 读取点紧邻 `startRuntime()` 调用之前，到 `createSession` 返回成功且带 `result.sessionId` 的时间差，包含进程 spawn 与首条 RPC。
- `subscribeRpcMs`：从发起 `runtime.subscribe(sessionId)` 到其 RPC 响应的时间差。
- `idleRssKiB`：subscribe 响应后固定静置 1000 ms，再从 Linux `/proc/<pid>/status` 解析 `VmRSS`；`<pid>` 为 runtime 主进程。该 1000 ms 是唯一同步边界，不轮询、不等待额外事件。

## 环境与构建标签

| 项    | 值                                    |
| ----- | ------------------------------------- |
| 平台  | Linux `6.14.11-061411-generic` x64    |
| CPU   | Intel(R) Core(TM) Ultra 9 285H，16 核 |
| 内存  | 31518 MiB                             |
| Node  | `v24.19.0`                            |
| rustc | `1.98.1 (48a229cea 2026-09-01)`       |

本次实际被测 artifact（`profile`/`label` 为构建命令声明，未独立核验优化级别）：

| 标签       | artifact（仓库相对路径）                          | sha256                                                             | sizeBytes | buildCommand                     |
| ---------- | ------------------------------------------------- | ------------------------------------------------------------------ | --------: | -------------------------------- |
| Node dist  | `apps/zcode-cli/packages/cli/dist/zcode.cjs`      | `63d57c9420227e77975a7e2e23da1d6c886ae9e3e30e8b65eaff547e015b9d6d` |  30333596 | `pnpm --filter @zcode/cli build` |
| Rust debug | `apps/zcode-cli-rust/target/debug/zcode-cli-rust` | `133665df1de1ba88c5c0a5587630b36b35f3bd6daa8b269f0b3de62de0545c03` | 504529472 | `pnpm run build:zcode-cli-rust`  |

## 原始测量

时间单位 ms；RSS 为 KiB。

| 轮次 | 启动顺序    | Runtime    | Startup → ready | subscribe RPC | 空闲 RSS | 非标题模型请求 |
| ---: | ----------- | ---------- | --------------: | ------------: | -------: | -------------: |
|    1 | node → rust | Node dist  |         829.518 |         5.771 |   407552 |              0 |
|    1 | node → rust | Rust debug |         203.656 |         2.464 |    60108 |              0 |
|    2 | rust → node | Rust debug |         202.720 |         4.576 |    59568 |              0 |
|    2 | rust → node | Node dist  |         830.476 |         4.914 |   409252 |              0 |
|    3 | node → rust | Node dist  |         818.070 |         5.206 |   410100 |              0 |
|    3 | node → rust | Rust debug |         212.630 |         9.022 |    59176 |              0 |
|    4 | rust → node | Rust debug |         187.917 |         8.637 |    59604 |              0 |
|    4 | rust → node | Node dist  |         856.892 |         6.212 |   407472 |              0 |
|    5 | node → rust | Node dist  |         845.792 |         6.104 |   407768 |              0 |
|    5 | node → rust | Rust debug |         206.601 |         2.302 |    59788 |              0 |
|    6 | rust → node | Rust debug |         221.642 |         8.972 |    59640 |              0 |
|    6 | rust → node | Node dist  |         845.269 |        13.820 |   407648 |              0 |

6 轮中位数：

| 指标            |   Node dist |  Rust debug |
| --------------- | ----------: | ----------: |
| Startup → ready | 837.8725 ms | 205.1285 ms |
| subscribe RPC   |   5.9375 ms |   6.6065 ms |
| 空闲 RSS        |  407708 KiB |   59622 KiB |

## 解释

本组受控样本中，Rust debug 的启动至 `createSession` 成功与空闲 RSS 明显低于 Node dist；subscribe RPC 往返中位数接近（约 5.94 ms vs 约 6.61 ms，方向不稳定）。单轮波动仍明显（Node 启动 818–857 ms，Rust 188–222 ms），因此这里只报告中位数，不据此推断 release、跨平台、稳态负载或模型任务性能。仅报告上述具体 artifact、环境与观测值。

## 限制

- Node 侧为 dist bundle，Rust 侧为 debug（未优化、含 debuginfo）二进制；不是 release 对照，也不构成 release 结论。构建标签来自构建命令声明，未从二进制独立核验优化级别。
- 只测量启动到 `createSession`、subscribe RPC 往返与静置空闲 RSS；不含模型生成、工具执行、并发或吞吐。
- 6 轮/运行时的样本量有限，未做统计显著性检验，也未控制整机其他任务负载；单轮离群值只能作为波动证据，不能作为稳定性结论。采样只标识记录哈希的 artifact，不保证后续 checkout 重新构建仍得到相同 artifact。
- `nonTitleModelRequests: 0` 只表示 driver 未发送用户输入且 fixture 未记录非标题请求；fixture 的标题 sidecar 请求不计入 `requests[]`，不能据此声称模型侧完全没有任何请求。
- 本地 fail-closed 代理只是 HTTP 客户端环境变量约束（`HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` 及小写形式 + `NO_PROXY`），不是 OS 级网络沙箱，不阻止直连 socket 或非 HTTP 流量。
- 仅 Linux 实测；`/proc/<pid>/status` 与 POSIX 进程组清理不可用于 Windows/macOS，脚本在非 Linux 平台输出 `unsupported_platform` 并以退出码 1 结束。
- raw JSON 只包含构建标签与 artifact `sha256`/`sizeBytes`、环境摘要、逐轮样本与中位数；写入前用 `assertNoSensitiveReport` 扫描，未包含真实 HOME、临时绝对路径、凭据或会话正文。
