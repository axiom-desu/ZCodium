# S9：手机 ProjectDirectory 的既有 owner 适用边界

父规格：`upstream-3.16-source-server.md`、`upstream-3.16-settings-and-navigation.md`。
源证据：只读快照 `/tmp/zcode-upstream-3c5b2276` 的
`services/src/window-project-directory/contract.ts`、
`services/src/project-workspace-navigation/contract.ts` 与 Web 手机入口。
本规格为手机项目目录的正式实现合同。目录 capability 为 Host RPC Initialize 的可选 `mobileProjectDirectory`；仅安装不可启动型 admission 的 replayable attachment 宣告。

## 产品规则与唯一所有者

- 当前窗口已共享的 Host 与已连接 Source 的项目仍由各自 SQLite / `IProjectService` 拥有。
  手机只能经既有 Host RPC 读取投影；Main/relay 不保存项目快照，不设第二业务缓存。
- 项目目录必须可发现。项目 root 尚未附着时仍显示，但选择/创建显式禁用并提示「请在桌面端打开 / Open on desktop」。
  不得以约束为由隐藏整个功能，也不得调用连接 Source、安装、创建 Agent、Local Host 或 RemoteSession。
- 选择/创建仅复用已附着 workspace 的现有 runtime，创建走现有 `IZCodeTaskService.createTask`。
  「workspace 在窗口中」不等于「runtime 已存在」；查询身份与创建之间的 runtime 消失也不得触发重新启动。
- capability 缺失时保持旧工作区首页，不猜测远端能力，不向缺失 channel 发起永不完成的调用。
- 服务必须经真实公开 contract / DI / hooks 接入，不仿造上游 WindowProject 服务组，不把 Repo 暴露给 UI。

## 身份、时序与失效

```text
手机首页 hook（仅当前入口投影）
  → 已有 replayable workspace bridge / attachment
    → 同一 IProjectService → 本 Host SQLite / 已连接 Source 的原 Host RPC
      → 项目及 roots（只读；零 Agent、零连接、零新 logical scope）

点击已附着 root
  → 验证 source authority + workspace identity + remoteSessionId / attachment generation
    → 验证同一现有 runtime owner（不可启动型 admission）
      → 既有 createTask → 同一 Agent actor / 原任务索引事务

断线 / 切 Source / 切 workspace / remoteSession 换代
  → 旧入口 epoch 失效 → 旧读取不发布、旧选择不导航、旧创建不得被重投到新 owner

desktop-continuous ─ 原 live stream ─┐
                                    ├─ 同一 runtime owner，不增加 accepted queue
web-remote-replayable ─ 快照/补读 ───┘
```

身份 key 仍为 `workspaceIdentity?.trim() || workspacePath`；本地保留 path fallback。
远端需要 Source 身份与 remoteSession epoch，不能仅按 root path 匹配，也不能把易失 session ID 持久化。
目录只读不能调用 `prepareSession`：其默认/空项目分支会 mkdir；远端绑定版 `readTree` 也必须先确认
其 identity resolver 不为未附着 root 注册新的 logical scope。优先使用现有只读 `readProjects`。

## 测试先行验收

以下是必须完成的产品验收，不得用调查性测试或旧 smoke 的通过替代：

1. 真实 `packages/web/src/mobile/main.tsx` + `MobileApp`，loopback LAN / 已有 Host RPC fixture，
   真实 ProjectService + 临时 SQLite + 一个既有假 Agent actor；项目只读前后 process/owner 数均不变。
2. 当前共享 Host / connected Source 的项目可见；未附着 root 可见、disabled、双语 desktop 提示；
   点击/键盘不能触发 Agent/Source connect/install/新 RemoteSession。
3. 已附着 root 选择/创建只调用正确现有 actor 的 task API，项目归属、cwd、附加目录保留。
4. 同 path 不同 Source / identity 不串；未知 scope、断开的 session、stale epoch/runtime owner 拒绝，
   迟到目录不覆盖新入口，拒绝不能触发启动型 fallback。
5. capability 缺失的旧首页不变；现有 bad-hash、互踢、重连与 replayable 会话回归仍通过。
6. 只使用临时 HOME/XDG/workspace/DB/browser profile；零外部网络、零真实用户日志/认证。

## Host-only admission 与公开目录合同

- AgentService 捕获真实 existing client 与 runtime identity/generation；返回仅进程内可用的 typed admission。
  admission 每次同步复检 client 引用、disposed、workspace identity 和 attachment epoch；不能经 RPC 传入或反序列化。
- TaskService 的同一 createTask 实现接受 Host 注入 admission，任何 MCP/项目 prepare 前检查，await 后再检查。
  guarded 创建只走 existing client 的 session/create direct request；不调用 getClient、resume、兼容重试或 draft fallback。
  AgentService 项目 reservation 仍是唯一创建归属写入口，冻结 additionalDirectories 仍传到 actor。
