# Node/Rust CLI 会话库真实互操作验收

## 目标与场景

以当前 checkout 重建的 Node CLI bundle 和 debug Rust CLI 对同一显式临时 SQLite 会话库做真实 stdio 互操作，逐会话分别使用 Node reader 与 Rust cold reader 比较 history、rows、state，保留差异的完整 JSON 路径及分类计数。不得输出会话正文或凭据。

1. **alternate**：Node 创建会话并写入文本/工具轮，Node 与 Rust 轮流续写同一会话；下一模型请求必须能观察此前双方的对话与工具记录。
2. **crash**：分别在 Node/Rust 的流式生成、工具运行中强杀进程（四个方向均须执行），再由另一 runtime 冷恢复；验证没有遗留运行状态、重启队列输入按既有协议判为丢弃，并能继续会话。工具运行必须以测试 fixture 写入当前 workspace（位于 test root 内）的绝对 PID 路径作为实际执行握手；`toolCall.status=running` 只作诊断事件，不代表 shell 已启动。仅 `success`、`error`、`cancelled` 是工具终态；`pendingApproval` 和 `inputStreaming` 不得被视为终态。缺少握手时不得继续/跳过，按终端状态/错误路径、permission ack 与 stderr 分类并停止当前 case；日志不得输出 fixture 输入或用户数据正文。
3. **concurrent**：Node/Rust 各在不同 workspace、不同 session 同时运行，在同一个显式临时 DB 并发写入并冷读比较。

## 所有者、传输与边界

- `scripts/lib/zcode-cli-rust-interop-fixture.mjs` 是 `fixtureModel + tempConfig` 的唯一所有者：只管理 loopback model fixture、对话文本投影及临时 HOME/provider 配置；不拥有 runtime 子进程生命周期。`scripts/zcode-cli-rust-interop-runtime.mjs` 是 `runtimeLifecycle` 的唯一所有者：管理进程、RPC、交互 actor 与清理；通过 re-export 保持既有 fixture helper 公开接口不变。fixture 和 runtime 均只操作 driver 显式提供的临时 root，不访问真实 HOME、DB 或 model。

- 每个运行时是其当前命令执行期间会话状态的写入者；SQLite 是两个运行时之间唯一共享的持久化事实来源。测试进程只发 stdio JSON-RPC 命令和消费事件，不维护第二套会话状态。
- Node/Rust App Server 使用 stdio；模型只连接测试进程启动的 loopback OpenAI-compatible fixture。fixture 对话基于请求内容固定回复，测试目录中的配置和所有 HOME、storage、DB 路径均显式指向临时 root。
- 从仓库根目录使用 `env -u TSX_TSCONFIG_PATH node --import tsx scripts/zcode-cli-rust-node-interop.mjs ...` 执行，不依赖仓库中不存在的 tsconfig。用当前 checkout 的 Node CLI公开导出 reader/API 做 Node 侧读取；Rust 使用 `examples/node_read.rs` 冷读。字段差异不允许整体忽略，只有已有协议明确的易变标识可按已说明规则剔除。Node artifact store 的显式 storage root 下路径为 `cli/artifacts`。
- 两个 runtime 显式使用同一临时 root 下的 HOME/provider 环境与共享 SQLite DB；权限采用实际默认 `build` 模式，不伪造 yolo 加载。Node `DefaultRuntimeConfig` 默认配置文件为 `$HOME/.zcodium/cli/config.json`；Rust `WorkspaceConfig::user_path` 也读取 `$HOME/.zcodium/cli/config.json`。`ZCODE_STORAGE_DIR` 只覆盖存储根，不重定向用户配置文件，因此 driver 不得创建 `$HOME/.zcode/...`，也不得以写后读文件声称 runtime 加载了配置。不得使用真实 HOME、真实 DB 或 provider credentials。正常 build 权限提示由测试 driver 像用户操作 V4 控件一样一次性回答 `allowOnce`，不是改变 runtime 权限。
- V4 pending interaction 的唯一消费所有者是 driver 的 pendingInteractions actor：从 conversation 的 snapshot/patch 发现 interaction 后，以该 sessionId 发送 `resolveInteraction({interactionId, answer:{optionId:"allowOnce"}})`，等待并检查真实命令 ACK；不带 baseRevision。权限 fixture 仅预期 Bash 与 Read 各一次性授权。旧 `interaction/requestPermission` handler 保留兼容，但 interaction ID 必须唯一认领、同一 ID 不得由两路重复回答。actor 的异步拒绝、子进程退出必须被捕获并使当前 case 失败；禁止 unhandledRejection 与无限等待。测试应覆盖 V4 actor 延迟到达及重复 interaction ID 的去重。

```text
runtime pendingInteractions ── conversation snapshot/patch ──> driver actor (唯一 ID owner)
                                                              │ resolveInteraction(sessionId)
                                                              ▼
                                                         runtime V4 ACK
                                                              │
                                                              ▼
                                                    Bash PID handshake / turn resume
```

