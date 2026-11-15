# 上游 3.18.2 项目管理与远端设备 UI（U4）

- 来源：`.cache/upstream-3.18.2@fec97590`（区间 `3c5b2276..fec97590`），只读。
- 依赖：D2 项目恢复/测容/彻底删除（`IProjectService.restoreProject`、`measureProjectData`、
  `deleteProjectData`），R1 远端生命周期合同（`stopSource/restartSource/cancelSourceUpdate/
getSourceRunningTasks`、`allowDowngrade`、`downgrade-unconfirmed`、`lifecycle-control-min-version`）。
- 上游参考：`packages/ui/src/project-sidebar/{ProjectManagement,ProjectManagementRow,
project-management-view,useProjectManagement,RemovedProjects,ProjectRemovalDialog}.tsx|ts`、
  `lib/sourceServerUpdateAction.ts`、`settings/SourceServerManagementPanel.tsx`。
- 非目标：本 UI 批次不实现 `remote-projects` 用户入口服务/`project-catalog`/目录管理 UI（由 W1 实现只读服务与持久意图）；不新增第二个 connection manager，不删除工作区源码，不恢复遥测/登录/支付/off-session/highspeed/CUA 休眠。

## 1. 单一所有者

```text
ProjectManagement（设置页分区唯一入口）
  → useProjectSidebarData（Host IProjectService.readTree 唯一树快照）
  → useProjectSidebarCommands（save/delete/restore 命令；写入后 refresh）
  → useProjectManagement（批次互斥队列 + 失败横幅；只做编排，不缓存第二份项目事实）
       → IProjectService.measureProjectData / deleteProjectData（D2，数据删除只本机）

SourceProfileList（SSHDialog 已保存设备列表）
  → useSourceServerManagementSnapshot（既有 Host 快照唯一 owner）
  → ISourceServerManagementService.stopSource/restartSource/cancelSourceUpdate/
       getSourceRunningTasks/updateSource({allowDowngrade})
       → windowRemoteConnectionRegistry（唯一连接/lifecycle flight owner）
```

- 项目管理只读 `readTree` 快照；行草稿/搜索/筛选/排序只是 UI 状态，树刷新后自然收敛。
- 删除批次确认后先固定 `hostId + projectId` 集合；之后刷新、搜索或重复点击不能扩充已确认批次。
- 撤销只恢复本 Host 本机（`hostId === "local"`）的软删除项目；远程项目不在本页移除，避免制造
  第二个远程入口权威。`deleteProjectData` 只接受已软删除、本机项目，绝不删除工作区源码。
- 远端设备生命周期操作只经管理服务；UI 不直连 `window.zcode`、不自行比较远端版本之外的协议、
  不把「旧 Agent 缺方法」当成功（服务抛出即失败）。

## 2. 项目管理行为

### 2.1 入口

- 设置页「数据与统计」新增 `projects` 分区（`projectManagement.nav`），简介 `projectManagement.intro`。
- 工作区侧栏「添加项目」菜单新增「管理项目…」：写入 `projects` 分区意图并打开设置页；
  不复制第二套项目/任务事实，也不改 #92 手机抽屉语义。

### 2.2 列表

- 行只来自当前 Host 的 `ProjectTree.projects`（排除 `deleted`），排除任务/会话按 `projectId` 归属统计：
  `sessions`、`lastActiveAt`（任务 `updatedAt` 最大值）。
- 设备列本机显示「本机」；远程行只展示设备身份，不提供移除。
- 疑似不再使用（仅对可移除、未置顶、可用主目录有事实的行）：
  - 主目录 `primaryRootStatus === "missing"` → `missing`；
  - 无会话且创建超过 7 天 → `empty`；
  - 最近活动超过 90 天 → `idle`（显示月数）。
- 搜索：名称、目录路径、设备名（本机/远端）；筛选：全部/疑似不再使用；排序：最近活动/名称/会话数。
- 「复核 N 个」重置查询、切到疑似筛选并预选全部候选；选择集合 = 草稿 ∩ 当前可见且可移除行。
- 行菜单支持编辑（复用现有 `ProjectEditorDialog`）与单行移除；编辑不改变树事实，保存后 refresh。

### 2.3 移除 / 撤销 / 恢复

- 移除单行或批量：本机项目调用 `deleteProject`（软删除）；成功后显示「已移除 N 个项目」toast，
  带「撤销」动作，撤销调用 `restoreProject(id, hostId)`；失败进入横幅（项目名 + 原因 + 重试）。
