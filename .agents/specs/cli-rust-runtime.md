# zcode-cli-rust：CLI runtime 的 Rust 重写

> **状态：机械迁移改动仍在当前工作树、尚未提交；受控 case 已验收，M2–M8 / exhaustive 产品 parity 未完成**。Rust 最新测试为 426 passed、1 ignored；29 Command/1 ACK cases 通过 `parse_command` + serde 验证完整 outputs，350 leaf cases 验证 publicNode normalization projection。Linux Node interop 的 alternate/crash/concurrent 场景均通过。以上仅是受控 case，不代表全面 DTO 漂移覆盖或产品 parity。当前边界和证据见 [review status](cli-rust-review-status.md) 与 [CI contract](cli-rust-ci.md)。

## 背景与动机

桌面 App 的进程拓扑（`packages/shared/src/processResourceTelemetry.ts` 的 10 个角色）里，
Agent CLI 是重复成本最高的一块：

- `zcode.cjs` 是 **16 MB 单文件 bundle**，每个 CLI 进程启动就把整个 runtime 吃进去。
- 三个 lane（chat / plugin / mcp-status）**默认全部常驻**——`zcodeAgentProcessManager.ts`
  的 `idleTimeoutMs` 只对 mcp-status 生效，chat / plugin 缺省不回收。
- 每个 workspace 的 chat lane 又是一个独立 Node 子进程。

即空闲、单 workspace 就有 3 个 Node 进程各扛一份 16 MB bundle。

参考实测（MBearo/ZCode-rs，M1 Max，2026-09-25，release 产物，同机各五次取中位数）：

| 场景                         | 结果                                                                                |
| ---------------------------- | ----------------------------------------------------------------------------------- |
| 与 Node CLI（8 轮 × 256 块） | 启动 786 → 20.6 ms，空闲 RSS 416 → 17.8 MiB，峰值 520 → 28.7 MiB，CPU 0.92 → 0.05 s |
| 4 MiB 会话冷读取             | p95 21.6 ms，footprint 18 MiB                                                       |

**这是本仓库最值得做的一项原生替换**：单位收益最大、可回退、不触碰 Renderer 与 Host。

## 目标与非目标

**目标**

1. 用 Rust 实现 Agent CLI runtime，行为与现有 TS CLI 对齐到可交替续写同一会话。
2. 通过既有环境变量显式选择，默认仍为 TS：`ZCODE_AGENT_SERVER_RUNTIME=zcode-cli-rust`。
3. 与 Node **共用同一个会话库**，记录格式逐字节一致，两个 runtime 可交替打开同一会话继续对话。Rust CLI 默认必须对齐当前 TS `DefaultRuntimeConfig.storage` 的有效默认 `~/.zcodium`；shared standalone SQLite store fallback 的 `.zcodium-exp` 是另一条路径约定，需独立决策，不得据此声称 Rust 默认全部使用 `.zcodium-exp` 或擅自迁移用户数据。
4. Host ↔ CLI 仍走 stdio NDJSON，**协议不改**。

**非目标**

- 重写 Host / Renderer / Electron Main。（那是另一个量级的工程，且 Renderer 仍是 React。）
- 重写远端 server、Web server、`zcode-server-cli`——它们继续用 TS。
- 动态工作流（`dynamic-workflow` / `dynamic-workflow-runtime`）：不在当前范围，
  `workflowRuns` 继续明确返回 unsupported。
- 完整 TUI parity：TUI 只保留子命令入口。
- 改会话库或协议 schema。

## 决策

