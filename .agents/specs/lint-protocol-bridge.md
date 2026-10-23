# 旧 protocol 桥接层 max-lines 结构治理（保守提取，不改协议设计）

## 背景与范围

`lint-debt-retirement.md` 分片 5 要求「旧 protocol 各自保持唯一 owner、原事件次序与缓存失效」。
本 spec 只处理该分片中 `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/` 的六个超限文件：

| 文件                        | 当前有效行 | 目标 |
| --------------------------- | ---------: | ---: |
| `interaction-broker.ts`     |        684 | ≤400 |
| `v4-bridge.ts`              |       1676 | ≤400 |
| `server.ts`                 |        883 | ≤400 |
| `subagent-session-query.ts` |        456 | ≤400 |
| `plugins.ts`                |        557 | ≤400 |
| `session-mapper.ts`         |       1373 | ≤400 |

诊断来源：`.gate-baseline/lint.json` 中六条 `lint\0error\0eslint(max-lines)`，以及
`v4-bridge.ts` 的 `eslint-plugin-unicorn(no-useless-spread)` 警告。验收时逐条对账，不看总数。

不触碰：`storage-startup.ts` 等已修文件、`zcode-protocol-v4/`、`bootstrap/src/app/`、
Rust crate、`.gate-baseline/`、`.architecture-baseline.json`。

## 不变量

- **唯一 owner 不变**：`ZCodeProtocolAgentServer`（`server.ts`）仍是协议会话 host 的唯一状态 owner；
  `createConversationV4Gateway`（`v4-bridge.ts`）仍是 v4 传输衔接的唯一 owner；
  `createProtocolInteractionBroker` 仍是权限/交互注册的唯一入口。
  提取出的模块只做纯派生、受控 IO 适配或网关端口声明，不持有第二份事实、不做 clone。
- **workspaceIdentity + remoteSessionId**：`server-types.ts` 的上下文与请求键不变；
  新增 helper 不重写身份 key，不做按路径的会话匹配。
- **两条投递语义不合并**：desktop `continuous` 实时链路与 mobile `web-remote-replayable`
  恢复链路的投递分支仍在原 owner 处，提取必须保持原分支与顺序。
- **owner/lease、command admission、`CommandInbox` 串行性**：`v4-bridge.ts` 里的
  admission/fork 逻辑只换文件位置，不新增第二份 accepted 队列。
- **公开导出面不变**：`server.ts`、`v4-bridge.ts`、`subagent-session-query.ts`、`plugins.ts`、
  `session-mapper.ts`、`interaction-broker.ts` 原有的 `export` 名称、参数个数、
  `@zcode/shared` 协议字段全部保持；新增 helper 只在本目录内 import，不新增对外导出。
- **不压行、不 disable**：不用 `max-lines` 关闭注记、不合并语句、不写一行多语句；
  每个新文件也须自行满足 400 有效行。
- **状态/事件顺序**：不改变事件发射顺序、交互 request/response 竞速语义、
  auto-resolution 持久化时机、快照 seed 顺序。

## 事件顺序与状态所有者（不变）

```text
agent runtime (permission broker)
      └─ createProtocolInteractionBroker ── requestPermission /
                                          requestUserInput /
                                          requestExitPlanModeApproval / MCP elicitation
              ├─ legacy 反向 RPC（requestClient）──────────────► desktop continuous
              └─ v4 interaction registry（raceClientRequestWithV4Interaction）
                                                  └─ mobile replayable（snapshot + pending 恢复）

runtime event (SessionEvent)
      └─ ZCodeProtocolAgentServer.mapSessionEvents / mapSessionEventForProtocol（纯派生）
              ├─ v4 gateway ingest（owned by createConversationV4Gateway）
              └─ notification fan-out（server.ts 唯一 owner）
```

提取后的模块角色：

```text
domain/纯派生：session-mapper-*（事件、投影、上下文用量、goal/todo 统计）
             ：subagent-*（候选枚举、终态判定、分页游标）
             ：interaction-answer-mapping（v4 answer ↔ legacy response 归一）
app 决策：v4-bridge-*（命令入口、事件转发、快照衔接，需 await runtime port）
adapters：plugins-*（协议字段投影；marketplace/install 仍由 ../plugins.ts 执行）
```

## 提取映射（实际落地）

