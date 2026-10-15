# M8：Desktop 原生 storage preparation transport

## 范围

- 只改 Desktop Host 的存储准备实现：`packages/desktop/src/host/storagePreparationProcesses.ts`
  与新增同目录 `storagePreparation*` helper/test/fixture。
- 不新建 schema、UI、accepted queue 或回退路径；不改默认存储路径、历史 SQL、用户库。
- `packages/desktop/src/host/hostDatabaseStartup.ts` 只消费既有导出
  `prepareHostStorage` / `prepareSessionStorage`，本 spec 不改变其调用签名与语义。

## 产品规则

- 存储准备由 Services resolver 唯一决定 transport：

  ```ts
  type ZCodeAgentStoragePreparation =
    | { kind: "node-worker"; entry: string }
    | { kind: "native-process" };
  ```

  `ZCodeAgentCommand.storagePreparation` 是唯一 tagged descriptor（`@zcode/services/storage-startup`
  导出该类型）；Host 不再读取旧的 `storagePreparationEntry` 字符串，也不推断未知自定义命令的存储能力。

- `kind: "node-worker"`：运行已知 JS 存储 Worker（`entry`），argv 沿用
  `app-server --stdio --prepare-storage --cwd <cwd>`。
- `kind: "native-process"`：复用 resolved `command/args/cwd/env`，追加
  `--prepare-storage --cwd <cwd>` 启动原生进程。禁止把 Rust binary 塞进 `Worker`。
- 两条 transport 必须复用同一份握手、`realpath`、`observePath`、`preparedPaths`
  与失败上报；transport 只负责 stdin/stdout/stderr、退出与终止。

## 所有者与顺序

```text
HostDatabaseStartupCoordinator（唯一启动状态 owner）
  → prepareSessionStorage（本 spec 唯一握手/reuse owner）
      → Services resolver 产物 storagePreparation
      → runStoragePreparation（唯一帧解析路径）
           ├─ node-worker transport（worker_threads）
           └─ native transport（child_process + 既有进程树清理）
      → storagePath 帧 → realpath → observePath（按需）
      → storagePathReady{reuse} → startup/storageState* → storagePrepared
      → stdout drain + exit code 0 → 成功；prepared path 才写入 preparedPaths
```

- `preparedPaths` 只缓存本轮已成功完成 `storagePrepared` 的真实路径；失败或非零退出
  一律不缓存，也不持久化 skip 标记。`reuse:true` 只表示 Host 本轮已成功关闭该库。
- 同一轮重复 `startup/storagePath`、`storagePrepared` 先于 `storagePath`、非法帧、
  `failed` 状态、非零退出、未收到 `storagePrepared` 都是失败。
- 正常成功路径必须在收到 `storagePrepared` 且底层退出码为 0、stdout 已排空后 resolve；
  仅退出码 0 不足以成功。

## 清理边界

- abort、非法帧、`observePath` 失败、超时都先请求终止 transport，然后等待底层退出；
  不以超时掩盖同步问题。
- native transport 使用 `@zcode/services/process/processTreeTerminator` 的公开
  `terminateProcessTreeAndWait`：POSIX 以独立进程组启动并按组回收，Windows 交给
  taskkill /T；进程树清理失败会返回 `remainingPids`，实现据此记录而不伪装成功。
- Host 正常退出不会留下持锁孤儿：`dispose()` 触发 abort，终止并等待 native 准备进程退出。
- 已知边界：Host 自身被 `SIGKILL` 时 JavaScript 无法运行，无法保证向子进程发送
  SIGKILL；这种情况下可能留下孤儿。该边界如实记录，不额外增加兜底分支。
- stdin EOF 只用于让 JS Worker 收尾；native 进程自行退出，收到 `storagePrepared` 后
  关闭写端产生的 EPIPE 不得判为准备失败。

## 验收

- Vitest 使用 `vi.mock` 替换 Services resolver，同一个真实 `.mjs` fixture 分别以
  Node Worker 与 native child 运行，覆盖：
  成功缓存、`reuse` 不重复 observe、非法帧、重复 path、prepared-before-path、
  failed 帧、非零退出、未 prepared、`observePath` 失败、abort 清理。
- native abort 用 fixture 写出的 PID 验证进程确实退出。
- 另加 `unsupported_runtime`（缺 descriptor）用例。

## 非目标

- mixed-runtime 同 workspace 并发 owner 协调、默认 Rust 启用、发布切换、
  MCP OAuth/CUA/REPL/memory 产品补齐。
