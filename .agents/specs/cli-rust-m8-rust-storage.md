# M8：Rust `--prepare-storage` 握手与复用契约

本 spec 只覆盖原生进程存储准备入口：`apps/zcode-cli-rust/src/main.rs`（`--prepare-storage` 分支，可提取 `src/storage_startup.rs`）与 `apps/zcode-cli-rust/crates/app-server/src/stdio.rs` 的启动握手，以及新增真实 binary 集成测试。对照 TS `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/storage-startup.ts` 与 Host `packages/desktop/src/host/storagePreparationProcesses.ts`。不修改 `packages/services`、`packages/desktop` 或其他 M8 worker 文件。

## 产品规则与边界

- 存储准备的唯一 owner 是 Host `prepareSessionStorage`：它决定真实路径、本轮已成功关闭的 `preparedPaths`、是否授予 `reuse`，并负责 `observePath`。Rust 只消费握手结果，不自行判断路径是否已准备。
- 原生进程与 Node Worker 共享同一组控制帧 schema，不新增帧类型，不改变 UI/platform API、accepted queue 或数据库 schema。
- 只有 CLI 能开库/迁移。Rust 必须在收到合法 `startup/storagePathReady` 之后才允许调用 `node_store()`；收到帧之前只允许解析存储路径（`node_database()` 不打开数据库）。
- `reuse:true` 只表示复用 Host 本轮已成功关闭的库：本次不再打开、不再迁移、不写永久 skip 标记。`reuse:false`（或缺省）走单一路径的开库/迁移。
- `reuse` 只作用于 `--prepare-storage` 进程。常规 `app-server` 启动仍必须先取 workspace owner 锁、发 `checking`、开库、发 `ready`，再进入 `serve`；`reuse` 不能绕过该 gate 或 owner 锁。
- 不加产品 fallback：非法握手、超时、EOF、开库失败都按既有启动错误语义失败，不用默认值掩盖。

## 共享 schema（冻结，来自 `packages/shared`）

```text
startup/storagePath        { method, params:{ path: string } }
startup/storagePathReady   { method, reuse?: boolean }          // 顶层字段，strict
startup/storageState       { method, params: zcodeStorageStartupStateSchema }
startup/storagePrepared    { method, params:{} }
```

`startup/storagePathReady` 与 TS `zcodeStoragePathReadySchema` 一致：对象只允许 `method` 与可选 `reuse`；`reuse` 存在时必须是布尔。`reuse:null`、`reuse:"yes"`、额外字段、嵌套 `params.reuse` 都不是合法握手，必须按非法输入处理，不能等同于 `false`。

## 事件顺序与所有者

```text
Host prepareSessionStorage
  ├─ write startup/storagePath(path)
  ├─ realpath → preparedPaths? → observePath(path when not reuse)
  └─ write startup/storagePathReady { reuse }
Rust --prepare-storage
  ├─ 读严格 pathReady；非法/超时/EOF 直接失败
  ├─ reuse:true  → 跳过开库
  ├─ reuse:false → startup/storageState checking
  │                → node_store() 单一路径开库/迁移
  │                → startup/storageState ready
  │                → 关闭连接
  └─ write startup/storagePrepared
     → stdout drain → exit 0
```

失败路径先写 `startup/storageState { phase:"failed", errorCode, ... }` 再以非零码退出；`storagePrepared` 只在成功、连接已关闭时发出。Host 只有同时满足 `storagePrepared`、退出码 0、无失败帧时，才把该真实路径加入 `preparedPaths`。

## 失败语义

- 30s 未收到 `startup/storagePathReady`：错误码 `startup_status_timeout`。
- stdin EOF / 输入通道关闭：错误码 `transport_closed`。
- 非法握手（类型/字段不符）：错误码 `sql_failed`（对应 TS 对未知错误的分类兜底），进程非零退出。
- 开库/迁移失败：沿用 `zcode_cli_state::node::open::StartupError.code`（如 `open_failed`、`corrupt`、`checksum_mismatch`），写入失败帧后非零退出。
- 失败帧写入失败时不覆盖原始存储异常；stdout 断管仍按既有取消路径收口。

## 不做的事

- 不新增帧类型、不改共享 schema、不添加持久化 `reuse` 标记。
- 不修改 Host/Worker 的 reuse 判定或 `observePath`。
- 不为 `reuse` 非法值猜默认，不把超时/EOF 静默当作复用成功。

## 验收（真实 binary，临时 HOME/DB/workspace）

1. 合法握手缺省 `reuse`：进程真实启动，输出 `storagePath` → `checking` → `ready` → `storagePrepared`，退出码 0，临时数据库被创建。
2. `reuse:true` 且数据库文件为故意损坏内容：进程跳过开库，只输出 `storagePath` → `storagePrepared`，退出码 0，文件字节哈希不变。
3. `reuse:false` 且数据库损坏：输出 `checking` → `failed`（带 `errorCode`），非零退出。
4. 非法握手（`reuse` 为字符串/`null`/额外字段）：失败帧 + 非零退出，且不创建/不修改数据库文件，证明非法 `reuse` 未被当作 `false`。
5. 读 `storagePath` 后关闭 stdin：进程快速失败（远小于 30s）且非零退出，不遗留持锁孤儿。
6. 定向执行 `cargo test -p zcode-cli-rust --test storage_preparation`、`cargo clippy -p zcode-cli-rust --all-targets`、`cargo fmt --check -p zcode-cli-rust`，并如实报告结果。
