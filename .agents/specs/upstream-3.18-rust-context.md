# 上游 3.18.2 Rust 上下文 / 提示词稳定性 / 原生工具线协议

范围：官方上游 `fec97590`（3.18.2）区间 `3c5b2276..fec97590` 的 F1/F2/F3 语义在
`apps/zcode-cli-rust/**` 的落位，以及 F11 中 Anthropic provider 内置工具块的线协议修复。
本仓 TS 侧同批能力见 `upstream-3.18-sync.md` / 三个 writer 任务；Rust 侧不复制 TS 代码，
按本仓 crate 边界重写。

## 固定来源

| 项           | 值                                                                                                                                                                                                                                                                                                 |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 官方上游     | `.cache/upstream-3.18.2` @ `fec97590`（只读）                                                                                                                                                                                                                                                      |
| 官方语义参照 | `core/src/context/total-tokens.ts`、`core/src/context/sections/instruction-files.ts`、`core/src/runtime/helpers/total-tokens-budget.ts`、`core/src/runtime/helpers/prompt-snapshot.ts`、`core/src/runtime/methods/context-refresh.ts`、`adapters/src/model/provider-builtin-tool-compat/compat.ts` |
| MBearo 参考  | `.cache/upstream-rust-reference` @ `a7a980de`（Apache-2.0，**仅加上下文形状参照**）                                                                                                                                                                                                                |
| 参考可用片段 | `packages/rust-cli/crates/context/src/{instructions.rs,announce.rs,system.rs}`                                                                                                                                                                                                                     |
| 参考不可用   | `prompt_snapshot` system 字节冻结、`session_lifecycle`、`session_control`、provider 内置工具改写（0 命中）                                                                                                                                                                                         |

许可：参考树 Apache-2.0 与 `NOTICE.md` 保留 `Copyright 2026 Z.AI Co., Ltd.`；
`apps/zcode-cli-rust/NOTICE.md` 继续记录 MBearo/ZCode-rs 派生与 revision，本批不整树搬运、
不复制其 40 crate 布局与业务声明。

## 所有者与事件顺序

```text
Host/ContextPort 读取 AGENTS.md（仅会话开始与 compaction 提交后）
  → Engine Session 持有读取缓存（instructions + boundary）         ← 唯一读取缓存所有者
  → core run 每步：按已落库公告算增量 → Event::ModelOnlyNotice("context_prefix") 落库后才发请求
  → 历史里已公告的 path→hash 是唯一事实（不另存第二份公告状态）

Engine Session 持有 total_tokens 预算（rolledOver/anchor/maxUsed，进程内，resume 重新起算）
  → core run 每步按本轮上下文增长扣减、真实用户输入时重新锚定 → Event::TotalTokensBudget
  → 预算提醒是本请求附件（run 内 transient，不进模型历史），每步替换，不重复累积

Engine Session 持有主会话 system 字节快照（进程内 + session_entry `runtime/prompt_snapshot`）
  → 首个主会话请求记录；模型标识不同则重建；compaction 成功写 cleared 并清内存
  → 冷恢复命中同模型时直接用快照 system，模板升级不改已绑定前缀字节
```

- 公告（F1）唯一事实来自模型历史：`_zcode_source == "context_prefix"` 的 reminder 消息带
  `instructions` metadata。热历史与冷恢复必须得到同一条 canonical 消息。
- 指令读取缓存由 Engine Session 独占；run 只读副本，边界（`context.offset`）变化即重读，
  重读原因是 `session_start` / `compaction`。
- 预算（F2）只有一份所有者（Session.runtime 之外的 `total_tokens` 字段），run 不允许在本地
  再起算第二份权威；reminder 只是投影。
- F3 快照只用于 `interactive` 主会话（无 subagent profile）；子代理、压缩请求不走快照。

## 行为规则

### F1 指令公告

1. 首次公告（历史无完整块）：`INSTRUCTIONS_PREAMBLE` + 每个文件
   `Contents of <path> (<type>):\n\n<body>`；type 为
   `project instructions, checked into the codebase` / `user's private global instructions for all projects`。
2. 有完整块之后：只追加差异。`changed` = path 新增或 hash/type 变化；`removed` = 已公告但当前
   不存在（读取失败不算删除）；两者皆空不发。差异正文首句为
   `Instruction files were re-read when this session started|after the conversation was compacted`。
