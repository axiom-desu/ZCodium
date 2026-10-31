# S8-B/C：真实任务事实、ProjectService 与运行时目录边界

父规格：upstream-3.16-project-ui；来源 3.16.1/3.16.2 最终源。S8-A 仅地基，不能用新表/仓储测试代替产品闭环。

## Owner 与顺序

```text
CLI accepted session/terminal → existing sessions-index owner + epoch/seq guard
  → existing zcodeTaskIndexSyncer → one TaskIndexRepo transaction
      organization columns + matching CLI mirror + admission → ProjectService.readTree
  → Host/controller public contract → UI hook → existing sidebar delegated project section

project draft → ProjectService command → same repository transaction
  → versioned organization fact → same readTree

prepareSession → frozen execution directories → existing create/admit command
  → TS/Rust runtime context (cwd/identity unchanged; additional directories explicit)
```

- Host Project ID 是组织态，不是 workspaceIdentity，不写进 CLI history 的 identity scope。
- CLI title/created/updated/outcome/deleted 只由真实 CLI owner 事实写入 mirror；Host 保有用户改名、pin/archive/read/order 事实。
  旧 Host 数据迁移的 fallback 必须明确来源与兼容规则，不能凭时间戳伪造新 CLI 结果。
- 缺席/分页/旧 epoch 不等于删除；只有被接受的删除事实才能标 cli_deleted。Host 用户 deleted 不被 CLI 重放复活。
- reserve/空草稿不必冒充 meaningful CLI 会话；真实输入接受后必须立即进入一致的项目投影，不能靠重启回填才可见。
- 组织写入、用户整理优先/creationId admission 必须同一现有事务，不能在 syncTaskMeta 的非事务路径偷偷先提交 admission。
- TaskFacts/ProjectService 是 port/用例，不再起第二消费者、缓存、接受队列或独立项目 DB；读取通过原唯一源，写入通过原唯一 Repo。
- 真实 public service/DI/RPC 必须接入（Desktop、standalone server、Web/远端能力显式）；UI 不接触 Repo。
  旧 remote 无 virtualProjects 能力时走明确的 legacy single-root 适配，不伪造可写远端项目功能。
- Controller 若需要新 topic/字段，先更新严格共享 contract 和兼容边界，避免旧手机 whole-frame 拒收。

## 地基审查收尾

- rollback 失败保留原始迁移异常（包括 falsy thrown value），只附加/报告脱敏 cleanup 诊断，不掩盖 migrationId/分类。
- 备份 skip 结果在 tasks/project 两阶段合并并通过启动诊断/结果真实传出；不能留无消费者的成功标志，不能静默跳过必要备份。
- 迁移日志不输出 host_id/task_id/path/user@host 等用户信息，只输出阶段/id/分类/计数。
- membership_id 必须核对上游语义与真实授权来源：不能把随机值当远端握手事实；若是本地数据库自行持有的持久 membership，
  则写明其 owner/产生时机与非远端 authority 含义，并测试，不能只因 randomUUID 就盲删合法本地身份。
- 新模块按真实 pure domain / application / IO adapters 划分；不以整模块 adapters 标签掩盖边界。
- 所有初次 seed 必需的 settings 必须由 Host worker 注入；缺失时明确失败/延期，不留下“已 seed”账本导致永久丢失导入。

## Sidebar 接入（S8-B 后半）

保留 WorkspaceSidebar 装配、本地独有 footer/usage/automations/plugin store/phone trigger/plugin preview 与 workbench 分屏。
先使用 ProjectService 真实 API 与现有 controller 服务边界接入，再按职责委派 project-sidebar managed 子模块；不能整体覆盖成上游三行 barrel。
新增项目、roots/信任、任务归属/分组、时间线/归档/置顶/排序按源规则验收；旧无项目任务仍可发现，不因切新树丢历史。
UI 只持表单草稿、展开/视图偏好与 pending overlay；服务端项目/任务行不是第二 Zustand 事实。

### S8-B UI 合同（本批实现）

