# zcode-cli-rust：CLI runtime 的 Rust 重写

> **状态：规划中**（2026-10-09）。本 spec 只定范围、决策与验收；实现按里程碑分批提交。

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
3. 与 Node **共用同一个会话库**（`~/.zcodium/cli/db/db.sqlite`），记录格式逐字节一致，
   两个 runtime 可交替打开同一会话继续对话。
4. Host ↔ CLI 仍走 stdio NDJSON，**协议不改**。

**非目标**

- 重写 Host / Renderer / Electron Main。（那是另一个量级的工程，且 Renderer 仍是 React。）
- 重写远端 server、Web server、`zcode-server-cli`——它们继续用 TS。
- 动态工作流（`dynamic-workflow` / `dynamic-workflow-runtime`）：不在当前范围，
  `workflowRuns` 继续明确返回 unsupported。
- 完整 TUI parity：TUI 只保留子命令入口。
- 改会话库或协议 schema。

## 决策

| 编号 | 问题             | 决定                                                                             |
| ---- | ---------------- | -------------------------------------------------------------------------------- |
| D1   | 代码来源         | **从 MBearo/ZCode-rs 移植并适配**，不从零写。依据见下                            |
| D2   | 协议漂移如何处理 | 契约驱动：schema 生成器读**本仓库** TS 契约重新生成，Rust 侧测试比对，漂移即失败 |
| D3   | 存储             | 共用 Node 的 `db.sqlite`，记录格式逐字节一致；不做导入/备份/反向同步             |
| D4   | 回退             | 显式 runtime 开关；取消覆盖即回 Node，Node 直接读 Rust 写的会话                  |
| D5   | 会话库锁         | 每 workspace 一个 owner 锁，只用stdlib `File::try_lock`                          |
| D6   | 工作目录         | `apps/zcode-cli-rust`，独立 Cargo workspace                                      |
| D7   | 发布             | 不在本 spec 范围；先在开发开关下验证                                             |
| D8   | 桌面分发口味     | **只在 Preview（`ZCodium Rust`）口味构建并随包分发**，生产口味不变               |

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

沿用他的分层（实测该约束被他用脚本强制，`scripts/check-zcode-cli-rust-boundaries.mjs`）：

```text
protocol / domain → core-api → core
                          ↑
             state / model / tools / host
                          ↓
           app-server / tui → cli binary
```

- `domain` 纯领域模型，不依赖 tokio / reqwest / rusqlite / 文件系统。
- `core` 不依赖 state / model / tools。
- application 代码不得 import adapter 或做文件/网络/进程 IO。
- `src/main.rs` 是唯一组装具体 adapter 的地方。
- workspace lint：`unsafe_code = "deny"`。

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

## 验收

每个里程碑都必须通过：

1. `pnpm typecheck`、`pnpm lint`、`pnpm fmt:check`、`pnpm architecture:check --changed`
2. `pnpm check:zcode-cli-rust`（cargo fmt + clippy `-D warnings` + Rust 源码边界检查）
3. `pnpm test:zcode-cli-rust`（cargo 单测 + Node 驱动集成测试）
4. **契约漂移测试**：TS 改字段而 Rust 未同步时必须失败
5. **共库互操作**：Node 与 Rust 交替续写同一会话、崩溃后由对方恢复、两进程并发写不同会话
6. **真实库比对**：用户现有库逐会话冷读取两端相等
7. 性能对照报告写入 `docs/reports/`，不能凭语言宣称更快

## 里程碑

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

## 实现偏差

实现时在此记录与上文不一致之处及原因。
