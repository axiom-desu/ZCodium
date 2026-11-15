# 上游 3.18 CLI 上下文同步（C1）

来源：`.cache/upstream-3.18.2` @ `fec97590`（v3.18.2），区间 `3c5b2276..fec97590`；
参考 Rust 仅语义参照（`.cache/upstream-rust-reference`，`crates/context/src/{announce,system,instructions}.rs`）。
本子 spec 只覆盖中央 spec 里的 **C1 = F1 + F2 + F3**（F4 typed context composition 见"未完成"）。

## 范围与所有者

| 能力                        | 唯一所有者                                           | 持久化                                                                                                          |
| --------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 指令文件区块/变更公告（F1） | `core/src/runtime`（`instructionAnnouncement` 状态） | session entry `runtime/instruction_announcement`（一行覆盖写）+ 已公告增量作为隐藏 synthetic user notice 落消息 |
| total_tokens 预算（F2）     | `core/src/runtime`（`totalTokensBudget` 状态）       | 不持久化（进程内事实，resume 从零开始）                                                                         |
| prompt 快照（F3）           | `core/src/runtime`（`promptSnapshot` 状态）          | session entry `runtime/prompt_snapshot`（一行覆盖写）                                                           |

写入路径只有一条：context 构建/compaction 提交点写状态 → 同一次调用里落库；没有第二个消费者写同一行。

## F1 指令文件区块与变更公告

### 区块形状

`core/src/context/sections/instruction-files.ts`：

- `INSTRUCTIONS_PREAMBLE` 打头，随后每个文件一段 `Contents of <path> (<type>):`、空行、正文（已 trim）。
- 类型：`project instructions, checked into the codebase`（workspace）、
  `user's private global instructions for all projects`（user）、
  `user's auto-memory, persists across conversations`（MEMORY.md 索引）。
- 旧的 `workspace instructions` / `user default instructions` 两种标题行仍可解析（`parseLegacyInstructionFiles`），
  用于没有 metadata 的历史会话。
- `createInstructionFile` 在读取时算一次 `sha256`，请求前只比较 hash 与 type。

### 公告语义

- **首次公告**：会话内第一次构建 context 时，把完整区块正文记入 `instructionAnnouncement.content`，
  文件记录（path/type/hash）记入 `instructionAnnouncement.files`，并写 session entry。
  此后前缀里的指令区块**固定用这段已公告正文**渲染（字节冻结），不随文件变化改写。
  - 与上游的差异（有意）：上游把完整公告作为一条会话消息持久化；本仓 context prefix 每次请求重建，
    所以冻结正文放在 session entry，恢复后重建出的前缀字节与首次公告一致。
- **变更公告**：每个模型请求前，用当前文件集合与 `instructionAnnouncement.files` 比较：
  - 变化/新增的文件、已公告但不再存在的文件 → 追加一条 `context_prefix` 增量提醒
    （`renderInstructionDelta`，reason 取 `session_start`；compaction 重读后取 `compaction`）。
  - 全部相同 → 不追加。增量正文与 `metadata.instructions`（`files`/`removed`/`reason`）一起落库，
    成功后更新 `instructionAnnouncement.files` 与 session entry。
  - 对比只发生在请求前，不能因为“本次没变化”重发整份。
- **失败语义**：session entry 读取失败 → 当作没有公告，第一次请求发完整公告（不阻断 resume）；
  写入失败只记 `warn`，下次请求会重新比较（最多重复一条增量，不会丢内容）。

### 冷恢复

- `resume.ts` 在 `ensureContextInitialized` **之前**读 session entry：命中则前缀按已公告正文重建，
  第一条请求不会再发整份指令；未命中（旧会话/读取失败）则按当前文件发完整公告。
- 已落库的增量提醒通过 `session-history-metadata.ts` 的 `runtimeMessage.instructions` 解析还原为
  `metadata.instructions`（append-only 事实，不参与"当前已公告集合"判定）。
- 事件顺序：

```text
resume → loadInstructionAnnouncement(session entry) → ensureContextInitialized(builder 用冻结正文)
      → hydrate(增量 metadata) → 第一次请求：比较 = 相同 → 不追加
```

## F2 total_tokens 预算

- `TOTAL_TOKENS_BUDGET = 15_000_000`（固定，不提供配置/模式）。
- system 末尾固定行 `<total_tokens>15000000 tokens left</total_tokens>`（`dynamic-sections`，
  source `total_tokens`）。
