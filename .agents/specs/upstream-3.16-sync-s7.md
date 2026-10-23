# S7：DWF 空闲阻塞提醒、统一 Stop 集与执行选型接纳顺序

上游来源：`0a1fc56d`（3.16.1）/ `3c5b2276`（3.16.2）；切片定义见 `upstream-3.16-sync.md` §S7。

本切片只改 TS 运行期；Rust 无 DWF 引擎（只有 `0019_dwf_journal.sql` 账本 schema），不造空模块。
执行级选型在 Rust 侧已等价（`input_admission.rs` 只在 `execution.is_none()` 时 `apply_selection`，
`busy_input.rs` 见 `modelSelectionScope === "execution"` 不改会话选择），本轮不改 Rust。

## 一、DWF 空闲阻塞提醒

### 事实归属

「会话闲着、某个在飞 run 还欠着决定」是**父会话**的进程内事实，不是 run 事件：

```
run 状态（任务注册表 + 端口快照） ──读──► 父会话空闲钟 ──► 既有后台通知队列 ──► 一轮模型请求
                                        （唯一 owner）        （不新增投递路径）
```

- 不进 DWF journal、不跨进程重启：进程亡故后在飞 run 结算为 `interrupted`，resume 时各 run
  自己的通知重新出现。
- 不新增任务队列/通道：复用 `enqueueBackgroundTaskNotification`（同一队列、账本、分支围栏与关闭丢弃）。

### 状态机（`core/src/runtime-task/workflow-blocked-reminder.ts`）

唯一跨空闲段留存的状态是「每个 run 已提醒过几次」；开集永远在到点那一刻现读。

| 入口             | 语义                                                                       |
| ---------------- | -------------------------------------------------------------------------- |
| `sessionBusy`    | 任何一轮开始：停钟、空闲时长作废                                           |
| `sessionIdle`    | 命令队列排空：已在空闲段则 no-op（空排一次队列不是一轮），否则起钟排定时器 |
| `userSpoke`      | 用户亲手发话：清空全部计数，每个 run 重新得到一对提醒                      |
| `openSetChanged` | 该 run 开集变化：忘掉它的计数；正在空闲时把空闲起点重置到此刻              |
| `stop`           | 会话关闭：此后不排钟、不发                                                 |

- 延迟固定为 `[15 min, 30 min]`（下标 = 该 run 已提醒次数）；用完即不再排定时器。不新增截断字段。
- 到点顺序固定：`epoch` 校验 → `isIdle()` 复核 → 逐 run `readOpen`（抛错只跳过该 run）→ 再校验 `epoch`
  → 入队即计数（先记后发）→ 排更晚的延迟。
- 只认 `local_dynamic_workflow && running`、且 `branchGeneration === 当前分支` 的 run。
- 开集 = `snapshot.pendingQuestions` ∪ `holes.filter(state === "waiting")`；空集不提醒、不烧次数。

### 载荷与文案

- `originMeta.workflowBlocked = { questions, holes, sinceMs }`：独立可选键，**不是**
  `WorkflowNotificationMeta` 的成员——那个 discriminatedUnion 在线上是闭集，多一个 kind 会让旧客户端
  拒掉整帧。与 `workflowNotification` 至多在场一个。
- shared `backgroundResultOriginMetaSchema` 同一份形状 + `.catch(undefined)`（将来形状变化按缺席读，
  不丢整帧）；`workflowBlockedMetaSchema` 从 `rows.ts` 原样再导出。
- `formatWorkflowBlockedNotification`：块内逐列开着的决定（各 ≤8，`count ≠ shown` 说真数，正文 ≤2000
  字符），散文给逐字下一步、需要用户就明说并收尾、还剩几次（末次说「最后一次」）。
- `taskId = runId` 让通知继承该 run 的 `branchGeneration` 围栏。

### 接线点（各一处，不新建第二条路径）

```
drainRuntimeCommandQueue 出队首条 ──► sessionBusy（prompt 且无 inputSource → userSpoke）
drainRuntimeCommandQueue 全部排空 ──► hasActiveOrQueuedTurnWork() 为假 → sessionIdle
steerTurn(inputPresentation === "user_steer") ──► userSpoke
recordDynamicWorkflowRunProgress(escalation-raised/resolved、hole-reached/filled) ──► openSetChanged
AgentRuntime.beginShutdown ──► stop
```

## 二、统一 Stop 集（并发治理器）

```
不可重试 model_request_failed
  → resolveWorkflowModelFailurePolicy(code ?? ModelRequestFailed, reason, retryable, providerErrorCode)
      decision === "stop" → controller.ended(at)（只终结尝试，不降 cap、不冷却、不冻桶）
      否则 reason === "rate_limited" → controller.throttled(...)（3008 这类真并发信号，行为不变）
      否则 → controller.ended(at)
```