- 进程强杀后其子进程及所属进程树须回收；server、runtime、临时 root 在 `finally` 清理。deadline（整个验收不超过 600 秒）仅用于失败退出，不用于同步；PID 文件是实际 shell 启动握手。pendingApproval 反映交互未消费，不是已确认的 Rust runtime 差分；本轮既往 Rust 差分归类改为“待核实：driver 缺少 V4 answer”，实际差异须以新运行结果为准。

## 安全与禁止范围

绝不读取或写入个人 HOME、真实会话 DB、真实账号/模型/provider 或代理凭据；不继承用户 provider/token/proxy 环境。子进程只继承运行所需的 PATH 与 OS 标准环境并覆盖 HOME、USERPROFILE、XDG_CONFIG_HOME、`ZCODE_STORAGE_DIR`、`ZCODE_SESSION_DB_PATH` 及临时 fixture provider registry。禁止协议/Core 状态机、Cargo 源码、迁移 checksum、旧 run 判断、package.json、CI 的行为变更；禁止 commit/push。

## 验收

按 alternate、crash、concurrent 顺序执行。构建当前 Node TypeScript bundle 与 `zcode-cli-rust`/`node_read` debug targets；三场景均真实运行且报告结果、Node bundle freshness、Rust reader DB compare 的 sessions/read/equal/failure/mismatch counters。driver/API 适配不得静默 skip。仅能因明确证据修改测试 driver 的版本适配；任何 runtime 差异或无法安全运行均报告失败场景和原因。验证脚本 oxfmt/oxlint、pnpm typecheck/lint、architecture changed。

## 本轮真实证据约束与平台边界

- alternate 只支持**同一 workspace/session 顺序续接**。concurrent 只支持不同 workspace、不同 session 并发；不支持同 workspace 混合 Node/Rust owner 并发，不以此推断锁/owner 行为。
- 每次 compare 必须等所有 runtime 关闭，再从原始 quiescent DB 及存在的 `-wal`/`-shm` 文件异步复制出两个独立临时副本；Node startup reader 只读 Node 副本，Rust cold reader 只读 Rust 副本。副本与 artifacts/cache 均置于测试已知临时 root，不复制或接触真实用户库。记录并校验源 DB/WAL/SHM 比较前后 hash；缓存值不是副本隔离证据。用临时 SQLite DB 的正/负向测试证明 Node reader 在副本迁移时不会改写源库。
- stream crash 必须同时观察到模型服务器针对该 slow request 发出的 first-chunk-sent 信号，以及本 session、本 turn 的非空 `assistantText` 行内容确实流出，方可强杀；`row.delta`、assistant placeholder 或其他行本身不是开始证据。字段依据 V4 protocol 实际 row/delta 定义。
- driver 全局 deadline 是故障出口，整个验收最长 600 秒。所有轮询（含 snapshot）检查 runtime 健康；所有超时均须最终清理。关闭失败的进程组须有 bounded cleanup；Windows 目前不能使用 POSIX sleep/Bash fixture，须明确报告 `unsupported_platform` 而非通过或声称跨平台清理已验证。本轮实际验收平台为 Linux，Windows/macOS 未验收。
- 当前命令范围仅限三份 interop mjs、actor helper/tests、新增比较器/stream 测试及本 spec；不修改 runtime/core/schema/Cargo/CI/package 或 `examples/node_read.rs`。不得复制真实用户数据库。

## 本次验收结果（Linux）

- Node CLI bundle 由当前 checkout 构建；Rust `zcode-cli-rust` 与 `examples/node_read` debug targets 构建成功。三场景真实运行通过：alternate `sessions/read/equal = 1/1/1`；crash 四方向 `4/4/4`；concurrent `2/2/2`。各场景 `rustFailed/nodeFailed=0`，history/rows/state mismatches 均为空；reader session counters 完整覆盖且 session ID 配对断言通过。
- 两个 stream crash 均同时观测到该请求真实 first-chunk flush 信号及对应 session 的非空 assistantText 流内容后再 kill；四个 crash case 均通过。两个 tool crash 均取得真实 Bash PID 文件握手及 accepted V4 ACK。
- 每场景 source main DB/WAL/SHM before/after SHA-256 相同；quiescent 状态下 WAL/SHM 不存在。Node reader 在独立副本上跑 startup migration 的正/负向临时 SQLite 测试通过（副本变化、源文件不变；直接对负向控制库 startup 会写入）。
- Node driver tests `--test-isolation=none` 实际计数 8/8；目标脚本 oxlint/oxfmt、`pnpm typecheck`、`pnpm lint` 与 architecture changed 通过。`pnpm lint` 报告仓库范围内 51 条 warning、0 errors。
- 本轮仅 Linux 已验收；Windows/macOS 未实测。Windows fixture 的 POSIX Bash/sleep/进程组清理会显式报 `unsupported_platform`，不宣称跨平台清理完成。验证日志：`/tmp/cli-rust-hardened-interop.log`。