- 每个请求追加 `<total_tokens>N tokens left</total_tokens>` 提醒（source `total_tokens_reminder`，
  只进 turn request entries，不落 session：预算本身不持久化，落库的倒数会与恢复后的计数器矛盾）。
- 计数（`runtime/helpers/total-tokens-budget.ts`）：上下文 = 最近一条带 usage 的 assistant 的
  `contextUsageTokens ?? inputTokens`；`used = max(maxUsed, rolledOver + context - anchor)`；
  `remaining = max(0, 15M - used)`；`maxUsed` 只增不减。
- 重新起算（reanchor）只发生在**主会话**里**出自用户本人**的输入：轮首真实用户 prompt、
  或纯文本回复后用户亲手 steer 的 guide。工具批次之后总是提醒但不重新起算。
  goal 续跑、子 agent、队列/工具跟进 guide 不把倒数拨回满额。
- resume 重置为新状态（`createTotalTokensBudgetState()`）。
- compaction 成功按 `rolledOver += 压缩前上下文` 结转，压缩后不回到满额。

## F3 prompt 快照（system 字节冻结）

- session entry `runtime/prompt_snapshot`：`{ model: {providerId, modelId}, system: ModelInputMessage[] }`
  或 `{ cleared: true }`。
- 只有带 session store 的**主会话**使用（`querySourceForTask(taskType) === "main_turn"`），子 agent /
  workflow actor 不用。
- 记录点：主循环请求准备之后；只有请求用的是**会话模型**（非 execution override）、
  且当前快照对同一 provider/model 不适用时才记录。
- 使用点：`rebuildContextPrefix` 里快照模型的 provider/model 与本次请求一致时，system 用快照字节，
  不用当前代码重新渲染（升级或冷恢复后前缀不变，prompt cache 与 thinking 签名不失效）。
- 冷恢复：读取失败/数据无效按没有快照处理，**不阻断** resume。
- compaction 成功：内存置 `null` 并**总是**写 `{ cleared: true }`（不能由内存是否为空决定是否写库），
  返回是否曾有快照；有快照时调用方重建前缀，下一请求重新记录。
- fork：子会话复制父会话当前快照（没有快照不复制）。legacy fork 通过既有 session entry 写入；stable fork 与 selection-side-chat 将快照 entry 纳入 `commitForkBundle` 同事务，不在 bundle 成功后补写。子会话使用父快照的深拷贝，失败遵循各自现有事务语义。

### C1-F3 接线剩余项（Q1）

`runtime/helpers/prompt-snapshot.ts` 已有 fork 复制构造与写入实现，但此前均为 private 且没有调用者；不得删除 helper 规避缺口。唯一所有者仍是 core runtime prompt snapshot。legacy fork 在 child 创建后调用复制写入；稳定 fork 则把同一 entry 放入原子 bundle 的 `entries`，避免 durable commit 与补写之间 child 已可见但 system 未冻结的窗口。验收须用真实 SQLite store 验证父子快照字节相同并冷恢复 child 后仍一致。

### C1-F3 fork 回归（CQ5 补）

Q1 只接线未回归，本片补齐真实 SQLite 证据，`apps/zcode-cli/packages/bootstrap/test/upstream-318-fork-snapshot.test.ts`：

| 场景                  | 事实来源                                                                       | 断言                                                       |
| --------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| legacy fork           | `forkWorkspaceFromCheckpoint`（无 checkpoint → `forkConversationFromMessage`） | child 的 `runtime/prompt_snapshot` entry 与父相同          |
| stable fork           | `forkStableConversationAtMessage` → `commitForkBundle`                         | bundle 提交后立刻读 child entry 即存在（不是 fork 后补写） |
| child 冷恢复          | 新 runtime `resumeFromStore` + 一轮真实请求                                    | 请求体 `system` 与父首请求逐字节相同                       |
| 换模型                | child `setSessionModelSelection` 到另一 modelId                                | 旧快照不套用，按新模型重新记录（父 entry 不被改写）        |
| compaction            | `/compact`                                                                     | 总是写 `{cleared:true}`；之后一轮重新记录                  |
| 负向：压缩后立刻 fork | 内存快照为 null                                                                | child 不带快照行（不伪造）                                 |

