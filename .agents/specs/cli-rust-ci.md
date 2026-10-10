# Rust CLI CI 和当前验收状态

## 范围与契约

本次只收口 `.github/workflows/cli-rust.yml`、根 `package.json`、Rust CLI README 与本 spec 链接的 runtime/review 状态文档；不修改 Rust/schema/Interop helpers/source specs。CI 的职责是分别验证：Rust Linux 编译及静态/单测、TS 变换 driver、TS↔Rust 真实 Node interop、schema/contract drift，以及 Windows/macOS 原生目标编译。Rust 静态 lint 必须覆盖 Cargo workspace 的全部 crate 和 all targets（包括 tests），不能只 lint manifest root 的 targets；格式检查保留 `cargo fmt --all --check`，测试保留 `cargo test --workspace`。CI 结果不能扩展为未执行的产品 parity 或平台 runtime 结论。

## 真实 CI 失败与修复契约（run 38042550013）

本地 workspace freshness 只表示基线与分支关系满足检查，不代表 clean checkout；忽略的旧 `dist` 可能掩盖 Node workspace build prerequisite 缺失。真实 CI 的 clean checkout 证据：`protocol-schema` 的 Contract asset step 因 `@zcode/contracts/dist/index.js` 缺失而 `ERR_MODULE_NOT_FOUND`（`/tmp/cli-rust-ci-contract.log`）；Linux interop Node CLI build 缺少 contracts/adapters/core/i18n/bootstrap 的构建产物（`/tmp/cli-rust-ci-node-build.log`）。因此 Node jobs 在校验/CLI build 前必须通过同一个根脚本运行仓库已有依赖构建路线 `pnpm exec turbo --skip-infer --cwd apps/zcode-cli run build --filter=!@zcode/cli --force`，而后 CLI job 仍执行原 `pnpm --dir apps/zcode-cli/packages/cli build`。不得跳过 checks、将包外置、恢复模块、伪造单个 dist、增加上游 launcher 或模型数据库。

CI stable Rust 1.99 对 `schema/schema_shape.rs` 报 `single_element_loop`（`/tmp/cli-rust-ci-clippy.log`）；保持 CI 工具链和 `-D warnings`，用等价简单条件检查代替单元素循环，并保留 fail-closed 形状约束。Rust 1.98 本地未触发该 lint 不是降级 CI 的理由。

Native compile jobs 的真实证据来自 run 38042550013：macOS 与 Windows native compile 均 success，仅证明 native compile，runtime 仍未检查。不能将 native compile 失败改绿或降级。

迁移 SQL 的 checksum/字节是契约：执行 `node --import tsx scripts/sync-zcode-cli-rust-node-migrations.mjs --check` 验证 22 个历史 SQL；不得改 SQL 内容/空白或全局关闭 whitespace 检查。先前 untracked SQL 造成“全 diff check 通过”的表述不准确，需明确验证边界。Root CI 使用 Node 24.14.0，当前本机 Node 24.19.0；版本差异需记录，不把 `mise.toml` 缺失当作阻断。

新增根脚本入口：

- `test:zcode-cli-rust-drivers`: `node --import tsx --test --test-isolation=none scripts/tests/*.test.mjs`，必须保留全量测试 glob 与 isolation 参数。
- `test:zcode-cli-rust-interop`: `node --import tsx scripts/zcode-cli-rust-node-interop.mjs apps/zcode-cli/packages/cli/dist/zcode.cjs apps/zcode-cli-rust/target/debug/zcode-cli-rust apps/zcode-cli-rust/target/debug/examples/node_read`。

依赖已安装的 `protocol-schema` job 在运行任何 contract checks 前先运行共享的 Node workspace dependency build，再同时运行 driver suite。Linux interop job 安装 workspace dependencies 与 stable Rust，先运行同一 dependency build，再构建 Node CLI 和 Rust binary/reader，最后执行上述脚本。不得依赖 TSX_TSCONFIG_PATH 或旧 tsconfig 路径；无仓库现成 cache action 时不引入/固定新第三方 action。Native compile matrix 仅在 `windows-latest`、`macos-latest` 执行 `cargo check --locked --workspace --all-targets`，Rust-only 环境不安装 Node dependencies，不执行 POSIX interop。

## 所有者、顺序与失败语义