```text
IProjectService.readTree → useProjectTree（请求序号 + workspace/profile epoch）
  → ProjectTree（projects/tasks 唯一行集合） → project-sidebar 视图模型
  → WorkspaceSidebar 的既有 projects 分区（保留外壳/折叠/滚动）

ProjectEditor 草稿（名称/roots/primary/信任）
  → prepareSession / saveProject / deleteProject / restoreProjectId / reorderProjects / moveTask
  → 同一 ProjectRepository 事务 → readTree 刷新（UI 不写 project 行缓存）

state:projects 广播 + workspace_task_list_changed（真实 CLI 事实）→ 重新 readTree
```

- 新 managed 模块 `packages/ui/src/project-sidebar`，`requires: [services, shared, ui]`，只公开 `index.ts`/`contract.ts`；
  UI 通过 `useServices().projectService` 读取与写入，不接触 Repo、SQLite、网络或第二业务缓存。
- 行集合/项目归属/CLI 标题时间只来自 Host `readTree`。UI 只持：编辑器表单草稿、`hostId::projectId` 展开偏好、
  任务行 pending overlay（TaskList 既有）和在途请求资格；不建立项目/任务 Zustand 真值。
- 显示顺序唯一 owner 是 Host `position`；拖拽只提交 `reorderProjects`，不在 localStorage 再存一份顺序。
  置顶只改 `pinned`，跨置顶边界不改变分组；置顶任务仍归全局置顶区，项目行不重复渲染 pinned/archived 任务。
- 项目行任务来自 `tree.tasks`（`projectId` 精确匹配，`hostId` 相同）；同任务不得同时出现在旧 workspace 行与项目行。
  旧未归类任务继续可发现：属于项目 root 的本地 workspace 行让位给项目行，其余 legacy workspace 行保留；
  无 tab 的未归类任务在“未归类任务”区展示。旧 remote tab 不因本地服务缺行而消失。
- 新项目默认本地设备；`0 roots` 允许创建，首次 `prepareSession` 才生成确定性目录。roots 存在时保存前显示本次目录信任确认；
  取消不写库。编辑 roots/primary 只影响后续新任务，不改既有任务 cwd。软删保留任务归属；恢复必须显式选择同一组 roots。
- `legacySingleRoot`/`project.legacy-read-only` 的项目行保留可展开与历史任务导航，但创建/编辑/删除/置顶/排序/移动显式禁用并说明
  旧远端不可写；不把 UI fallback 当 legacy adapter owner（R3 接线仍是后续批次）。
- `prepareSession` 只用于新任务前校验/初始化 root；冻结目录与归属由 Host 预占决定（见下节“创建桥”），UI 只传
  项目意图，不伪造 `v4Create` payload 或第二套 create API。
- 取消、workspace/profile 切换、服务换代或组件卸载使旧 readTree/命令回包失效（epoch + 请求序号）；迟到结果不覆盖新树、
  不关闭新编辑器、不把旧项目归属写入当前选择。写入后只 `refresh()`，不乐观伪造成功行。
- 空 reserve 行不显示；真实 CLI 事实到达后无需重启立即出现在项目行。任务行复用既有 `TaskList` 的 rename/pin/archive/unread，
  归档当前任务时沿用既有 `removeTaskState` 清理；不新起第二任务缓存。
- 保留 WorkspaceSidebar footer/usage/automations/plugin store/phone trigger/plugin preview/文件树/分屏与 conversation 分区；
  App/WorkspaceShellLayout 的完整视图集成、SourceRemoteRegistry 与连接向导不在本批改动范围。

验收（本批实际执行）：`project-sidebar` 纯视图测试覆盖项目排序/去重/legacy 只读/未归类发现；
真实 `createProjectService` + `TaskIndexRepo`（临时 SQLite/HOME/XDG）驱动真实 `WorkspaceSidebar` 的隔离浏览器流程：
新建（目录信任）、编辑多 roots、置顶、改序、移动任务（含缺 root 显式确认）、软删/恢复同 roots、任务选择；
空 reserve 不可见、真实 CLI 事实到达后即时可见；legacy 适配器项目写操作显式拒绝。根 typecheck/raw lint 0、架构检查与目标包测试通过。

## Runtime additionalDirectories（S8-C，TS/Rust 同批）

