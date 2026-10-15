# Rust CLI M8 桌面接线交接

## 结论

**后续需求调整：用户确认只要求 Rust 接管 TS 现有库，最终替代 TS。Rust→TS 切回恢复不再是 M8 阻塞项；下文失败记录只保留为当时测试事实。当前必验收方向为 TS 历史库→Rust 读取、恢复、续写与原数据保全，不等于任意历史库版本均已保证兼容。** 本次仅文档调整，不启动 GUI、不改变默认 runtime。

本轮补上 runtime 显式选择、Desktop 原生存储准备 transport 和 Rust 准备握手/reuse；**真实 App 的 Rust 启动、文本对话和工具显示已有局部运行证据，但切回 TS 恢复没有通过，M8 未验收完成**。

用户接手后续测试。本次交接不再启动 GUI、不重跑性能测试；默认 runtime 仍 TS，不迁移用户库。

## 实现了什么

### 1. Services：真正落实显式 runtime 选择

文件：

- `packages/services/src/zcode-agent/zcodeAgentProcessManager.ts`
- `packages/services/src/runtime-tools/providerRuntimeResolver.ts`
- `packages/services/src/{storage-startup,node}.ts`

行为：

- `ZCODE_AGENT_SERVER_COMMAND` 仍最高优先级，不推断未知自定义命令的存储能力。
- `ZCODE_AGENT_SERVER_RUNTIME` 未设置/空/`ts` 走 TS；`zcode-cli-rust` 显式选 Rust；未知值失败。
- Preview 随包存在 Rust 不再自动启用；显式 Rust 找不到 binary 不静默回退 TS。
- binary 优先随包候选，开发态再查仓库锚点的 Cargo `target/debug`、`target/release`。开发发现受 `ZCODE_RUNTIME_ENV=development` 控制，不能仅设置 selector 就假设会命中 dev binary；陈旧随包 binary 仍可能抢先命中。
- 存储准备由一个 tagged descriptor 描述：`storagePreparation: {kind:'node-worker',entry}` 或 `{kind:'native-process'}`，替代原 `storagePreparationEntry`；tap wrapper 保留描述。

此前 spec 声称已有 env 开关，但源码并未读取，且 Preview 自动选择与 TS 默认规则冲突；本轮修正这一真实漂移。

### 2. Desktop：原生存储准备接线

文件：

- `packages/desktop/src/host/storagePreparationProcesses.ts`
- `packages/desktop/src/host/storagePreparationTransport.ts`

Host 复用同一个帧解析、pathReady、observePath、preparedPaths 和失败报告路径。TS 继续 Worker，Rust 通过 native spawn；不把可执行文件交给 JS Worker。

成功要求收到合法 prepared、stdout 排空、退出码 0，之后才缓存真实 prepared path；abort/坏帧/重复 path/observePath 失败/异常退出不缓存。native 终止复用公开跨平台进程树 helper。

```text
Host DatabaseStartupCoordinator（启动状态 owner）
  → Services resolver（runtime + transport descriptor）
  → Host shared handshake
       ├─ Node Worker
       └─ native Rust child
          storagePath → observePath → pathReady(reuse)
            → CLI 开库/迁移并关闭（reuse 则跳过）→ storagePrepared → drain/exit0
  → 既有 ProcessManager / stdio client → Core session owner → ACK / V4
```

不更改 UI/platform API、协议字段、默认存储路径或 session 业务所有权。

### 3. Rust：握手校验与 reuse

文件：

- `apps/zcode-cli-rust/crates/app-server/src/stdio.rs`
- `apps/zcode-cli-rust/src/{main,storage_startup}.rs`
- `apps/zcode-cli-rust/tests/storage_preparation.rs`

`storagePathReady` 严格解析顶层 `reuse?: boolean`，拒绝非法类型/额外字段；`reuse:true` 不再打开 NodeStore，直接结束本次准备。非 reuse 必须先合法握手再开库/迁移；失败输出 failed frame 并非零退出。普通 app-server 的 workspace owner 锁和 startup gate 未被绕过。

