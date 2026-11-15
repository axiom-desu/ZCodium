# 上游 3.18.2 typed context composition / 中断标记 / 后台子代理停滞

状态：实现中（C7 writer）。上游来源 `.cache/upstream-3.18.2@fec97590`，参考区间
`3c5b2276..fec97590`；Rust 参考树只读、不参与本片（本片不动 Rust）。

盘点依据：`/tmp/sync318-cli-inventory.md` 的 F4，以及「延后项」里的中断标记、后台子代理停滞、
会话引用、输入预测。C1（F1/F2/F3）与 C3/C4 的已落地实现是本片的前置，不重写、不回退：
指令公告 / `total_tokens` 预算 / prompt 快照 / `AUTOMATION_SELF_PAUSE_TOOL_NAME` 都在本片保持不变。

## 1. 行为范围

| 项                                                                            | 本片处置   | 结论                                                                                                                                     |
| ----------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| F4 typed context composition（11 细类别 + V4 查询 + 修订 tracker + 草稿预演） | 实现并接线 | 完成                                                                                                                                     |
| 中断标记（`[Request interrupted by user]` + 工具取消文案）                    | 实现并接线 | 完成                                                                                                                                     |
| 后台子代理停滞提醒（registry 活动快照 + 钟 + 后台通知队列 + 出队失效判定）    | 实现并接线 | 完成                                                                                                                                     |
| 会话引用 / 批注（`conversation-quotes`）                                      | 不实现     | 本仓 `TurnInputIntentMetadata` 没有 `conversationQuotes` 字段，也没有渠道/机器人入站投影；metadata 路径不存在，接线只会变成未接线 helper |
| 输入预测 sidecar                                                              | 不实现     | 本仓没有手机远控输入预测客户端路由（`input-prediction` 全仓 0 命中），也没有同一模型所有权；按 task 约束留作显式剩余                     |

不允许空实现：上表每个「实现」项都必须经真实调用路径（runtime → 协议 / runtime → 后台通知队列），
并有可执行测试。未接线的部分不写代码。

## 2. 单一所有者与事件顺序

### 2.1 context composition

```text
模型请求（model.ts runModelTextRequest）
  → buildContextUsageSnapshot → classifyContextComposition（唯一一次计算）
       ├─→ 圆环 contextUsageBreakdown（粗类别只由 contextCompositionUsageSource 投影）
       └─→ recordRequestContextComposition（最近一次请求组成，runtime 私有状态）
  → usage 到达 → recordRequestContextCompositionUsage（同一个 breakdown 对象身份配对）
                      ↓ 同步调用监听器（失败只 warn，不打断请求）
              bootstrap ContextCompositionRevisionTracker（每协议 server 一份）
                      ↓ queueMicrotask 合并同轮多次触发
              v4/conversation/contextCompositionChanged {sessionId, revision}
消费方 → v4/conversation/contextComposition {sessionId, modelSelection?}
       → runtime.getContextComposition（existing-only，不冷启动）
       → 有效请求组成且模型相同 ? phase=request : 按所查模型预演 phase=draft-preview
```

- 组成事实的唯一 owner 是 core runtime（`runtime/context-composition/state.ts` 的 WeakMap 状态）；
  bootstrap 只拥有**修订号**，不缓存组成，也不做第二套分解。
- 唯一分解：`classifyContextComposition` 是唯一计算点；圆环与查询结果都从它出数，
  禁止再写第二套分类或缓存。
- 失效（`superseded`）：compact 完成、工具缓存失效（MCP / 页面工具）、context 前缀重建、
  换模型。之后查询改为预演，直到下一次主轮请求算好分解（不返回会误导的旧组成）。
- 修订号语义：每会话从 0 起、CLI 进程内单调递增；runtime 重建（冷恢复）不重置，
  进程重启从 0 重新开始。查询在测量**之前**读修订号，测量期间的新变更由后到通知的大修订号覆盖。
- 冷状态：会话没有模型选择时不返回组成（`null`）；会话不在内存时 handler 直接 `null`，
  不为查询冷启动/恢复会话。
- 预演无副作用：不调 `persistAnnouncements` 一类落库入口、不写历史、不发请求、不跑 hooks、
  不做目录/Git 的 IO 探测、不消费一次性提醒（todo / 计划退出 / Memory 更新）。
