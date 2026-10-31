# S11/S12：剩余设置、文件管理、插件推荐与原生未读

来源：3.16.1 `0a1fc56d` / 3.16.2 `3c5b2276` 最终源。逐行为采纳，不能以新增文件数量代表完成。
父规格：upstream-3.16-sync/project-ui；Root lint0/无新忽略/身份与队列边界照旧。

## 设置（唯一 SettingsService owner）

```text
setting draft → existing SettingsService.set → persisted AppSettings + broadcast
  → generation-safe store.reload / Host startup preferences → newly materialized runtime
```

- DWF offered/user mode 与 applyDynamicWorkflowUserMode 按最终源：用户明确 on/off 不被灰度 offered 覆盖，auto 才跟随 offered。
  没有 DWF 引擎的 Rust runtime 不能伪造支持；区分 capability 不支持与 offered 灰度关闭。
- ToolSearch 设置仅提供源 UI 的 off/auto/local（CLI native 仍独立支持），默认和说明跟实际 capability/prefs一致；
  修改作用于新创建/冷 materialization，不假装热会话已经换模式，不建立第二写路径。
- auto-archive 30 天默认已改；reset-version 一次迁移与禁用状态可编辑规则按源确证后补齐，不能擅猜是否覆盖用户值。
  真正的 reset/迁移只在原设置 owner，一次提交且广播不回环；旧/坏值兼容场景要测试。
- UI 复用 DESIGN primitives/tokens/双语，服务通过 hooks；测试包含 Desktop/Web、迟到 reload、持久化/重启与 startup-pref字节。

## 文件管理导航

- 新 `fileManagerNavigationOpenByWorkspace` 仅为 UI 偏好，不是远端文件事实，key 必须 identity.trim() || path。
  同路径不同远端不串；无有效 identity 时保留本地 fallback；切工作区/连接换代的迟到目录响应不覆盖新目录。
- Source `FileManagerPane` 行为在现有文件服务/预览/导航 owner 中闭环；不新建第二文件服务，不把 Agent identity 当 cwd。
- 收放/前进后退/目录切换/文件预览、refresh、双语/主题/窄屏/键盘与 Desktop/Web/远端使用现有 IPlatformService/DI。
  保留本地 pointer drag/split pane 与完整视图的新 guard，不能复制上游删除。
- 实际生产组件浏览器 E2E 证明导航偏好隔离、迟到丢弃与文件服务调用，不只测 pure model。

## UI 插件推荐与商店

- 使用当前内置市场/个人来源术语与本地 catalog；不恢复账号、营销或官方云依赖。
  推荐配置/元数据与 fallback 能力按源，但安装须用户明确动作，进入商店不自动下载。
- AppSettings/client config 的 uiPluginRecommendations 等字段只有真实消费时采纳；zsrcUrl 只在确有现存无账号路径时配置，
  不凭空增加后台请求或内部地址。推荐为空明确空态，不伪造成功/可用。
- 复用插件生命周期唯一服务/管理 store，busy key 与详情异步关联必须包含 workspace identity + remoteSessionId/generation + market/plugin id。
  同 pluginID 跨工作区的旧成功/失败不覆盖新详情/忙状态；卸载抑制/可恢复/孤立已安装规则保持。
- 工具 UI 不可用/不支持环境回退普通 MCP 卡，不新增 accepted input queue。四个文档插件 ui 分类与面板契约保持。
- 测试包括实际本地 catalog、用户确认安装/恢复/取消、迟到并行读写与跨工作区、只读加载无下载；交互用生产组件隔离 E2E。

实现边界（S12 插件 UI）：

```text
clientConfigService（Host 公开配置唯一入口）
  └─ uiPluginRecommendations / zsrcUrl 解析；推荐 hook 只持当前入口投影
pluginManagementService（唯一插件生命周期 owner）
  └─ createPluginManagementStore(service) 每个市场/管理视图独立投影
       └─ activeOperations（按 plugin + market/plugin id 粒度）
推荐 target key = workspaceIdentity.trim() || path
                 + remoteSessionId + sessionId + market/plugin id
迟到结果：context/currentKey 不相等 → 丢弃；安装/启用成功不替用户打开面板
```

- `uiPluginRecommendations` 由真实 `useUiPluginRecommendations` 读取；当前本仓没有无账号的官方配置端点，
  `zsrcUrl` 只保留严格 http(s) 解析，不接后台请求、不生成内部地址。配置为空时仅从实际本地目录回退到
  已存在的 UI surface；目录也没有时保持空态，不伪造条目。
