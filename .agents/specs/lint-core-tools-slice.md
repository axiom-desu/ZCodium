# core tool/services max-lines 分片：职责接缝与不变量

本 spec 是 `.agents/specs/lint-debt-retirement.md` 的 S3（core/tool）+ S4（core/services）实现分片，
只覆盖 `/tmp/lint-maxlines-slices.json` 中 `core/tool` 与 `core/services` 两个 bucket
（`core/src/mcp/index.ts` 同属本片）。不改变父 spec 的产品规则。

## 范围

12 个文件（包内路径相对 `apps/zcode-cli/packages/core/src/`）：

| 文件                                    | 原有效行 | 拆分后 | 新文件（同包）                                                                                               |
| --------------------------------------- | -------- | ------ | ------------------------------------------------------------------------------------------------------------ |
| `tool/executor/background-tasks.ts`     | 970      | ≤400   | `background-task-providers.ts`, `background-task-notifications.ts`, `background-task-workflow-projection.ts` |
| `tool/executor/call-runner.ts`          | 587      | ≤400   | `execution-context.ts`, `tool-call-success.ts`, `tool-call-failure.ts`, `call-runner-helpers.ts`             |
| `tool/handlers/read.ts`                 | 467      | ≤400   | `read-file-state-cache.ts`                                                                                   |
| `tool/executor/result-display.ts`       | 453      | ≤400   | `cua-result-display.ts`                                                                                      |
| `tool/handlers/bash.ts`                 | 428      | ≤400   | `bash-execution-request.ts`                                                                                  |
| `tool/handlers/read-session-context.ts` | 412      | ≤400   | `read-session-context-lite.ts`                                                                               |
| `permission/service.ts`                 | 569      | ≤400   | `capability-resolution.ts`, `rule-evaluation.ts`                                                             |
| `workflow/lifecycle.ts`                 | 540      | ≤400   | `lifecycle-internals.ts`, `lifecycle-types.ts`                                                               |
| `agent/session-history-hydrator.ts`     | 518      | ≤400   | `session-history-metadata.ts`                                                                                |
| `mcp/index.ts`                          | 464      | ≤400   | `result-format.ts`                                                                                           |
| `agent/message-history.ts`              | 426      | ≤400   | `message-history-entries.ts`                                                                                 |
| `hooks/runner.ts`                       | 424      | ≤400   | `callback-result.ts`                                                                                         |

## 每文件接缝（职责划分）

- **background-tasks**：状态 owner 仍是 `BackgroundTaskTracker` + `background-task-registry.ts`
  （`taskMap` 不复制、不缓存）。抽出的是三类纯转换：生命周期提供者查表
  （`background-task-providers.ts`，含 `cancellable` 缺省 false 的原语义）、通知文本投影
  （`background-task-notifications.ts`）、dynamic-workflow 快照字段投影
  （`background-task-workflow-projection.ts`，只读 snapshot）。轮询/等待/终态的
  完成顺序、`lost` 判定、`stopped/completing` 互斥与 subagent 已通知短路全部留在原 owner。
- **call-runner**：`executeToolCall` 仍是唯一编排入口，校验 → hook → 权限 → handler →
  序列化 → PostToolUse 的顺序不变；permission 结果对象、`emitToolCallStarted` 位置、
  `ToolDeadline` 准入暂停与 attestaion 顺序保持。抽出：上下文装配
  （`execution-context.ts`）、成功收口（`tool-call-success.ts`，CUA 帧 attestation 失败
  仍抛 `ToolExecutionFailed`）、失败收口（`tool-call-failure.ts`，PostToolUseFailure →
  additionalContext 追加 → `ToolCallError` 事件顺序不变）、纯投影
  （`call-runner-helpers.ts`）。
- **read / read-file-state-cache**：Read handler 仍是 `readFileState` 的唯一写入者；
  抽出的缓存读写与「文件不存在 + 相似名建议」只是 IO/投影。
- **result-display / cua-result-display**：display 投影按工具域拆分；CUA 内联媒体配额、
  `truncated` 与 meta schema 解析逐字保留。
- **bash / bash-execution-request**：handler、权限能力、工具 entry 留在 `bash.ts`；
  `ExecutionRequest` 构造、progress 事件、backgrounded 输出骨架移出（`MAX_INLINE_OUTPUT_BYTES`
  随之移动到请求构造模块并被 entry 复用）。
- **read-session-context / -lite**：工具 entry 与输出装配留在原文件；lite 抽取模型的
  请求、分批与归并移出，仍是唯一发起抽取模型调用的地方（AsyncIO 不变）。
- **permission / rule-evaluation + capability-resolution**：`PermissionService` 仍是唯一
  规则集持有者；`checkPermission` 的分支顺序（yolo → disallowed → 项目 deny/ask/allow →
  预授权 WebFetch → 模式分支 → alwaysAsk）不变。抽出的规则求值是纯函数；能力解析与
  `PermissionDecisionResult` 的 10 个字段（`decision/allowed/escalated/mode/reason/
riskLevel/ruleId/sideEffectScope/alwaysAsk`）整体搬迁，不压平、不与 BrokerResult 合并。
- **workflow/lifecycle**：快照仍是入参出参，函数只做纯转换；`lifecycle-internals.ts`
  放节点/相位/活动改写与 seed 边校验（自环、未知节点、重复边、环），
  `lifecycle-types.ts` 放公开选项/结果类型，`lifecycle.ts` 重新导出以保持原导出面。
- **session-history-hydrator**：`hydrateMessageHistoryFromSession` 仍是唯一 hydration
  owner；抽出的 metadata/part 投影不写历史。
- **mcp/index**：`createMcpToolEntry` / `registerMcpTools` 与 schema 表留在原文件；
  结果 → 模型内容投影移入 `result-format.ts`，并由 `index.ts` 重新导出
  `formatMcpToolResult`（`app-tools.ts` 继续从 `index.js` 导入）。
- **message-history**：`MessageHistoryImpl` 仍是可变历史的唯一 owner；
  entry 克隆/判别移入 `message-history-entries.ts`，克隆函数仍从 `message-history.js`
  重新导出（原 public export 面不变）。
- **hooks/runner**：`InMemoryHookRunner` 保留注册、超时、背景 hook 与事件发射；
  callback 结果解包与诊断清洗（纯转换）移入 `callback-result.ts`。async IO 主路径不变。

## 不变量

- 原 public export（`formatMcpToolResult`、`createBashToolEntry`、`bashToolEntry`、
  `readToolEntry`、`readSessionContextToolEntry`、`cloneRuntimeMessageEntry`、
  `invalidateRuntimeTokenUsage`、`isRuntimeAttachmentEntry`、`cloneModelMessageContent`、
  `PermissionService`/`PermissionConfig`/`defaultPermissionConfig`、lifecycle 的
  `reconcile*/cancel*/reopen*/apply*` 与其类型）保持同名同签名，经原文件重新导出。
- 工具 schema、receiver/`this` 可见 API、事件顺序、owner/lease/stale 边界、CUA
  `frame-contract` 休眠策略（`OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION` 恒否时保持休眠）
  不变。
- 新文件均为同包内部模块，不新增跨包入口，不新增 `export` 到跨包可见面。
- 不新增 oxlint disable、不改 `.oxlintrc.json` / gate baseline、不压行。

## 验收

- `pnpm --filter @zcode/core typecheck` 通过；`pnpm --filter @zcode/core test` 通过。
- 定向 oxlint 检查上述 12 个文件与新文件：max-lines 归零，无新增 warning。
- 根仓 `pnpm lint` / 三 gate / architecture 由父任务统一验收。
