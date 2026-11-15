# 上游 3.18.2 项目数据：恢复项目 / 测容彻底删除 / V4 会话数据 / 有界备份

上游来源：`.cache/upstream-3.18.2@fec97590`（区间 `3c5b2276..fec97590`）。
产品规范：上游 `docs/superpowers/specs/2026-10-24-project-management.md`「恢复命令」「彻底删除数据」「协议」。
盘点依据：`/tmp/sync318-services-inventory.md` B/C、`/tmp/sync318-cli-inventory.md` F6。
本仓约束：`AGENTS.md`；本片**不做 UI**（设置页批量移除/测量勾选属 U 面），只交付服务与 CLI/协议真实执行路径。

## 1. 所有者与唯一写入路径

```text
UI/设置（本片不含） → ProjectService（project 模块，唯一项目命令面）
   restoreProject(id)            → 仓储 saveProject({ restoreProjectId, roots })
   measureProjectData(ids)       → 只读：仓储 readTree/readProjectTaskRefs → ProjectDataPort.measure
   deleteProjectData(id)         → 仓储 readProjectTaskRefs → ProjectDataPort.purgeSessions
                                 → 仓储 readTaskDirectories/deletableDirectories
                                 → ProjectDataPort.purgeDirectories
                                 → 仓储 purgeTasks | markTasksDeleted → (无失败时) purgeProjectIfUnreferenced
                                 → afterChange() → state:projects 广播

ProjectDataPort（project/data/adapters，node.ts 装配）
   sessions → IZCodeAgentService.measureSessionData / purgeSessionData（existing-only）
   directories(记忆) → 同一 V4 调用
   v2/checkpoints/<workspaceHash> → Host 自己删除（git checkpoint store 的写者是 Host）
```

- 项目组织态唯一所有者仍是 `ProjectRepository`（project-storage）。本片只新增行操作，不新增第二份组织态、
  不改 admission（`task_creation_reservations`）与分组准入语义。
- 会话/记忆文件的唯一删除者是 CLI（`v4/storage/sessionData/*`）；Host 只是发起方，且**只删** `v2/checkpoints`。
  不经 `services/src/storage` 的 `clean`，避免两个删除者。
- `ProjectDataPort` 由 `services/src/node.ts` 装配注入；`project` 模块不依赖 Agent 实现。
- 远端项目：`measureProjectData`/`deleteProjectData` 一律 `project.data-local-only`。W1 已批准新增 `remote-projects` 用户入口意图服务，数据仍落既有 `remote_project_entries`；它不拥有连接身份/连接事实（归既有 `windowRemoteConnectionRegistry`），也不删除远端项目数据。

## 2. `restoreProject(id, hostId?)`

- 幂等：项目未删除 → 直接返回当前项目（不改 name/roots/pinned/position）。
- 未知 ID → `project.not-found`；跨 Host → `project.cross-host-move`。
- 目录校验**不做**：撤销「文件夹不存在」的项目必须可行；主目录失效继续由 `primaryRootStatus` 与
  `prepareSession` 表达。
- 写路径复用仓储既有 `saveProject({ restoreProjectId, roots })`（清 `deleted/deleted_at`、名称按保存规则
  重新派生、重名加序号、`position` 不变）；仓储契约不新增方法。
- 远端 Host 经既有 route 转发；旧 Server 无该方法时表现为 method-not-found（不视为成功）。
- 事件顺序：仓储事务提交 → `afterChange()` → `state:projects` 失效广播。

## 3. `measureProjectData` / `deleteProjectData`

- 只接受**已软删除**项目（否则 `project.data-requires-removed`）；不存在 `project.not-found`。
- 目录集合 = 项目 roots ∪ 该项目全部任务 cwd（含已归档/已软删除任务），扣除：
  - 范围外项目（含已软删除项目，它们可恢复）的 roots；
  - 范围外 `deleted=0` 任务行的 cwd（移除项目只改项目行，任务行仍保护其 cwd）；
  - 同批已被更早项目占用的目录（一次只删一次）。
