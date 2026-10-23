# ProductProjection lint 治理：owner 不移动，状态容器 + 窄端口 reducer

上游约束见 `spec.lint-debt-retirement.md`。本 spec 只覆盖
`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection.ts` 及其同域新增
`product-projection-*` modules/tests；不改 gateway、transcript hydration、其他 bootstrap、
contracts、Rust 与 gate 基线。

## 现状与真实接缝

`product-projection.ts` 初始 5246 行（有效 4673；`ProductProjection` class 有效 4461）。
class 持有 40 个 private state field、15 个内部 helper、26 个 public method，是唯一可变状态
owner：`snapshot`、row/turn/tool/message/entity 索引、hydration accumulator、pending hook
暂存、compact/goal marker 索引、product-turn split 映射、config/usage seed 守卫、streaming
row 指针与诊断计数。

已确认可提取的纯接缝（输入只读，输出值/row/delta，不读取 `this` 状态）：

| 接缝                                                                        | 归属模块                            | 说明                                    |
| --------------------------------------------------------------------------- | ----------------------------------- | --------------------------------------- |
| Hook 命令展示名、执行状态/结果/聚合/lane                                    | `product-projection-hooks.ts`       | 纯 payload → 展示/枚举映射；不写 row    |
| 模型选择 sparse clone/equal、重试/恢复 reasonCode、正整数归一               | `product-projection-model-facts.ts` | 无 `this`；仅协议字段归一               |
| 工具 display 白名单、AskUserQuestion/ExitPlanMode 问题构造、tool input JSON | `product-projection-ask-user.ts`    | 纯 payload → protocol display/questions |
| 跨模块共享的只读 seed/target 类型                                           | `product-projection-types.ts`       | 只移类型，保持原 public export 名称     |

纯 helper 全部移出后 class 仍约 4460 有效行，仅靠纯构造器提取**不可能**达到 400 行。因此
本片采用下述「owner 不移动」方案，而不是把 class 按事件 handler 拆成多份 `this` 或第二套事实。

## 已对齐并实施的方案：单实例 ProjectionState + 窄端口 reducer

不变量：

1. `ProductProjection` 仍是唯一对外 receiver 与事件顺序仲裁者：26 个 public method、
   constructor、返回 shape、`snapshot.seq = event.sequenceNumber` 语义全部保持。
2. 内部只有**一个** `ProjectionState` 实例（`private state: ProjectionState`）。snapshot、
   row/turn/tool/message/entity 索引、hydration accumulator、pending hook 暂存、marker 索引、
   临时 stream 指针、cache 全部是该实例的字段；不存在第二份事实、不 clone 平行状态。
3. 提取的 reducer 接收 `Pick<ProjectionState, ...>` 形式的窄端口（`.ts` 里显式命名为
   `TextRowPort`/`ToolRowWritePort` 等）**原地写同一个实例**，不做 `this` 透传、不继承 mixin、
   不建 getter 适配器层。
4. `cloneProjection`/`adoptProjection` 只有一处实现：`cloneProjectionState` 深拷贝全部侧表，
   adopt 做整体引用替换。因此不存在「部分侧表已提交」的中间态，拒绝候选时 owner 状态一字未改。
5. 共享只读原语（`findProjectionRow`、`projectionTurnIdOf`、`projectionMs`、
   `appendProjectionRowBase`、`isProjectionRunning`）只实现一次，class 的私有同名方法退化为
   单行委托，不再各模块复制。

### 事件顺序图（applyEventInternal，未改变）

```
SessionEvent
   │
   ├─(1) SubagentSpawned ──> invalidSubagentChildSessionIds.delete(child)   [ghost 解除]
   ├─(2) AssistantFeedbackUpdated ──> applyAssistantFeedbackUpdated(state, event)   [stream 模块]
   │      else normalizeConversationEvent → reduce(fact)                     [事件分派，仍在 class]
   ├─(3) shouldMaterializeSubagentProjection / materializeSubagentProjection [subagent 镜像]
   ├─(4) materializeCommandRowActions(reduced)                              [action/currentEditable]
   ├─(5) attachRevision(clearSettledOutputPreviews(deltas))
   ├─(6) hydrationAccumulator ? applyConversationDeltasMutable + seq=event.sequenceNumber
   │                           : snapshot = applyConversationDeltas(...) + seq
   └─(7) updateToolIndexesAfterDeltas(deltas)                                [派生索引对齐]
```

