# adapters MCP / FS 存量 lint 治理

父 spec：`lint-debt-retirement.md`。只处理 `packages/adapters/src/mcp/{index,pool,oauth-interactive}.ts`
与 `src/fs/index.ts` 的 max-lines 及同文件 warning；不碰已修复的 `oauth-refresh.ts`、
`resource-subscriptions.ts`，不改 config/plugins/storage/model 或 Rust。

## 治理前事实

| 文件                       | 实际行 | oxlint 有效行 | 诊断                                          |
| -------------------------- | ------ | ------------- | --------------------------------------------- |
| `mcp/index.ts`             | 2143   | 1878          | max-lines；2 个 no-useless-fallback-in-spread |
| `mcp/pool.ts`              | 553    | 516           | max-lines；2 个 no-useless-spread             |
| `mcp/oauth-interactive.ts` | 497    | 410           | max-lines                                     |
| `fs/index.ts`              | 1878   | 1644          | max-lines                                     |

## 状态所有者与接缝

公开入口保持：`createMcpAdapter`、`createMcpAdapterConnectionPool`、`createMcpConnectionPool`、
`createMcpProcessTracker`、`MCP_NOTIFICATION_*`、`runMcpInteractiveAuthorization`、
`MCP_OAUTH_AUTHORIZATION_TRANSACTION_TTL_MS`、`NodeFileSystemAdapter`、
`createNodeFileSystemAdapter`、`setRipgrepWorkerFactoryForTests`、`setRipgrepTimeoutMsForTests`
的函数名、参数与 arity 不变。

- `NodeMcpAdapter` 仍是唯一状态 owner：`records`（client/transport/tools/status/config）、
  `connectionGenerations`、`resourceSubscriptions`、`activeCallTraces`、
  `toolListRevisionCounter`、`appConnectionListeners` 只存在一份。提取模块只接收窄接口，
  不复制 Map、不缓存第二份连接事实。
- 连接申请/关闭顺序不变：`connectServer` → `closeRecord` → `openServerConnection`
  → 成功 `records.set` / 失败 `failConnection`；generation 校验仍是 stale 连接唯一判定。
- 鉴权顺序不变：Phase 2 交互授权（独立 lease、TTL）→ Phase 1 纯 AuthProvider 重连；
  OAuth 恢复由 record 的 connecting promise 单飞，caller 只限制自己的等待预算。
- 工具缓存：`records[].tools` 与 `toolsStale` 只在 adapter 内更新；`listTools` 的
  refresh → 投影顺序保留。提取的 projection 只做纯映射。
- `McpConnectionPool` 仍独占 `entries`/refs；提取的 key/context 构造为纯函数，
  `acquire`/`release`/`revalidate` 的 owner/lease 与事件顺序不变。
- `InteractiveAuthorizationProvider` 只持有单次授权事务内存；移入独立文件后仍由
  `runMcpInteractiveAuthorization` 每次构造，pending/CAS/lease 语义不变。
- `NodeFileSystemAdapter` 保持 canonical `resolveAbsoluteRequestPath`、symlink write 拒绝、
  async IO；搜索/写入/元数据 helper 为纯函数或无状态模块，不新增 sync IO、超时或权限 owner。
  ripgrep test factory 状态仍只有一份，由原导出 setter 委托设置。

## 验收

1. 四个文件及所有新增文件 `oxlint` effective lines ≤ 400，无新增 disable/ignore，
   无 `any`，旧文件 warning 清零。
2. `pnpm --filter @zcode/adapters typecheck`、包 `test` 全绿。
3. 新增定向测试先锁行为：
   - `status()` 只读：fresh adapter 返回空；disabled server 连接后为 `disabled` 且不启动进程。
   - 连接错误不假绿：不存在的 stdio command 得到 `failed` + error/failureKind，不是 `connected`。
   - FS：相对路径解析、`..` escape、symlink 写入拒绝、atomic write 后 revision/content 正确、
     glob/grep 在临时 root 内可用。
4. 不新增跨包依赖；跨包导入继续走公开入口。

## 实际接缝

- MCP：`adapter-types`（协议常量/record 类型）、`protocol`（版本协商、请求 meta、stderr 脱敏、
  transport PID、OAuth 配置判定）、`transport-factory`（transport + AuthProvider + stdio 日志）、
  `connection-registry`（records/generation/listener + status 投影）、`connection-teardown`、
  `connection-open`、`connection-lifecycle`、`connection-recovery`、`oauth-runtime`、
  `resource-operations`、`adapter-handlers`、`tool-call`、`tool-call-orchestration`。
  `NodeMcpAdapter` 仍持有唯一 `records`/`connectionGenerations`/`activeCallTraces`/
  `resourceSubscriptions`/`appConnectionListeners`，提取函数只通过宿主接口读写同一实例。
- pool：`pool-entry` 持有 entry 生命周期与 connection key/context 纯函数；`pool.ts` 继续唯一
  持有 `entries` 和 lease/ref 计数。
- OAuth：`oauth-interactive-provider` 只承载单次授权事务内存；事务编排、lease 与 pending
  发布仍在 `oauth-interactive.ts`。
- FS：`path-errors`、`atomic-write`、`read-bytes`、`file-types`、`file-walk`、`ripgrep-plan`、
  `ripgrep-worker`、`ripgrep-parse`、`text-search`、`text-search-runner`；`fs/index.ts` 保留
  `NodeFileSystemAdapter` 的 canonical 路径检查、read/write/list 编排与错误归一化。