| 原文件                      | 新文件                                 | 责任                                                                                          | 持有状态                |
| --------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------- |
| `interaction-broker.ts`     | `interaction-answer-mapping.ts`        | v4 answer → legacy permission/user-input/plan-approval 响应归一，AskUserQuestion content 收敛 | 无                      |
|                             | `interaction-registration.ts`          | 注册选项、持久化 auto-resolution 读取/解析、重发现间隔                                        | 无（读写 sessionStore） |
| `subagent-session-query.ts` | `subagent-candidates.ts`               | 从 tool part + spawn/stop 事件枚举 subagent 候选                                              | 无                      |
|                             | `record-values.ts`                     | 协议边界 `unknown` 收窄                                                                       | 无                      |
| `plugins.ts`                | `plugin-protocol-projection.ts`        | `ZCodePluginInfo` / marketplace / install / diagnostic 投影                                   | 无                      |
| `server.ts`                 | `server-dispatch-types.ts`             | 分派 host 端口（context / gateway / outbox / 两张 operation 表）与 unhandled 哨兵             | 无                      |
|                             | `server-dispatch-v4.ts`                | v4 通道 method → gateway 能力映射，initial frame 交给 owner 的 outbox                         | 无                      |
|                             | `server-dispatch-legacy.ts`            | 旧 `session/*`、`workspace/*`、`plugins/*`、`mcp*/*` 方法分派                                 | 无                      |
|                             | `server-operation-signals.ts`          | 插件同步 / workspace generateText 的 operation 信号登记、取消、互斥                           | Map 仍由 server 持有    |
|                             | `server-client-requests.ts`            | 反向 RPC pending 登记表（单实例，server 持有并转发）                                          | pending Map / id 计数器 |
| `session-mapper.ts`         | `session-mapper-snapshot-parts.ts`     | 快照消息与文件 part 的 URL/artifact 物化                                                      | 无                      |
|                             | `session-mapper-events.ts`             | 事件暴露判定与事件负载映射                                                                    | 无                      |
|                             | `session-mapper-context-usage.ts`      | 上下文用量派生（投影 / 持久消息 / cache）                                                     | 无                      |
|                             | `session-mapper-goals.ts`              | goal 校验事件合并与 timeline                                                                  | 无                      |
|                             | `session-mapper-goal-stats.ts`         | goal 迭代分桶与统计                                                                           | 无                      |
|                             | `session-mapper-todos.ts`              | todo 分组与 tool 输入解析                                                                     | 无                      |
|                             | `session-mapper-values.ts`             | mapper 侧宽松 record 取值（与协议守卫不同：接受数组）                                         | 无                      |
| `v4-bridge.ts`              | `v4-bridge-shared.ts`                  | binder 端口类型、model selection 归一、fork mode 归一                                         | 无                      |
|                             | `v4-bridge-fork.ts`                    | admission 命令判定、fork 初始输入、fork 失败/注册 best-effort                                 | 无                      |
|                             | `v4-bridge-cold-hydration.ts`          | 文件摘要、dwf 冷回放、backing record 解析、rewind 预览                                        | 无                      |
|                             | `v4-bridge-auto-drain.ts`              | 队首自动提升与重试节拍                                                                        | 重试定时器表（单实例）  |
|                             | `v4-bridge-command-entry-lookups.ts`   | 命令入口：record / 交互登记 / queue 读面                                                      | 无                      |
|                             | `v4-bridge-command-entry-admission.ts` | 命令入口：input admission / cancel / 共享上下文 / 持久命令事实                                | 无                      |
|                             | `v4-bridge-row-resolution.ts`          | 命令入口：row ↔ message/turn 定位、transcript prompt 解析、反馈写入                           | 无                      |
|                             | `v4-bridge-session-ops.ts`             | 命令入口：模型/Provider 就绪、session 增删、fork 三类入口                                     | 无                      |
|                             | `v4-bridge-summaries.ts`               | sessions-index 冷启动摘要（workspace identity 过滤）                                          | 无                      |
|                             | `v4-bridge-event-forwarding.ts`        | 帧发射、config 种子、sessions-index hook                                                      | 无                      |
|                             | `v4-bridge-transport-codec.ts`         | 命令执行、attachment、file changes、dwf 读面、命令事实查询                                    | 无                      |
|                             | `v4-bridge-hydration.ts`               | `loadPersistedEvents`（三源冷合并 + subagent seed）                                           | 无                      |

`v4-bridge.ts` 只剩「组装」：同一 `context`、同一 `ConversationV4Gateway`、同一
`PersistentCommandIndex`、同一 auto-drain 定时器表被显式 ports 传给各段，再按固定顺序
展开成一个 gateway options 对象；没有 clone、没有 mixin、没有 `any`、没有巨型 `this`。
`server.ts` 的 `dispatchHost` 是显式对象字面量（context / requireV4Gateway /
setPostResponseBatch / 两张 operation Map），class 的公开成员未变化。

## 失败语义

- 提取不改异常边界：`withPluginStorageLock` 的回滚/抛出、interaction 竞速的 abort 传播、
  fork 失败记录（best-effort）的 `catch` 位置与日志事件名保持原样。
- 冷启动/恢复路径不得因为提取而读到真实用户会话日志：bootstrap 单测用 HTTP fixture 与
  临时 root（现有 `test/local-*.test.ts` 的隔离方式），禁止访问仓库 `logs/`。

## 验收

1. `node /tmp/efflines.mjs` 口径（与 oxlint `max-lines` 一致：去空行/注释）六文件均 ≤400。
2. `cd apps/zcode-cli/packages/bootstrap && npx oxlint src/zcode-protocol`
   → 六条 `max-lines` 与 `no-useless-spread` 清零，无新增诊断。
3. `pnpm --filter @zcode/bootstrap typecheck` 通过。
4. `pnpm --filter @zcode/bootstrap test`（`node --import tsx --test test/*.test.ts`）通过；
   新增 `test/protocol-bridge-structure.test.ts`（合成 context / record，不读真实会话日志）锁定：
   - 消息顺序：`mapSessionEvents` 保持输入序且过滤后仍是稳定子序；
   - 同一 `workspacePath`、不同 `workspaceIdentity` 的请求不被混为一谈；
   - `closed`/`stale` run 的交互应答仍被拒绝；
   - permission/interaction 同一 request 只有一个 owner 能写入最终结果（重复 resolve 幂等 noop，
     stale unregister 不得注销重新注册的等待者）。
5. `pnpm architecture:check --changed` 无新增违规；`pnpm gate:lint` 只允许「基线中这六条出现减少」
   这一方向的差异，不新增条目。
6. 不修改基线；如需收紧另行单独对齐。