- 协议偏斜：方法未知时旧 CLI 回 `-32601`；App 侧视为 `null`（本片只做 CLI 侧 + 线格式）。

### 2.2 中断标记

```text
用户 stop → turn abort（send-now 抢占不换文案）
  → 工具结果：ToolCancelled 的 modelContent 换成 USER_STOPPED_TOOL_RESULT_CONTENT（卡片仍显示各自原因）
  → 批次内被打断？ state.interruptedDuringToolBatch = true
  → 已提交 assistant / tool result 之后追加一条普通 user 文本标记
       （模型阶段 `[Request interrupted by user]` / 工具阶段 `[Request interrupted by user for tool use]`）
  → 持久化成功后才写历史；失败只 warn，取消错误照常上抛
冷恢复：part metadata source=interrupt_marker → 同一条 user 文本 entry，分类归 messages（不是 reminder）
```

### 2.3 后台子代理停滞

```text
child SessionEvent（ModelRequest/ModelComplete/ToolCall*/Permission*）
  → noteSubagentActivity（唯一写 activity 的地方；迟到事件不改写终态或新执行）
  → RuntimeTaskRegistry.update（activity: lastProgressAt / runningTools / waitingForPermission）
  → registry.subscribe → BackgroundSubagentStallClock.reconcile（对齐最近到期，不用轮询）
  → 到期 remiremind → enqueueBackgroundTaskNotification（既有后台通知队列，唯一投递 owner）
  → 出队：isBackgroundSubagentStallReminderCurrent（已结束 / 有新进展 / 在等审批 / 换执行 → 丢弃并结算 ledger）
```

- 不新增任务注册表、不新增通知队列：activity 挂在既有 `RuntimeTaskSnapshot` 上，
  提醒走既有 `enqueueBackgroundTaskNotification`。
- 只发现并报告，不自动停任务；提醒轮不算「消费了后台 Agent 结果」（`subagentStall` 在场即排除）。
- 等用户审批时不算停滞；`firstAfterMs` 后首次提醒，之后间隔加倍，上限 `maxIntervalMs`。
- 默认 15 分钟 / 4 小时，可由 `config.subagents.backgroundStallNotifyMs` /
  `backgroundStallMaxIntervalMs` 覆盖；`beginShutdown` 释放钟。

## 3. 接口与契约

- 共享线格式：`packages/shared/src/zcode-protocol-v4/context-composition/{contract,module,CONTRACT.md,contract.example.ts}`，
  只放 zod schema 与纯函数（细类别 id、条目上限 / 名字截断、细类别 → 圆环粗类别投影、查询 / 通知 schema）。
- 运输：`V4_METHODS.conversationContextComposition`（`v4/conversation/contextComposition`）、
  `V4_NOTIFICATIONS.conversationContextCompositionChanged`。查询只读、无状态、超时重发安全；
  通知 live-only，不进 snapshot。
- core 公开面：`AgentRuntimeSurface.getContextComposition / subscribeContextCompositionChanged /
markContextCompositionChanged`。
- bootstrap：`zcode-protocol/context-composition/{handler,tracker,index}.ts`；
  `ZCodeProtocolAgentServerContext.contextCompositionTracker`（每 server 一份）；
  session record 建立/恢复时接线，deactivate 时退订。
- 子代理停滞：`core/src/subagent/{background-stall,background-stall-notification}.ts`、
  `runtime/methods/subagent-stall-reminder.ts`；`BackgroundResultOriginMeta.subagentStall` 是
  originMeta 上的**新可选键**（不是 union 新成员）；App / v4 行 schema 会剥掉它，界面退回裸标题。

## 4. 与上游的已知差异（显式登记）

1. `originEntries`（MCS 合并 / 并入 tool result 的多来源归因）本仓投影没有该输出，分类只用
   `sourceEntries`。本仓不折叠提醒进 tool result，缺口只影响 MCS 合并消息的按长度分摊精度，
   已在分类函数注释写明。
2. 草稿预演只模拟本仓存在的公告：context 前缀 + 运行模式提醒 + output style（首步）+ ToolSearch 公告。
   todo / 计划退出 / Memory / 指令增量属于 IO 或一次性状态，按上游同样不做；指令公告正文已在前缀里。