`applyEventAtomically` = `cloneProjectionState → candidate.applyEvent → accept(candidate.state.snapshot, deltas)
→ 接受则 this.state = candidate.state（单引用交换）/ 拒绝或 accept 抛错则 owner 完全不变`。

### 已交付模块（`wc -l` 总行；oxlint `max-lines` skipBlank/skipComments 全部 ≤400）

第一片（状态容器+纯接缝）：

| 模块                                  | 行数 | 内容                                                           |
| ------------------------------------- | ---- | -------------------------------------------------------------- |
| `product-projection-types.ts`         | 109  | 只读 seed/target 类型                                          |
| `product-projection-hooks.ts`         | 106  | hook 展示/状态纯映射                                           |
| `product-projection-model-facts.ts`   | 78   | 模型选择/sparse/归一秒提                                       |
| `product-projection-ask-user.ts`      | 129  | 工具 display/问题构造                                          |
| `product-projection-state.ts`         | 259  | `ProjectionState`、初始构造、唯一 clone/adopt、共享行/事件原语 |
| `product-projection-stream.ts`        | 188  | 文本/思考流式行 reducer                                        |
| `product-projection-tool-rows.ts`     | 248  | tool call 行、流式 input 预览节流、终态收口                    |
| `product-projection-bash-progress.ts` | 54   | bash/工具活动展示                                              |

第二片（本片，private handler 全部迁出 class）：

| 模块                                    | 行数            | 内容                                                                        |
| --------------------------------------- | --------------- | --------------------------------------------------------------------------- |
| `product-projection-primitives.ts`      | 334             | row/turn/ms/findRow/patch builder、subagent 行定位、tool 索引对齐、共享常量 |
| `product-projection-queries.ts`         | 253             | row/message/entity/target 只读查询与 fork 候选                              |
| `product-projection-seeds.ts`           | 242             | config/usage/subagents/sharedContext 种子、establishedStreamingAppend       |
| `product-projection-sessions.ts`        | 289             | session created/title/resumed/mode/fork/rewind                              |
| `product-projection-turns.ts`           | 346             | onTurnStarted/error、后台通知、control-only 草稿                            |
| `product-projection-turn-facts.ts`      | 52              | turn 收口共享的纯状态原语（draft 离场、边界工时）                           |
| `product-projection-turn-segments.ts`   | 255             | turn complete、turn header、product turn split、guided work segment         |
| `product-projection-hook-lifecycle.ts`  | 244             | hook run 聚合、block error、pending hook flush                              |
| `product-projection-permissions.ts`     | 381             | permission 交互、workspace hook review、user input auto resolution          |
| `product-projection-queue.ts`           | 287             | turn-steer queued/delivery/dispatch/reorder、autoDrain、followupMode        |
| `product-projection-steer.ts`           | 174             | steer drained/discarded、session input promoted                             |
| `product-projection-tools.ts`           | 261             | tool scheduled/activity/progress/result/error、todo plan                    |
| `product-projection-model.ts`           | 312             | model selected/complete/streaming                                           |
| `product-projection-stream-recovery.ts` | 167             | network status、stream recovery、api retry                                  |
| `product-projection-compact.ts`         | 155             | compact lifecycle/marker                                                    |
| `product-projection-targets.ts`         | 347             | target changed、target verification、goal verify 身份                       |
| `product-projection-subagents.ts`       | 379             | subagent 镜像物化、spawn/stop/message                                       |
| `product-projection-subagent-tasks.ts`  | 179             | background task lifecycle、workflow run progress                            |
| `product-projection-events.ts`          | 304             | applyEventInternal、command action materialization、revision、hydration     |
| `product-projection-reduce.ts`          | 250             | 172 行 reducer dispatch，逐事件调用各域 handler                             |
| `product-projection.ts`                 | 289（有效 121） | 25 public 薄门面 + constructor + 单 `state` + clone/adopt/atomic 门面       |

### class 门面与模块 DAG

- class 只保留：`private state: ProjectionState`、constructor、25 个 public method（原签名/泛型/
  return type 全部不变，body 退化为 `return xxxImpl(this.state, ...)`）、`applyEventAtomically`、
  `cloneProjection`/`adoptProjection`。
- 原 private method 全部变成模块级普通函数，签名 `(state: Pick<ProjectionState, ...>, ...args)`；
  字段集合按调用图取传递闭包，因此 parent 的 Pick 一定覆盖 child 需求；确实需要整份状态
  （传给 `cloneProjectionState`/`applyConversationDeltas` 等）时才用 `ProjectionState`。
