# 上游 3.18.2 Rust 收尾 parity（R3）

范围：`apps/zcode-cli-rust/**` 中 R2 之后仍未闭环的 functional parity。上游只读来源
`.cache/upstream-3.18.2@fec97590`（区间 `3c5b2276..fec97590`）；MBearo 参考树只作形状参照。
TS 同批契约以 C1/C3/C5/C6/C7 实际落地代码为准（`/tmp/sync318-*-result.md`），不复制 TS 代码，
按本仓 crate 边界重写。D3 拥有 state 迁移与 session-data，本片不改 `crates/state/**/session_data*`、
`session_data*.rs` 与迁移账本。

## 固定来源

| 项                     | 值                                                                                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W4 system 冻结边界     | `core/src/runtime/helpers/prompt-snapshot.ts`、`runtime/methods/context-refresh.ts`、`runtime/helpers/prompt-snapshot.ts#buildForkedPromptSnapshotEntry` |
| F1 读不出的指令文件    | `core/src/runtime/methods/context.ts`（`unreadableInstructionPaths`）、`context-refresh.ts#buildInstructionAnnouncement`                                 |
| F4 context composition | `runtime/context-composition/{classifier,query,state}.ts`、`packages/shared/src/zcode-protocol-v4/context-composition/contract.ts`                       |
| F12 session features   | `runtime/session-features/session-features.ts`、`contracts/src/model/invocation-context.ts`、`adapters/src/model/model-request-headers.ts`               |
| 安全审查               | `.agents/specs/upstream-3.18-security-hardening.md`、`/tmp/sync318-security-review.md` §W4                                                               |

## W4：system 冻结的身份与拼接边界

1. 快照记录增加 `model.reasoningLevel`（新写入必带）；比较时若快照带 `reasoningLevel`
   则必须与请求 `ModelIdentity.reasoning_level` 相同。旧快照没有该字段时按 provider+model
   兼容（不因升级丢弃既有快照）。
2. `step_prefix` 拼接冻结 system 前断言前缀前 `SYSTEM_LEN` 条全部是 `role=system` 且
   `content` 为字符串；形状不符时按“无快照”处理，重建并覆盖，不做部分 splice。
3. compaction 清空 + 写 `{cleared:true}` 的既有语义不变。
4. fork：父会话有快照时把同一 data 写成子会话的 `runtime/prompt_snapshot` entry（覆盖写），
   两处 fork（`fork_history`、`node_fork`）都执行；写入失败只 warn，不中断 fork；
   没有快照时不写。
5. `/add-dir` 语义（记录，不改行为）：冻结的 system 含 `Additional directories` env 段；
   会话中途 `/add-dir` 只影响下一次 compaction 重建的 system，与上游同形。

## F1：读不出来的指令文件不算删除

1. `ContextPort::instructions` 返回 `InstructionRead { sources, unreadable }`：
   - 不存在 / 不是普通文件 → 不是声明（不进 sources，也不进 unreadable）；
   - 存在但读取失败（权限、IO、超长读错误）→ 进 `unreadable`，不进入正文；
   - 被截断仍是可读来源（`truncated` 标记）。
2. 增量公告：已公告但当前不在 sources 的路径，若在 `unreadable` 中则**不**算 removed；
   其它变化照旧。读不出的路径记一条 warn（不阻断请求）。
3. 重读（会话开始 / compaction）：若 runtime 当前持有的文件在本次读取中变成 unreadable，
   整次重读作废、沿用旧内容（下一次再试）；取消仍上抛。
4. 宿主 `read_instructions` 对用户文件与工作区 AGENTS.md 一视同仁：NotFound 静默。

## F12：native session features（只增不减）

- 词表与 TS 相同（`browser_use`、`computer_use`、`tool_search_called`、`tool_search_local`、
  `tool_search_native`、`workflow_auto`、`workflow_auto_attempt`、`workflow_cmd`）。
- owner = Engine `Session.session_features`（`BTreeSet`，进程内）+ session_entry
  `runtime/session_features`（`{features:[...]}` 字典序）。run 只拿副本，事件把新增并集交回 owner。
