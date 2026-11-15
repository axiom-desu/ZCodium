# A8 AppForkSession：稳定消息边界的 App 会话分叉

## 范围

只补 `services/app-control/execution.ts` 中恒 `throw unavailable` 的 `forkSession`。
不新增 runtime、fork store、accepted 队列或第二份会话事实；不改变 CLI standalone 八个
会话工具、A7 interrupt fence 与 mentionItems。

## 单一所有者与调用链

```text
App call (可信 binding: sourceServerId + connection.generation)
  → AppControlService.forkSession(ctx, input{atMessage, requestId})
  ├─ requireTask: 父 task 必须在本 Host 的项目快照里（同 workspace/identity/project）
  ├─ 父会话忙: 既有 task meta status === "running" → rejected(parent_busy)
  ├─ 稳定边界: AppControlAgentPort.readConversationRows
  │    └─ 真实 V4 投影 conversation/rowsRange（tail → 向前分页）
  │       匹配 assistantText 且 (assistantResponseId|entityId) === atMessage
  │       且 actions.canFork === true → {target:{rowId,entityId}, baseRevision, baseLogEpoch}
  │       分页期间 revision/logEpoch 变化 → rejected(fork_target_stale)
  ├─ 再复验连接代际（Host 换代/连接撤销）→ forbidden
  ├─ AppControlAgentPort.forkAssistant
  │    └─ 既有 CLI v4 forkAssistant（W6 同一 sendConversationCommandV4 owner）
  │       commandId = app-control-<caller+requestId> 幂等
  ├─ ACK 无 forkAssistant result → unknown（保留 receipt，不假成功）
  ├─ ACK rejected/stale/failed → rejected(reason)
  └─ ACK created(childSessionId)
       → AppControlProjectPort.reserveFork（既有项目任务预留 owner）
       ├─ 成功 → created {session: 父引用 + childSessionId}
       └─ 失败 → unknown {session}（子会话已由 CLI 创建：保留 receipt/目录，不删除）
```

- 边界映射是显式的：`ReadSession(view=messages).messages[].id` 是 transcript messageId；
  V4 行只暴露 `entityId`/`assistantResponseId`。只接受与 messageId 精确相等且
  `canFork` 的 assistant 轮尾段，绝不“取最后一条”或 `as never` 掩盖。
- `baseRevision`/`baseLogEpoch` 来自同一次 tail 快照；向后翻页必须保持同一
  `atLogEpoch` 与 `atRevision`，否则边界已过期，命令不发送。
- 子会话的产品归属仍写既有 `tasks` 行（`reserveCreatedTask`）。`forkedFromTaskId`
  用于继承父 task 的 root/执行目录/worktree 归属；不新建 fork 表。

## 能力与失败语义

| 条件                                                               | 结果                                                         |
| ------------------------------------------------------------------ | ------------------------------------------------------------ |
| Host 装配没有 `readConversationRows`/`forkAssistant`/`reserveFork` | `unavailable`，`availableActions` 不含 `forkSession`         |
| 旧 runtime 不识别 v4 forkAssistant                                 | `unavailable`（显式 unsupported），不伪造 created            |
| 父会话 status=running                                              | `rejected` + `parent_busy`，不发送命令                       |
| 边界消息不存在/不是稳定 assistant 段                               | `rejected` + `fork_target_not_stale`/`fork_target_not_found` |
| 翻页期间 revision/logEpoch 变化                                    | `rejected` + `fork_target_stale`，不发送命令                 |
| 命令前连接代际变化                                                 | `forbidden`，不发送命令                                      |
| 命令 ACK 无 result / 传输结果不明                                  | `unknown`，不写任务预留、不删除目录                          |
| CLI 已创建但 Host 预留失败                                         | `unknown` + session 引用；保留 receipt 与目录                |
| 命令 ACK 明确 rejected/stale/failed                                | `rejected` + owner reason                                    |

`availableActions` 只在端口真实存在时追加 `forkSession`；旧 Agent（端口缺失/显式
unsupported）明确 `unavailable`，不再是所有 Agent 恒不支持。

## Browser / Node 入口边界

App factory、命令幂等 SHA-256 与执行端口是 Node/Host 实现，浏览器安全的
`@zcode/services` 根入口仅 re-export 类型，不导出 factory 运行时代码。
Host composition 继续通过模块公开入口装配，不改命令身份算法，也不将 `node:crypto`
external 到浏览器来掩盖错误。新增 browser bundle 回归直接打包根入口，必须无需 Node builtin。

## 测试

- `packages/services/test/appFork.test.ts`：真实 SQLite 项目仓储 + loopback App RPC/命令端口。
  - positive：稳定 assistant 边界 → created，子 task 行落库并继承父归属/目录/worktree；
  - 负向：父会话忙、边界过期（revision/logEpoch 变化）、未知 ACK、非本 Host 会话、
    旧 Agent（端口缺失）、预留失败保留 receipt；
  - `availableActions` 有/无能力的差异。
- `packages/services/test/projectStorageRepository.test.ts`：`forkedFromTaskId` 预占继承
  父任务 root/执行目录/worktree 的真实 SQLite 回归。
- 现有 `appControl.test.ts` 的“不伪造 fork”改为“能力存在才暴露、缺失明确 unavailable”。