- 从 ProjectService.prepareSession 的真实 root 决策冻结到既有 create/session preference 合同；不另建配置通道。
- workspacePath 仍是 cwd，workspaceIdentity 仍隔离；additionalDirectories 为明确的规范化允许目录集合，不改变身份。
- TS context/commands/skills 与 Rust prompt/env/ToolPort/skills 使用同一合同；远端目录走远端 IO，不在控制端 realpath。
- 热会话不被迟到 Project 修改反向改 cwd；新会话/冷恢复按当前合同固定，已有任务的执行事实不因组织移动被重写。
- 保留权限、symlink/file boundary 与静态 scope；不能把 additionalDirectories 当无限外部读写许可或隐式批准。
- 上游 3.16.2 同样只把 additionalDirectories 用于 Environment/env-info 与显式 skills/commands/subagents 发现根，
  `AGENTS.md` 仍只从 cwd 祖先与 home 读取；因此本仓 TS/Rust 不扩展 instructions 发现，属于有意保留的上游规则，
  不是新增缺口。
- 共享严格 schema、Rust protocol/config/generated assets 同步更新，不仅加 UI 字段。

## 验收

真实临时 DB + CLI frame：创建/接受后即时树可见、无需重启；只改组织不篡 CLI；旧/分页/乱序/重连不误删；
用户 deleted 不复活；admission 与组织写入同事务失败全回滚；历史 checksum/所有行保持。
公开 Host RPC 的 read/create/update/delete/reorder/prepare/reserve 与 virtualProjects/legacy 两路径；
实际 UI CRUD/多 root/远端单 root/信任/取消/迟到/旧任务可发现；Desktop/Web/手机既有列表不回归。
additionalDirectories 两侧真实模型请求与实际文件/skill/command 正反例、冷恢复/身份隔离/权限/符号链接边界。
根 typecheck/raw lint0、格式/三 gate/架构、目标包测试、Rust/Node 互操作与交互 E2E 必跑；未完成不标完整 3.16.2 对齐。

## S8-B 实际落地（后端，2026-10）

```text
CLI sessions-index frame / 真实 snapshot / reconcile
  → task-facts(app) ── TaskFactStore=TaskIndexRepo（同一写事务）
      task 行 + host/project 归属 + 分组 admission + cli_* mirror
  → ProjectRepository（唯一写者）→ IProjectService(readTree/prepare/reserve)
  → ServiceChannels.Project → Host RPC → 远端 capability(virtualProjects)
```

- 事实来源：`sessions-index` 摘要/真实 CLI snapshot、显式 `session.removed`、`v4/sessionsIndex/reconcile`。
  缺席/分页/旧 epoch 不删除；只有 CLI 明确 deleted 才写 `cli_deleted`，用户 deleted 永不被重放复活。
  空 reserve/预热草稿不伪造 `cli_created_at`；首条真实 CLI 事实到达后立即进入 `readTree`，不依赖重启。
- 事务边界：`syncTaskMeta` 所有路径都显式 `BEGIN IMMEDIATE`；task 行、`admitTaskIdentity`、系统分组登记/
  `creationId` admission、CLI mirror 要么全提交要么全回滚。`writeRecord` 只在无外层事务时自建事务。
- 公开 ABI：`packages/services/src/project/{domain/contract.ts,app/index.ts,adapters/legacy-single-root.ts}`。
  `IProjectService` 已冻结（readDirectory/readProjects/readTree/saveProject/deleteProject/moveTask/
  reorderProjects/prepareSession/resolveSessionDirectories）。`ProjectDirectories.additionalDirectories` 是
  S8-C 的输入合同；本批不修改 TS/Rust runtime 的 cwd/上下文。
- 运行时接线：`createLocalServices` 注入 `projectStorageHostId`、旧 settings loader、reserve 回调、Project channel、
  `state:projects` 失效广播与自动归档调度器；Desktop storage worker 注入 settings+hostId 并回传备份跳过结果。
  远端只在握手声明 `virtualProjects` 时创建 Project 代理；旧远端走 `legacy-single-root` 只读适配（显式
  `project.legacy-read-only`，不伪造可写项目）。
- 自动归档：唯一触发者是 project scheduler；`archiveInactive` 只读 CLI 时间并排除活跃/pin/删除；
  `readTree`/点击/进入 grouped 视图不再触发归档。
- S8-A 收尾：rollback 失败保留首因（含 falsy）；tasks/project 备份跳过结果合并后经 Worker done 消息与
  Host `onStorageWarning` 消费；迁移 warn 只带阶段/表/计数；`membership_id` 经上游核对为本地持久成员标识并幂等；
  `project-storage` 拆为 domain/app/adapters，`task-facts`/`project` 按 domain/app(/adapters) 分层。