- 打点：
  - ToolSearch 请求准备的真实生效模式（native/local）→ 在模型调用前记录；
  - 成功的 ToolSearch 工具结果 → `tool_search_called`；
  - `mcp__node_repl__js` 结果的 `_meta["zcode/nodeReplBrowserUse"] === true` /
    `["zcode/nodeReplComputerUse"] === true`（与上游 hardened MCP trust key 一致）
    → `browser_use` / `computer_use`；
  - workflow 相关标签：本仓没有 CreateWorkflow/dynamic workflow 工具与 `/workflow` 命令，
    无法从真实调用产生；不从用户原文猜测，登记为缺口（词表常量保留）。
- 出站：`EventSink.session_features` 快照（只增、去重、字典序）由 model provider 写成
  `x-zcode-session-features`，值须匹配 `^[a-z0-9_]{1,64}$`、总长 ≤256；非法/超长整头省略。
  Provider 静态配置的同名头被剔除，调用上下文拥有该头。
- 冷恢复：entry ∪ 从持久消息推导（completed ToolSearch part）；entry 读取失败只 warn；
  fork 不复制父 entry，靠历史推导到 fork 点。workflow 标签没有真实来源，保持未设置。

## F4：V4 context composition（query + revision）

- `v4/conversation/contextComposition` 已接 Engine；参数 strict `{sessionId, modelSelection?}`。
- 唯一计算点：主轮次模型请求准备后，用**真实请求**（prefix、ToolSearch 曝光后的工具、
  投影后的 messages）分类成 11 个细类别（`system_prompt`…`messages`），存到
  `Session.context_composition`（最近一次请求 + 每会话递增 `revision` + `measuredAt` + model/window）。
- 结果 `{composition}`；会话不在内存或还没有请求时返回 `null`。phase 固定 `request`，
  tokenMethod 固定 `estimated`；类别按固定顺序、0 值省略、条目按 token 降序 ≤50、名字 ≤200。
- 变更通知（`v4/conversation/contextCompositionChanged` live-only）本片不实现：Rust 尚无
  V4 通知订阅通道；消费方重连后按 query + revision 对账（登记缺口，不凭空实现宣称完成）。
- 查询只返回会话最近一次已发请求的 composition；传入其他 `modelSelection` 仅 strict 校验、不做预演，
  这是 Rust 当前 V4 合同的明确范围，不等价上游可预演草稿模型的 query。
- 圆环（既有 `usage.contextWindow.breakdown`）继续由既有 `usage::breakdown` 产出，
  本片不改其 7 粗类别口径（避免改变既有测试/协议）。

## 明确不本片交付（登记，不宣称完成）

1. 8 个独立 CLI session-control 工具与插件发现（mentionItems）：Rust 运行时没有
   `standaloneSessionControl` 根控制面与插件 mention 目录 owner；新增会形成第二个会话控制面，
   需先有 Rust 侧真实宿主端口设计。本片不建空工具、不接旁路队列。
2. workflow\_\* 打点：无对应工具/命令。
3. MCP 工作区信任真实授予：Rust 现有 MCP 配置 owner 读 `.agents/mcp.json`，但与 TS
   `createConfig` 的项目/用户来源优先级与规范化不同；写同一 `workspace-mcp-trust-v1.json`
   会因摘要口径不同产生两份“权威”。本片不写第二份信任存储，继续 typed 拒绝并记录原因。
4. `CronPauseSelf`：Rust 有 Cron permission/schema 元数据，但没有 automation host port、可信注入的
   `automationId` 或该工具的实现；不能从可控参数推断暂停目标，不新增伪工具。
5. Workspace Hook policy：领域有 `Policy` 枚举，但 Engine 生产路径固定 `UserDecides`，无 policy
   配置/host port。接入前须增加与 TS 同源的权威配置端口；不能把用户配置猜作 allow/deny。
6. BUA/CUA session-feature：本仓没有 Node REPL host 执行器注入 hardened `_meta` key 的生产通路；
   只识别可信 `zcode/nodeReplBrowserUse` / `zcode/nodeReplComputerUse`，不从普通 MCP 输出猜测。

## 验收

- `cargo fmt --all -- --check`、`cargo clippy --workspace --all-targets -- -D warnings`、
  `cargo test`（受影响 crate + 集成）。
- 真实 Engine + 真 store + 临时目录测试：W4 身份/拼接/fork 冷恢复；F1 unreadable 不算删除
  与重读作废；F12 header 与冷恢复；F4 query 来自真实请求。
- 不放宽既有测试；未执行项如实登记。
