# S1：会话软删除、lastOutcome、只读 kind 与父链列表归属

上游来源：`0a1fc56d`（3.16.1）/ `3c5b2276`（3.16.2）；切片定义见 `upstream-3.16-sync.md` §S1。

## 唯一所有者

`session` 行的持久事实只有一份，Owner 是 SQLite `session` 表：

```
turn terminal → 写 last_outcome（现有唯一持久化收口）→ 发布终态事件 / 索引投影
delete command → identity+存在性 → 软删除事务 → 现有 close/drain 路径 → 索引移除 → ACK
显式 session ID → 只读行读取 → 持久 parentID 归属证明 → 同 workspace 投影（不激活、不写身份）
```

TS adapter（`adapters/storage/session-store`）与 Rust `NodeStore` 各自经公开 `SessionStore` 端口读写同一账本，
不在 core/runtime/bootstrap 保留第二份会话事实。

## 迁移 0023

- 新增 `0023_session_soft_delete_outcome`：`time_deleted integer`、`last_outcome text`。
- 旧 0001–0022 SQL/checksum 冻结不动；`time_archived` 列保留为历史列，不回填删除时间、不再参与任何过滤。
- 两侧都必须容忍「列已存在」的历史库：TS migration 的 `apply(db)` 先查 `pragma table_info(session)`，
  对每列分别判存在，只执行缺失列的 ALTER；Rust `open` 对 0023 执行同样的逐列守卫，其它迁移语义不变。
  特别覆盖只存在 time_deleted / 只存在 last_outcome 两种半升级库；不能用“两列全存在才跳过整段 SQL”的守卫。
- Rust 迁移 SQL 仍由 `scripts/sync-zcode-cli-rust-node-migrations.mjs` 逐字节生成，checksum 镜像。
  新 0023 仅规范化模板尾部空白并保留一个结尾换行；`sha256(sql.trim())` 与上游不变，TS/Rust SQL 原文仍逐字节相同。
  不改旧 0001–0022 字节，也不为生成文件添加 whitespace 忽略规则。

## 软删除语义

1. `softDeleteSession(id, at)` = `time_deleted = coalesce(time_deleted, ?)`：首时间保持，重复调用幂等。
2. 正文（`message` / `part` / `session_entry` / `session_input`）保留；`createSession` 的 upsert 不清 `time_deleted`，删除行不会复活。
3. 普通列表永不返回 `time_deleted is not null` 的行；显式 ID 查询同样拒绝已删行。
4. `getSession` 仍返回软删行（Host 需要区分「已删」与「不存在」）；`resume`/`load` 把 `time.deleted` 视为不存在。

## 删除执行面

顺序固定（任一失败不得发布移除事实）：

```
1 payload 必须空对象、会话必须存在（resident 或持久行）
2 store.softDeleteSession（持久事实先落库，幂等）
3 现有 close 路径：取消前台/后台/子代理、收齐终态、关闭工具、释放 waiters/uploads
4 现有收口：draft 回收或 persist（ACK）
5 索引移除 + resident 摘除 + closed 集
```

重复删除幂等成功；`session.removed` 只发一次。已有 owner/lease、admission 队列、draft 回收语义不变。
普通 session/close 仅释放 runtime，不等于持久删除，不得发布 session.removed；dispose 的 deleted 标记由完成软删除的路径显式传入。
失败软删除不得先释放 runtime 或发布删除，普通 close 后该持久会话仍可列出和再次打开。

## lastOutcome

- 取值 `completed | error | interrupted`；未知历史值按缺失读取，不伪成功。
- 写入点唯一：`TurnComplete` → `resultType === "cancelled" ? interrupted : completed`；`TurnError` → `error`。
- 持久化发生在终态事件发布之前（TS `persistDurableSessionEvent`；Rust `Event::Finished` 先 persist 再 publish）。
- 它是「上次结果」，不替代当前 running phase；消费者用它纠正冷启动摘要（不再把历史一律标成 `completedSuccess`）。

## 只读 kind 与父链归属

- `isReadonlyAgentSessionKind` = `subagent_child | workflow_child | nested_workflow_child`（唯一实现，TS 与 Rust 同值域）。
- `isAuxiliarySessionKind` = 上面三种 ∪ `selection_side_chat`。
- 用户输入准入（legacy `session/send`、v4 `admitInputCommand`）只按只读集合拒绝，`selection_side_chat` 保持可输入；
  拒绝体不变：`-32010` + `reasonCode: "guard.subagentReadOnly"`。
- `session/list` 仅显式 `sessionIds` 分支可沿持久 `parentID` 证明辅助子会话归属：
  每级 `workspaceID?.trim() || (path || directory)` 必须等于期望 identity；辅助层要求 `path === workspace.workspacePath`、
  显式身份非空时不得与 path 冲突；环用 visited 截断；已删/缺父/跨工作区拒绝。普通分页仍按当前 workspace key 隔离。
  全程只读：不 `ensure_session`、不激活 runtime、不回写 `workspaceID`。
- `fork` / `workflow_parent` 不是 auxiliary，即使带 `parentID` 也不能沿父链改归属。

## 兼容

- 协议 `includeArchived` 保留接收但忽略（`deprecated`，避免旧 strict-schema 发送端断裂）；仓库调用端停发。
- `archivedAt` 仅在历史 `time_archived` 非空时投影，不由它推导 `deletedAt`；`deletedAt` 只来自 `time_deleted`。
- 前置依赖（仅加字段，不改媒体形状）：`AttachmentStorageMetadata.pathReferenceText?: string`（S3）、
  synthetic user message source `tool_search_announcement`（S6）。

## 验收

- 两侧真实临时 SQLite：迁移幂等（列已存在）、旧 22 checksum 不变、三 outcome 往返、正文保留、upsert 不复活、
  二次软删除保留首时间、默认列表隐藏。
- 删除后 list/resume/input 行为正确；ACK 与 removed 顺序、失败路径不发布移除。
- 四 kind 输入矩阵；显式 ID 父链正反例（同 path 归入、错 path 拒绝、身份冲突拒绝、fork 不走父链、环不死循环）。
- Rust fixtures/迁移资产 `--check` 绿；Node/Rust 双向互操作不回归。
