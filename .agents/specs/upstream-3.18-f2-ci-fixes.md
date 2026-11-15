# 3.18.2 F2：远端 CI 三类具体失败的定向修复

本片只修 `.github/workflows` 最近两次远端运行（43692966466 / 43692966383）里已复现的三类失败，
不新增产品能力，不改根 `package.json`/`knip.json`/CI workflow/棘轮 baseline（F1 独占），
也不放开任何 lint、type 或架构门禁。所有断言保留强度，不用加超时或改期望值来“通过”。

## 唯一所有者

| 状态 / 边界                         | 唯一所有者                                                               | 约束                                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| 远端 workspace bind 成功信号        | Host `RemoteWorkspaceContextBound` / `RemoteWorkspaceContextBindFailed`  | 见 `upstream-3.18-security-hardening.md` B3；Main 只认 ACK，不接受“请求已发出”当成功。     |
| Main ↔ Host bind 桥的测试夹具       | `packages/desktop/test/sourceAuthorityLoopback.test.ts` 的 `mainHarness` | 夹具代表真实 Host 进程，必须复刻 `host/index.ts` 的 ACK 回包，不能吞掉 bind 请求。         |
| 剪贴板图片写入                      | `packages/desktop/src/main/pluginSandbox/host.ts`（`clipboard.write`）   | Electron 44 异步剪贴板合同；`scripts/ci/browser-without-payment.test.mjs` 只补可解析形状。 |
| 会话数据存储类别目录的链接拒绝      | `crates/state/src/node/session_data_files.rs` `list`                     | 平台无关的安全断言，两个平台都真实执行。                                                   |
| POSIX 目录 fsync / 权限位的平台分支 | `crates/tools/src/checkpoint_blobs.rs`                                   | 平台分支用 `cfg` 表达，不用 `#[allow]` 抑制诊断。                                          |

## 失败 1：`sourceAuthorityLoopback.test.ts` 两个 5s 超时

复现：`pnpm vitest run --config packages/desktop/vitest.config.ts packages/desktop/test/sourceAuthorityLoopback.test.ts`
在本机同样两次失败；把超时放大后真实报错为
`workspace bind ACK 超时，sessionId=session-1, timeoutMs=40000`（`desktopRemoteSessions.ts` 的 bind 超时）。

已确认原因：B3 之后 `bindRemoteWorkspaceSessionContext` 必须等 Host 的 `RemoteWorkspaceContextBound`
才提交 descriptor 并换代 attachment；而 `mainHarness` 的假 Host 收到 `BindRemoteWorkspaceContext`
只调用 `registry.bindWorkspaceContext`，从不回 ACK，Main 的 pending bind 永远不会 settle。
换言之夹具落后于生产桥接，而不是产品逻辑回归。

规则：

- 假 Host 按 `host/index.ts` 的真实顺序实现：`registry.bindWorkspaceContext({..., signal})` 成功后才回
  `RemoteWorkspaceContextBound`（同 `requestId`）；抛错或 abort 回 `RemoteWorkspaceContextBindFailed`
  （带 `reasonCode`/`retryable`）。`CancelRemoteWorkspaceBind` 只 abort 本年度的 bind，不能改写已提交状态。
- 失败 ACK 时 Main 必须拒绝，且 **不** 提升 `rendererAttachmentId`、**不** 改动
  `registry` 里 session 的 `workspacePath/workspaceIdentity`，也不新增 `AttachServicePort`。
  这是“未知/失败 ACK 保守保留旧状态”的负向回归。
- 真实 loopback 负向回归（错误 Bearer 401 不写 history/credentials、`server-info` 只请求两次）保持并以实际执行作为证据。
- 不允许用 `--testTimeout`、`testTimeout` 配置或放宽 `expect` 掩盖；夹具修好后 5s 内必须完成。

## 失败 2：`fixture:electron` 缺 `ClipboardItem`

复现：`node --test scripts/ci/browser-without-payment.test.mjs` 直接失败，
esbuild 报 `No matching export in "fixture:electron" for import "ClipboardItem"`。

已确认原因：Electron 44 移除同步 `clipboard.writeImage`，沙箱复制图片改为
`clipboard.write([new ClipboardItem({ "image/png": Blob })])`；该 mock 仍只有旧 `writeImage`。

规则：

- mock 增加 `ClipboardItem` 类与异步 `clipboard.write`，只补到“能被解析”的最小形状，不模拟语义，
  也不 stub 整条生产 browser 链（`createBrowserWindow` 仍是真实实现）。
- “无 payment 例外”的既有断言（guest 隔离、preload 覆盖、popup 路由、外部链接）一条不少。

## 失败 3：Windows `--all-targets` 编译 + 同段两条 cfg unused 警告

复现（CI 原文）：`cargo check --locked --workspace --all-targets` 在 windows-latest 上
`error[E0433]: cannot find 'unix' in 'os'`，位置 `crates/state/src/node/session_data_tests.rs:260`，
`std::os::unix::fs::symlink` 未做 `cfg`。

规则：

- 用平台原语构造同一个安全夹具（unix `symlink`，Windows `symlink_dir`），
  “存储类别目录被换成链接必须拒绝清理”的断言在 unix 与 Windows 都真实执行，不删除、不跳过。
- 同段两条警告的实际原因：`crates/tools/src/checkpoint_blobs.rs` 的 `sync_parent` 只在
  `#[cfg(unix)]` 块里使用 `anyhow::Context` 与参数 `path`，Windows 编译时整块消失，于是
  import 与参数变成未使用。修法是把依赖项移入对应 `cfg` 块并按本文件既有风格显式说明
  非 unix 分支，不添加 `#[allow]`/`#[expect]` 抑制。

## 验收（临时 HOME/XDG/data/DB/workspace，loopback，显式复用工具缓存）

- Desktop：`pnpm vitest run --config packages/desktop/vitest.config.ts packages/desktop/test/sourceAuthorityLoopback.test.ts`
  两个用例在默认 5s 内通过；失败注入用例证明失败 ACK 不提交。
- Release：`node --test --test-isolation=none scripts/ci/browser-without-payment.test.mjs` 通过。
- Rust：`cargo check --locked -p zcode-cli-state --all-targets` 与
  `cargo test --locked -p zcode-cli-state node::session_data_tests` 通过；
  `cargo check --locked -p zcode-cli-tools --all-targets` 无新增警告。
- `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 如实记录，未执行或受环境限制的项明确标注。
