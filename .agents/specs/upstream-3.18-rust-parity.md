# 上游 3.18.2 Rust 侧剩余 parity（R2）

范围：`apps/zcode-cli-rust/**`。上游 `.cache/upstream-3.18.2@fec97590`（区间 `3c5b2276..fec97590`），
MBearo 参考树 `.cache/upstream-rust-reference` 只作 Rust 形状参照。本片补 C2 留下的
provider 原生工具冷恢复/轮次语义、共享会话生命周期方法、MCP 工作区信任缺口与
V4 session-data 存储面。TS 侧同批能力由 C4/D2 拥有，本片不复制 TS 代码，按 crate 边界重写。

## 固定来源

| 项                    | 值                                                                                                                                                                                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 会话生命周期          | `.cache/upstream-3.18.2/apps/zcode-cli/packages/bootstrap/src/session-lifecycle/{contract,controller}.ts`；协议 `session/lifecycle/{changed,getState,ensureReady,stop,restart}`                                                                                                 |
| provider 原生工具轮次 | `.cache/upstream-3.18.2/apps/zcode-cli/packages/adapters/src/model/provider-builtin-tool-compat/compat.ts`（渲染副本抑制）、`core/src/runtime/provider-tool-rounds/{rounds,cards}.ts`（`metadata.providerExecuted` + 冷恢复切轮）、`core/src/agent/session-history-hydrator.ts` |
| MCP 工作区信任        | `.cache/upstream-3.18.2` 的 `workspace-mcp-trust`（C4 已在 TS 落地，Rust 无工作区来源）                                                                                                                                                                                         |
| V4 session-data       | `.cache/upstream-3.18.2/packages/shared/src/zcode-protocol-v4/session-data/*`、`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/session-data/*`、`adapters/src/storage/{session-store/repositories/sessions.ts,session-data-files/*}`                                      |

## A. Provider 原生工具轮次（唯一事实：助手消息上的 `_zcode_anthropic_server_rounds`）

```text
Anthropic 流 → 轮次切分（服务端渲染副本按前缀+相邻结构丢弃）
  → 助手消息：content=可见正文；_zcode_anthropic_thinking=全序推理；_zcode_anthropic_server_rounds=段列表
  → 落库（唯一写入者 node_journal）：每段 reasoning/text part + 服务端调用的 tool part
    （metadata.providerExecuted=true，metadata.providerResultBlock=provider 原始结果块）
  → 冷恢复（node_history::hydrate）：按 part 顺序切回同一段列表，热/冷 canonical 字节一致
  → 请求（model_protocol::anthropic_body）：每段 assistant(thinking,text,server_tool_use) + user(result)，
    最后一段（无调用）为尾部正文
```

- 段形状：`{thinking:[块], text:字符串, call:块|null, result:块|null}`；`call` 为
  `server_tool_use`/`mcp_tool_use`（缺 `server_name` 补 `zcode-provider-builtin`），
  `result` 为 provider 原始结果块。未配对的结果不进入段（回放会被 provider 拒绝）。
- `_zcode_anthropic_server_tools` 保留为平铺线事实（跨模型剥离与协议判定用），由段派生，不再单独写入。
- 服务端渲染副本（`**🌐` 调用头、紧跟调用/结果的 `**` 结果副本、`**Output:**`+`**<tool>_result_summary:**`
  摘要副本）只在 `server_tools` 消息内按「前缀 + 紧跟结构」确认后丢弃；确认不了按原样保留，
  不做「见到 `**` 就删」的宽松匹配。
- 跨协议/跨模型：Chat/Responses 剥离全部 `_zcode_*`；`_zcode_origin` 不同则剥离段与平铺块。
- 失败语义：非法块仍按 `ModelFailure::invalid` 失败，不新增容错分支。

## B. 共享会话生命周期（owner = Engine actor 的唯一 residency）

- 方法：`session/lifecycle/getState`、`ensureReady`、`stop`、`restart`；
  参数 `{sessionId, workspace?}`，结果 `{completed:true}`，快照
  `{sessionId,state,generation,revision,lastError}`；状态 `unloaded|starting|ready|stopping|faulted`。