3. 中断标记持久化为 runtime synthetic user notice（`source=interrupt_marker`），与 C1 指令公告同一种
   隐藏提醒记录；不新增 DB 列。
4. 模块注册（`architecture-policy.yaml` 的 `context-composition` managed 模块）不在本 writer 可写范围；
   本片按既有 `zcode-cli` / `shared` 模块落位，注册与 publicEntrypoints 交主代理（integration owner）。
5. 停滞提醒的 `subagentStall` 载荷只服务 CLI 侧因果判定，不进入 v4 `backgroundResultOriginMetaSchema`
   （上游同样不加：闭集加值会让旧客户端整帧失败）。

## 5. 验收

- 分类纯函数：11 细类别、reminder 计入、`app__` 工具、延迟加载工具、compact summary、
  条目上限 50 / 名字 200、粗类别只投影 7 值且映射与上游表一致。
- 真实 runtime：首次请求后查询返回 `phase=request`（system_prompt / 内置工具非 0）；
  `modelSelection` 换成另一个 provider/model → `draft-preview`；compact 后 → `draft-preview`
  （失效）；冷状态（未发请求的会话）→ `draft-preview`；无模型 → `null`；shuttingDown → `null`。
- 修订 tracker：同一会话同轮多次触发只加一、只发一条通知；不同会话互不影响；
  测量前读修订号（handler 顺序用真实调用断言）。
- 中断标记：真实 runtime 取消一轮后，历史里是普通 user 文本标记（不是 reminder、不移动投影锚点），
  send-now 抢占不换工具文案；冷恢复同形。
- 停滞：registry 活动派生、等审批不提醒、interval 加倍、`isBackgroundSubagentStallReminderCurrent`
  的四种失效（结束 / 新进展 / 审批 / 换执行）、一次提醒（one-shot）与出队丢弃结算。
- 命令：`pnpm --filter @zcode/core test`、`pnpm --filter @zcode/bootstrap test`、
  `pnpm --filter @zcode/core typecheck`、`pnpm --filter @zcode/bootstrap typecheck`、
  `pnpm --filter @zcode/shared typecheck`、`pnpm lint`、`pnpm architecture:check --changed`。

## 6. 迁移边界

- 线格式 strict；新增字段/类别必须另起方法或能力位，不能往现有闭集加值。
- 旧的 `buildContextUsageSnapshot` 调试字段保留（debug 日志不是稳定 API），
  但 categories 改为由分类结果投影，数值会随归类修正变化；圆环 7 值枚举一字不改。
- 无跨包 import 实现细节；context-composition 不依赖 bootstrap。
- Rust 侧（`crates/context`）不在本片。

## 7. 实现台账（2026-11，C7 writer）

已实现并接线（真实调用路径）：

- **F4 context composition**
  - 共享线格式：`packages/shared/src/zcode-protocol-v4/context-composition/{contract.ts,CONTRACT.md}`，
    从 `zcode-protocol-v4/index.ts` 导出；`transport.ts` 增加
    `V4_METHODS.conversationContextComposition` 与
    `V4_NOTIFICATIONS.conversationContextCompositionChanged`。
  - core：`runtime/context-composition/{classifier,state,query,preview,items,index}.ts`；
    `context-usage.ts` 改为「一次分类 → 细类别 → 圆环粗类别投影」，调试贡献者由细类别条目生成
    （`helpers/context-usage-breakdown.ts` 收成类型）。
  - 接线：`model.ts`（请求组成 + usage）、`compact-active-commit.ts`（compact 作废）、
    `config.ts` 的 `invalidateToolCache`（tools）、`context-refresh.ts` 的 `rebuildContextPrefix`
    （context_prefix）、`session-facade-command.ts` 的 `setModel`（model 作废）。
  - bootstrap：`zcode-protocol/context-composition/{handler,tracker,index}.ts`；
    `server-types.ts` 的 `contextCompositionTracker`；`server-dispatch-v4.ts` 分派；
    `server-operations.ts` 在 `createRecord`（create/resume/fork 共用）订阅 runtime 变更，
    随 record `unsubscribe`（释放/去激活）退订。
  - runtime 公开面：`AgentRuntimeSurface.getContextComposition / subscribeContextCompositionChanged /
markContextCompositionChanged`；`AgentRuntimeCoreMethods` 与 `methods/index.ts` 注册。
- **中断标记**：`runtime/methods/interrupt-marker.ts`；`turn-failure.ts` 在用户取消/宿主外部故障
  （`isExternalTurnFault`，新增于 `turn-errors.ts`）且非 send-now 抢占时追加标记；
  `turn-tools.ts` 用 `withUserStoppedToolResultContent` 改模型可见取消文字并置
  `interruptedDuringToolBatch`；`agent/message-history.ts` 增加 `interrupt_marker` source，
  `session-history-metadata.ts` 冷恢复同一身份；contracts `SYNTHETIC_USER_MESSAGE_SOURCES` 与
  shared 旧协议词表同步；`synthetic-notice-metadata.ts` 给 `system_reminder` kind。