- replayable attachment 的普通 createTask 也由 Host 注入 admission，省略客户端字段不能回落普通路径。
  Host-only admission 方法不暴露给 RPC；Desktop 普通 createTask 不变。
- 公开 `IMobileProjectDirectoryService.readProjects/createTask`，投影只从现有 IProjectService.readProjects 读取。
  Source Server 仅在真实 TaskService 有 `createTaskExistingRuntime(params, expectedRuntime)` 时声明
  `existingRuntimeAdmission`；此 RPC 入口在源 Host 内捕获 admission，不能序列化 client/closure。
  Source socket 关闭使源 Host admission 失效。已经交给原 actor 的请求结果未知时不重投、不尝试撤销已接受事实。
  项目 owner Host ID + rootIdentity、精确 workspaceIdentity、Source/session generation 联合匹配；不按远程路径猜测。
  read 不调用 prepare/readTree/连接/安装。无 runtime 或未绑定 root 仍返回 disabled。
- UI hooks 在当前 workspace bridge 的 Initialize capability 到达后才请求目录；旧 peer 无 capability 不创建代理。
  本轮 bootstrap/Source 列表换代或手动刷新均使 hook 入口 epoch 失效并重新读取，迟到结果不导航。
  bridge/socket 换代作废所有读取和创建结果，不导航、不重投。Main 只透明传输，不增加业务 snapshot。
- 手机首页 hook 是跨包公开能力：唯一入口是 `@zcode/ui` 的 `./mobile-project-directory` 子路径
  （`packages/ui/package.json` 显式声明 → `src/hooks/useMobileProjectDirectory.ts`）。
  Web 入口只从该子路径导入，不得深引 `ui/src/**` 文件路径；UI 侧不新增第二份 hook 或代理层。
  该 hook 的消费方是真实手机首页（`packages/web/src/mobile/MobileApp.tsx`），不是仅供静态分析。

验证与未完成项如实记录于 `/tmp/s9-mobile-project-directory-final-implementation.md`。

## Attachment-scoped 目录 owner 与创建资格（P1/P2 修复）

手机目录不是“按路径猜 owner”的投影。一次 `mobileProjectDirectory` attachment 只有一个可创建
scope：创建 request 必须落在当前 MessagePort 的 `sourceServerId / workspaceIdentity /
remoteSessionId / attachmentGeneration` 上。目录读仍可列出当前窗口可见的本地与已连接 Source
项目，但除 attachment 精确匹配的 root 外一律 `enabled: false`，read 不注册新 logical scope。

```text
phone attachment（已验证 scope + generation）
  → createMobileProjectDirectoryOwners（同一 scope）
    → 逐 host 投影 root（未附着 → disabled）
      → createTask：owner.target(rootPath) 必须 === attachment scope 的 path/identity/session
        → guarded typed existing-only entry（固定 runtime）
          → 现有 Agent admission / actor 唯一写入口
```

- owner 工厂接收 `attachmentScope`、`attachmentGeneration`、attachment `services` 与
  `capabilities`，不再对同 Source/path 的 sessions 做 `find` 取 first，也不把 legacy identity
  canonicalize 成另一条 key。canonical 与 legacy 同 path 是两个 host owner，只有与 attachment
  完全一致的那个可启用。
- 每个 owner 的 `assertCurrent` 只复检它实际使用的 transport/session lease（Source entry 或
  单个 logical session + `resolveScopedServices === services`），不扫描同 Source 的全部
  sessions；其他 session 断线不得拖垮当前 root。legacy/second owner 使用同一套 lease 复检。
- `directoryAvailable` 只由本次 attachment 的 `services` 和握手 `capabilities` 决定：
  replayable + 非 source-settings + 有 `IProjectService` + local 的 typed existing 入口 /
  remote 的 `existingRuntimeAdmission === true`。不得读取窗口本地 `activeServices` 推断远端能力。

断连、切换 Source/workspace 或 generation 换代后：

- 尚未发送到 actor 的 prepare/await 复检失败 → `project.stale-attachment`，不派发、不重投。
- 已经发送或已被 actor 接受的命令 → 保留 unknown/accepted 事实；不得宣称回滚，也不得重投到
  新 owner。结果返回后的资格复检只用于作废旧结果，不伪装成发送前 admission。
- 远端 scoped TaskService 经真实 RPC，不能把 in-process `assertAttachment` 函数跨进程传递。
  local/in-process typed existing 入口才传回调；remote 在发送前校验固定 target，对端 Host 在
  自己的转发边界注入 socket/attachment lease 回调，并保持固定 expected runtime 与 scope。