- 批量按发起顺序串行执行；批次在途时再次发起操作排队而不是丢弃（撤销点击不能被静默吞掉）。
- 已移除列表（`RemovedProjects`，仅本机软删除项目）可折叠、分页、显式恢复；恢复幂等。
- 确认对话框按设备分组展示后果；本机项目可勾选「同时删除 ZCode 数据」：
  - 勾选才调用 `measureProjectData(ids,"local")`；`project.data-unavailable` 时隐藏选项，
    不显示 0 字节成功；
  - 删除数据前要求输入确认词（中英文本地化）；
  - 逐项 `deleteProjectData`，常驻进度 toast 更新已释放字节；运行中/被引用的会话返回计数，
    项目保持软删除并进入失败横幅可重试；
  - 删除数据成功后不提供撤销（数据已不可恢复），并提示不删除用户文件夹/应用日志。
- 测容结果只在对话框内展示（会话/会话文件/文件检查点/记忆/总计），不写入任何设置/树。

## 3. 远端设备生命周期行为

- 设备列表行菜单新增（仅已保存 Source profile 行）：
  - 停止远端服务、重启远端服务：先读 `getSourceRunningTasks(sourceServerId)`；`available:false`
    明确显示「设备未提供任务清单」，空数组显示「没有运行中的任务」；确认后调用 `stopSource/restartSource`。
  - 取消更新：仅当 `state === "updating"` 且快照 `updateCancelable === true` 时显示，调用
    `cancelSourceUpdate(profileId)`；`{canceled:false}` 不提示成功。
  - 更新/显式降级：`updateAvailability === "required" && upgradeTarget === "controller" &&
currentVersion` 时显示「切换远端到 {version}」，先显示降级二次确认，确认后
    `updateSource({profileId, allowDowngrade:true})`。
- 版本门禁：`lastSeenVersion` 缺失或 `< SOURCE_SERVER_LIFECYCLE_CONTROL_MIN_VERSION` 时隐藏/禁用
  停止/重启并提示先更新；不发送试探命令，不把缺失方法当成功。
- 生命周期确认期间按钮禁用；同一设备操作互斥由 Host registry flight 保证，UI 只做重复点击防抖。
- 成功后用返回快照 `applySnapshot`；失败按既有错误分类展示，`credentials-required` 不打开确认。
- 停止成功后设备保持未连接；重启成功后走既有连接流程（Host 负责重连）。

## 4. 共享文件边界

- 只做定向编辑：`settingsPageConfig.ts`、`lib/settingsNavigation.ts`、`SettingsPage.tsx`、
  `WorkspaceSidebar.tsx`、`SSHDialog.tsx`、`remote-connection/SourceProfileList.tsx`、
  `lib/sourceServerErrorPresentation.ts`、`i18n/locales/{en-US,zh-CN}.ts`。
- U3 的 dataSync 设置入口、S1 的 MCP/CAS/remote commit、R1 的 Host/registry/transport、
  D2 的项目服务/存储不在本片修改；共享文件只做最小唯一锚点编辑。
- 新导出：`project-sidebar/index.ts` 增加 `ProjectManagement`（README/manifest 由 G1 记录策略条目；
  不新增受管模块，文件落在既有 `project-sidebar` roots）。

## 5. 失败语义

| 场景                            | 结果                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------ |
| `project.service-unavailable`   | 页面显示不可用，不伪造空树                                                     |
| 移除时项目已被别处删除/不可移除 | 跳过该行，不向新状态补发命令                                                   |
| 撤销/恢复不存在项目             | 服务 `project.not-found` → 失败横幅可重试                                      |
| 数据测容不支持（旧 CLI/Host）   | `project.data-unavailable` → 隐藏「同时删除数据」，不显示 0 字节               |
| 数据删除部分失败                | 返回 `failed/runningSessions/referencedSessions > 0` → 保留软删除 + 可重试横幅 |
| 远端设备旧版本/缺清单           | 生命周期操作禁用/清单不可用；命令错误如实展示，不默认成功                      |
| 取消更新返回 false              | 不提示已取消，刷新快照                                                         |

## 6. 验证

- `packages/ui/test/projectManagementView.test.ts`：行统计、疑似原因、筛选/排序/搜索、移除候选、撤销快照、测容汇总。
- `packages/ui/test/sourceServerLifecycle.test.ts`：版本门禁、取消/降级可用性、运行任务说明、force/downgrade 请求形状。
- 真实 Chromium：`packages/ui/test/fixtures/upstream-318-project-remote-ui.jsx` 挂载真实
  `ProjectManagement` + 内存 `IProjectService` 适配器（删除→撤销→恢复、测容→确认词→删除数据、失败重试），
  以及真实 `SourceProfileList` + 内存 `ISourceServerManagementService`（停止/重启任务清单、取消更新、
  旧版本禁用、显式降级确认）；`scripts/ci/sync318-u4-project-remote-smoke.mjs` 使用临时
  HOME/XDG/Chromium profile + loopback，不读真实配置、不连真实远端。
- `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`，报告其他 writer 错误但不改其文件。
