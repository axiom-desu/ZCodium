# P3：手机 Host attachment RPC 授权

## 来源、确认原因与边界

对照 `a9fe401e:packages/desktop/src/host/windowHostAttachmentRpcPolicy.ts`，适配当前 Host 的 `exposeServicesOnMessagePort`，不整体搬运上游 Host。
当前 `ServiceCollection.exposeOnChannelServer` 无条件发布全部注册服务，手机与桌面共用该路径；仅隐藏手机同步 UI 无法阻止 RPC 写入，新注册的高权限服务也会自动暴露。这是本次修复的已确认原因。

仅修改 desktop Host policy/接线/测试及 services collection 的可选 policy 参数和公开类型；不修改 RPC、UI、Main、协议或服务实现。不新增上游本仓不存在的频道，不恢复已移除能力。

## 所有者与时序

- Host attachment 是授权边界，不是新的业务状态 owner；权限由可信 `clientMode` 决定，不能由 RPC 参数选择。
- 原 Host 服务继续唯一持有设置、凭据、终端、项目、任务和 runtime 状态；registry/lease/identity、串行 admission 均不变。
- 所有包装只在本 attachment 的 override map 生效，不修改共享 ServiceCollection 实例或其他 attachment 的权限。
- 现有 controller/task/Agent/分享 wrapper 先构造；MCP 方法约束在已有 override 外再收窄，不能用 override 绕过 channel allowlist。
- mobileProjectDirectory 仍由原 capability 判定与显式注册路径提供，不把原项目频道替换成上游窗口目录组；generation/stale 检查不变。

```text
可信 attachment(clientMode, scope, generation)
  → 现有 controller/task/Agent/分享 override
  → mobile: 显式 channel allowlist + MCP 方法 wrapper + Gen UI listState 只读面
  → ServiceCollection/原服务 owner → 原 replayable 交付
  └→ desktop: 无 policy、无新增 wrapper → 完整原服务面 → continuous 交付

attachment 换代 → 原 registry/connectionScope 的撤销与 flow closed（不变）
终端 ID → 原 ITerminalService → UI dispose / PTY exit（不依附 attachment 换代）
```

## 权限矩阵

| 频道/方法                                                                                                           | web-remote-replayable                                      | desktop-continuous             |
| ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------ |
| File, MediaPreview, System, Terminal, Git, GitCheckpoint                                                            | 原完整接口                                                 | 原完整接口                     |
| Setting, OnboardingRecord, Credential, CuaPermission, Broadcast                                                     | 原完整接口                                                 | 原完整接口                     |
| ZCodeTask, WindowController, ZCodeAgent, ZCodeSession, Project                                                      | 现有 attachment wrapper（不放宽 admission）                | 原 attachment wrapper          |
| ConversationShare                                                                                                   | 保留现有手机 feature_disabled/只读限制                     | 保留现有 trusted scope wrapper |
| FileWatcher, ProviderSettings, ModelSelection, UsageStats, CodingPlanSubscription, ClientScenes                     | 原完整接口                                                 | 原完整接口                     |
| Skills, Plugins, PluginManagement, Subagents, Commands, Hooks, Memory, SettingsSync, Bots, PromptAttachmentTransfer | 原完整接口                                                 | 原完整接口                     |
| McpSync.loadMcpFromUserDirectory/saveMcpToUserDirectory/listWorkspaceMcpServerStatuses                              | 允许，绑定原服务 this 与全部参数                           | 完整接口                       |
| McpSync 其余/未来方法                                                                                               | 拒绝 feature_disabled，不触达底层                          | 完整接口                       |
| Gen UI                                                                                                              | 仅 listState（上游只读面）；无原型投影，继承方法也不可调用 | 完整接口                       |
| SkillSync, PluginSync                                                                                               | 不发布                                                     | 完整接口                       |
| SourceServerManagement、ProviderProvisioningTarget                                                                  | 不发布                                                     | 完整接口                       |
| ClientConfig、PluginUiBridge/Sampling/AppTools、AstrBotBridge 等未批准频道                                          | 不发布                                                     | 完整接口                       |
| 任意未来/未知频道（含 override）                                                                                    | 默认不发布                                                 | 自动发布，保持原行为           |
| mobile-project-directory                                                                                            | 原 capability/guard/显式注册路径不变                       | 原行为不变                     |

