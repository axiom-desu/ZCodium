# Core runtime 协作面（fork / steering / rewind / turn / compact）max-lines 接缝

本 spec 承接 `.agents/specs/lint-debt-retirement.md` 实施分片 3 与
`.agents/specs/lint-runtime-methods.md`。后者明确排除的 5 个协作方法文件由本 spec 负责。
只做职责提取，不宣称 `AgentRuntime` 已完成上游 P1-A 解耦，也不改协议、admission、
queue、owner/lease、权限或持久化语义。

## 范围

`apps/zcode-cli/packages/core/src/runtime/methods/`：

| 文件                | 原有效行 | 接缝                                                                      | 新文件（同包内部模块）                                                                                                             |
| ------------------- | -------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `session-fork.ts`   | 1386     | prepare（身份/历史） / bundle / journal / commit / goal                   | `session-fork-identity.ts`、`session-fork-bundle.ts`、`session-fork-history.ts`、`session-fork-commit.ts`、`session-fork-goal.ts`  |
| `steering.ts`       | 1262     | 输入投影 / turn 生命周期 / queue 项操作 / drain / 设置事件                | `steering-input-events.ts`、`steering-turn-lifecycle.ts`、`steering-queue-items.ts`、`steering-queue-edit.ts`、`steering-drain.ts` |
| `file-rewind.ts`    | 657      | checkpoint 解析 / 计划 / 原子 apply + journal                             | `file-rewind-checkpoints.ts`、`file-rewind-plan.ts`、`file-rewind-apply.ts`                                                        |
| `turn.ts`           | 770      | 接纳冻结 / prepare / user-input / loop state / complete / finally cleanup | `turn-execution-context.ts`、`turn-user-input.ts`、`turn-loop-state-create.ts`、`turn-completion.ts`、`turn-cleanup.ts`            |
| `compact-active.ts` | 631      | selection / summary request / context commit                              | `compact-active-selection.ts`、`compact-active-request.ts`、`compact-active-commit.ts`                                             |

不包含（已由其它 worker 拆分）：`agent-runtime.ts`、`events.ts`、`turn-model-step.ts`、
`turn-tools.ts`、`compact.ts`、`compact-persistence.ts`、`usage-observability.ts`、`background.ts`、
`runtime-command-queue.ts`、`resume.ts`、`model.ts`、`helpers/attachment-media-resolver.ts`、
`internal-turn-methods*`。本片不顺带修改这些文件或 Rust/Node contract 资产。

## 状态所有者与数据流

```
                 ┌──────────────── AgentRuntime (唯一实例状态) ────────────────┐
                 │ activeTurn / pendingInputs / pendingInputReservations       │
                 │ queueAutoDrain / turnNumber / messageHistory / eventStore   │
                 └───────────────▲───────────────────────────▲────────────────┘
                                 │ receiver this（保守保留）  │
 fork prepare ──▶ identity map ──┼──▶ bundle ──▶ commitForkBundle（单事务）
                                 │
 steering queue 项操作 ──────────┼──▶ appendEvent / settleSessionInput
                                 │
 rewind 计划（只读）──▶ 原子 apply（journal 逆序补偿）──▶ RewindTriggered
                                 │
 turn prepare ──▶ TurnStarted ──▶ RunRegularTurnLoop ──▶ TurnComplete ──▶ 失败收口
                                 │
 compact selection ──▶ summary request ──▶ CompactBoundary / replaceMessages
```

- 可变事实只有一份：`AgentRuntime` 字段、`RegularTurnLoopState`、`ActiveTurnSteeringState`、
  `turnRequestState`、fork identity map、rewind journal 都由原 owner 持有。新模块只接收
  显式传入的局部值/回调或原 `this: AgentRuntimeInternal` receiver，不复制、不缓存第二份事实。
- 事件顺序锁定：fork 子事务先 `commitForkBundle` 再父 `SessionForked`；steering 先持久
  `session_input` 终态再发 `TurnSteerDiscarded`，reservation 先落 map 再发 dispatch 事件；
  rewind 写文件成功后才 `commitAfterApply` 再 `RewindTriggered`；turn 的
  `TurnStarted → ModelRequest → ... → TurnComplete → usage 事实` 与 `finally` 清理顺序不变；
  compact 的 `ModelRequest → ModelComplete → CompactBoundary → CompactCompleted → replaceMessages`
  顺序不变。
- `workspaceIdentity` / fork remote identity、permission、skip、accepted queue、owner/lease、
  stale run guard 留在原分支与原文件调用点。提取函数不新增超时、兜底分支或并发命令。

## 接口约束

- 原文件 export 名字、签名、arity 不变；需要迁出的 export 由原文件 re-export 保持原导入路径。
- 纯转换/投影使用显式参数，不接 broad `this`；需要 runtime 编排的步骤保留
  `this: AgentRuntimeInternal`，沿用既有保守 receiver。不新增 `any`、`oxlint-disable`、压行、
  阈值调整或假 export。
- 每个改动前后的文件（含新模块与测试）有效行 ≤ 400。禁止把单个巨大 `this` 函数整体搬到
  新文件，或通过 mixin/barrel 规避行数规则。

## 验收

- 先补 `apps/zcode-cli/packages/core/test/lint-runtime-coordination.test.ts`：
  合同 export 面 + fork 历史选择、rewind 计划/补丁、compact 选择、steering guide 车道、
  turn loop state 默认值等事件/纯逻辑回归；提取后同一测试继续通过。
- `pnpm --filter @zcode/core typecheck` 与 `pnpm --filter @zcode/core test` 通过。
- 对本片 5 个原文件与新模块跑 raw `oxlint`（目标 0 error；仅保留原有非本片 warning 时需注明）。
- `pnpm gate:lint` 仅用于确认未新增指纹；Rust/Node contract 资产检查不改、不刷新基线。
