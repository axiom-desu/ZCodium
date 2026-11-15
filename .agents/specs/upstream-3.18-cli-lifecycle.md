# 上游 3.18.2 CLI 生命周期 / MCP 信任 / 插件启动预算（C4）

## 范围与来源

- 上游：`apps/zcode-cli/packages/bootstrap/src/{session-lifecycle,workspace-mcp-trust,plugin-startup-budget}`，
  `bootstrap/src/app/{create-app.ts,bundled-plugins.ts}`，`bootstrap/src/zcode-protocol/{server.ts,server-types.ts,mcp.ts}`，
  `packages/shared/src/zcode-protocol/index.ts` 的 lifecycle/trust schema 与
  `packages/shared/src/mcp.ts` 的 `WorkspaceMcpTrustReview`（`fec97590`，3.18.2）。
- 本仓基线：`feat/upstream-3.18.2-sync`。既有 owner：`SessionResidentPool`（容量/回收）、
  `server-operations`（session 物化）、`runtime-resources`（app 资源）、`session-residency`（去激活执行面）。
- 本片只做 F5 / F7 / F8。F3 prompt snapshot、F6 session-data、F15 Hook `onError` 由其他 writer 负责，不在本片改动。
- Rust 侧本片不适用（CLI 无 desktop host attachment）；不复制参考 Rust 结构。

## 单一所有者与事件顺序

```text
协议 session/lifecycle/* → SessionLifecycleController（每 session 一个操作 owner）
  → validateActivation（只读预检，无副作用）
  → activate: activateSessionForResume（既有 runtime 物化路径）
  → release: releaseSessionRecord（既有 record/app 释放路径）
  → context.notify(session/lifecycle/changed)

LRU/TTL 去激活 → SessionResidentPool → deactivateSessionRecord
  → 若 context.sessionLifecycle 存在：lifecycle.dispose(release)（同一 owner 串行）
  → 否则沿用原直接释放路径
```

- 不新增第二 runtime、第二条 accepted 队列或第二份 session registry。
- `stop` 与 `restart` 必须串行：`restart` 遇到在途 `ensureReady` 时先登记“启动后重启”，
  期间拒绝新 `stop`；`ensureReady` 遇到在途 `stop` 时等待后重试。
- 预检失败（`sessionNotFound`、workspace 冲突、`faulted`）不产生副作用。
- 版本事实：初始化成功 `generation += 1`；每次状态迁移 `revision += 1`。
  失败释放进入 `faulted`，迟到回调不能复活下一实例。
- `getState` 只读：不得触发激活/续期/回收。

## MCP 工作区信任

- 唯一写入者：`createWorkspaceMcpTrust`，存储 `security/workspace-mcp-trust-v1.json`
  （与 Hook trust 同目录，由用户存储根决定；项目 `storage.dir` 不能选择信任文件）。
- 记录：`{ workspaceIdentity, serverName, declarationDigest(sha256 hex), grantedAt }`，
  `schemaVersion: 1`；损坏存储一律视为“未授权”，不得把声明显示为可信。
- 摘要：工作区归一化后的执行配置 + workspace 身份 + server 名 + 声明来源路径，规范 JSON 后 sha256；
  `enabled`/`source` 不参与摘要。
- `inspect`：只读声明与持久授权，不连接。读取失败返回空集，不影响用户/插件 MCP 列表。
- `decide`：文件锁内重读声明；摘要不符返回 `workspace_mcp_declaration_changed`；
  持久写成功是返回成功的唯一条件；不启用、不连接。
- `allows`：plugin/builtin/user 显式来源保持原语义；工作区来源要求声明存在、enabled、摘要精确匹配且有授权记录；
  无声明/无来源/未知名字一律 fail closed。收紧后的完整准入规则见
  `upstream-3.18-security-hardening.md`（B1）；用户/系统来源由 `createConfig` 的 `serverSources` 显式映射。
- `guard`：包装既有 `McpPort`。连接前重验；配置移除/变更/损坏/撤销后拒绝新连接，并先断开旧连接；
  已连接调用只查已准入快照；替换连接时旧迟到握手不能覆盖新配置；`close` 只关闭门，不重复关闭底层 lease。
- 协议：`workspace/mcp/trust` 只做 `decide` 并返回 `{accepted, reasonCode?}`，不携带连接副作用。

## 插件启动预算

- `createPluginStartupBudget` 是进程拥有的等待预算：
  - 超时后置 `degraded`、触发一次 `onTimeout`，返回 `plugin_startup_timeout` warning 的空插件结果；
  - 超时后迟到结果必须被丢弃（不能先返回空、再让迟到结果覆盖）；
  - 并发 `resolvePlugins` 共享同一截止时间与同一个 expired 事实；
  - `dispose` 后的新调用抛关闭原因，未决调用结算为关闭原因，不产生未处理拒绝。
- 接线：`resolveStartupPlugins` 接受 `pluginStartupTimeoutMs`；未配置或 `<= 0` 时保持当前行为
  （与上游 3.18.2 生产默认一致：预算默认停用，避免冷启动误降级）。启用时预算只覆盖
  “解析插件根 + discovery”，降级返回 warning 空结果并记录日志，进程不因插件超时失败。
- 不通过超时掩盖同步错误；预算仅处理“插件准备过慢”，不改变 Hook/MCP 授权。

## 验收

- `bootstrap/test/session-lifecycle.test.ts`：只读 getState；并发 ensureReady 单 flight；
  stop/restart 串行；预检失败无副作用；释放失败 faulted；generation/revision。
- `bootstrap/test/workspace-mcp-trust.test.ts`：摘要稳定；未授权/授权/撤销；配置变更 fail closed；
  存储损坏 fail closed；持久化成功后才返回；guard 在连接前拒绝；迟到连接不覆盖替换。
- `bootstrap/test/plugin-startup-budget.test.ts`：超时降级；迟到完成被丢弃；并发共享预算；
  dispose；经 `resolveStartupPlugins` 的实际接线降级。
- 全部测试使用临时 HOME/XDG/workspace，不读真实配置、不连真实 MCP/远端。
- 执行 `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`，如实记录结果。