- 下一批（S8-C，不在本报告范围）：TS/Rust 消费 `additionalDirectories`，v4 createSession 预占，UI/sidebar 接入。

## S8-C 实际落地（运行时目录与 reconcile，2026-10）

```text
prepareSession / reserveCreatedTask → frozen additionalDirectories (Host, remote IO)
  → legacy session/create|resume / v4 createSession(payload.sessionId + additionalDirectories)
  → runtimePreferences(runtime-materialization).additionalDirectories
  → core config (cwd/workspaceIdentity 不变) → skills/commands/subagents 发现 + 模型 Environment
  → 冷恢复按当前合同冻结；热会话忽略迟到目录
v4/sessionsIndex/reconcile → SessionStore 只读事实（含软删），缺席≠删除
```

- Host 侧只经既有 create/session-preferences 合同传递：`prepareSessionCreation` 预占并返回目录，
  `resolveSessionDirectories` 服务冷恢复；不新增配置通道。v4 create 的稳定 `sessionId` 由 Host 预留，
  CLI 只拒绝覆盖活跃/已存在（含软删）会话。
- TS：共享 strict schema（create/resume/preferences、v4 createSession、subscribe）与 Rust
  `schema/v4-command.json` 生成资产同批更新；context env-info、skills/commands roots、subagents
  namespace 消费同一冻结数组。附加目录只扩大显式发现根，不改变权限、hooks、symlink 或读写边界。
- Rust：`RuntimeOptions.additional_directories` 每次 create/冷恢复冻结一次；V4 create 接受预留 ID，
  冷订阅经 `open_topic` 注入，热会话保持原值；prompt Environment、ToolPort skill/profile 发现消费同一数组。
- Rust reconcile：`v4/sessionsIndex/reconcile` 严格参数、只读 store 屏障、workspace identity/软删判定与 TS
  同形；store 不可用或未知终态显式失败，不返回空成功，也不做分页/epoch 推断。
- 验收：TS 临时文件系统 skills/commands 正反例、Environment 投影；Rust 临时 DB+真实运行时覆盖预留 ID、
  模型请求目录、软删重连与冷/热恢复目录冻结、reconcile 跨进程事实；根 typecheck、Rust workspace 测试、
  目标测试与既有 gates 见 `/tmp/s8c-runtime-directories-report.md`。

## 创建桥：项目新任务的真实冻结路径（S8 最终整合，2026-10）

```text
项目行“新建任务” → ProjectService.prepareSession（校验 root / 空项目目录）
  → shell onCreateTask({ targetWorkspace, projectId })       # projectId 不得被丢弃
  → Root 冻结项目意图 → startDraft(projectId)                # 未显式表态时按活动任务归属/既有草稿继承
  → 既有 v4 createSession（prewarm 或首发 fallback）
      sendCommand(envelope, { projectId })                   # Host RPC 上下文，不进入 CLI wire
  → Host buildConversationCommandEnvelope
      derive sessionId(workspaceKey, clientId, commandId)    # 同一命令重试同一身份
      reserveV4CreateSession → prepareSessionCreation        # 唯一预占入口（与 legacy create 同一 port）
      payload += { sessionId, additionalDirectories }        # 既有 v4 字段，不新增命令
  → TaskIndexRepo 同一写事务：task 行 + project_id + 冻结 execution_directories
  → CLI 接受真实事实 → readTree 立即可见（空预占行不可见）
```

- 归属与目录 owner 是 Host：`createProjectSessionCreationPort`（`project/app/sessionCreation.ts`）同时注入
  agent service 与 task adapter；`reserveV4CreateSession`（`zcode-agent/v4CreateReservation.ts`）只做信封级派生。
  两处都是 production 代码，测试直接构造同一 port/helper，不复制实现。
- 创建路径（legacy create / v4 create / task adapter draft）在预占时固化 `execution_directories` 快照：
  之后编辑项目 roots 或移动任务只影响新任务，冷恢复目录不被改写。普通只读预占仍保留 NULL 语义。