- 推荐面板与商店详情使用同一 `IPluginManagementService` / `buildStoreItems`；`restorable` 走
  `restoreBuiltin`，已安装但禁用走 `setEnabled`，其余才 `installPlugin`。进入商店只读，
  手动刷新才调用既有 `updateMarketplace`。
- 推荐条目去重：同一 `pluginId` 只认首个 `surfaceId`；surface 解析失败给空态/提示，不伪造可用。
- 跨工作区/会话切换时，旧 `plugins/list`、`describe`、安装、启停结果不得覆盖新 store 的
  `describeCache`、`activeOperations`、`error` 或打开的详情；用户未提交的配置草稿不因迟到响应被重置。
- 工具结果后台入口：当前本地桌面成功 UI 结果经 `v4/plugin-ui/tool-result` → Host 校验 schema/本地来源
  → 窗口接收器，复用唯一 page owner 与逻辑键；历史、失败、取消、Web/手机/远程不创建 guest。
  无插件 UI 或平台不支持时仍渲染普通 MCP 卡，不接受第二条输入队列。
- 面板状态键只下发 SHA-256 派生值，不下发含工作区路径的原始逻辑键。
- 测试：clientConfig 严格解析、store 跨 target 迟到隔离、逐插件 busy、推荐去重/restorable、Office4 的
  TS/Rust `ui` 分类、后台工具结果单次投递；生产 `PluginStorePage` + `PluginUiLauncherItems` 在
  Chromium loopback 中切换 A/B 并释放迟到响应。

## 原生未读（派生值）

```text
same Host project tree/read state → UI unread projection (dedupe existing task identity)
  → window count event → Main max-window-count aggregation → native badge/tray render
```

- Main 不持任务业务状态，只接窗口派生计数；上游最终聚合规则为 max 而不是 sum，避免相同全局树跨窗口重复统计。
- 单树计数用原真实 unread/read/active 规则；项目与 legacy 行不能重复计数，不把旧 snapshot/错误当 unread=0 清掉。
- Windows 任务栏/托盘使用 16/32 两档抗锯齿原生图，保持当前 TS/Rust 品牌/平台差异；图像缓存是派生产物，不是未读 owner。
- pure RGBA/尺寸/alpha/max 聚合测试 + Electron nativeImage adapter 测试；Windows 真机未运行必须如实说明。
  不以 Linux 构建等同 Windows runtime，不修改旧发行包。

## 项目树视图收口

group/timeline/archive 由既有一个 ProjectSidebar read-model owner 的同一完整树派生，多个纯视图不等于第二业务 owner/读取器。
不为视图各起独立订阅，不用“唯一读取者”误拒实现所需视图。旧未分配/legacy远端依旧可发现且无重复任务。
实际任务组仍由现有仓储组织事实负责，project id 不替换 workspace identity；移动不重写运行目录/历史。

### S8-D 实现合同（项目树视图）

```text
useProjectSidebarData（唯一 readTree 订阅）
  ├─ projects 行：selectProjectRows / selectUnassignedTasks（现状）
  ├─ grouped 行：同一 tree.tasks + tree.taskGroups（taskIndexRepo 三张表只读投影）
  ├─ timeline 行：同一 tree.tasks，!archived，CLI updatedAt/createdAt/taskId 倒序，20/+20
  └─ archive 行：同一 tree.tasks，archived 按 (hostId, projectId) 分组
任务组写操作仍走现有 zcodeTaskService 分组命令；不新建 group store、不另起树读取器。
```

- `ProjectTree.taskGroups` 是同一 tasks-index 快照的只读投影（groups/members/topLevelOrders），由 ReadTree 同仓储读取；
  缺表时字段缺席，旧库/旧远端不伪造空组。
- 分组视图：`!pinned && !archived` 任务按 Host 结构出现一次；组内顺序读 `task_group_view_node_orders` /
  `task_group_members.sort_order`；置顶任务在独立置顶区，归档任务不进入分组视图。
- 时间线：包含置顶任务，不显示项目/Host 分组；分页只切行数，不重排、不改变任务 key；日期标题按本地日历日。
- 归档：只含 `archived` 任务，按 `(hostId, projectId)` 分组；软删项目仍按原 ID 展示，不按目录叶名合并。
- 旧未分配 workspace 行在项目视图继续由 legacy 行渲染；grouped/timeline 从同一树排除这些已知 legacy
  workspaceKey，避免同一任务出现两次；无 legacy 行的未归类任务仍出现在两个视图。