- **后台子代理停滞**：`runtime-task/registry.ts` 增加 `SubagentActivitySnapshot`、`activity`、
  `subscribe` 与变更通知；`subagent/background-stall.ts`（活动派生 / 钟 / 出队失效）+
  `background-stall-notification.ts`（正文与标题）；`runtime/methods/subagent-stall-reminder.ts`
  走既有 `enqueueBackgroundTaskNotification`；`subagent.ts` 的 child event sink 写活动；
  `agent-runtime.ts` 构造/`beginShutdown` 创建与释放钟；config 增加 `backgroundStallNotifyMs` /
  `backgroundStallMaxIntervalMs`；contracts `BackgroundResultOriginMeta.subagentStall`；
  `background-notifications.ts` 出队时丢弃过时提醒并结算 ledger（新增 admission 等待表）；
  `runtime-command-active-loop.ts` / `runtime-command-execution.ts` 不把提醒算成「消费了后台结果」。

测试（真实执行）：

- `core/test/context-composition.test.ts`：11 细类别、提醒/新轮通知/compact/工具归类、
  条目上限与名字截断、圆环 7 值投影。
- `bootstrap/test/context-composition.test.ts`：真实 runtime 冷状态预演 → 请求相位
  （providerInputTokens/ContextTokens）→ 换模型/compact 作废 → 别模型预演 → 关停 null；
  tracker 同轮合并/跨会话独立；handler existing-only 与「修订号在测量前读」；
  v4 分派命中真实 handler 并发出 `contextCompositionChanged`。
- `core/test/background-subagent-stall.test.ts`：活动派生、终态后迟到事件不改写、
  one-shot + 间隔加倍 + 取消/结束不再提醒、等审批不提醒、出队失效四种判定。
- `bootstrap/test/interrupt-marker.test.ts`：真实 loopback 挂起 + 宿主外部故障中止后，
  落一条普通 user 中断标记（语义 system_reminder / synthetic），冷恢复 `hydrate` 保持同一身份。

已知差异（实现时核对）：

1. 中断标记走本仓既有 `persistSyntheticUserNoticeForSession`（会更新
   `latestConversationMessageId`，与 todo/context_prefix 同档），上游用独立
   `persistRuntimeReminderMessage` 且不移动指针。差异只在投影指针，消息身份/语义一致。
2. 停滞没有 `executionId`：本仓 `RuntimeTaskSnapshot` 没有 SendMessage 恢复执行的概念，
   所以 `subagentStall` 载荷与失效判定只按 status / lastProgressAt / waitingForPermission。
3. 中断标记的「工具阶段」文字由 `interruptedDuringToolBatch` 选择；端到端测试覆盖模型阶段，
   工具阶段由 `turn-tools.ts` 的真实置位路径保证（未伪造单独断言）。

显式剩余（本片不做，已在 §1 说明理由）：

- 会话引用 / 批注（`withConversationQuotes` + `conversation-quote-context`）：
  本仓 `TurnInputIntentMetadata` 无 `conversationQuotes`，也没有渠道入站投影。
- 输入预测 sidecar：本仓无手机远控输入预测客户端路由，也无同一模型所有权。
- 模块注册（policy 的 `context-composition` managed 模块与 publicEntrypoints）：属
  integration owner；本片不修改 `architecture-policy.yaml`。
