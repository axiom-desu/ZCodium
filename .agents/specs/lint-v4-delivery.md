# v4 delivery 五文件 max-lines 接缝

本 spec 是 `lint-debt-retirement.md` 在 v4 delivery 池的具体承接。只处理下列五个文件的
400 有效行拆分，不宣称完成整个 v4/bootstrap 的架构重写，也不改协议、Rust、gate 或其它
bootstrap 文件。

## 范围

| 原文件                              | 保留职责（唯一 owner / public entry）                                                  | 提取接缝（narrow context，新文件）                                                                                                                                                                                                                                       |
| ----------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `command-inbox.ts`                  | `CommandInbox`：唯一 admission / pin / settle / query 入口                             | `command-inbox-admission.ts`（guard 裁决纯事实）、`async-gate-registry.ts`（FIFO gate）                                                                                                                                                                                  |
| `cold-event-merge.ts`               | `mergeColdConversationEvents`、`loadPersistedConversationMaterialization` public entry | `cold-event-merge-materialization.ts`（持久事实读取）、`cold-event-merge-indexes.ts`（行选择索引）、`cold-event-merge-anchors.ts`（durable turn/boundary 映射）                                                                                                          |
| `conversation-telemetry-facts.ts`   | `ConversationTelemetryFactNormalizer` 事件→fact 分派                                   | `conversation-telemetry-bounded-state.ts`（有界键值状态）、`conversation-telemetry-fact-mappers.ts`（payload→fact 纯映射）                                                                                                                                               |
| `conversation-topic-publisher.ts`   | `ConversationTopicPublisher`：topic 状态唯一 owner                                     | `conversation-topic-subscription.ts`（订阅类型/缓冲纯函数）、`conversation-topic-subscriptions.ts`（订阅 registry/frame）、`conversation-topic-resync.ts`（resync 回滚）、`conversation-topic-hydration.ts`（冷恢复测量）、`conversation-topic-query.ts`（只读输出投影） |
| `commands/handlers/goal-compact.ts` | `goalCompactHandlers`、`parseGoalObjectiveFromCommandText`、`applyGoalCommand`         | `goal-compact-lifecycle.ts`（手动 compact 启动/后台收尾；`startManualCompact` 原路径 re-export）、`goal-compact-errors.ts`（裁决错误；原路径 re-export）                                                                                                                 |

不包含：`product-projection.ts`、`v4-gateway.ts`、`transcript-hydration.ts`（另 worker）；
`commands/handlers/queue.ts`（已有 warn 修复）；其它 bootstrap、Rust、gate 基线。

## 不变量

- **唯一 admission owner**：accepted busy input 仍只经 `CommandInbox`；per-session actor 的
  serial admission 仍由原 `AsyncGateRegistry` 的 key gate → session gate → settle 顺序表达。
  提取的裁决函数只读 revision/logEpoch/guard 结果，不持有队列、不写第二份事实，不新增 writer。
- **stale-run / lease / data revision guard 原样**：baseRevision、baseLogEpoch、row target、
  product guard 的判定顺序与 reasonCode 不变；cold merge 的 durable boundary 优先级、resume
  subagent、queue/state 保留规则与 `insertAtDurableTurnBoundaries` 顺序不变。
- **两种链路语义不变**：`desktop-continuous` 实时链与 `web-remote-replayable` 的
  snapshot/resume/seq 水位分离保持。`floorSeq`、`sentSeq`、in-flight reservation、
  resync/rollback、coalesce 与 delivery profile 过滤仍由 `ConversationTopicPublisher` 同一实例
  拥有；提取函数只接收显式局部值/回调，不新增缓存或定时器。
- **冷热事件合并按原优先级**：durable transcript/goal/target authority → boundary anchor →
  authority turn → queue/model setup → memory-only → resumed subagent → transcript-derived
  suppression → unclassified preserve。诊断 code/计数与最终 `resequence` 顺序不变。
- 每个新文件同样满足 400 有效行；不新增 `any`、oxlint disable、阈值/基线调整、压行，或把
  主体藏进另一个超长文件/barrel。原 public export 名字与 import 路径保持。
- mutable state 的 owner 不转移：`CommandInbox` 字段、`ConversationTopicPublisher` 的 projection/
  log/subscription 表、telemetry 实例的 bounded maps、publisher 的 `manualCompactControllers`
  仍各只有一份。提取模块只拥有纯函数或单一窄状态（有界缓存、gate tail map）。

## 事件顺序

```text
CommandInbox.handle(raw)
  parse → key gate → lookup pin/exact → session gate
    → decideCommandAdmission(getRevision/getLogEpoch/rowTarget/guard)
    → pin in-flight + admissionSeq → execute → settle(final) → release session gate

ConversationTopicPublisher
  ingest → projection.applyEvent(Atomically) → log push/retention
         → per-subscription filter/legacy encode → coalesce buffer
  subscribe(base) → resumable ? replay (floorSeq..current] : snapshot
  reserveFlush → reservation.commit(sentSeq=toSeq) / resync snapshot

rehydrate → candidate publisher full replay
          → batch hydration ? snapshot recovery boundary : retained log
          → adopt projection/log/byte watermark → 既有订阅 resync

mergeColdConversationEvents
  memory authority → durable transcript/goal/target → boundary anchor
  → turn prefix/tail insertion → trailing supplements → resequence
```

## 测试与验收

- 先补行为/时序测试再提取：`CommandInbox` 同 key final promise、per-session 串行 admission、
  stale revision/logEpoch；cold merge target authority/queue suppression/未知事件保留与
  resequence；telemetry turn source 传播与 clearSession；publisher snapshot→delta→resume、
  retention 缺口 snapshot、慢订阅 overflow→resync；goal compact 后台失败释放 active lock 并写
  timeline fact。
- 提取后同一测试不改断言通过；新增纯函数测试只锁定已有优先级/输出投影，不另造事实。
- 验证：`@zcode/bootstrap` 的 `typecheck` 与 `test`；对五个原文件及新 helper 跑定向 raw
  `oxlint`（目标 0 error/0 warning），并报告根 `pnpm lint` 与架构检查未新增本片指纹。