### 4. Electron smoke：未完成验收的驱动草稿

入口 `scripts/zcode-cli-rust-desktop-smoke.mjs`，辅助模块在 `scripts/lib/zcode-cli-rust-desktop-*.mjs`。

使用现有 Playwright Electron、当前 tsup/vite 产物、独立临时 HOME/userData/sessionData/XDG/DB 和 loopback 模型，测试真实 UI，不自造 ACK。构建会重写 `packages/desktop/out/`，测试会打开/关闭真实窗口并进行自动输入。

**不是启动性能基准。** 记录的 build duration 只是构建耗时，不是 CLI/App 启动性能结论。

## 已执行的验证（区分证据来源）

以下运行来自本轮 worker 执行回报，未在交接时重跑全部 suite：

| 验证                                                                                                                   | 本轮已执行结果                       | 边界                                                             |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------- |
| Services `node --import tsx --test packages/services/test/*.test.ts`                                                   | 37/37，包含 9 个新 resolver 行为测试 | 不等于全部 services 测试                                         |
| Desktop `pnpm vitest run packages/desktop/src/host/storagePreparationProcesses.test.ts`                                | 24/24，多轮通过                      | mock resolver + 真实 JS Worker/native fixture，不是 Rust App E2E |
| Rust `cargo test --locked --manifest-path apps/zcode-cli-rust/Cargo.toml -p zcode-cli-rust --test storage_preparation` | 6/6；修复前 4 项失败                 | 真实 binary，临时 HOME/DB                                        |
| Rust app-server tests                                                                                                  | 28/28                                | 非完整桌面链路                                                   |
| Rust root package tests；root/app-server clippy、fmt                                                                   | worker 报告通过                      | 本轮未重跑全 workspace 汇总                                      |

交接前主 agent 对当前工作树实际执行：

- `pnpm typecheck`：通过。
- `pnpm lint`：通过，50 warnings、0 errors。
- `pnpm architecture:check --changed`：通过，0 violations / 0 new。
- 本轮文件定向 oxfmt 格式化完成；`cargo fmt --manifest-path apps/zcode-cli-rust/Cargo.toml --all --check`：通过。
- `git diff --check`：通过。
- 上轮的 Rust **470 passed / 1 ignored**、driver **50/50**、CI **264/264** 是本轮 M8 之前的基线，**不能当成本次 M8 最终总数**。

另有未改文件的既有失败线索：`packages/services/src/zcode-agent/genUiOutputEnv.test.ts` 的 vitest 期望 `.zcode`，当前实现使用 `.zcodium-exp`；worker 报告该失败，未为本次接线修改存储规则。

## 真实 Electron 已观察到什么

本机临时证据 `/tmp/m8-e2e-evidence.json`、`/tmp/m8-e2e-run4.log`（不纳入版本库；可能被清理）：

- 本轮构建完成，数据库 ready。
- 扫描到 Rust app-server，页面发送输入后出现本地模型回复。
- 工具步骤的可见性断言通过。
- 切回 `ts` 的恢复步骤没有通过：`Target page, context or browser has been closed`，最终 `ok:false`。
- 不能据此认定产品恢复失败，也不能认定是用户操作造成；需排查窗口选择、driver 生命周期、进程退出或外部关闭。
- 工具可见性目前用 timeline 文本（`tool done` 或 `note.txt`）判断，不是完整文件字节/权限结果验收；runtime 证据目前是全局 ps 扫描，不严格限于本次 App 进程树。
- 失败时未完整收集 network/model 尾部证据；空 blocked 列表不证明零外网。Node main/Host 的直接出网没有 OS 级沙箱保证。

**本次不宣称 GUI 全通过、切回 TS 全通过、M8 完成或跨平台完成。**

## 用户接手测试清单

### 优先修整 smoke，再跑完整 GUI

