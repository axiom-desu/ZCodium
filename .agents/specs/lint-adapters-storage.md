# adapters/storage max-lines 分片：职责接缝与不变量

本 spec 是 `.agents/specs/lint-debt-retirement.md` 的实施分片 4（adapters/storage）实现说明，
只覆盖以下 6 个 max-lines 文件及其相邻 helper/test；不改 `migration-runner.ts`（另一个 worker
已修复 `no-unsafe-finally`）、contracts、其它 adapter 目录、Rust、gate/baseline 或 ignore。

## 范围

路径相对 `apps/zcode-cli/packages/adapters/`：

| 文件                                                | 原有效行 | 目标 | 新文件（同包）                                                                                                                                                                                                       |
| --------------------------------------------------- | -------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/storage/index.ts`                              | 435      | ≤400 | `src/storage/tool-artifact-store.ts`, `src/storage/tool-artifact-codecs.ts`                                                                                                                                          |
| `src/storage/session-target.ts`                     | 422      | ≤400 | `src/storage/session-target-row.ts`, `src/storage/session-target-access.ts`, `src/storage/session-target-runs.ts`                                                                                                    |
| `src/storage/workspace-hook-trust-store.ts`         | 472      | ≤400 | `src/storage/workspace-hook-trust-types.ts`, `workspace-hook-trust-file.ts`, `workspace-hook-trust-lock.ts`, `workspace-hook-trust-codec.ts`                                                                         |
| `src/storage/session-store/migrations.ts`           | 821      | ≤400 | `migrations/0001-0006-base-schema.ts`, `0007-0009-workflow-schema.ts`, `0010-0012-usage-schema.ts`, `0013-0015-message-sequences.ts`, `0016-0018-session-inputs.ts`, `0019-dwf-journal.ts`（0020–0022 已有独立文件） |
| `src/storage/session-store/sqlite-session-store.ts` | 914      | ≤400 | `session-store/repository-surface.ts`, `target-surface.ts`, `usage-workflow-surface.ts`, `fork-commit.ts`, `surface-base.ts`                                                                                         |
| `src/storage/session-store/repositories/usage.ts`   | 704      | ≤400 | `usage-model.ts`, `usage-turn.ts`, `usage-tool.ts`, `usage-query.ts`, `usage-values.ts`                                                                                                                              |

新增/修改的切片测试放在 `test/`：SQL/导出面锁与事务回滚回归。所有新文件同样受 400 有效行约束。

## 接缝与状态 owner

### SQLite migrations

- `migrations.ts` 只保留 migration 类型、`SQLITE_MIGRATIONS` 的**静态组合**与导出。
  组合顺序固定为 0001→0022；每个 id 仍只出现一次。
- 每条 migration 的 `appVersion`、`id`、`sql` 原字节完全不变：不 trim 模板内字节、不补/删换行、
  不改模板插值。`checksum` 仍由 migration runner 对最终 `sql` 计算，因此拆分后 Rust
  `node/migrations/*.sql` 必须与 TS 输出逐字节相同。
- 拆分只按既有 id 组移动对象字面量；不合并、不重排、不改 runner。

### SqliteSessionStore

- `SqliteSessionStore` 仍是唯一的 SQLite connection owner：打开/关闭、startup migration、
  `throwBeforeWrite`、`begin immediate`/`commit`/`rollback` 都留在该类。
- 事务 body 可移到 `fork-commit.ts`，但 helper 不 begin/commit；class 的 `runImmediateTransaction`
  是唯一事务边界。fork child、copy、goal、entries、input、parent command fact 的原子性、
  `forkCommitFaultAt` 注入顺序、existing bundle 幂等返回均不变。
- repository 委托方法按 query/target/usage-workflow 责任放入 surface 基类，通过继承保留
  `SqliteSessionStore` 的完整公开方法面；不建立包含全部方法的“巨大 this 接口”。
- `UsageStorePort` 的 retention（`pruneUsage`，30 天）、input history、ACK/command fact
  的唯一写入路径不变；不新增第二份 accepted/queue 状态。

### Session target

- `session-target.ts` 继续导出原所有函数；写入仍是 `session_target` 的单一路径。
- 行解码/目标 id/时长计算放 `session-target-row.ts`；读取与 `touchSessionForTarget` 放
  `session-target-access.ts`；run 生命周期（start/heartbeat/finish/recover/account）放
  `session-target-runs.ts`。`active_*` 清理、`budget_limited` 判定、崩溃恢复不用 `Date.now()`
  结算等语义逐字保留。

### Workspace Hook Trust

- `FileWorkspaceHookTrustStore` 仍是 mutation queue 与 read-modify-write 的唯一 owner；
  `grant/revoke/touch/compact/load` 的校验、空 digest 三态、fail-closed corrupt 语义不变。
- `workspace-hook-trust-lock.ts` 独占 lock 获取/所有权校验/stale 回收/进程实例启动时间判断；
  `workspace-hook-trust-file.ts` 独占目录权限、读当前文件、corrupt 改名、atomic write/rename retry；
  store 只组合二者，不复制锁或文件事实。
- 所有 IO 保持 `async`/`Promise` 包装，不因为拆分改成同步。

### Tool artifact store

- `NodeToolArtifactStore` 仍是 artifact 路径与 media singleflight 的唯一 owner；
  `tool-artifact-store.ts` 承载类，`tool-artifact-codecs.ts` 承载 MIME/扩展名/URI/data URL 纯转换。
- `index.ts` 只保留原导出（含 `InMemorySessionEventStore` 与 session-store/trust re-export），
  原 `NodeToolArtifactStore`、`createNodeToolArtifactStore`、`NodeToolArtifactStoreOptions`
  名称与签名不变。

### Usage

- `recordModelUsage`/`upsertTurnUsage`/`upsertToolUsage`/`pruneUsage` 拆分后仍由原 `usage.ts`
  重新导出；写入 SQL、upsert 合并规则、retention delete 顺序不变。
- `queryTaskUsage` 保留 **source baseline** 语义：按 `main_turn`/`subagent`/`workflow_child`
  分别维护 `inputBaselineBySource`，压缩后 baseline 跟随下降，不能退化为输入行简单相加。
  `queryAppUsage` 的 dayIndex 固定偏移、三类按日合并、模型/工具聚合不变。
- 新增切片测试锁定 source baseline 与事务回滚，不只比较总数。

## 不变量

- 原 public export、`SessionStorePort`/`UsageStorePort` 方法、receiver/`this` 可见 API 保持；
  跨包仍只用 `@zcode/adapters/storage` 公开入口。
- 不新增 `any`、oxlint disable、ignore/阈值、不压行；新增 IO helper 必须保持原异步边界。
- 不改事件/命令顺序、owner/lease、workspace identity、migration checksum 或恢复/回放语义。
- 不删除与任务无关的本地改动，不恢复已移除模块。

## 验收

- 先跑新增 SQL/导出面锁与事务回滚测试（在原文件上通过），再实施拆分后重跑。
- `pnpm --filter @zcode/adapters typecheck`、`pnpm --filter @zcode/adapters test`。
- 定向 oxlint 上述原文件与新 helper：max-lines 归零、无新增 warning；清理本切片自身 warning
  （`sqlite-session-store.ts` 的 `no-useless-fallback-in-spread`）。
- `pnpm check:zcode-cli-rust-contract-assets` 只做 `--check`，不生成/改写 Rust 资产；
  必须证明 SQL 字节与 checksum 未变。
- 根 typecheck/lint/三 gate/architecture 由父任务统一验收；本切片不刷新 baseline。