注意：快照 entry 存进程内形状（`content`/`cacheControl`），请求体是线格式（`text`/`cache_control`），
所以“字节一致”只能在**请求体之间**比较；entry 之间比较用 deepEqual。

## F5 会话选区引用（conversationQuotes）

上游 3.18 把“选中了哪段历史 + 用户对该段的批注”从正文尾块搬成 turn metadata。
C7 曾判定“本仓没有 `TurnInputIntentMetadata.conversationQuotes`，接了也是未接线 helper”；
本片补上字段与真实调用链，因此该排除理由失效。

### 唯一所有者与共享接缝

| 层                 | 落点                                                                                                                                                  | 职责                                                                                    |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 线格式（唯一契约） | `packages/shared/src/conversationSelection.ts`（经 `zcode-protocol` 导出）                                                                            | 上限常量 + zod 严格 schema；未知字段拒绝                                                |
| v4 命令            | `zcode-protocol-v4/{command,input-intent,rows}.ts`                                                                                                    | `sendText`/`createSession.firstInput`/canonical intent/`userInput` row                  |
| CLI 事件/持久化    | `contracts` `TurnInputIntentMetadata.conversationQuotes`、core `buildPersistedConversationInputIntent`、`product-projection-queue`、`projection-rows` | admission 固定 → 队列项 → user row，一条事实                                            |
| 模型边界           | `core/src/runtime/helpers/conversation-quotes.ts` `withConversationQuotes`                                                                            | 纯函数，把引用转为 `<conversation_quote>` + 批注用途说明                                |
| 引用点             | `methods/turn-user-input.ts`、`methods/steering-drain.ts`、`methods/message-persistence.ts`                                                           | 普通轮 / queue·guide 消费 / 持久化用户消息同一处转换                                    |
| UI                 | `ui/src/lib/conversationSelectionReference.ts`（含 `admitConversationSelectionQuotes`）、`ConversationComposer`、`SessionPane`、`ConversationRowView` | 选区交出带锚点的引用 → 宿主准入 → 结构化 quotes；历史行从 `row.conversationQuotes` 显示 |

- 正文与材料分离：UI 不再把 `# userselect:` 尾块拼进 `promptText`（`conversationSelections: []`），
  模型材料只来自 metadata。旧转录的尾块仍被 `parsePromptConversationSelections` 解析显示。
- UI/CLI 接缝就是 shared schema：UI 只交出 `{text,path,comment,agent}`；锚点（sourceSessionId/sourceRowId）
  不跨进程传输，只在 renderer 内部准入时使用。
- 批注（`comment`）语义：只有非空批注才追加 “user annotation on that exact quoted text” 说明，
  否则模型会把批注当成原文的一部分。`agent` 标明子 agent 来源。
- admission 拒绝（renderer 侧唯一判定，`admitConversationSelectionQuotes`）：
  - 跨会话：`sourceSessionId` 与目标会话不同 → `crossSession`，发送前 toast 并保持草稿；
  - stale：`sourceRowId` 不在当前投影窗口（rewind 截断后）→ `staleAnchor`；
  - 投影尚未到达（窗口为空）不做 stale 判定；markdown 选区（文件预览）没有会话锚点，直接放行。
- 不新建 accepted store：引用只是本轮 intent 的 metadata，队列/恢复读取同一份 intent。

### 验收

1. 真实 runtime（`bootstrap/test/upstream-318-conversation-quotes.test.ts`）：loopback 请求体含
   `<conversation_quote>`、批注文本、用途说明与 `agent`；SQLite 里用户消息 text 与模型一致；无引用轮次不新增块。
2. 线格式负向：>8 条 / 单条 >8000 字符 / 总量 >16000 / 未声明字段 → schema 拒绝。
3. 纯函数（`core/test/conversation-quotes.test.ts`）：空引用正文不变、批注说明只在非空批注时出现、不修改入参。
4. renderer 准入（`ui/test/conversationSelectionQuotes.test.ts`）：同会话通过、跨会话拒绝、stale 拒绝、空投影不误判、markdown 放行。

## 系统提示审计（Plan/env/date/Git/model）

按源码逐条比较 `.cache/upstream-3.18.2`（不用 `architecture:context` 代答）：