| 编号 | 问题             | 决定                                                                                                                                                                                |
| ---- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1   | 代码来源         | **从 MBearo/ZCode-rs 移植并适配**，不从零写。依据见下                                                                                                                               |
| D2   | 协议漂移如何处理 | 契约驱动：schema 生成器读**本仓库** TS 契约重新生成，Rust 侧测试比对，漂移即失败                                                                                                    |
| D3   | 存储             | 共用 Node 的 `db.sqlite`，记录格式逐字节一致；Rust CLI effective config 与 TS `DefaultRuntimeConfig.storage` 对齐；standalone store fallback 差异待独立决策；不做导入/备份/反向同步 |
| D4   | 回退             | 显式 runtime 开关；取消覆盖即回 Node，Node 直接读 Rust 写的会话                                                                                                                     |
| D5   | 会话库锁         | 每 workspace 一个 owner 锁，只用stdlib `File::try_lock`                                                                                                                             |
| D6   | 工作目录         | `apps/zcode-cli-rust`，独立 Cargo workspace                                                                                                                                         |
| D7   | 发布             | 不在本 spec 范围；先在开发开关下验证                                                                                                                                                |
| D8   | 桌面分发口味     | **只在 Preview（`ZCodium Rust`）口味构建并随包分发**，生产口味不变                                                                                                                  |

### D8 依据：为什么挂 Preview 口味

`packages/desktop/scripts/desktop-product-identity.mjs` 里 Preview 身份的产品名在 2026-10
已从 `ZCodium Preview` 改名为 **`ZCodium Rust`**，appId 保持 `dev.zcodium.app.preview`。
它的定位本来就是滚动更新模型里 preview 渠道的提前通道——让 Rust runtime 在这里随包分发，
既能拿到真实安装包的验证，又不影响生产口味。

接线（三处，全部以 `ZCODE_PREVIEW_IDENTITY=1` 为闸门）：

1. `packages/desktop/scripts/prepare-cli-rust.mjs`：按 target triple `cargo build --release`
   并把产物 stage 到 `bundled-agents/<platform-key>/rust/`（补执行位，copyFileSync 不保留）。
2. `prepare-runtime-assets.mjs` 与 `electron-builder.config.js` 的 extraResources：
   preview 才跑、才打包，落到 `resources/rust`。
3. `zcodeAgentProcessManager.ts` 新增 `resolvePackagedZCodeCliRustCommand`，解析顺序为
   env 显式覆盖 → monorepo dev 源码/dist → **随包 Rust CLI** → Electron Node 跑 zcode.cjs
   → 远端已部署 native binary。

Rust 排在 TS bundle 之前，因为 Preview 的目的就是提前验证它；没有该文件时（生产口味、
dev 未构建）解析返回 null，自然落到 TS bundle，不需要额外开关。Rust 是独立可执行文件，
不需要 `ELECTRON_RUN_AS_NODE`。

### D1 依据：为什么移植而不是从零写

实测两边协议导出面（`packages/shared/src/zcode-protocol/index.ts`）：

|           | 数量    |
| --------- | ------- |
| 共同      | **418** |
| 仅本仓库  | 58      |
| 仅 MBearo | 37      |

**88% 共通。** 且：

- 同为 Apache-2.0，移植加署名即可。
- 他的协议 crate 是**从 TS 契约生成**的（`scripts/generate-zcode-cli-rust-protocol-schema.mjs`
  读 `zcode-protocol-v4/command.ts`，Rust 侧 `json_schema_tests.rs` 比对）——这正是防漂移机制。
- 已有 305 个 cargo 单测 + 297 个 Node 驱动集成测试。

所以移植的真实工作量是「补 12% 我们有他没有的 + 去掉约 9% 他有我们刻意不做的」，不是重写。

**必须一并认领的维护成本**：约 10 万行 Rust，本 fork 现有贡献者基线是 TS。
这点写在这里以免后续被当成免费午餐。

## crate 边界

```text
schema ← protocol / domain → core-api → core
                              ↑
              state / model / tools / host / net
                              ↓
            app-server / tui → cli binary
```

- `schema` 是无 IO 的底层纯 JSON Schema validator；`protocol` 与 `domain` 共用它，禁止复制第二份 validator。
- `domain` 纯领域模型，不依赖 transport、tokio / reqwest / rusqlite / 文件系统；不依赖 `protocol`。协议 DTO 由真正需要它的消费者直接依赖公开的 `protocol` crate。
- `tools` → `net` 是 WebFetch/Search 共用网络策略的明确 adapter 依赖；网络策略由 `net` 所有，tools 不另建策略实现。
- `core` 不依赖 state / model / tools。
- application 代码不得 import adapter 或做文件/网络/进程 IO；`schema` 同样加入无 IO application 检查。
- `src/main.rs` 是唯一组装具体 adapter 的地方。
- workspace lint：`unsafe_code = "deny"`；源码文件不超过 400 行。约束覆盖 `crates/**` 与 workspace 根下 `src/**`、`tests/**`、`examples/**` 的全部 Rust 源码（按 checker 的行数口径，含末尾换行产生的空行）；根级 composition 代码仍可组合具体 adapter，不受 application 禁止 IO 检查。拆分仅为源码组织，不改变 runtime 行为。

