# lint 存量退役：v4 gateway / transcript hydration 职责提取

## 范围

本 spec 只覆盖两个 max-lines error 文件的结构治理：

- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/v4-gateway.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/transcript-hydration.ts`

不修改 `product-projection.ts`、其它 v4 模块、旧 `zcode-protocol/`、`@zcode/shared` 协议契约、
Rust sidecar 或 lint gate 配置。跨 scope 的失败只报告，不顺手修。

目标：保留原 public export、命令/schema/strict parse、事件顺序与唯一状态 owner，把两个文件
的有效行降到 400 以内；新增 helper 也各自 ≤400 有效行。

## 唯一 owner（不可新增第二份）

```text
transport (desktop stdio / web relay)
        │  command envelope / query / subscribe
        ▼
ConversationV4Gateway  ← 唯一会话运行态 owner
  ├─ publishers: sessionId → ConversationTopicPublisher   (snapshot/queue/rows/seq)
  ├─ inbox: CommandInbox                                  (accepted/admission/pin)
  ├─ rawSequenceStates                                     (raw→transport seq 水位)
  ├─ readyFlights / hydrationInFlight / hydrationBuffers   (cold READY + 补回窗口)
  ├─ flushStates + flush timer                             (唯一打帧时间源)
  ├─ indexPublishers / configPublishers                    (列表/配置独立 topic)
  └─ binaryReadCache                                       (附件/dwf 字节共用预算)
        │
        ├─ query helpers (无状态，只读 owner)
        ├─ command binding helpers (只调用 inbox/host，不缓存 ACK)
        ├─ hydration helpers (只重建 publisher，不持有第二份 projection)
        └─ flush/emit helpers (只消费 reservation)
```

规则：

- 提取的模块不持有 `accepted queue`、projection snapshot、session 缓存或第二个 `publishers` map。
  queue 仍在 `ConversationTopicPublisher` / `CommandInbox`。
- 不用 `this` 巨型接口或继承 mixin 摊行数。每个 helper 只声明自己实际使用的窄依赖
  （host 回调、publisher accessor、cache、`now`），由 gateway 组装。
- helper 的文件边界按职责而不是按行数切；同一事件的所有权不跨文件复制。

## 交付面（不可变）

- v4 public protocol：command 类型、参数/结果 schema、`strictParse` 全部不变。
- public export：`ConversationV4Gateway`、`V4GatewayHost`、`V4CommandNotImplementedError`、
  `V4CommandNoopError`、`synthesizeEventsFromMessages`、`goalVerificationEntriesFromSessionEntries`、
  `HydratedGoalVerificationEntry` 保持原入口与 arity。
- `workspaceIdentity?.trim() || workspacePath` 的身份 key 规则不变；远程链路继续同时传
  `workspaceIdentity` 与 `remoteSessionId`，不能退化成只按路径匹配。
- `seq` 缓存失效：`invalidatePersistentCommandFacts` 仍在 persistent command promotion/
  queue removal 后先失效再解 pin。
- `TopicClosed` / subscription ownership：unsubscribe/resync 仍按 topic + subscriptionId +
  connectionId 精确命中，不能按裸 subscriptionId 广撒网。

## 两条 delivery 链路（必须同时锁验）

```text
desktop-continuous
  ingest ─ raw reorder ─ publisher.apply ─ scheduleFlush(flushWindowMs) ─ emitWireFrame
         └ 保留 live publisher；hydrate 不重建完整事件日志

web-remote-replayable
  subscribe(base) ─ seq/logEpoch 裁决 ─ resume(deltas) 或 snapshot
                  └ gap / cold 时 snapshot + 后续 replay；hydrate 后补回 await 窗口 raw