- 依赖方向：`primitives → (queries|seeds|sessions|turns|...|subagents|targets)`；
  `events → reduce → domain handlers`；`product-projection.ts → events/queries/seeds/sessions`。
  无循环：handler 之间没有互相 import，跨域共享原语集中在 `primitives.ts`。
- 后续修订：`onTurnComplete`（segments）与 `onTurnError`（turns）都需要
  `leaveDraftAfterControlOnlyTurn`/`activeMsForCompletion`，两者若与调用方同住 turns 会形成
  `turns ↔ segments` value import 环。这两个纯状态原语现住在 `product-projection-turn-facts.ts`
  （只 import `primitives` 的 `controlPatch`/`ms` 与窄 `Pick<ProjectionState, ...>` 端口，
  不 import 任何 handler 模块），turns 与 segments 都直接 import 该模块；`upsertTurnHeader`
  仍留在 segments，避免出现反向边。
- `reduce` 仍是唯一事件分派点，但已是独立函数；事件顺序未变（subagent ghost 解除 →
  AssistantFeedbackUpdated/规范化 reduce → subagent 镜像 → command actions → settle previews →
  delta apply/seq → tool 索引对齐）。
- 迁移中仅两处局部变量与注入形参 `state` 或原语同名，做了语义等价的局部改名并记录在
  归一化测试的 alias 表：`previewState`/`hookState`/`resultState` → `state`，
  `hookRowBase`/`userRowBase` → `rowBase`；`upsertTurnHeader` 的原 `state` 形参改为
  `resultState`，对象字面量保持 `state: resultState`。

## 归一化 token 守卫

`test/product-projection-normalization.test.ts` + `test/fixtures/product-projection-handler-tokens.json`
逐 token 比较迁移前 126 个 class handler 与当前实现，防止搬移时漏分支或重排：

- fixture 基线 = **迁移中态 midstate4764**：迁移前工作树的 `product-projection.ts`（4764 行，40 字段已收进
  `ProjectionState`）。它**不是 git HEAD**：HEAD 仍是更早的 5603 行 40-private-field 版本，handler 集合与
  `this.state` 参数化都不同，不能作为本片 token 基线（fixture 内 `note`/`source` 已写明
  `pre-migration-midstate-4764:` 前缀）。
- 覆盖边界：该守卫只比较**第二阶段**（126 个 handler 迁出 class）的 token 等价，不能当作
  **第一阶段**（`ProjectionState` 容器 + 纯接缝提取）的语义证明；第一阶段不变量靠
  `product-projection-state.test.ts` 与独立字段/方法对照，而不是本 fixture。
- 归一化：AST 叶子取 token（跳过空 SyntaxList）；`this.state`→`state`、`this.foo`→`foo`、
  `fooImpl`→`foo`；对已知 state-taking 函数剔除注入的首参；`{ state: state }`→`{ state }`；
  去掉格式化产生的尾逗号与箭头函数表达式冗余括号；上述局部改名走 alias。
- 结果：126/126 handler token 完全一致；第二个断言锁定 class 只剩 25 个 public 门面 +
  clone/adopt，且 class 只有 `state` 一个实例字段。

## 验收与执行记录

- `node --import tsx --test --test-isolation=none test/product-projection.test.ts test/product-projection-state.test.ts test/product-projection-normalization.test.ts`
  → **11/11 通过**（原 9 例 + token parity 2 例）。
- 整包 `node --import tsx --test --test-isolation=none test/*.test.ts` → **67/67 通过**
  （本片交付时 66/66；后续 v4 gateway waiter 快照守卫新增 1 例，属
  `spec.lint-v4-gateway.md` 范围，不改本片结论）。
- 整包 `tsc --noEmit`（`apps/zcode-cli/packages/bootstrap`）→ **0 错误**。
- `oxlint <全部 product-projection*.ts>` → **0 error / 0 warning**，`max-lines` 对该文件不再触发
  （原基线指纹已成 stale；棘轮容忍 stale，清理 `.gate-baseline/lint.json` 归 gate 基线 owner）。
- `pnpm knip` 中本片相关只剩既有 `takePendingStreamingToolInput`（第一片 `product-projection-tool-rows`
  的未用导出），本片新增 helper 全部有真实调用，无新增未用导出。
- 未改 gateway、transcript hydration、contracts、Rust、gate 基线；未 commit。
