# S6 ToolSearch（TS 侧）实现边界与已交付切片

上游权威语义见 `docs/design/v2/tool/19-tool-search.md`（3.16.2 快照），本文件只记录本仓
TS 侧本次交付的边界、所有者与缺口，避免把纯 helper 当成完整链路。

```text
CLI --toolsearch-mode / App Settings toolSearchMode
  → Bootstrap session 创建或冷恢复时固定 runtimeConfig.toolSearch.mode
  → turn loop 一次 prepareRuntimeProviderRequest（全作用域候选目录 + 有效历史）
      → buildToolExposure：启用判定 / 目录分类 / 引用投影 / 包装还原
      → tools + messages + toolSearchEnabled（仅 Native）
  → adapter：tool_reference 编码、defer_loading、advanced-tool-use beta
  → executor：resolveDeferredToolCall 解包（目标事件/权限/Hook 之前，同 callID）
  → completed part metadata.modelContent（严格文本/引用数组）→ 冷恢复 hydrate
```

## 所有者

| 事实                          | 所有者                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------- |
| 模式（auto/native/local/off） | CLI 启动覆盖或 Host 启动偏好，写入 `AgentRuntimeConfig.toolSearch`              |
| 启用判定、发现集合、引用投影  | `core/src/tool/search/exposure.ts`（纯函数，请求内一次）                        |
| 搜索算法                      | `core/src/tool/search/search.ts`                                                |
| 公告增量事实                  | `RuntimeMessageMetadata.toolSearchAnnouncement`（既有 JSON metadata）           |
| 引用块持久化                  | `completed part metadata.modelContent`（`PersistedToolSearchContentSchema`）    |
| 包装调用身份                  | 目标 `name/input` + `modelCallWrapper: "DeferredToolCall"`                      |
| 能力声明                      | `Model.requestCapabilities.toolSearch`（anthropic-messages + Coding Plan 默认） |

## 已交付

- 契约：`tools/tool-search.ts`、`tools/deferred-tool-call.ts`、`tool_reference` 内容块与 JSON
  schema、`ModelToolContract.deferLoading`、`ModelTextRequest.toolSearchEnabled`、
  `completedToolPartSchema.modelContent`（string | 严格数组）。
- Core：搜索/暴露/历史投影、`ToolSearch`/`DeferredToolCall` 注册、executor 解包与未加载
  schema 纠错段、turn loop 一次请求准备 + 公告收集与持久化、provider 投影恢复包装名并派生
  Native `Tool loaded.`、completed part 保存/冷恢复引用。
- Adapters：`tool_reference` 走 AI SDK custom block（真实 wire 由 Anthropic 编码）、
  `defer_loading`、beta 大小写无关合并、能力解析、MCP `alwaysLoad`/`searchHint` 元数据。
- Bootstrap/CLI/Shared：`--toolsearch-mode`（四值，缺省 off，非法值拒绝，仅 prompt/target/tui）、
  App Settings `toolSearchMode`（缺省 off）、协议字段与旧 Host 缺省 off。
- Compact 检查点：成功 compact 从已提交引用/有效边界收集 `preCompactDiscoveredTools`，写入
  summary entry metadata 与 boundary；compact 摘要请求、主 turn、Goal、Memory 共用
  `prepareRuntimeProviderRequest` 的 exposure；compact 后公告按 `getContinuationTools()` 作用域
  重建；Local 在两次 compact 之间按有效检查点提升目标 schema。
- 冷恢复与分支：`toolSearchAnnouncement` 与 `compactBoundary` 只按严格 JSON schema 恢复
  （坏字段只丢该字段），fork/rewind 通过持久消息与 metadata clone 继承；公告在提交历史后
  才生成请求快照，请求投影不追加公告。
- V4 工具行：scheduled 目标事件定稿 `toolName/input/inputText`；断流时 `tool_call_closed`
  在包装行上补齐 Core 确认的目标身份；迟到原始流不能覆盖已定稿输入。continuous 与 replayable
  使用同一 row upsert。
- 执行身份：包装调用在 streaming 准入/end-of-stream 调度前解包一次，assistant/tool result
  内部保存目标 name/input + `modelCallWrapper`，持久 part metadata 与冷恢复保留该标记；
  请求渲染才还原包装。completed/error `metadata.modelContent` 兼容字符串与严格 text/reference
  数组，损坏的 modelContent 不再丢弃整份 metadata（display/media layout 保留）。
- 真实 TS CLI loopback E2E：真实 `AgentRuntime` + SQLite + Anthropic Messages loopback，
  驱动 ToolSearch → DeferredToolCall → 目标结果 → 下一请求，并验证 close/reopen、compact、
  fork/rewind 后的引用、公告与 Local 提升。

## 剩余缺口（精确记录）

1. **Rust S6**：`apps/zcode-cli-rust` 由独立 worker 持有；本切片不改 Rust schema/生成资产。
2. **真实 provider / Desktop / 手机**：本环境无凭据与桌面运行时；已运行真实 TS CLI loopback
   E2E（真实 runtime、SQLite、HTTP wire），未运行真实第三方 provider、Desktop continuous
   或手机 replayable 真机。
3. **渲染位置差异（已接受）**：Local 结果内逐条反馈与 Native 成功提示仍在同一 tool result
   尾部；上游在结果批次外的展示位置不同，语义与去重规则一致，不作为语义缺口。
4. `generate:zcode-cli-rust-tool-schemas` 未在本切片重跑；Rust handler 接线后由 Rust owner 跟进。

## 验证入口

```bash
# core 全量（含 tool-search* / continuity）
node --import tsx --test --test-isolation=none apps/zcode-cli/packages/core/test/*.test.ts
# contracts modelContent 严格/局部恢复
node --import tsx --test --test-isolation=none \
  apps/zcode-cli/packages/contracts/test/tool-result-model-content.test.ts
# adapters 真实 wire
node --import tsx --test --test-isolation=none \
  apps/zcode-cli/packages/adapters/test/tool-search-wire.test.ts
# V4 目标身份 + 真实 CLI loopback E2E（SQLite close/reopen/compact/rewind）
node --import tsx --test --test-isolation=none \
  apps/zcode-cli/packages/bootstrap/test/deferred-call-product-projection.test.ts \
  apps/zcode-cli/packages/bootstrap/test/tool-search-cli-e2e.test.ts
```