```

共同 owner 与 sequence 水位不变；差异只在 `deliveryProfile` / snapshot-vs-delta 裁决。
任何提取都不得让 desktop 走 snapshot 重建，或让 web 丢失 gap repair。

## 提取接缝

### transcript-hydration（已完成）

| 文件                            | 职责                                  |
| ------------------------------- | ------------------------------------- |
| `transcript-hydration-types.ts` | 共用不可变事实类型                    |
| `transcript-hydration-facts.ts` | 消息归类、时间、错误、compact payload |
| `transcript-hydration-shape.ts` | 输入意图、subagent、附件、fork 元数据 |
| `transcript-hydration-parts.ts` | assistant part → 事件                 |
| `transcript-hydration-goal.ts`  | goal verification 归一/去重           |
| `transcript-hydration-model.ts` | 轮次选型、轮边界、legacy compact      |
| `transcript-hydration-turns.ts` | 单轮输出收集、turn final              |
| `transcript-hydration.ts`       | 只保留事件序列所有权与轮循环          |

原有 public export 由 `transcript-hydration.ts` re-export，`replay.ts` / `cold-event-merge.ts`
引用不变。

### v4-gateway（已完成，保持上述 owner）

| 目标文件                         | 接缝                                                      | 依赖                                     |
| -------------------------------- | --------------------------------------------------------- | ---------------------------------------- |
| `v4-gateway-contract.ts`         | host/options/状态结构/常量/纯 helper/错误类               | 无                                       |
| `v4-gateway-state.ts`            | 唯一 root-owned 运行态（map/cache/host/timer refs）       | 各域窄 Pick                              |
| `binary-read-cache.ts`           | 附件与 dwf 字节的单预算缓存                               | `now`                                    |
| `v4-gateway-attachments.ts`      | attachment begin/chunk/commit/abort/read/stat/preview     | host、uploads、cache、publisher resolver |
| `v4-gateway-workflow-queries.ts` | workflow run/artifact/workspace 只读                      | host、cache、cold resume                 |
| `v4-gateway-file-queries.ts`     | rowsRange/plans/fileChanges/rewind preview                | publisher resolver、host                 |
| `v4-gateway-commands.ts`         | v4/command、commands/query 绑定                           | inbox、host、publisher accessor          |
| `v4-gateway-read-model.ts`       | queue/row 只读访问器                                      | publisher accessor                       |
| `v4-gateway-index-config.ts`     | sessions-index / workspace-config subscribe/publish/flush | registries、host、emit                   |
| `v4-gateway-subscriptions.ts`    | conversation subscribe/resync/unsubscribe/flush 调度      | publishers、flushStates、emit            |
| `v4-gateway-ingest.ts`           | live ingest、telemetry、detached child、index fan-out     | sequence、inbox、index                   |
| `v4-gateway-hydration.ts`        | publisher 建取、cold READY、rehydrate、buffer 补回        | sequence、flush、index                   |
| `v4-gateway-sequence.ts`         | raw→transport seq、projection commit waiter               | publisher apply 回调                     |
| `v4-gateway-lifecycle.ts`        | cleanup/dispose/prune、flush emit                         | 各 owner                                 |

`ConversationV4Gateway` 最终只保留 root-owned state、构造组装与 public signature 转发；
领域函数按 `Pick<GatewayState, ...>` 窄面接收同一份引用。行为回归见
`test/lint-v4-gateway.test.ts`。

## 验收

1. `pnpm --dir apps/zcode-cli/packages/bootstrap typecheck` 在自身 scope 无新增错误。
2. `oxlint` 对两个原文件与新增 helper 为 0 error/warning；新增文件有效行 ≤400。
3. 行为锁定测试：
   - query 复用同一 READY publisher；subscribe 的 snapshot/resume 顺序；
   - `synthesizeEventsFromMessages` 输出的事件类型/顺序与冷 hydrate 归约结果一致；
   - 原 public export 仍可从旧入口导入；
   - desktop-continuous 与 web-replayable 两种 profile 均保留 seq 水位与 gap 修复。
4. `TopicClosed`、`invalidatePersistentCommandFacts`、workspace identity trim/fallback 有对应
   回归断言或明确标注由既有测试覆盖。