| 项                    | 上游 3.18.2                                                                                              | 本仓前状态                       | 本片处置                                                                                                              |
| --------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Plan 流程             | **5 阶段**：Phase 4 Final Plan（Context 段/推荐方案/关键文件/验证），Phase 5 调 ExitPlanMode 并带 `plan` | 4 阶段，Phase 4 直接收尾         | **已窄修**：`runtime/helpers/runtime-reminders.ts` 五阶段正文 + 稀疏提醒改 “5-phase”                                  |
| ExitPlanMode 工具描述 | 与 `plan` 参数一致（必填 `plan`）                                                                        | 已一致（schema/描述均有 `plan`） | 无改动                                                                                                                |
| env                   | 环境公告（新增/移除目录增量、visualization 目录、Desktop 段、untrusted downloads 说明）                  | 仅一次性 env 块                  | **CQ6 已移植适用子集**：untrusted downloads 行 + 增量公告（session entry 基线）；`# gitStatus` 标题仍是排版差异，不改 |
| date                  | 独立 “Today's date is …” 段（无 `# currentDate` 标题）                                                   | 带 `# currentDate` 标题          | 未改：纯排版差异，无行为/字节契约变化，改它会无谓改快照字节                                                           |
| Git                   | `# gitStatus` 标题 + main branch 提示                                                                    | `gitStatus: …` 前缀              | 未改：同上，属排版差异                                                                                                |
| model                 | env 内独立一行 “You are powered by the model named provider/model.”                                      | 已一致（同一句，位置在 env 内）  | 无改动                                                                                                                |

## 未完成（本轮显式留账）

> CQ6 已闭合下列 F5/env 相关项：canonical intent 带 `conversationQuotes`（按语义拆出
> `conversation-canonical-intent.ts`，公开入口不变）、`editUserQuery`/`editQueueItem`/`retryTurn`
> 与队列撤回编辑接通同一 strict 契约、UI 批注输入框与投影代际准入、环境增量公告。
> 详见 `upstream-3.18-conversation-quotes.md`、`upstream-3.18-environment-announcement.md`
> 与 `upstream-3.18-cq6-ledger.md`。

- project-memory dream/recall（上游 `core/src/memory/dream.ts`、`runtime/helpers/project-memory-dream.ts`、
  `project-memory-retrieval-branch.ts`）：本仓无 dream 抽取/回放 owner，需独立 spec（CQ6 逐源比较见 ledger）。
- plugin secrets 配置 adapter：本仓 `pluginSecret*` 0 命中，属插件配置 owner，不新建第二配置缓存。
- 本地 `ReadTopicResource`：本仓无该工具/本地 topic 资源 owner（也无 topic history 归档），先定 owner 再接。
- 手机/Web 端引用：默认拒绝未审查频道，不新增第二 accepted store。
- Rust runtime 的 quotes：显式不支持（能力不声明 + 解析拒绝），不假装支持。

## 验收场景

1. 首次请求：前缀含 preamble + 三个类型的区块（workspace/user/MEMORY.md）。
2. 会话中改 AGENTS.md：再次请求只追加一条增量（含新正文与 "differ from their earlier copies"），
   前缀里旧正文**不变**。
3. 删除文件：追加 `Instructions no longer present: <path>`。
4. 关闭 store → 重开 → resume：第一条请求的 system 与上次记录的 system **逐字节相同**，
   且不重复公告整份指令。
5. compaction：预算结转（倒数继续下降而不是回到 15000000）；快照清 `cleared: true`，
   下一次请求重新记录。
6. 子 agent 会话（taskType `subagent_child`）不发预算提醒、不读写快照。

真实 runtime 场景在 `apps/zcode-cli/packages/bootstrap/test/upstream-318-context-sync.test.ts`
（SQLite + loopback 模型，抓真实请求体）；纯状态机在
`apps/zcode-cli/packages/core/test/total-tokens-budget.test.ts`。

## 未完成（明确登记）

- F4 typed context composition（11 细类别/7 粗类别投影、v4 查询、revision tracker）未实现：
  它需要 `packages/shared/src/zcode-protocol-v4/{transport,index}.ts` 与 bootstrap 主路由，
  按中央 spec 属整合方（manifest main）接线；本 writer 不在共享运输文件里留空壳。
- compaction 后**重读**指令文件（`rereadInstructionSources`）未接线：增量公告已支持 reason
  `compaction`，但目前没有调用点会在 compact 提交时重读；下一次 resume/init 才会读到新文件。
- Rust 对应实现（`crates/context`）归 C2。