```text
protocol-schema + Node driver tests ─┐
Rust Linux tests ─────────────────────┼── CI jobs; each command is authoritative for its boundary
Linux Node interop ───────────────────┘
Windows/macOS cargo check ──────────── compile evidence only, not runtime evidence
```

工作流仅编排验证，不拥有 CLI 产品状态。Driver tests 验证 Node 辅助/转换逻辑；interop 由测试驱动启动各自 runtime、测试 fixture 与 reader，SQLite 是被比较持久化事实源。任意测试失败均令对应 job 失败；不跳过缺失 reader、场景或测试，不以另一 job 的成功抵消。Windows/macOS cargo check 失败（包括 Windows 工具链/runner 环境问题）须作为实际 CI 结果报告，不得将本机 cross-build 阻碍等同原生 job 通过。

## 真实证据与非目标

- 当前 checkout Rust 测试在最新 schema fix 后为 426 passed、1 ignored，日志 `/tmp/zcode-cli-rust-test.log`；此前 423 是 schema 新增三项前的旧数，不再引用为最新结果。
- Node driver 入口 `pnpm test:zcode-cli-rust-drivers` 当前为 15 cases（本地日志 `/tmp/cli-rust-main-node-tests.log`）。另一个 CI 脚本回归套件命令 `node --test --test-isolation=none scripts/ci/*.test.mjs` 当前为 256 cases；256 不是 Node driver 入口的数量。
- Transformation inventory：63 paths、70 leaf branches × 5 cases = 350 leaf cases；另有 29 整 Command cases 和 1 ACK case。29 Command/ACK cases 通过 `parse_command` + serde 验证完整 outputs；350 leaf cases 验证 publicNode normalization projection，不应统称为完整 DTO oracle。覆盖是受控验收的当前 case，不等价于 exhaustive product parity。
- Linux hardened interop 日志 `/tmp/cli-rust-hardened-interop.log`：alternate 1/1、crash 4/4、concurrent 2/2 sessions/read/equal；crash 包括四个 kill/resume 方向；源数据库 hash 不变且 compare 使用独立 copies。仅支持同 workspace/session 顺序 alternate，以及不同 workspace/session 的并发；mixed-runtime 同 workspace owner coordination 未验证。
- 已受控验证当前原始输入 transformation、protocol/schema 与 interop cases；这不是全面 DTO/schema drift 证明或 exhaustive 产品 parity。禁止文档继续称 protocol strip/trim/baseRevision 未修好，或称 interop 尚未移植/尚未运行。
- M8 blocker 不是 Rust 缺少 `prepare-storage` 命令：Rust 已有 command/frames；Desktop resolver 未声明相应 capability，故在 Rust 启动前将 `prepareSessionStorage` 判为 `unsupported_runtime`。Native process transport 尚未接入 Worker 分支。不得加 fallback 或扩大 UI/platform interface 来绕过 gate。
- mixed runtime 同 workspace owner 未协调。Native Windows/macOS runtime 仍未实际运行；新增 native CI 仅做 compile check，等待远程真实 CI 结果也不能表述为 runtime 通过。Windows Linux cross-check 的当前障碍为缺少 native `lib.exe`，这不证明 Windows 原生 runner 失败或通过。
- Rust CLI effective storage config 目标仍为 TS `DefaultRuntimeConfig.storage` 的 `~/.zcodium`；standalone fallback `.zcodium-exp` 与之不同，尚无 home migration。不得启动默认 runtime或声称已完成迁移。
- 最新 root `pnpm lint` 有 51 条 TypeScript warnings；Rust 全 workspace、all targets 的 `cargo clippy --locked --manifest-path apps/zcode-cli-rust/Cargo.toml --workspace --all-targets -- -D warnings` 已实跑通过且无 warnings，证据日志 `/tmp/cli-rust-main-workspace-clippy.log`。Rust `cargo fmt --all --check` 通过。Root `pnpm fmt:check`（oxfmt）最新结果为 79 项失败；本任务 scope 文件的格式检查为零问题。`/tmp/cli-rust-main-format.log` 是本地日志，不是可移植验证入口。

验收要求：validate workflow YAML/syntax and script references; execute `pnpm test:zcode-cli-rust-drivers` (current 15 cases) and, separately, `node --test --test-isolation=none scripts/ci/*.test.mjs` (CI script suite, 256 cases); execute root typecheck, lint, fmt check and changed architecture check; targeted formatting only for scoped paths as applicable. Do not commit or push. Native matrix status is pending until the actual remote CI jobs finish.