## 状态所有权

```
CLI/TUI/AppServer input → SessionRuntime / SessionActor（唯一业务状态 owner）
   → command admission → state transition → durable commit receipt → event projection
```

- accepted input 只能进入 Core owner 一次；前端只保留 draft 与 pending optimistic overlay。
- 模型结果、工具结果、问答、todo、goal、file checkpoint 必须先 durable commit，
  再继续模型请求或发布下一步事件。
- 旧 run 事件按 `sessionId + runId + generation` 丢弃。
- `workspaceIdentity?.trim() || workspacePath` 用于隔离与去重；`workspacePath` 只用于文件操作与展示。

## M1 协议验证覆盖边界与规则

M1 的 `schema --check` 只验证由本仓库 Zod 契约生成的 JSON Schema 文件是否与生成结果一致；它不验证 Rust DTO 字段是否完整，也不包含手写 `superRefine` 规则。Rust DTO 的代表性 TS→Rust 解码与往返由差分 fixture 覆盖，`sendText` 的两个 `superRefine`（拒绝 `OffPeakCreate`、`modelExecution` 需要 `modelSelection`）由真实 TS oracle 与 Rust 校验对照。此验证不构成全面自动 DTO 漂移检测。

M1 正确规则与验收：

- `sendText` 的 `commandId.trim().startsWith("offpeak-")` 必须拒绝（含前后空白包围的 offpeak 值）；非 offpeak 普通命令仍可通过。由真实 TS oracle 对照 Rust 校验。
- UUID 的唯一语义来自本仓库 Zod 转出的 `pattern`；Rust 不再额外手写 UUID 格式校验。编译 `format: "uuid"` 时必须同时存在合法 `pattern`，缺 pattern 或 pattern 非法则编译失败；其他未知 format 仍拒绝。
- enum/const 的数字比较遵循 JavaScript `JSON.parse` 数值语义，因此 `1` 与 `1.0` 相等。Rust `serde_json::Number::as_f64()` 在允许范围内返回浮点表示；不得假设超过 2^53 就必然为 `None`，也不把这种假设用于拒绝数字。
- AckStatus 包含 `Failed`。Command 与 CommandAck 必须通过来自 TS `parseCommandEnvelope` / `commandAckSchema` 的数据验证 Rust 解码与往返，而非只用 Rust 自己构造的数据自测。
- Node→Rust 差分覆盖真实 TS oracle：nil/max/普通 UUID、1/1.0 原始 JSON 字面形式、非法 UUID/花括号/unicode、`sendText` strict、两个 `superRefine`、CAS、ACK failed 及关键可选字段保留；验证组合必须实际执行 Rust `validate` 后再解码为 Command。oracle 与 fixture 的 `--check` 必须重新调用 TS 契约并比较真实结果，不得依靠静默生成的期望值。
- 保持 UTF-16 字符串长度与 strict/strip 语义；新增与修改 Rust 文件继续遵守 400 行上限及 `unsafe_code = "deny"`。
- 当前 transformation inventory：63 paths、70 leaf branches × 5 cases = 350 leaf cases；另有 29 整 Command cases 和 1 ACK case。29 Command/ACK cases 通过 `parse_command` + serde 验证完整 outputs；350 leaf cases 验证 publicNode normalization projection，不等同完整 DTO oracle。此受控用例集已验收，但不等价于 exhaustive DTO coverage 或产品 parity。

此前关于“上游缺 preserve_order”及“大整数 `as_f64` 必然为 NaN”的结论不正确，撤回；本 M1 不以这些结论作为设计依据。

