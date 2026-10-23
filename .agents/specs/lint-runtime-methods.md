# Core runtime methods 行数存量的职责接缝

本 spec 是 `lint-debt-retirement.md` 实施分片 3（core runtime methods 与 runtime helpers）在
`core/src/runtime` 这一片的具体承接。只处理本片列出的文件，不宣称完成上游 P1-A 的完整 runtime
架构重设计，也不改协议、admission、queue、owner/lease 或持久化语义。

## 范围

`apps/zcode-cli/packages/core/src/runtime/`：

| 文件                                   | 提取接缝                      | 新文件（归属）                                                |
| -------------------------------------- | ----------------------------- | ------------------------------------------------------------- |
| `agent-runtime.ts`                     | 类型表面（public surface）    | `agent-runtime-surface.ts`                                    |
| `methods/events.ts`                    | 诊断聚合 / durable projection | `events-append-aggregate.ts`、`events-durable-persistence.ts` |
| `methods/turn-model-step.ts`           | 准备请求 / 单次结果应用       | `turn-model-step-request.ts`、`turn-model-step-result.ts`     |
| `methods/turn-tools.ts`                | 工具结果后续输入 admission    | `turn-tools-follow-up-input.ts`                               |
| `methods/compact.ts`                   | 输入 token 估算投影           | `compact-input-token-estimate.ts`                             |
| `methods/compact-persistence.ts`       | reminder / 清理 projection    | `compact-persistence-reminder.ts`                             |
| `methods/usage-observability.ts`       | 纯事实投影                    | `usage-observability-facts.ts`                                |
| `methods/background.ts`                | payload / info 投影           | `background-payload.ts`                                       |
| `methods/runtime-command-queue.ts`     | 单条 command 执行步骤         | `runtime-command-execution.ts`                                |
| `methods/resume.ts`                    | 恢复投影纯函数                | `resume-projection.ts`                                        |
| `methods/model.ts`                     | 工具入参增量缓冲              | `model-tool-input-delta.ts`                                   |
| `helpers/attachment-media-resolver.ts` | 本地媒体读取/编码             | `attachment-media-local.ts`                                   |

不包含（本轮由其它 worker / 后续轮次处理）：`session-fork.ts`、`steering.ts`、`file-rewind.ts`、
`turn.ts`、`compact-active.ts`、`internal-turn-methods*`。

## 不变量

- 所有提取函数保持 `this: AgentRuntimeInternal` receiver 与原 `export` 名字；只搬实现，不改
  arity、返回值形状或调用方 import 路径语义（需要时在原文件保留 re-export）。
- mutable state 仍归原 owner：`AgentRuntime` 实例字段、`RegularTurnLoopState`、`turnRequestState`、
  runtime command queue、foreground lease 都不复制。新文件只接收 narrow context（显式传入的局部
  值/回调）或原 receiver，不持有第二份事实。
- 事件次序不变：`appendEvent` 的 `event_store.append → persist_durable → record_usage →
notify_sinks → 聚合 flush` 顺序保持；`ModelRequest → 流式事件 → ModelComplete → usage 事实`
  次序保持。
- permission、queue admission、owner/lease、stale run guard、`workspaceIdentity` 判定留在原文件
  原分支里；提取的步骤只做投影或单步执行，不新增兜底/超时。
- 不新增 `any`、`oxlint-disable`、压行或阈值调整；新文件同样受 400 有效行约束。
- 唯一允许的模块级状态转移：`events.ts` 的诊断聚合 `WeakMap` 移到 `events-append-aggregate.ts`，
  由该模块成为唯一 owner（纯诊断、无业务语义），调用点仍传同一 runtime 实例。

## 风险与验证

- `agent-runtime.ts` 的 `interface AgentRuntime` 是 declaration merging；改为 `extends
AgentRuntimeSurface` 后类型面必须逐成员一致，`installAgentRuntimeMethods(AgentRuntime)` 与
  prototype 装配路径不变。
- `turn-model-step.ts` 拆分必须在 `ModelRequest` 事件落库之后才切分边界：准备阶段负责
  message/part/ModelRequest，结果应用阶段负责 usage、ModelComplete、tool 执行；失败路径仍在
  同一 try/catch 内，`streamingToolCoordinator` 与 snapshots 是 narrow context 而非新 owner。
- 验证：`@zcode/core` 的 `typecheck` 与 `test`；对本片文件跑 raw `oxlint`（目标 0 error /
  0 warning）；`pnpm gate:lint` 只用于确认没有新增指纹。跨 scope 未完成项只报告，不在本片顺手改。