1. 确认构建的 Rust binary 是本轮源码；当前忽略的 `bundled-agents/<platform>/rust` 可能陈旧。默认 smoke 会检查并临时改名不支持 prepare-storage 的 staged binary，finally 恢复；被 SIGKILL 时 finally 不能保证执行，先检查是否残留 `.m8-stale-hidden`。本次检查 staged 原文件已恢复。
2. 改验收方向：TS 创建临时历史库（含已完成/中断会话），结束 TS owner 后由 Rust 启动，严格验证同 session ID 的历史、状态恢复与续写及旧记录保全。反向 TS restart 窗口关闭不再是必修项。
3. 审核 smoke 的退出清理、早期失败临时目录清理、进程组所有权。当前 `forceKillAppTree` 使用负 pid，但 Playwright launch 并未在此显式证明 PGID 所有权；不要假设整个树已清空。启动失败后的 app handle 和首次/重启两次的子树均需确认。
4. 网络守卫存在 `.catch(()=>{})` 和失败路径证据不全；先修整以避免“未安装守卫却记录成功”。只有确认隔离可靠后再跑。
5. 构建桥检测仅检查 assets 存在，不证明桥实际编译/暴露；运行时验证桥与 run-id 条件。当前 smoke 是接手入口，不是已通过的门禁。
6. 工具需要验证真实调用/结果/最终文件；runtime 检测限定本次 PID 子树，避免用户同时运行其它 ZCode 误判。

### 可复跑命令

不启动 GUI的定向入口：

```bash
node --import tsx --test packages/services/test/zcodeAgentRuntimeResolver.test.ts
pnpm vitest run packages/desktop/src/host/storagePreparationProcesses.test.ts
cargo test --locked --manifest-path apps/zcode-cli-rust/Cargo.toml -p zcode-cli-rust --test storage_preparation
```

完成上述 smoke 审核后，在不影响正常桌面操作时运行：

```bash
cargo build --locked --manifest-path apps/zcode-cli-rust/Cargo.toml --bin zcode-cli-rust
node scripts/zcode-cli-rust-desktop-smoke.mjs --skip-restart --keep --evidence=/tmp/m8-desktop-result.json
```

上述命令重建 desktop、启用测试 bridge，打开真实测试窗口并验证 Rust 对话/工具；`--skip-restart` 跳过已不要求的反向切 TS，`--keep` 保留临时数据。驱动当前默认仍含旧的 Rust→TS 步骤（历史实现，未改源码）；该命令也尚未自动生成 TS 历史库，因此不能把局部通过称为 TS→Rust 接管全验收。用户需补该方向的 fixture/步骤；不要用陈旧 out 的 `--no-build` 结果证明本轮源码。

### 尚未执行或未完成的整体验证

- 本轮最终全 workspace Rust tests/check、driver suite、CI script suite、protocol/contract/domain/migration checks 和 Node/Rust 共库 interop 回归。
- 全仓 `pnpm fmt:check`：本轮未执行；此前被无关 `logs/` 下 5 个 JSON 阻塞，不自行修改这些日志。
- 真实 App 的 TS→Rust 历史会话读取/恢复/续写和原数据保全、附件、问答/权限交互、取消、崩溃/重连、Host 退出/进程树清理。
- 本轮新 Desktop/services 测试尚未接入 CI 门禁。
- Windows/macOS 原生运行；Linux fixture/Playwright 不能代替。
- Host 被 SIGKILL 的 native 孤儿/持锁边界，正常 abort helper 清理失败是否被吞掉需专项复核。
- M4 Responses 错误分类、M5 CRLF/display/BOM、权限/hooks/Bash 等前轮剩余差异，详见 `.agents/specs/cli-rust-handoff.md`。

## 提交与数据边界

实现与测试草稿按独立切片提交；Services descriptor 定义与 Desktop 消费方属于同一接口变更，保持原子提交。报告单独提交。不包含 `logs/`、临时原始证据、忽略的 out/bundled binary 或任何用户库。此轮仅本地提交，不推送。