## 落地阶段与验收

阶段顺序为：固定上游快照全源码机械迁移（当前工作树已落入）→ 集中适配 review（包含下列阻碍清单）→ 按 M2–M8 逐门槛验收。schema 纯共享、safe API 替换、真实 TS oracle 与 state 边界改进已有测试，但这些局部结果不代表任一里程碑或产品 parity 完成。文件被复制、Cargo 能解析或编译均不代表对应阶段验收通过。

### 后续集中 review 阻碍清单

1. stale stop/idle 状态语义需要与当前 runtime 对齐验证。
2. 冷读 load 有副作用，需审查读路径是否可变更持久化状态。
3. mixed-runtime owner 协同尚未实现；interop 只覆盖不同 workspace/session 并发与同 workspace/session 顺序交替，不覆盖同 workspace 混合 owner 并发。
4. M8 Desktop storage preparation 接入未完成：Rust 已实现 `prepare-storage` command/frames；Desktop resolver 未声明 capability，故启动 Rust 前将 `prepareSessionStorage` 拒绝为 `unsupported_runtime`。Native process transport 尚未接入 Worker 分支。不得将问题描述为 Rust 缺命令，也不加 fallback 或扩展 UI/platform interface。
5. 存储路径必须区分所有者：当前 TS CLI `DefaultRuntimeConfig.storage` 有效默认是 `~/.zcodium`；`packages/shared` standalone SQLite session-store fallback 是 `~/.zcodium-exp`。不得将两者合并描述为单一默认或擅自迁移用户数据；默认 runtime 仍不可启用。
6. Native Windows/macOS runtime 未实际运行；CI native matrix 只检查编译，不作为 runtime 通过证据。Windows 的本地 Linux cross-check 被缺失 native `lib.exe` 阻碍，需等待真实 native CI 结果。
7. 上游缺少当前产品的 MCP OAuth、browser CUA、Node REPL 与 memory 能力；不将这些功能描述为已迁移或已验收。
8. 当前 raw-input transformation inventory 与 Linux interop 只证明本 spec 明确列出的受控 case，不构成 exhaustive DTO drift 或产品 parity。

### 契约材料和生成器盘点

- 本地 M1 命令 schema/oracle 的实际来源是 `packages/shared/src/zcode-protocol-v4/command.ts`（payload schemas、command/ACK schema 和 parser）；当前权威 driver 为 `scripts/generate-zcode-cli-rust-protocol-schema.mjs`。不得用上游 `crates/protocol`、`schema/v4-command.json` 或 generator 覆盖本地 M1 crate、oracle 与 fixture。
- 上游 `crates/domain/schema/config.json` 的 generator `scripts/generate-zcode-cli-rust-config-schema.mjs` 输入为上游 `apps/zcode-cli/packages/adapters/src/config/schema.ts`。本仓库当前可见候选是 `packages/shared/src/config-schema.ts`；语义映射尚未审核，故 schema/driver 是待审材料，不声称生成通过。
- 上游 `scripts/zcode-cli-rust-node-projection-schemas.mjs` 输入为 `packages/shared/src/zcode-protocol-v4/index.ts` 和 `apps/zcode-cli/packages/contracts/src/tools/tool-result-metadata.ts`；前者存在于本仓，后者路径也存在，但导出/语义需审。此 schema 不属于 M1 command schema。
- 上游 `scripts/generate-zcode-cli-rust-tool-schemas.mjs` 读多个 `apps/zcode-cli/packages/core/src/tool/handlers/*`、`packages/contracts/src/tools/*` 的工具定义与 subagent prompt。脚本直接依赖路径在本 checkout 存在，但需逐个确认 named exports 与本 fork 产品边界后才能运行。
- 需要后续盘点/移植的 fixture drivers：`generate-zcode-cli-rust-fixtures.mjs`、`zcode-cli-rust-{egress,permission,bash,legacy-params,web,edit,plan-mode,hooks,workspace-hook,plugin,node-db,node-cold,node-projection-schemas,node-session,bash-parse}-fixtures.mjs` 以及 DB message/ledger ops。总驱动包含上游旧 CLI 的 adapters/repositories、未同构导出和多项脚本互相依赖；按实际 import 可用性逐个适配，不能整批原样复制。当前扫描显示 fixtures 汇总 driver 的 15 个 import 目标、node-db fixture driver 的两个 message/ledger ops、node-session driver 的 cold fixture/scenario 目标在本仓对应路径缺失，均为阻碍；真实库检查 driver 不运行。
- 当前 M1 TS oracle、protocol generator 与 M1 fixtures/test driver保持原样；缺失 export/module 不补回、不恢复已删除 TS 模块。