- 视图切换只写本客户端偏好，不写 Host/CLI；项目/任务事实仍只由 readTree 刷新。
- 手机项目目录按 `upstream-3.16-mobile-project-directory.md` 接入既有 `IProjectService` / Host RPC；不照搬上游独立服务组。只读显示当前共享 Host / 已连接 Source 的项目，未附着 root 可见但明确禁用并提示在桌面打开；旧 capability 缺失保持工作区首页。已附着创建仍须不可启动型 runtime admission，不能以缺少上游类为理由隐藏整项功能。

验收：同一树驱动四视图；置顶/归档/未分配/legacy/远端行不缺失、不重复；分组结构与时间线纯函数用真实 tree 数据；
生产 `WorkspaceSidebar` + 真实 ProjectService/TaskIndexRepo 浏览器 E2E 切换 tabs，覆盖 timeline 排序、group 成员、
archive 分组、项目移动/删除与 legacy 去重。

## S12-F 修正：DWF 按 3.16.2 最终源的真实语义（取代下方 S12 中 on/off/auto 与 env 推断的旧结论）

来源：3.16.1 `0a1fc56d` / 3.16.2 `3c5b2276` 最终源，逐文件核对
`packages/shared/src/dynamic-workflow-feature.ts`、`packages/ui/src/settings/DynamicWorkflowModeSetting.tsx`、
`apps/zcode-cli/packages/cli/src/workflow-mode.ts`、core `dynamic-workflow-activation.ts` / `tool-allowlist.ts`、
`bootstrap/zcode-protocol/dynamic-workflow-policy.ts`、`services/zcode-agent/zcodeAgentService.ts`。

```text
Host（唯一裁决者）                          CLI runtime（唯一工具面 owner）
  offeredMode ── latch（进程内单次）┐
  userMode   ── 每次现读设置文件     ├─ applyDynamicWorkflowUserMode → mode
  engine capability ────────────────┘
        │ workspace/updateDynamicWorkflowPolicy { enabled, mode? }
        ▼
  runtimeConfig.dynamicWorkflowEnabled + dynamicWorkflowToolsOnDemand
        │
        ├─ alwaysOn：出生即注册十个 workflow 工具
        └─ onDemand：出生不注册；`/workflow`、run Resume/配置/启动、冷恢复历史
                     首次触发 → runtime.dynamicWorkflowToolsActivated=true → 重注册（只加不减）
```

- **三档原样**：`disabled | onDemand | alwaysOn`。设置行与源一致，三档都出现，`offeredMode` 所在项带「默认」标记；
  不再用 on/off/auto 折叠。`onDemand` 与 `alwaysOn` 在目录/技能/重启入口同为开启，差别只在 CLI 工具面的注册时机，
  UI 不得把两者写成同一行为。
- **哨兵**：用户选回 `offeredMode` 等于删除选择，patch 写 `""`（`normalizeSettingsPatch` 归一成删除），安装继续跟随服务端翻转。
  显式选到与当前默认相同的另一档也要原样保存；未知/非法用户值按「跟随」处理，不写坏设置。
- **协议 ABI**：`zcodeSessionCreateParamsSchema` / `zcodeSessionResumeParamsSchema` / v4 `createSession` /
  `workspace/updateDynamicWorkflowPolicy` 都带可选 `dynamicWorkflowMode`。旧 Host 只发布尔时缺席 = `alwaysOn`；
  Rust strict validator 同步接受该字段，Node 与 Rust 版本兼容。
- **引擎能力**：`engine: supported | unsupported` 仍与「灰度关」分开。判定来自 runtime 选择 owner 的公开解析结果
  （`resolveZCodeAgentRuntimeKind` / DI 注入的 typed capability），不是只读 `process.env` 的猜测；Rust runtime 恒
  `unsupported`，生效值 `disabled`，但 `offeredMode`/`userMode` 原样保留。设置行在 `unsupported` 时不出现。
- **应用闩只认回执**：`workspace/updateDynamicWorkflowPolicy` 成功后才把 `entry.dynamicWorkflowPolicyMode` 记为已应用。
  瞬时失败保持可重试：下一次用户请求/重连/重新入队时才重发，不建自动定时器；已知 `-32601` 只记降级日志，不冒充成功。
  已应用的 owner 存在 entry 上，旧 client/旧 epoch 的迟到回执不能写给新 owner；同一 workspace 的 desired→applied 只有一条串行链。
