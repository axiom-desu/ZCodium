# 普通 lint warning 退役：行为边界与验证

本 spec 只覆盖“非 max-lines 文件上的普通 warning”这一分片（`lint-debt-retirement.md` 实施分片 1），
不涉及任何 max-lines 文件与其新拆分模块、Rust、vendor 资产、构建脚本、`.oxlintrc`、gate/baseline。

## 不变量

- 不新增 disable/ignore/阈值，不把真实字段改成 `any`，不写 no-op 假消费。
- 未使用项按语义删除：有副作用的调用保留（只删未使用的绑定），不删除公开协议字段、不改公开函数 arity。
- `preserve`：所有改动不改变事件顺序、状态 owner、持久化与恢复语义。

## 行为变更（仅控制流，不改业务结果）

### `no-unsafe-finally`：清理异常优先级

涉及：

- `apps/zcode-cli/packages/adapters/src/storage/session-store/migration-runner.ts`
  （`runSqliteSessionMigrationsAsync` 恢复 `busy_timeout`）
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/storage-startup.ts`
  （握手收尾关闭 store）
- `packages/services/src/session/tasksDatabase/startup.ts`
  （关闭迁移连接；关闭 `TaskIndexRepo`/`AutomationRepo`）

规则：**首个异常（primary error）优先；清理异常只在原操作成功时才传播。**

实现方式：`finally` 内不再 `throw`，改为记录 `cleanupFailed`/`cleanupError`，在 `try/finally`
结束后再判断是否抛出。这样 primary error 由 JS 语义自然优先，不再依赖
`if (!failure) throw error` 的真值判断——旧写法的真值判断会把 `throw null`/`0`/`""`/`undefined`
误判为“原操作成功”，从而让清理异常顶替首因，属于真实缺陷，已在代码中以中文注释说明依据。

`bootstrap/storage-startup.ts` 额外引入显式 `hasFailure` 标记（原 `failure` 变量只用于该判断，已删除），
保证 falsy primary error 仍被识别为失败。

回归锁定：`apps/zcode-cli/packages/adapters/test/session-migration-cleanup.test.ts`
（primary + cleanup 同时失败时首因保留；falsy primary `throw null` 仍优先）。

`bootstrap` 与 `services` 两处的清理失败路径没有可注入的 seam（`store.close()` / `db.close()` 由模块内部创建），
按不虚构依赖注入边界的原则未新增注入点；其语义由同一控制流位移保证，且没有再依赖真值判断。

### `no-unsafe-optional-chaining`（测试）

`apps/zcode-cli/packages/contracts/test/in-memory-session-event-store.test.ts`：先用 `assert.ok`
断言事件存在，再去读 `payload`，断言强度不降低，不用可选链吞掉缺失。

### `no-control-regex`

- `packages/ui/src/plugin-ui/domain/pluginUiDownloadFile.ts`：逐字符按码点判断替换（分隔符或 `< 0x20`），
  与旧 `[\\/\u0000-\u001f]` 完全等价。
- `packages/shared/src/zcode-protocol-v4/transport.ts`：用 `String.fromCharCode(0)` 拼出等价字符类，
  拒绝 NUL 与换行的校验语义不变，schema 仍为单一 `regex` 约束。

### `typescript-no-this-alias`

`packages/rpc/src/ipc.ts`：`getChannel` 返回的 `call`/`listen` 改为箭头函数，`getMulticastEvent`
的回调本就是箭头函数，均直接使用类实例 `this`，不再保存 `const that = this`。

## 明确不在本分片内（未修改）

- 构建/打包脚本与配置：`packages/desktop/electron-builder.config.js`、
  `packages/desktop/scripts/*.mjs`、`apps/zcode-cli/packages/node-repl-host/scripts/build.mjs`、
  `apps/zcode-cli/packages/cli/scripts/sea-official-plugin-assets.mjs`。
- vendored skill 资产：`pdf-plugin`、`superpowers-plugin`、`restore-legacy-sessions-plugin` 下的脚本。
- max-lines 文件及其新拆分模块（其他 worker 范围）。

这些文件里仍有普通 warning，按上述边界保留为真实剩余项，不通过修改这些文件或加 disable 清零。

## 验证

- `pnpm typecheck`（root，`tsc -b`）通过。
- 逐包 `tsc --noEmit`：adapters、bootstrap、node-repl-host、tools/repo-snapshot-parody 通过；
  contracts/core 的语法错误来自其他 worker 正在编辑的文件（非本分片改动）。
- `npx oxlint` 全仓 JSON 统计：本分片原 75 个文件里 66 个已零诊断，剩余 16 条全部落在上节禁止范围内。
- `node --import tsx --test test/session-migration-cleanup.test.ts`（adapters）2/2 通过。
- `npx oxfmt --check` 对改动文件通过（`useRootWorkspaceActions.ts` 已按 formatter 修正）。