当前 MCP contract 没有上游 `setWorkspaceMcpTrust`，不得凭空添加或放行。现用三个方法证据：`store/mcpStoreDesktop.ts` 目录读写、`settings/McpSettingsSection.tsx` 状态查询。
未发布频道沿用 RPC 已有 Unknown channel 错误路径；不引入新协议、超时兜底或占位频道。未允许 MCP 方法在调用时立即拒绝，非字符串/then/on\* 不伪装成方法。

## Terminal 设计冲突（先报告，不在本次解决）

调查证据：`services/src/terminal/terminal.ts` 的 create 只有 cols/rows/cwd，无页面 owner；`terminalService.ts` 的实例 map 属于共享服务；`ui/src/hooks/useTerminalService.ts` 与 `terminal/TerminalSession.tsx` 由 UI 以终端 ID 释放；Host attachment handle dispose 只撤销 controller、Agent connection scope、RPC/transport。
上游新增 page-owner registry 和无 owner 时 attachment 回收 fallback，若直接移植，会将独立换代的 RPC attachment 当成页面退出，可能提前回收仍在用的 PTY；还会引入当前协议没有的 owner 事实。
已在实现前向用户报告此冲突。此片只允许 Terminal channel，绝不增加 terminal scope、owner 推导、换代回收或 fallback；完整页面 owner 隔离需要单独对齐设计和协议后实施。

## 先测试后实现的验收

1. 真实 MessagePortProtocol + ChannelServer/ChannelClient，手机正常设置调用与事件仍可用；新注册未知 channel 即便提供 override 也不可调用，底层调用计数为零。
2. SkillSync/PluginSync、SourceServerManagement、ProviderProvisioningTarget 等手机拒绝；同集合 desktop 可调用全部服务与新频道，证明不污染集合。
3. MCP 三个现用方法可调用，参数与 this 保留；所有同步方法、未来方法/override 方法拒绝且底层零写入。
4. Gen UI 仅只读 listState；分享 wrapper 仍拒绝手机 publish；保留原任务/目录 wrapper 的现有测试。
5. Terminal ID 可在同集合的不同 attachment 使用；关闭 RPC attachment 不触发服务 dispose，显式 dispose 仍由原服务处理，不启动真实 PTY。
6. 测试仅使用内存服务、真实进程内 MessagePort 和临时 HOME/XDG/data；workspace 仅虚构参数，无 workspace IO。不读真实用户日志/数据，不启动 Host 主入口。

执行目标测试、root typecheck/lint、目标格式检查和 architecture --changed，记录真实结果及未验证限制。不 commit/push。

## 实际验证记录

- 已先写测试并执行：首次因 policy 模块尚不存在而红灯，再实现授权；另补 Gen UI 原型方法 RPC 用例，确实出现 constructor 可调用的红灯，改用无原型单方法投影后通过。
- 真实 RPC policy 用例 16 项通过；连同 `mobileProjectDirectoryOwners.test.ts`、`windowRemoteConnectionRegistry.test.ts`、`remoteWorkspaceServiceCollection.test.ts` 共 4 文件、42 项通过。
- 执行入口：`node node_modules/vitest/vitest.mjs run --config packages/desktop/vitest.config.ts` 加上述四个 `packages/desktop/src/host/` 测试路径；运行时 HOME、XDG_CONFIG_HOME、XDG_DATA_HOME、XDG_CACHE_HOME 指向一次性 mktemp 目录，结束后删除。
- 根 `pnpm typecheck` 通过；`pnpm lint` 为 0 warning/0 error；`pnpm architecture:check --changed` 为 0 violation/0 baseline/0 new。
- 六个改动文件目标 `oxfmt --check` 通过；`git diff --check` 通过。不刷新任何棘轮基线。根 `pnpm fmt:check` 失败，仅报告其他 agent 所有的 `.agents/specs/upstream-3.17-sync.md`，未擅自修改该文件。
- 环境 Node v24.19.0，与仓库 pin 24.14.0 不完全一致；未修改 pin。未运行真实 Electron/手机浏览器交互或真实 PTY，Terminal 仅验证 RPC 不新增 attachment 回收，页面 owner 隔离仍是待设计事项。
- 未改 RPC 文件（其并行变更属于另一 agent），未读真实用户日志，未 commit/push。