3. 正文 trim 后算一次 sha256；正文为空（trim 后）不公告。
4. 公告作为 provider 可见的 model-only notice 落库后才进入请求；`renderInstructionDelta` 不含 preamble，
   说明"上方 preamble 仍然有效"。
5. 冷恢复按 `canonical()` 重建同一条消息（含 `instructions` metadata），不重发整份。

### F2 total_tokens

1. system 末尾固定行 `<total_tokens>15000000 tokens left</total_tokens>`（常量，不可配置）。
2. 每请求附件 `<total_tokens>N tokens left</total_tokens>`：
   - 真实用户输入开始的步：提醒 + 重新锚定（`anchor = rolledOver + context`）；
   - 工具批次之后的步：提醒，不重新锚定；
   - 其他（续写、通知、子代理、goal 续跑）：不提醒。
3. 预算只减不增（`maxUsed`），compaction 之后 `rolledOver += context`（跨压缩连续）。
4. 只在主会话；子代理不重新锚定也不消耗主会话预算（不共享）。
5. resume 重新起算（内存态），不落库。

### F3 system 字节冻结

1. 首个 `interactive` 主会话请求记录本次请求的 system 消息（3 段）与模型标识到
   session_entry `runtime/prompt_snapshot`；之后同模型请求直接复用。
2. 模型标识（provider + model）不同 → 按当前构建重建并覆盖快照。
3. 冷恢复读取失败/数据无效按"无快照"处理，不阻断恢复。
4. compaction 成功：清内存快照并写 `{"cleared": true}`（内存为空也必须写，避免库里的旧行
   在下次冷恢复被复用）。
5. 与既有 `session.prompt_snapshot`（首轮环境快照，`contextSnapshot`）不是同一事物，不合并。

### F11 Anthropic 原生工具块

1. 请求带 provider 原生工具（`server_tools`）时，流里的
   `server_tool_use` / `web_search_tool_result` / `web_fetch_tool_result` /
   `code_execution_tool_result` / `bash_code_execution_tool_result` /
   `text_editor_code_execution_tool_result` / 裸 `tool_result` 不再"接受并跳过"。
2. 规范化：调用块保留 provider 的块类型（`server_tool_use` / `mcp_tool_use`）与 `id/name/input`
   （流式 `input_json_delta` 累积进 `input`）；`mcp_tool_use` 缺 `server_name` 补
   `zcode-provider-builtin`。结果块按 provider 原始形状保留（服务端工具的内容类型由它定义）。
   本仓直接编码 provider 线协议，因此不做上游 AI SDK 的 `mcp_tool_*` 改写。
3. 配对：同一消息内未与调用配对的结果块丢弃（回放会被 provider 拒绝），配对的按到达顺序保留在
   助手消息 `_zcode_anthropic_server_tools`。
4. 请求编码：`_zcode_anthropic_server_tools` 在 `anthropic_body` 中按原顺序回放，多轮可继续；
   跨协议（Chat/Responses）不发送。
5. 持久化：Node part 的 provider 原生块形状未定，本批只保证进程内多轮与流式归一化；
   冷恢复丢结构化块属于**已知剩余差距**，必须登记，不得宣称"provider 轮次已完整移植"。

## 失败语义

- 指令文件读取失败 → 视为"未变化"（不算删除），继续请求，不中断。
- 公告/快照落库失败 → 该请求不发送（durable 等提交），与 ToolSearch 公告一致。
- 预算提醒构造失败不应影响步骤；仅日志。
- Anthropic 规范化不做容错兜底：非法块仍按既有 `ModelFailure::invalid` 失败。

## 验收

- `crates/domain`：指令公告渲染/增量/删除/legacy 拆分、预算扣减与跨压缩；`cargo test -p zcode-cli-domain`。
- `crates/core`：公告只发差异、读取缓存按 boundary 重读、预算提醒只在该步出现且被替换、
  快照记录/复用/清空；`cargo test -p zcode-cli-core`。
- `crates/model`：流式归一化 + 多轮编码回放；`cargo test -p zcode-cli-model`。
- `cargo fmt --check`、`cargo clippy -D warnings`、`cargo test`（受影响 crate）。
- 禁止：放宽现有测试、把只修线协议说成运行时轮次完成。
