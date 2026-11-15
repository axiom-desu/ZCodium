# A7 — App interrupt execution fence、mentionItems 客户端与权限范围回归

父规格：`.agents/specs/upstream-3.18-sync.md`；前置：A5/A6（App control 生产装配）、
W5 安全复核、C8（`plugins/mentionItems` handler）。官方只读源
`.cache/upstream-3.18.2@fec97590`。本片只收口既有 WIP，不新增大域。

## 状态所有者与顺序

```text
App InterruptSession(expectedExecutionId)
  → 既有 AppControlService 用例层（授权/绑定不变）
  → 既有 task owner zcodeTaskService.stopGeneration(expectedExecutionId)
  → 既有 v4 stop 命令 payload.expectedForegroundExecutionId
  → 既有 CLI runtime stopActiveForegroundExecution（同 owner 原子比较 active foreground execution）
  ├─ 匹配：停止旧执行
  └─ 已结束 / 已被新 run 取代：noop(guard.stopTargetChanged) → App 回 rejected/stale
```

- `executionId` 只从既有 runtime 事实读取：`session/read` 的 `runtime.activeTurnId` +
  `turn.started` 事件的 `foregroundExecutionId`。App 服务不维护第二份 run truth cache；
  `readSession(view=summary)` / `WaitSessions` 每次经只读端口读取。
- 停止凭据只由调用方传入（`AppInterruptSessionInput.expectedExecutionId`），Host 不猜测、
  不自动重试新 run。旧 run 已结束返回 `rejected`（`stale`/`not_running`），绝不落到新 run。
- 发现范围 `allowedScopes`/`discoveryScopes` 是**显式 App 授权**下的 Host-wide 语义
  （`host` + 本 Host 全部未删除项目），不是“当前项目”范围；绑定仍按根会话与来源 Host 复验。

## 验收

- services 单测：interrupt 必须把 `expectedExecutionId` 传给 task owner；owner 返回
  mismatch → `rejected/stale` 且不重试；task meta 非 running → `rejected/not_running`。
- `readSession(summary)`/wait 快照使用 runtime 只读事实给出 `executionId`；
  `availableActions` 只在有 executionId 时包含 `interruptSession`。
- loopback/SQLite：Host 反向 RPC 收到旧 `expectedExecutionId` 时，CLI v4 stop 以
  `guard.stopTargetChanged` noop，不停止新 run。
- 权限：`bind`/`bindClient` 的 scopes 明确包含 host（+ 本 Host 项目），跨 Host 仍拒绝；
  不把 host scope 伪装成 current-project。
- `plugins/mentionItems`：services Agent 客户端 `getPluginMentionItems` 走既有
  only-existing 连接；`-32601` → `supported:false`；UI `@` 插件工具组只采用最新响应。
- 激活事实复用既有 `loadedPluginIds`（已加载 = ready；未加载 = refreshRequired），
  不新增热重载 API；没有 API 时不伪造 ready。