- 三层（runner / driver / governor）读同一张策略表，不按 provider 前缀、模型名或错误文案硬编码。
- 配额 429（1308 等）带的 Retry-After 指到额度窗口结束，冻桶会活得比停下的 run 还久，且用户换额度后
  resume 也进不来；何时再试由用户决定。
- `errorCode` 缺失按 `ModelErrorCode.ModelRequestFailed` 读；配额判定只看业务码。

## 三、执行选型接纳顺序

```
admission（prompt / steer / deferred input）
  → acceptSubmissionModelSelection：只写「已接纳」的会话选择，按 admissionSeq 前进
  → 执行：applySubmissionExecutionState 只按本命令的 intent 建 Model，不再倒写会话选择
  → ModelSelected：previous 取「上一次已发布」值，持久与展示分离
```

- `selectionScope === "execution"`：不写会话选择（既有不变式），本轮模型仍取 intent 里的选型。
- 去重/顺序键：`sourceCommandId` 相同，或 `intent.admissionSeq <= 已接纳序号` → 复用上一次的持久化
  promise，**不回退**；持久化按接纳顺序串行（旧异步写不会落库在新选择之后）。
- 只有一条接纳路径（`CommandInbox` → runtime command intent），不新增输入队列或第二 owner。
- `publishedSelections`（`WeakMap<runtime, ModelSelection>`）只用于 `ModelSelected` 的前后展示边界。

## 验收

`core/test/workflow-blocked-reminder-clock.test.ts`（手控 clock / 定时器，零真实等待）：

1. 无在飞 run 不排定时器；空闲满 15 分钟恰好一条，到点前不读快照。
2. 到点无开集：不发、不烧次数；量的是空闲时长（一轮开始即归零）。
3. 第二次在第一次唤起的那轮结束后再空闲 30 分钟；之后不再排定时器。
4. 别的通知唤起的一轮不清零；用户发话给每个 run 新的一对；单 run 开集变化只影响该 run。
5. 空闲期间开集变化重置空闲起点；各 run 计数独立。
6. 到点时会话其实不闲 → 不读不发；读快照期间来了一轮 → 作废；读快照抛错只跳过该 run。
7. run 不再在飞 → 跳过并忘计数（同 id resume 从第 1 次算起）；`stop` 后完全静默；
   重复空闲沿不重置空闲时长。

`core/test/dynamic-workflow-blocked-reminder.test.ts`（文案 + host + 接线，`node:test` `mock.timers`）：

8. 文案：第 1/2 次收尾句、只有问题/只有留白、无草稿路径、匿名 actor、转义、截断诚实。
9. host：15 分钟铸一条 `workflowBlocked` 载荷（含补过留白不计、最久等待）、`taskId = runId`；
   无开集不发；只看在飞 workflow run（结算/别的类型/stale 分支不算）；读失败只跳过该 run。
10. 开集事件给该 run 新的一对，其余事件不动；`beginShutdown` 停钟且不留定时器。
11. 队列接线：用户 prompt → `busy,user,idle`；合成来源 → `busy,idle`；空排 → `idle`；
    持晋升租约不报；连跑两条 → 每条 `busy`、全部排空后一次 `idle`。
12. steer 接线：`user_steer` 算用户发话，`coordinator_steer` / 无 presentation 不算。

`core/test/execution-scope-selection.test.ts`：

13. 旧排队输入（`admissionSeq` 更小）不覆盖新选择；同 `sourceCommandId` 幂等；
    `execution` 作用域不写会话选择仍建本轮模型；`ModelSelected.previousModelSelection` 取已发布值。

`bootstrap/test/workflow-concurrency-governor.test.ts`：

14. 配额 1308 + Retry-After 3h：`cooldownUntil` 未定义、cap 不变、`tryAdmit` 立即成功（run 与 observer
    两例）；3008 不可重试限流仍 `throttled`，可恢复限流（retryable）仍按原语义。

`bootstrap` 侧只做 Stop 集一处窄改；不引入上游 governor 的 run 上界/seeding 语义（本仓无该能力）。

## 不做

- 不恢复 `requestAuth` / highspeed / offpeak（本仓已移除的协议与运行期）。
- 不把 `workflowBlocked` 加进 `WorkflowNotificationMeta` 闭集，不加新的截断字段。
- 不为提醒新增持久化：它是父会话进程内事实，`session_input` / `session_entry` 都不写。
- 不整文件抄上游 `steering.ts` / `runtime-command-*.ts`；只按本仓拆分后的所有者做窄改。