- 目录集合必须在删除任务索引行**之前**计算（否则 roots 变更前的旧 cwd 会漏删）。
- 会话保留：CLI 侧运行中（busy）整棵保留；附件仍被本次不删除的未删除会话引用（`zcode-artifact://<sid>/…`
  不动点迭代）整棵保留；文件删除失败保留行。命令正常返回部分结果（`runningSessions` /
  `referencedSessions` / `failed`），不抛错，释放量照算。
- 目录失败：只 `markTasksDeleted`（`deleted=1, cli_deleted=1`，清删除交接位），项目保持软删除，重试仍能找回目录；
  目录全成功：`purgeTasks`（tasks/分组成员/分组准入）→ `purgeProjectIfUnreferenced`
  （仍被 tasks/automations/off_peak_tasks 引用则保留软删除）。
- 幂等：CLI 已不存在的会话按 0 字节删除成功；重复调用不让项目复活或产生新行。
- 不删除用户工作区源码（项目 roots 与 `~/.zcode/workspace/<id>` 都保留）。

## 4. V4 `sessionData` 协议（shared + CLI 执行面）

方法（`V4_METHODS`）：`v4/storage/sessionData/{measure,purge,deletionPreview,deletionExecute}`，
四条都已接真实执行面（D3 补齐永久删除）。

- 入参 `{ sessionIds, directories: { workspacePath, workspaceIdentity? }[] }`（strict）。
- measure → `{ sessions:[{sessionId,bytes}], memory:[{workspacePath,bytes}] }`；会话大小含附属后代
  （subagent/workflow/侧边问答，不含 fork）。
- purge → `{ deleted, kept:{reason:"running"|"referenced"}, failed:{sessionId?|workspacePath?,code}, memory }`。
- 旧 CLI / Rust CLI 无该方法 → method-not-found；Host 侧 `measureProjectData`/`deleteProjectData` 报
  `project.data-unavailable`，**不得**把「不支持」当成 0 字节成功。
- 文件位置：`cli/{artifacts,exec,agents,sessions}/<sid>`、`cli/{debug,rollout}/model-io-<sid>.jsonl`、
  `cli/memories/projects/<slug>-<hash>/memory`（父目录）；会话 ID 只接受 `[A-Za-z0-9_-]`。
- purge 顺序：测量文件 → 释放空闲驻留（**不**发布 `session.removed`）→ 删文件 → 单事务删行 → 从 sessions-index
  投影移除。文件失败不删行。
- 永久删除（`deletionPreview/Execute`）：只处理单个根会话与 owned tree，fork 只列出不删除；
  `revision` 覆盖 ID 集、文件清单、引用与阻塞原因，确认后新增子会话/文件/外部引用都按 `changed` 拒绝；
  运行中/跨进程运行态按 `running`/`in-use` 阻止；`not-found` 不得当成 0 字节成功。
- 执行顺序：预检 → 同一事务写 `session_purge` 凭据（revision/operationId/保留附件）→ 释放本进程空闲驻留 →
  删文件（保留仍被外部引用的附件）→ 删正文并把凭据标记 `deleted` → 从索引投影移除。
  文件或数据库步骤失败返回 `incomplete`，凭据阻止重启/旧 create/旧 upsert 复活同一 ID，重试从凭据继续。
- 跨进程运行态：每个 CLI 进程在会话激活时写 `session_runtime_presence(pid,owner_id)`，去激活/关闭时删除；
  预检里其它 owner 的进程已退出（Linux `/proc` 不可用且非本机）时清理残留，仍存活则整棵保留。
- 存储迁移：新增官方 `0025_session_permanent_deletion`（本次冻结、与上游同 id/appVersion/字节，
  账本 checksum `608f3ea3…`），由 `scripts/sync-zcode-cli-rust-node-migrations.mjs` 逐字节镜像到
  `apps/zcode-cli-rust/crates/state/src/node/migrations/0025_session_permanent_deletion.sql`；
  `0023`/既有 23 条 id、SQL 字节与 checksum 不变。官方 `0024_session_database_identity` **未**引入：
  其消费者（Source/server workspace identity 迁移）不在本仓，单独加表会成为无写入方的空表；`0025`
  不依赖它，账本允许 id 不连续。`apply` 守卫在“结构已存在但账本缺失”时只补缺失对象，保留凭据与数据。