- **归档重置**：`taskAutoArchiveResetVersion: 1` 迁移保持；归档天数选择器在开关关闭时仍可编辑（源已去掉
  `disabled={!taskAutoArchiveEnabled}`），改了天数不等于打开归档。`SettingService.get` 的迁移写盘与用户 `set` 共用
  同一 owner 串行链，写前重读并保留所有字段。
- **测试先行**：shared 全 mode 矩阵 + UI 三档/默认标记/哨兵 + SettingService 持久化/重启 + Host RPC 失败可重试/重连 +
  CLI onDemand 出生不注册/首次 `/workflow` 激活/冷恢复 + Rust preview/default 能力判定 + 真实 `SettingsPage` 浏览器 harness。

## S12 落地决定（DWF / ToolSearch / 归档重置）

```text
setting draft --SettingsService.update--> persisted AppSettings + broadcast
  Root(useDynamicWorkflowUserModeSync, 每窗口一次) --串行--> Host.syncDynamicWorkflowUserMode
                                                     ├─ 失效「生效模式」缓存（「提供」仍闩住）
                                                     ├─ 重发 workspace/updateDynamicWorkflowPolicy
                                                     └─ forward → 在线远端 Host（同一方法）
  UI 快照 store.reload()（不 forceRefresh）← Host getDynamicWorkflowClientConfig 重算
```

- **快照三层**：`offeredMode`（服务端/本地覆盖给的默认）、`userMode`（用户选择）、`mode/enabled`（生效值）。
  `applyDynamicWorkflowUserMode` 是唯一折叠实现；对已应用快照重放是覆盖而不是叠加。
- **引擎能力与灰度关分开**：`engine: "supported" | "unsupported"`。Rust CLI 没有十个 workflow 工具，
  `dynamicWorkflowEnabled` 只会被丢弃，因此 `engine=unsupported` 时生效模式恒为 `disabled`，
  但 `offeredMode`/`userMode` 照实保留；设置行在 `unsupported` 时**不出现**（选了也做不到，不能假装）。
  能力来自 runtime 选择 owner 的公开解析结果（见 S12-F），不再由 `process.env` 猜测。
- **设置有 `disabled|onDemand|alwaysOn` 三档**（S12-F 修正旧 on/off/auto 结论）：存储用 `DynamicWorkflowMode`，
  「跟随默认」写 `""` 哨兵，`normalizeSettingsPatch` 折成删除。显式选择即使等于当前默认也原样保存，
  只有选回 `offeredMode` 才删除选择；`onDemand` 由 CLI 延迟注册工具面兑现。
- **旧 Host 兼容**：快照缺 `offeredMode` 时设置行不出现（旧 Host 不认用户选择，写进去也不会生效）。
- **ToolSearch**：设置行只给 `appToolSearchModeSchema.options`（off/auto/local），写共享设置，CLI `native` 不变；
  偏好经 `buildHostSessionRuntimePreferences` 在新建/冷恢复 materialization 一次性写进 runtimeConfig，
  不假装热会话已换模式，也不建第二写路径（本地与远端 Host 同一构造点）。
- **归档重置迁移**：`migrateTaskAutoArchiveReset` + `taskAutoArchiveResetVersion: 1`，在 `appSettingsSchema` 的 preprocess 链上，
  `settingService.shouldPersistSettingsMigrations` 负责落盘（否则用户重新开启后下次启动又被关）。只覆盖旧实现下
  「开启但未执行」的历史会话，不改阈值，不碰已有标记的文件。

新增验证：`packages/shared/test/{dynamic-workflow-feature,appSettingsMigrations}.test.ts`、
`packages/services/test/{settingService.dynamicWorkflow,dynamicWorkflowClientConfig,dynamicWorkflowEngineSupport,hostSessionRuntimePreferences}.test.ts`、
`packages/ui/test/{dynamicWorkflowModeSetting,dynamicWorkflowAvailabilityStore}.test.ts`、
`packages/desktop/src/host/remoteDynamicWorkflowUserMode.test.ts`。

## 验收

spec→test→code，根 typecheck/raw lint0/格式三 gate/架构与实际包测试，新增交互必须真实生产组件 E2E。
只用临时 HOME/XDG/workspace/DB/browser profile 与 loopback，不读 logs/ 或用户数据，不执行真实远端安装/更新。
原 Rust/TS runtime、MCP Apps、Gen UI、分享、完整视图、远控、历史/队列验收保留；未完成项在总账明确而不提前升版本。