- 存在性预检只读：内存会话或 `store.session_exists`（只读屏障查询），不加载、不创建、不隐式恢复。
- 激活 = 既有 `ensure_session`（冷恢复同一条路径）；释放 = 既有 `shut_down`（历史留在 Store）。
- `generation` 只在实际激活时 +1；`revision` 每次状态迁移 +1；`lastError` 记录最后失败的操作与码。
- 幂等：`ensureReady` 已 ready 不重复激活；`stop` 已 unloaded 无副作用；`restart` 串行执行
  `release → activate`，失败后 `lastError` 保留且不隐式恢复（`faulted` 需重试 restart）。
- workspace 预检：与持久记录的 workspacePath / workspaceIdentity 不一致报
  `project.session-lineage-invalid`，不物化 runtime。
- 通知：状态迁移经既有 `ServerMsg::HostNotification` 发 `session/lifecycle/changed`，不新增投递通道。

## C. MCP 工作区信任

本仓 Rust 运行时没有工作区来源（`.agents/mcp.json`/项目声明）的 MCP 服务器：只有配置与插件来源。
因此 `workspace/mcp/trust` 以 typed 拒绝回答（`workspace/mcp/trust-unavailable`），
不返回「已信任」，也不新增第二份信任存储。

## D. V4 session-data（measure/purge/preview/execute）

- 四条方法已接 `Engine`：`v4/storage/sessionData/{measure,purge,deletionPreview,deletionExecute}`，
  参数 strict（多余字段/空 ID/非法 sessionId 直接失败），结果字段与官方 schema 同形。
- 存储 owner = `NodeStore`（唯一连接线程）：owned tree、附件引用扫描、`session_purge` 凭据、
  `session_runtime_presence`、正文 purge 全在 `crates/state/src/node/session_data*.rs`；
  文件端口在 `session_data_files.rs`（`<cli>/{artifacts,exec,agents,sessions}/<sid>`、
  `{debug,rollout}/model-io-<sid>.jsonl`、`memories/projects/<slug>-<hash>`）。
- 只沿附属会话展开（`selection_side_chat|workflow_child|subagent_child|nested_workflow_child`
  - `session_task_link`），fork 只列出不删除；附件仍被本次不删除的会话引用
    （`zcode-artifact://<sid>/…`，含工作流 journal/回退/输入队列）→ 整棵保留，迭代到不动点。
- 运行态：会话激活（ensure/create/fork/subagent/import/shared-context）写 `session_runtime_presence`，
  去激活/停用/淘汰时删除；其它 owner 的进程已退出（Linux `/proc` 缺失）时预检清理残留，存活则拒绝。
- 永久删除顺序：预检 → 释放本进程空闲驻留（Rust 释放会持久化并推进 revision，故在写凭据前完成并复查
  同一 ID 集/引用/fork）→ `session_purge` 凭据（revision + operationId + 保留附件）→ 删文件 →
  删正文并标记 `deleted` → 索引投影移除。文件/DB 失败返回 `incomplete`，凭据阻止复活，重试从凭据继续。
- 迁移：`0025_session_permanent_deletion` 已按上游字节镜像并加入 Rust 账本（checksum `608f3ea3…`）；
  “结构存在但账本缺失”时只补 `if not exists` 对象，保留凭据/触发器。官方 `0024`（database identity）
  的消费者不在本仓，不新增空表。
- workspace 不匹配 → `session-data.identity-mismatch`；缺端口/缺表 → `session-data.unavailable`，
  绝不返回 0 字节成功。

## 失败语义总则

- 生命周期失败不吞错：预检失败无副作用，激活失败先释放再抛原错，释放失败保持隔离态。
- provider 原生块/轮次非法 → 请求失败，不降级成纯文本。
- session-data 缺端口/缺表 → typed `session-data.unavailable`，不得当成 0 字节成功。

## 验收

- `crates/model`：轮次切分、渲染副本抑制、多轮 replay 编码（含跨模型/跨协议剥离）。
- `crates/domain`：落库 part 形状与冷恢复切轮往返一致（热 canonical == 冷 canonical）。
- `crates/core`：生命周期 getState/ensureReady/stop/restart 的幂等、generation/revision、只读预检、
  失败隔离；`session-data` 走真实 SQLite + 临时目录。
- `cargo fmt --check`、`cargo clippy --workspace --all-targets -- -D warnings`、`cargo test`（受影响 crate）。

剩余边界：Rust `stop`/删除释放仍复用既有 `shut_down`，会像 `session/close` 一样发布一次
`session.removed` 索引帧（持久行在文件删除成功前保持不变，列表已按凭据过滤）。项目数据
（`project restore/measure/delete`）不在 Rust 范围，见 TS spec。