- 会话数据方法只在本机 Host 路径被调用：agent 侧 `purgeSessionData` 用 `existing-only`，
  没有该 workspace 进程时回退管理面进程，**绝不**为该 cwd 拉起项目 Agent（文件夹可能已不存在）。

## 5. SQLite 迁移备份 v2（`shared/src/sqlite-migrations`）

- 备份 `version: 2`：锁内**逐行**估算空间、逐行写入备份库；哈希用排序后的行 SHA-256 增量摘要，
  排序材料放有界页缓存的临时 SQLite（`temp_store=FILE`、`cache_size=-2048`），JS 只持有单行，
  保留重复行（不再 `Array.sort` 去重语义漂移）。
- 恢复：`version` 1|2 都接受；`1` 仍按原「JSON 数组排序」哈希校验（旧备份必须可恢复）；
  校验与复制共用备份库同一读事务；复制用 `copyTable` 逐行，不在 JS 保留整表。
- 迁移记录账本（`journalTable`）与 `previousIds` 语义不变；`schema_migration` 仍由 runner 独占。

## 6. 验收场景（本片实跑）

1. `restoreProject`：目录缺失也可恢复、幂等、重名加序号、保留 roots/置顶/顺序、未知名/跨 Host 拒绝。
2. `deleteProjectData`：非软删除拒绝、共享目录（范围外项目 root / 存活任务 cwd）保留、目录先于任务行计算、
   目录失败 → 只标记任务行且项目仍可恢复 → 重试成功、任务与项目行清理、引用了自动化时保留项目行。
3. 真实 SQLite（临时目录 `/tmp`）+ 真实文件：CLI store `listOwnedSessionTrees` 只展开附属后代（fork 不删）、
   `listArtifactReferrers` 命中按值复制的 artifact URI、`purgeSessions` 幂等、文件端口越界/软链拒绝、
   测量→删除→幂等重跑 0 字节、运行中 busy 保留、引用保留（含不动点链）。
4. 永久删除：0025 迁移幂等重跑与发布 checksum；预检 fork/引用/revision；准入后触发器拒绝运行态登记、
   正文写入与迟到引用；跨连接运行态阻止；新增文件/引用返回 `changed`；文件失败保留正文与凭据；
   数据库失败后重开连接凭据续删；重复 execute 返回 `deleted`；不存在返回 `not-found`。
5. 备份：真实 SQLite 写入 >1 页数据 → v2 备份 → 篡改/恢复 → v1 旧格式备份仍可恢复；
   重复行、BLOB、bigint 值哈希稳定；空库不产生备份。
6. 不支持路径：缺失 `sessionData` 方法的 client → `project.data-unavailable`（不是 0 字节成功）。

## 7. 明确未交付（不得宣称完成）

- 设置页「项目管理」UI、批量移除/撤销/进度 toast、编辑项目入口：U 面，本片不含。
- 永久删除 UI（归档列表的确认/进度/重试）与 Host 侧调用方不在本片：服务/协议/CLI 执行面已真实可用，
  但设置页尚未接这两个方法。
- `remote-projects` 用户入口意图 / `project-catalog` 只读组合 / 手机待处理交互叠加由 W1 单独交付；它们不属于本片的 project-data 删除与恢复行为。
- Rust CLI（`apps/zcode-cli-rust`）的 project-data 端点（项目恢复/彻底删除）仍缺；本片只交付
  V4 sessionData 四条（measure/purge/preview/execute），见 `.agents/specs/upstream-3.18-rust-parity.md` D 节。
- 真实远端 Host、真实手机、真实 Electron 桌面未验证（本片全部临时 HOME/XDG/DB/loopback 级）。
