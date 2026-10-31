# project-sidebar 契约要点

spec：`.agents/specs/upstream-3.16-project-integration.md` 的 S8-B UI 合同。

- 唯一行集合是 Host `IProjectService.readTree`；本模块不建项目/任务缓存、Repo 读取或网络代
  理。UI 只持编辑器表单草稿、`hostId::projectId` 展开偏好、视图偏好和任务行既有 pending overlay。
- projects/grouped/timeline/archive 四个视图共用同一 `useProjectSidebarData` 快照：grouped 读
  `tree.taskGroups`（同库只读投影），timeline 取同一 `tree.tasks` 的 !archived 行并按 CLI 时间排序，
  archive 按 `(hostId, projectId)` 分组。视图切换只写浏览器偏好，不启动第二订阅/读取器。
- 置顶任务在 grouped 的独立置顶区、timeline 的时间线行中各出现一次；已归档任务只在 archive 出现。
  已知 legacy workspaceKey 的行由外壳 legacy 行继续渲染，树视图排除这些 key，避免同一任务双区。
- `WorkspaceSidebar` 继续拥有 footer/usage/automations/plugin store/phone trigger/文件树/分屏与
  legacy workspace 行；模块在既有 projects 分区内渲染项目行、未归类任务和编辑器/移动对话框。
- 显示顺序只来自 Host `position`；拖拽只发 `reorderProjects`。`pinned` 只改置顶事实。
- 项目行只渲染 `projectId` 精确匹配、同 `hostId`、`!archived && !pinned` 的任务；全局置顶区
  继续渲染 pinned。legacy workspace 行必须用 `isTaskOwnedByProject` 过滤，避免同任务双区。
- `legacySingleRoot` 项目只读：允许展开/导航历史任务，创建/编辑/删除/置顶/排序/移动显式拒绝
  （`project.legacy-read-only`），不伪造可写远端项目。
- `prepareSession` 只用于新任务前验证 root；`projectId`/冻结目录接线属于 S8-C，本批不伪造。
- 所有异步结果由唯一 readTree generation owner 的 opaque token + 请求序号作废；
  scope/service 换代或卸载后 token 无效，旧 refresh 在 IO 前拒绝旧 service。
  dialogs 仅叠加打开实例的 liveness；success/catch/finally 同验票，不覆盖新树、关闭新编辑器或清除其 busy。
- 写入成功后只 `refresh()` readTree，不乐观伪造成功行；空 reserve 行不显示，真实 CLI 事实到达
  后立即可见。
