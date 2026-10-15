# CLI Rust 测试 driver：子进程生命周期与超时

## 范围与所有权

本 spec 只覆盖 `scripts/` 下 CLI Rust 差分验收的 Node 测试 driver 如何派生、限时、终止并等待外部子进程；不涉及任何 Rust 生产实现、协议语义或产品行为。

- 唯一持有者：每个 driver 文件里真正调用 `spawn` 的 helper。它拥有该次子进程的 deadline、进程组归属、kill 策略和 `close` 等待；调用方只提供命令、参数、stdin 内容和 deadline。
  - `scripts/tests/cli-rust-m5-diff.test.mjs::run`（参考实现，本 spec 不改动该文件）。
  - `scripts/tests/cli-rust-m5-tools.test.mjs::run`（本 spec 补齐）。
  - `scripts/zcode-cli-rust-m4-model-oracle.mjs::runProcess`（本 spec 补齐）。
- 本 spec 不新增业务状态或缓存：`timedOut` / deadline 只是单次 `spawn` 的局部变量，随用例结束释放，不跨用例共享、不写入仓库、也不替代任何产品级取消或超时。
- 本 spec 不覆盖 `scripts/zcode-cli-rust-interop-runtime.mjs` 的 app-server 会话进程（它另有自己的 `kill`/`exited` 约定）；两者可以遵循相同的进程组思路，但所有权与接口彼此独立。

## 已确认问题

1. M5 tools 的 `run()` 直接 `spawn("cargo", ["run", ...])`，既没有 deadline 也没有独立进程组。driver 卡死时 CI 会无限等待；即便补上超时，只杀 `cargo` 也会遗留它通过 `cargo run` 派生出的被测 example。
2. M4 oracle 的 `runProcess()` 超时只调用 `child.kill("SIGKILL")`。`cargo build` / `cargo run` 会再派生 `rustc`；只杀直接子进程会遗留 `rustc` 继续占用 `target/`，并可能在调用方删除临时 HOME 时仍在写。

两者属于同一类测试支撑缺陷，修复规则由本 spec 统一约定，而不是在各 driver 里各写一套。

## 接口与顺序

```text
driver helper.run(command, args, input, timeoutMs)
  │  唯一所有者：本次 spawn 的 deadline + 进程组 + close 等待
  ├─ POSIX (process.platform !== "win32")
  │    spawn(..., { detached: true, stdio: ["pipe","pipe","pipe"] })
  │      → child.pid 成为新进程组组长，cargo/rustc/被测 example 同组
  │    deadline 到 → process.kill(-child.pid, "SIGKILL")  // 杀整组
  │                 失败(ESRCH/不可用) → child.kill("SIGKILL") 回退
  └─ Windows
       spawn(..., { detached: false, stdio: ["pipe","pipe","pipe"] })
       deadline 到 → child.kill("SIGKILL")                 // 无进程组信号
                        │
          无论哪条路径：clearTimeout → await child "close"
                        │
             超时 → reject(`<label> timed out after <ms>ms`)
             正常退出 0 → resolve(stdout)
             其它 → reject(`<label> exited <code|signal>: <stderr>`)
```

- kill 之后必须继续等待 `close`（Node 的 `close` 表示进程已退出且 stdout/stderr 管道已关闭）。在此之前不得 reject、不得删除临时目录或 target 产物。
- POSIX 用进程组 kill 是为了覆盖 `cargo run`/`cargo build` 的子孙进程（`rustc`、被测 example）；Windows 没有等价的负 pid 进程组信号，退回杀直接子进程，作为已声明的平台差异。
- `child.stdin` 在写入前挂 `error` 空处理器；提前退出由退出码/`stderr` 报告，而不是未捕获的 stdin EPIPE。

## 超时预算

- M5 差分 driver（`cli-rust-m5-diff` / `cli-rust-m5-tools`）：`DRIVER_TIMEOUT_MS = 180_000`。首次 `cargo` 编译可能较慢，但 driver 卡死必须在 180s 内失败并清理，而不是让 CI 永挂。实时 TS oracle（`node --import tsx`）与 `cargo run` 共用同一 deadline。
- M4 oracle `runProcess`：每次调用传入有界 `timeoutMs`，沿用调用点现值——`buildRustExample` 600_000，运行 `model_fixture` example 默认 15_000；本 spec 只改变超时后的终止方式，不改变预算数值。
- M4 example 运行保持“空环境白名单”（只给临时 `HOME`）与临时 HOME 的 `finally` 删除；`cargo build` 保持 `process.env`（需要 PATH 等）。进程组 kill + `await close` 才能保证删除临时 HOME 时编译/运行子进程已退出。

## 本批验收场景

- M5 tools `run`：用会挂起的子进程（`node -e "setTimeout(() => {}, 60_000)"`）在 100ms deadline 下断言 reject 文本包含 `timed out after 100ms`，且 reject 发生在 `close` 之后（helper 不遗留挂起进程）。与 `cli-rust-m5-diff` 既有的同类用例语义一致。
- M5 tools 四个工具差分用例仍在 180s deadline 内正常通过，超时逻辑不改变正常输出解析。
- M4 oracle：`buildRustExample` 与 `runRustOracle` 走同一 `runProcess`，在 POSIX 下整组 SIGKILL、Windows 下直接 kill；example 运行仍使用空 env + 临时 HOME，退出/超时都 `await close` 后才 resolve/reject。
- M4/M5 现有差分用例全量运行作为回归，证明改动仅影响超时路径，未改任何业务断言。

## 未覆盖边界

- Windows 只有直接子进程 kill，不声明能清理 `cargo` 派生的 `rustc` 子孙；这是平台能力差异，不作为 parity 缺陷。
- 只处理 SIGKILL 强杀，不实现 SIGTERM 优雅退出、信号升级或进程树快照。
- 本 spec 不新增 Rust 单测、不改 `crates/**`、`examples/**`，也不改 `scripts/tests/cli-rust-m5-diff.test.mjs` 与其它实现。

## 验收与边界

命令：

- `node --import tsx --test --test-isolation=none scripts/tests/cli-rust-m5-tools.test.mjs`
- `node --import tsx --test --test-isolation=none scripts/tests/cli-rust-m5-diff.test.mjs`（回归，文件不改）
- `node --import tsx --test --test-isolation=none scripts/tests/cli-rust-m4-model.test.mjs`
- `pnpm exec oxlint <改动文件>`、`pnpm exec oxfmt --check <改动文件>`
- `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`

本 spec 只约定测试 driver 的进程生命周期，不代表 M4/M5 产品级取消或超时已验收。
