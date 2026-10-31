# project-storage

Host 项目组织态的持久化升级。调用者持有 app SQLite 连接，CLI 通过协议交接事实，不导入此模块。

- `0005_projects`（旧 ID `0001_projects`）首次迁移旧 settings 中保留的 workspace；不删除或改写旧列语义、不移动目录。
- 首次项目集合与 position 仅来自 composition 注入的 `lastWorkspaceSession`，按原顺序去重，保留无任务的已保存项目。conversation、历史 tasks、recentProjects 和 Group 不创建项目；settings 缺失或列表为空时不推断项目。历史任务保留 cwd 与组织态，无匹配项目时保持 NULL；已有 ledger 不重跑转换、不重排或自动清理项目。
- 远端条目只首次写入本机 `remote_project_entries` 入口缓存，不创建本机权威 project；不导入连接 profile（R3 未接入）。目标只保存脱敏描述，不带口令/私钥引用。
- `handoff_pending` 为一次性意图 bit（删除/标题/归属）；NULL project_id 是合法最终组织态。旧版本新写行以 `host_id IS NULL` 识别，同一事务补身份、首次归位与 bit 8；用户在新版移出/新建的空归属不能再次自动分配。
- 同 Host 唯一 root 匹配才归位，主要目录没有优先级。Group 保留独立组织态，不转换为项目。
- 身份只经统一 identity 工具：远端同路径不同 identity 不合并；`remote:` 前缀但无法解析的旧行保持未分配且可读，不伪造 host key、不回落到 local。
- 迁移依赖 `@zcode/shared/sqlite-migrations` 公共端口；内部文件不被 UI/其他服务直接导入。目录/备份位置与 logger 由启动入口注入。

项目仓库的事务面：save/delete/move/reorder/reserveCreatedTask 不写 `cli_*` 列。列表与目录解析在同步 SQLite 读事务中完成，不跨 await。缺 root 移动需要 `addMissingRoot=true`；恢复必须同 host 且 roots 集合完全相同。项目唯一名称在写事务中分配。新建 task 归属只在未决定时提交，后续由 moveTask 显式变更。

项目树任务沿用原列表的执行后端过滤（`provider=ZCODE_AGENT_PROVIDER`）；已删除任务继续从普通列表排除，但保留行与组织关系，只有显式 `includeDeletedTasks` 返回引用。`readTree` 同时以 `taskGroups` 只读投影 taskIndexRepo 的 `task_groups/task_group_members/task_group_view_node_orders`；缺表时字段缺席，不建表、不补序、不形成第二组织态。

新建项目在原写事务内分配同 Host 的最小 position 减一，排在已有项目之前；编辑/恢复不改 position。远端持库 Host 只允许恰好一个固定 root：创建、恢复、初始化 root、移动、reserve 均在写事务内拒绝空/多 root、换 root、无项目或附加目录，不做部分写入。

`0006_default_workspace_tasks` 一次性纠正系统 default 目录误迁移；`0007_initial_workspace_order` 只在同一事务首次建立项目时按旧混排顺序补 `initial_position`，已升级用户不再猜测顺序。

`0008_task_creation_reservations` 追加 receipt 表 `task_creation_reservations`（与 tasks 同库，不并入 0005 已发布的 SQL/checksum）。它是 draft 创建预占的唯一 owner receipt：`reserveCreatedTask` 在写入空行（`created_at=0`）的同一事务写入 workspace/task/host/project 与冻结 `execution_directories` 快照；`settleCreatedTaskReservation` 是唯一收口入口，`input-forwarded` 只丢弃 receipt，`cli-closed`（Host 收到 CLI `deleteSession` accepted/noop）才释放仍完全未认领的空行。已接受 CLI 事实、pin/archive/删除/改标题/已读、分组 membership、`user_organized` admission、顶层 order 行、project/dirs 快照不一致、receipt 缺失或未知来源历史行一律保留任务行与冻结目录；任何失败都不得部分删除。`applyCliFacts` 在同一事务顺手丢弃 receipt（旧 create 路径没有删除回执），所以 receipt 不会永久堆积。

Host Worker 必须注入旧 settings 完成首次项目导入；缺 settings 时迁移显式延期且不写 0005 账本，后续 Host 仍可完成首次 seed（不会留下“已 seed 空项目”的永久丢失）。`membership_id` 是本地 tasks-index 自有的持久成员标识（上游 3.16.2 同样在 composition 迁移中生成），不是远端握手/授权事实，只保证首次写入后稳定。

CLI 事实镜像（`cli_title/source/created_at/updated_at/last_outcome/deleted`）只由 task-facts 应用层经 `applyCliFacts/applyCliDeletion/markCliOrphan` 写入；任务行写入、首次身份归属与分组 admission 在同一写事务提交。组织态（pin/archive/read/project/order）与 CLI 事实分列，普通 `writeRecord` 不合成 `cli_*`。

`archiveInactive` 只读取 `cli_updated_at`、所属 Host 与 syncer 观察到的活跃任务，只写 `archived`；触发者是 project 模块定时器（启动首轮/5 分钟/设置变更），任何 readTree/点击/列表进入都不归档。Host 项目公开服务是 `project` 模块的 `IProjectService`；Repository 不直接暴露给 UI。
