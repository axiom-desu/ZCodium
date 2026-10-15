# CLI Rust/Node 运行时性能基准（可复现入口）

## 目标与范围

为 `docs/reports/cli-rust-runtime-handoff-performance.md` 提供可重复、可复核的原始证据，替换此前无入口、不可复核的交接草稿。本基准只覆盖三项观测：

1. 进程启动到 `createSession` 成功响应（startup → ready）。
2. `v4/conversation/subscribe` RPC 往返。
3. subscribe 完成后固定静置 1 秒的 Linux 空闲 RSS（`VmRSS`）。

不覆盖模型生成、工具执行、并发负载、稳态吞吐、内存峰值或 release 构建；不得据此推断 release、跨平台或完整任务性能。

## 所有者与依赖

- `scripts/zcode-cli-rust-performance.mjs` 是测量入口的唯一所有者：负责隔离 root、调用 lifecycle/HTTP fixture、采样、统计并输出 raw JSON；`--bundle` 与 `--binary` 覆盖实际被测 artifact，标签、`sha256` 与 `sizeBytes` 均以解析后的实际文件为准。
- 复用 `scripts/zcode-cli-rust-interop-runtime.mjs` 已公开的 `prepareHome`、`modelServer`、`startRuntime`、`stopAllRuntimes`；不修改该文件，也不复制其实现。
- `scripts/lib/zcode-cli-rust-interop-fixture.mjs` 仍是 loopback fixture 与临时 HOME/provider 配置的唯一所有者；fixture 把标题 sidecar 请求排除在 `modelServer().requests` 之外。
- driver 只发送 `createSession` 与 `v4/conversation/subscribe`，不发送任何用户输入（无 `sendText`、无 `turn`）。`modelServer().requests` 只统计非标题请求，driver 每轮断言其为 0。

## 隔离与顺序

- 每次测量为对应 runtime 单独创建一个临时 root：独立 HOME、`ZCODE_STORAGE_DIR`、`ZCODE_SESSION_DB_PATH`、workspace 与独立 loopback model fixture。两个 runtime 不共享 DB、HOME 或 fixture 端口。
- 每轮两个 runtime 交替先后启动：奇数轮 `node → rust`，偶数轮 `rust → node`；至少 5 轮。
- runtime 关闭、fixture 关闭、临时 root 删除均在 `finally` 执行；`mkdtemp` 与 `modelServer` 也必须在 `finally` 覆盖范围内，确保 fixture 创建失败时仍删除已创建的 root。
- 临时 root 只放在系统临时目录；不读取/写入真实 HOME、真实 DB、真实 provider/凭据。
- driver 在 `prepareHome` 生成的 env 上显式覆盖 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 及其小写形式，指向进程内本地 fail-closed HTTP 代理（收到请求即返回 502 并关闭），并设置 `NO_PROXY=no_proxy=127.0.0.1,localhost,::1` 让 fixture 直连。目的是避免继承父进程代理或误用外部代理，并让遵循这些变量的 HTTP 客户端 fail closed。该 guard 只约束读取这些环境变量的 HTTP 客户端，不是 OS 级网络沙箱，也不阻止直连 socket 或非 HTTP 流量。
- `startRuntime` 只继承 PATH 等 OS 标准变量，driver 覆盖 HOME、USERPROFILE、XDG_CONFIG_HOME、`ZCODE_STORAGE_DIR`、`ZCODE_SESSION_DB_PATH`、fixture provider registry 与上述代理变量，不继承用户 provider/token/proxy。

## 测量定义与同步边界