- `workspacePath` 仍是 cwd，`workspaceIdentity` 仍隔离；`projectId` 只是 Host 组织态，不写进 CLI history 身份。
- 预热草稿 owner key 含项目归属：同一 primaryRoot 的不同项目各自持有 draft session；项目意图变化时旧预热
  会话被回收（迟到 ACK 就地删除），切换项目/workspace 期间的旧回调由 epoch/序号丢弃。
- 自动归档的活跃保护来自 syncer 的 live active-set（`activeTaskRefs()`，非终态会话，含 waiting/blocked/background），
  不再按 sqlite `status="running"` 过滤；保留时长默认 30 天（与上游一致），只由 Host 定时扫描/设置变更触发。

### 仍留待后续批次

- 时间线/归档行集合仍是“已打开 workspace scope + 既有 task 列表投影”，不是上游的整棵 Host 树：
  未打开 root 的项目任务不会凭空出现在这两个视图。归档按项目分组的卡片视图也未移植。
  关闭这两项需要把项目树接入这两个视图（会引入第二个树读取订阅），本批按“唯一读取者”合同不做。
  时间线日期段规则已与上游对齐（本地日历日 + locale 周起点，DST 边界有测试）。
- 手机/Web 项目目录能力组与远端项目导航仍属后续批次；本批保持既有 workspace UI 与 legacy 只读适配。

## 项目分组拖拽（S8-D，2026-10）

目标：把上游 3.16.2 的 grouped 单节点拖拽与 hover preview 接到当前项目树，不替换 `readTree` 唯一读取者，
也不把项目侧栏降级成旧的整表 `applyGroupedTaskViewOrder` 快照覆盖。

```text
真实 WorkspaceSidebar / ProjectGroupedView
  → 指针手势（仅本地 state：origin/preview/dropTarget/overlay）
  → drop 时从 origin+preview 提取 {node, sourceGroupId, groupId, anchor}
  → IProjectService.moveTaskGroupNode（typed Host 命令，校验 identity+host）
  → ProjectRepository 同一 SQLite 事务：
       source parent 复检 → 目标 group 存在 → anchor 属于目标层级
       → 只移动一个 task/group 的 membership/order
  → state:projects 失效 → 同一 readTree 重拉

Esc / pointercancel → 丢弃 preview，无写入
拖拽期间 readTree 变化 → 用最新权威行重算 preview；Repo 仍以 source/anchor CAS 拒绝真正过期命令
```

- 唯一读取者不变：`useProjectSidebarData` 仍是唯一 `readTree` 订阅；拖拽不新增 tree/group 订阅、不建第二 group store。
- 写 owner 不变：`ProjectRepository` 继续拥有 `task_groups/task_group_members/task_group_view_node_orders`，
  单节点命令和 `deleteTaskGroup` 都复用同一连接/事务；UI 只经 `IProjectService`。
- 命令只携带被拖节点和相邻锚点，不携带“当前可见行”全量快照。不可见成员（其它项目、被 legacy/搜索过滤、
  已归档、pinned 之外的历史行）保留原 group 和 order；取消分组把全部成员按原组块位置放回顶层。
- 身份边界：task 引用必须带 Host task 事实中的 `workspacePath + workspaceIdentity + taskId + hostId`；
  workspace 不匹配、同 path 不同远端、跨 Host、已删除/归档任务拒绝。group id 必须存在于当前 Host 可见结构。
- 幂等/过期保护：同一 group 相对重排重复提交收敛到同一顺序；task 的 `sourceGroupId` 或 anchor 在事务内已变化
  时分别返回 `task-group.stale-source` / `task-group.stale-anchor`，整条命令回滚，不能用延时或本地重试掩盖。
- 交互：hover 只渲染临时行序、克隆浮层与落点线；Esc 不写库；一次 drop 只发一条命令；不改旧 workspace/分屏/
  Source 指针拖拽。折叠组不因拖拽持久改展开偏好。
- 验收（真实 DI/浏览器）：生产 `WorkspaceSidebar` + 真实 `createProjectService`/`TaskIndexRepo` 临时 SQLite，
  指针拖动显示 preview、Esc 不落库、drop 后同组重排、其它组/过滤外/归档成员仍在、外部编辑后 drop 被 CAS 拒绝；
  服务测试覆盖同组/跨组/group 重排、不可见成员保留、取消分组、错误身份与 stale source/anchor。
