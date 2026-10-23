# adapters/plugins max-lines 分片：职责接缝与不变量

本 spec 是 `.agents/specs/lint-debt-retirement.md` 的实施分片 4（adapters/plugins）实现说明。
`apps/zcode-cli` 当前在 `architecture-policy.yaml` 中是 unmanaged（`architecture:context zcode-cli`
返回 `managed: false`），因此本切片只做包内结构治理，不宣称完成模块级 runtime 架构重设计。

只覆盖以下 3 个 max-lines 文件及其相邻 helper/test；不改其它 adapter 目录、contracts、Rust、
gate/baseline、ignore、`.oxlintrc` 或真实用户数据目录。

## 范围

路径相对 `apps/zcode-cli/packages/adapters/`：

| 文件                         | 原有效行 | 目标 | 新文件（同包 `src/plugins/`）                                                                                                                                                                                                                                                                        |
| ---------------------------- | -------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/plugins/marketplace.ts` | 2431     | ≤400 | `marketplace-types.ts`, `marketplace-manifest.ts`, `marketplace-authority.ts`, `marketplace-source.ts`, `marketplace-git.ts`, `marketplace-source-load.ts`, `marketplace-refresh.ts`, `marketplace-cache.ts`, `marketplace-dependencies.ts`, `marketplace-diagnostics.ts`, `marketplace-describe.ts` |
| `src/plugins/index.ts`       | 842      | ≤400 | `plugin-hooks.ts`, `plugin-components-resolve.ts`, `plugin-load.ts`                                                                                                                                                                                                                                  |
| `src/plugins/zip-source.ts`  | 458      | ≤400 | `zip-source-archive.ts`, `zip-source-paths.ts`                                                                                                                                                                                                                                                       |

新增/修改的切片测试放在 `test/`：入口导出面锁、刷新失败投影、非法 archive 拒绝、安装失败
rollback。所有新文件同样受 400 有效行约束。fixture 只使用 `mkdtemp` 临时目录，不读写真实
`$HOME`、`~/.zcode`、用户 config 或 logs。

## 接缝与状态 owner

### Marketplace

- `marketplace.ts` 只保留原公开导出面（`export type` / `export { ... } from "./...js"`）；
  不新增公开 helper，不恢复 CI 已收回的 `MarketplaceRefreshFailure` / `PluginValidationDiagnostic`
  导出，也不机械导出所有内部函数。内部 helper 只在确实被其它源文件消费时导出。
- 唯一事实 owner 不变：
  - known marketplaces 的写入/rollback 仍由 `marketplace-authority.ts` 组合
    `activateDirectoryAtomically` 完成；`upsertKnownMarketplace` 的并发代际校验、失败回滚、
    `cacheTransactionId` 语义逐字保留。
  - installed plugins 仍只由 `marketplace-cache.ts` 修改 `InstalledPluginsState`，安装循环失败时
    只回滚本循环新建的 activation，成功后统一 finalize；不新增第二份 installed 队列/缓存。
  - manifest 校验仍只在 `marketplace-manifest.ts`（解析/规范化）与
    `marketplace-diagnostics.ts`（根目录/manifest/MCP 校验）发生。
- `workspaceIdentity` / `remoteSessionId` 等远端参数不进入本切片；不改变路径解析、source
  identity pin、`cachePath`、staging/target 或 atomic transaction 参数。
- 刷新错误投影保持现状：`updateMarketplace` 对单市场失败写 `lastRefreshFailure`，abort 直接
  抛出且不持久化；慢请求的 180s timeout、redirect 上限与 header 跨 origin 清理不变。本切片
  **不顺手修** 刷新错误/慢请求行为，只锁定现状。
- 原 async 调用顺序不变：source resolve → manifest 准备 → stage/activate → known authority →
  finalize；install 的依赖闭包顺序、逐插件 cache 顺序、`saveInstalledPlugins` 后 finalize 顺序
  逐字保留。跨包只使用公开入口，不把 marketplace 内部细节暴露到其它包。

### Plugin adapter index

- `NodePluginAdapter` 仍是 discover 的 orchestration owner：candidate 解析、enabled 判定、重复 id
  过滤、priority 递增、mcp/hook/skill/command 聚合顺序留在 `index.ts`。
- `plugin-hooks.ts` 只承载 hook 文件解析/合并/详情投影；`plugin-components-resolve.ts` 只承载
  component root 解析、generated command materialize 与 skill 计数；`plugin-load.ts` 只承载
  candidate root 的 manifest 读取。它们不持有插件状态。
- `index.ts` 对 helper 的导入使用标准 `.js` 后缀；保留原函数 arity、`readonly` 参数/字段与返回
  类型。原公开 `NodePluginAdapter` / `createNodePluginAdapter` / `discoverNodePluginsSync` 不变。

### Zip source

- `zip-source.ts` 保留公开 `resolveZipPluginSource` / `resolveHttpZipSource` /
  `readZipPluginSourceSha256` / `isZipPluginUrlSource` / `PluginZipDownloadError` 与输入/结果类型。
- `zip-source-archive.ts` 独占下载/解压/大小上限/redirect/abort 与 cleanup；`zip-source-paths.ts`
  独占 zip 路径规范化、越界拒绝、entry 类型（symlink/encrypted）与 root 选择。
- 非法 archive 的拒绝顺序、错误消息、cleanup best-effort 与 sha256 校验时机不变；不新增兜底。

## 不变量

- 原 public export、receiver/`this`、异步顺序、事件/诊断 code、manifest 校验、安装原子性与
  rollback 语义保持；不新增 `any`、oxlint disable、ignore/阈值、不压行、不拆成跨包细节。
- 不删除与任务无关的本地改动，不恢复已移除模块/内部依赖，不刷新 gate baseline。
- 清理本切片自身 warning；定向 oxlint 原文件与新 helper 的 `max-lines` 归零。

## 验收

- 先补测试并在原文件上通过，再实施拆分后重跑：
  - 入口导出面锁：`index.ts` 对 marketplace 公开符号的 re-export 不变。
  - 刷新失败投影：单市场失败写 `lastRefreshFailure`；abort 不写。
  - 非法 archive：路径穿越/symlink/加密/超限被拒绝且临时目录清理。
  - 安装失败 rollback：依赖安装中途失败时 activation rollback，installed state 不落盘。
- `pnpm --filter @zcode/adapters typecheck`、`pnpm --filter @zcode/adapters test`。
- 定向 oxlint 原文件与新 helper；`pnpm fmt:check` 覆盖新文件。
- 根 typecheck/lint/三 gate/architecture 由父任务统一验收；本切片不刷新 baseline。