1. `startupToReadyMs`：`performance.now()` 读取点紧邻 `startRuntime()` 调用之前，到 `createSession` 命令返回成功且带 `result.sessionId` 的时间差。包含进程 spawn 与首条 RPC。
2. `subscribeRpcMs`：从发起 `runtime.subscribe(sessionId)` 到其 RPC 响应的时间差。
3. `idleRssKiB`：subscribe 响应后固定等待 `IDLE_MS = 1000` 毫秒，再从 Linux `/proc/<pid>/status` 解析 `VmRSS`；`<pid>` 为 runtime 主进程 `runtime.child.pid`。该 1 秒静置是唯一同步边界，不轮询、不等待额外事件。
4. 每个 runtime 三项指标分别取各轮样本的中位数。样本数少于 5 或任一指标缺失时，报告必须注明样本量与失败阶段，不得声称统计显著。
5. `nonTitleModelRequests`：每轮记录 fixture `requests` 数组中的非标题请求数；driver 不发送用户输入并断言其为 0。fixture 的标题 sidecar 请求不计入该数组，因此该字段不是“总请求数”，不能据此声称模型侧完全没有任何请求。

## 构建标签

- Node 侧标签为 `Node dist`，artifact 为 `apps/zcode-cli/packages/cli/dist/zcode.cjs`，由 `pnpm --filter @zcode/cli build` 生成，使用 `node` 启动。
- Rust 侧标签为 `Rust debug`，artifact 为 `apps/zcode-cli-rust/target/debug/zcode-cli-rust`，由 `pnpm run build:zcode-cli-rust`（cargo dev/unoptimized + debuginfo）生成。
- `--bundle=<path>` 与 `--binary=<path>` 覆盖被测 artifact；构建标签必须记录覆盖后文件的真实 `sha256` 与 `sizeBytes`，不得记录默认路径的哈希。
- 路径展示：artifact 位于仓库内时记录仓库相对路径；位于仓库外时只记录 `basename` 加 `sha256`（不写入绝对路径）。
- `profile` 与 `label` 是构建命令的声明值；raw JSON 用 `profileSource: "declared by build command; not verified from artifact"` 标明脚本只校验文件存在并记录哈希，未从二进制独立核验优化级别。
- 不得把 release 产物标为 debug，也不得把不同构建/平台混入同一标签；raw JSON 必须携带 `profile` 与 `buildCommand` 字段。

## 输出

- 默认可复现命令（仓库根目录执行）：`node scripts/zcode-cli-rust-performance.mjs`。
- 可选参数：`--rounds=N`（整数且 ≥ 5）、`--bundle=<path>`、`--binary=<path>`、`--output=<path>`；只接受 `--flag=value` 形式，未知参数即失败。
- raw JSON 默认写到 `docs/reports/cli-rust-runtime-handoff-performance.raw.json`，同时打印到 stdout。
- raw JSON 只包含构建标签与 artifact `sha256`/`sizeBytes`、环境摘要（node/rustc 版本、内核、CPU 型号与核数、内存）、代理 guard 摘要、每轮样本（含 `nonTitleModelRequests`）、中位数与限制说明。不得包含真实 HOME、临时绝对路径、凭据、token、内部服务地址或会话正文。
- 写入前用 `assertNoSensitiveReport` 扫描序列化文本；命中敏感模式即失败退出。失败路径的错误输出先用 `sanitize` 把 HOME/temp 前缀替换为占位符。
- 报告正文 `docs/reports/cli-rust-runtime-handoff-performance.md` 只引用该 raw JSON、列出中位数表并写明限制。

## 失败与平台边界

- 非 Linux 平台直接输出 `unsupported_platform` 并以退出码 1 结束，不进行测量（`/proc/<pid>/status` 与 POSIX 进程组清理不可用）。
- 任一测量失败即中止后续轮次，`finally` 清理所有 runtime、fixture 与临时 root，输出 `status: "failed"` 与阶段信息，退出码 1。
- 本基准只报告特定 artifact、特定主机、特定样本量下的观测值。

## 验收

- `node --import tsx --test --test-isolation=none scripts/tests/zcode-cli-rust-performance.test.mjs` 通过，覆盖 `buildLabels` 对覆盖路径的哈希/大小、非仓库路径的 basename 处理、代理 guard、`mkdtemp`/fixture 失败时的 root 清理。
- `node scripts/zcode-cli-rust-performance.mjs` 真实运行，产出 raw JSON 并由报告引用。
- `pnpm exec oxfmt --check`、`pnpm lint`、`pnpm architecture:check --changed` 通过（仅新增/改写本基准范围内的文件）。
