# adapters/model+config+browser+skills max-lines 分片：职责接缝与不变量

本 spec 是 `.agents/specs/lint-debt-retirement.md` 的实施分片 4（adapters 的 model/config/browser/skills），
只覆盖以下 8 个 max-lines 文件及其同包新 helper/test；不改 `model/runner.ts`、
`model/runner-normalization.ts`（另一 worker 已修改）、其它 adapter 目录、contracts、Rust、
`apps/zcode-cli-rust`、gate/baseline/ignore 或父 spec。

## 范围

路径相对 `apps/zcode-cli/packages/adapters/`，有效行按 root `.oxlintrc.json` 的
`max-lines`（skipBlankLines + skipComments）计算：

| 文件                                | 原有效行 | 现有效行 | 新 helper（同包，均 ≤400）                                                                                                                                                                                                                               |
| ----------------------------------- | -------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/config/index.ts`               | 439      | 356      | `config/default-values.ts`                                                                                                                                                                                                                               |
| `src/config/file-config.adapter.ts` | 521      | 363      | `config/file-config-migration.ts`, `config/file-config-patches.ts`, `config/json-record.ts`                                                                                                                                                              |
| `src/browser/index.ts`              | 414      | 337      | `browser/command-dispatch.ts`                                                                                                                                                                                                                            |
| `src/skills/index.ts`               | 421      | 298      | `skills/frontmatter.ts`                                                                                                                                                                                                                                  |
| `src/model/runner-stream.ts`        | 1364     | 357      | `runner-stream-attempt.ts`, `runner-stream-context.ts`, `runner-stream-end.ts`, `runner-stream-chunks.ts`, `runner-stream-error-event.ts`, `runner-stream-failure.ts`, `runner-stream-cleanup.ts`, `runner-stream-result.ts`, `runner-status-publish.ts` |
| `src/model/runner-generate.ts`      | 511      | 396      | `runner-generate-support.ts`, `runner-status-publish.ts`                                                                                                                                                                                                 |
| `src/model/failure-classifier.ts`   | 562      | 292      | `provider-business-failure.ts`                                                                                                                                                                                                                           |
| `src/model/transform.ts`            | 440      | 129      | `transform-parts.ts`, `transform-policy.ts`                                                                                                                                                                                                              |

切片测试：`test/model-lint-slice.test.ts`（请求转换、stream chunk 重试边界、usage 归一化、失败分类优先级）。

## 接缝与状态 owner

### runner-stream

- `runStreamText` 仍是 SSE 流式请求的**唯一 stream owner**：一个 provider stream 生命周期、
  usage/message 事件次序、attempt 重试循环、`AsyncGenerator` 的 yield/backpressure 都留在原函数。
- 每次 attempt 的准入、成功收口、失败分类/退避、finally 清理拆为显式参数的 async helper
  （`runner-stream-attempt.ts` / `runner-stream-end.ts` / `runner-stream-cleanup.ts`）；
  helper 不新建第二个 provider stream、不缓存事件、不并发消费 iterator。
- `runner-stream-attempt.ts` 的 `StreamRunInput` 是原输入对象的窄描述；
  `StreamAttemptState` 只承载 `awaitIteratorClose` / `terminalStatusPublished` 两个原局部标志，
  不是运行时的“巨大 this”，也不持有流或 usage 的第二份事实。
- 取消/超时/backpressure 语义不变：`attemptAbortController` 只在原位置 abort/cleanup；
  `admission.release()` 仍在 sleep 前与 finally 幂等归还；iterator 清理仍在 finally 按原分支执行。
- 请求 prepare（`createStreamTextOptions`、headers、status started）保持原顺序；
  provider 事件 normalize（`handleStreamChunk` / `applyStreamEventsToRetryBoundary`）保持
  retry-safe 前奏暂存与 flush 次序；流结果聚合（completed status、empty-completion、business error）
  保持“先 provider business error、再 generic empty”的判定顺序。

### runner-generate

- `runGenerateText` 仍是非流式请求与重试循环的唯一 owner；`runner-generate-support.ts` 只做
  响应归一化（`normalizeGenerateTextOutput`）、成功状态发布、abort race 与结构化输出序列化。
- `usage` 仍优先 `totalUsage`，`toolCalls/toolResults/sources/reasoning/text` 来源与顺序不变。

### 响应错误分类

- `failure-classifier.ts` 保留 `classifyModelFailure` 的原判定优先级：本地契约错误
  （`InvalidModelResponse`/`InvalidModelRequest`）→ abort → stream idle timeout →
  已包装 provider business error → AI SDK mapped error → APICallError body →
  timeout → 429 → 529 → 401/403 → 400/422 → context exceeded → 5xx → TLS → proxy → network → 其它。
- `provider-business-failure.ts` 只承载 provider business 分类与嵌套 code/status 读取；
  `retryAfterMs` 继续透传，`PROVIDER_BUSINESS_ERROR` wrapper code 过滤保持不变。
- 代理/网络策略不在本切片：`network/proxy-fetch.ts`、`network/incoming-response.ts` 未改动；
  callback-safe / TLS / proxy 分支仍由原分类函数消费。

### config

- `ConfigStore` 仍是配置值与 source 的唯一 owner；`ConfigPortImpl` 的 `get/getAll/has/set/observe/merge`
  不变。`config/default-values.ts` 只回答“key 的默认值”，不持有可变配置。
- 文件配置的“跨进程锁内读-改-写”仍由 `withFileConfigLocked` 独占；patch helper 只计算 next 对象，
  不读文件、不写文件。继承/覆盖（workspace/global/user）与 `workspaceIdentity` 的 owner 不在本切片，
  未被改写。
- `migratePluginConfigInFile` / `persistPluginConfigMigration` 仍是唯一 legacy CUA id 迁移路径，
  best-effort 写回失败不改变合法配置装载语义。

### browser / skills

- `ManagedCdpBrowserControlPort` 仍是 browser/session/connection 的唯一 owner；
  `browser/command-dispatch.ts` 只把一条 `BrowserCommand` 映射到已创建的 `ManagedCdpSession`，
  不持有 pending/session/generation 状态。descriptor（`createManagedCdpDescriptor`）与
  narrow `BrowserControlPort` 暴露面不变。
- `NodeSkillAdapter` 仍是 disabled path、scan、plugin alias 缓存的 owner；
  `skills/frontmatter.ts` 只做 SKILL.md frontmatter 解析（含多行 folded/literal 标量），
  无 IO、无状态。

### transform

- `toAiSdkMessages` 仍是消息投影入口与顺序 owner；`transform-parts.ts` 拆出 tool-result /
  assistant / user content part 构造，`transform-policy.ts` 拆出 Responses 无状态回放与
  tool name 投影策略。公开 `AiSdkMessageTransformOptions` 与 `toAiSdkMessages` 签名不变。

## 不变量

- 原包公开入口不变：`model/index.ts`、`config/index.ts`、`browser/index.ts`、`skills/index.ts`
  的 re-export 名称与签名保持；新 helper 不被 barrel 重新导出，不新增公开 API。
- 不新增 `any`、`as never`、oxlint disable/ignore/阈值，不压行；新文件同样受 400 有效行约束。
- 不改事件/命令顺序、owner/lease、workspace identity、取消/backpressure、provider stream 次数、
  SQL/protocol/配置继承语义。
- 不删除与任务无关的本地改动，不恢复已移除模块，不刷新 gate/baseline。

## 验收

- `pnpm --filter @zcode/adapters typecheck`
- `pnpm --filter @zcode/adapters test`（含 `test/model-lint-slice.test.ts`）
- 定向 oxlint 上述原文件与全部新 helper：max-lines 归零、0 warning；`apps/zcode-cli` 的
  `oxfmt` 只格式化本切片文件。
- 原 public export 与 HEAD 对齐：`model/index.ts`/`config/index.ts` 等入口的导出名未变；
  新 helper 仅包内引用。
- 根 typecheck/lint/三 gate/architecture 由父任务统一验收；本切片不刷新 baseline。