每个里程碑都必须通过：

1. `pnpm typecheck`、`pnpm lint`、`pnpm fmt:check`、`pnpm architecture:check --changed`
2. `pnpm check:zcode-cli-rust`（cargo fmt + clippy `-D warnings` + Rust 源码边界检查）
3. `pnpm test:zcode-cli-rust`（cargo 单测 + Node 驱动集成测试）
4. **契约漂移测试**：TS 改字段而 Rust 未同步时必须失败
5. **共库互操作**：Node 与 Rust 交替续写同一会话、崩溃后由对方恢复、两进程并发写不同会话
6. **真实库比对**：用户现有库逐会话冷读取两端相等
7. 性能对照报告写入 `docs/reports/`，不能凭语言宣称更快

## M2–M8 逐门槛验收（机械 landing 后执行）

| 里程碑 | 内容                                                                                 | 门槛                                      |
| ------ | ------------------------------------------------------------------------------------ | ----------------------------------------- |
| M0     | spec、Cargo workspace 骨架、crate 边界与依赖方向检查、CI 接线                        | 空 workspace 可构建、边界检查可跑         |
| M1     | `protocol` crate + schema 生成器 + 漂移测试                                          | 从本仓库 TS 重新生成 schema，漂移测试通过 |
| M2     | `domain` + `core-api` + `core`：Session owner、commit barrier、recovery、旧 run 防护 | 单测覆盖状态机                            |
| M3     | `state` adapter：SQLite、共库读写、冷加载                                            | 共库互操作三场景通过                      |
| M4     | `model`：三种协议、SSE、重试、取消                                                   | 本地 fixture 差分                         |
| M5     | `tools`：Read/Write/Edit/Glob/Grep/Bash、权限模式、hooks                             | 与 TS 逐项差分                            |
| M6     | `app-server`：stdio framing、RPC 路由、V4 投影                                       | 集成测试跑通                              |
| M7     | 扩展：MCP、Skill、子代理、Goal、compact                                              | 差分 + E2E                                |
| M8     | 桌面接入与回退验收                                                                   | 真实 App 基础对话/工具/附件/问答          |

M0–M2 不涉及行为，可先行；M3 起每个里程碑都要过共库互操作。

## 当前验收状态补充

- Latest Rust test evidence is 426 passed / 1 ignored after the schema fix; earlier 423 count predates three schema tests. `pnpm test:zcode-cli-rust-drivers` currently has 15 cases. Separately, `node --test --test-isolation=none scripts/ci/*.test.mjs` is the CI script regression suite with 256 cases, not the driver suite.
- Linux interop evidence: alternate 1/1, crash recovery 4/4, different-workspace concurrent 2/2; every DB comparison has matching sessions/read/equal counts and unchanged source hashes. Scope is controlled-case acceptance, not exhaustive parity.
- M8 blocker is Desktop capability declaration (`unsupported_runtime` before Rust starts), not a missing Rust command; native process transport is not connected to Worker branch.
- Native Windows/macOS runtime remains untested. Native CI performs compile checks only; do not infer runtime success from remote compile results.
- Root `pnpm lint` has 51 TypeScript warnings. Rust clippy (`-D warnings`) passed with no warnings, and `cargo fmt --all --check` passed. Root `pnpm fmt:check` (oxfmt) latest result is 79 failures; the scoped task files have zero formatting issues. See [review status](cli-rust-review-status.md) and [CI contract](cli-rust-ci.md).

## 实现偏差

实现时在此记录与上文不一致之处及原因。
