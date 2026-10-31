# S9：SourceServer/R3 在既有窗口 registry 上的语义同步

来源：3.16.1 `0a1fc56d` / 3.16.2 `3c5b2276` 最终源；父规格 upstream-3.16-sync/project-ui。
只读调用链已证明 R3 是远端常驻 daemon + transport adapter，不需要 Desktop Remote Host。

## 所有者

```text
UI form / profile command → existing platform/Host RPC
  → window remote connection registry (one owner/generation/claim)
    → transport adapter (SSH/WSL/Docker tunnel or direct server URL)
      → authenticated remote daemon /ws/host → existing IServiceAccessor
    → same remote service collection → same Host attachment → same Agent scope/lease

phone → desktop existing attachment; no new Agent/Host/session
Main/relay → auth/pair/heartbeat/routing only, no task queue/project snapshot
```

远端 daemon 的 SQLite 是远端 authority，不是控制端第二份业务 owner。客户端只缓存 profile/显示/成员描述，
真实任务/项目命令仍远端执行。desktop-continuous 与 web-remote-replayable 两条端点/恢复语义保留。

```text
UI server form (no serverId)
  → Host handshake: serverInfo.serverId + auth proof digest
  → Host descriptor: sourceServerId + target.serverId(authoritative) [+ root identity]
  → Main forwards exact Host descriptor (same-path bind preserves its primary key)
  → UI selects real workspacePath
  → canonical remote:server:<handshakeId>:<path> → history + credential slot
        └─ failure/cancel/late: no history, no workspace slot
```

旧 transport route identity 只有在 Host 验证过现有绑定时才保留为主 descriptor/execution/history/attachment key，不降为 canonical 的 alias。显示名/URL 只用于展示，
不进入身份或凭据 key；旧 name/URL provisional key 不因重连自动迁移到新 authority。

## ABI 与安全

- 先更新 shared 的 source-server/server-remote/target/identity 公共 contract，再改客户端；严格校验并保留旧 SSH/WSL/Docker。
  server URL/token 是新传输选项，token 永不进 identity/日志/snapshot/URL query，持久化只进既有 credential port。
- daemon ingress token 原子写入其私有 run 路径、权限 0600，按源轮换；HTTP/WebSocket 一致鉴权，常量时间比较。
  缺 token 时非 loopback 拒绝；匿名 info 仅暴露源允许的非敏感版本/能力，不给匿名 Host capability。
- proxy-stdio 是纯双向字节桥：stdout 只协议字节，诊断 stderr；stdin EOF/abort/远端关闭正确 half-close/释放，
  stderr 必须消费以免反压，不能夹带安装进度到 RPC 数据流。
- 本地 archive 更新验证 target/path/hash/兼容，复用既有 release installer；running-task 非 force 拒绝。
  force 只影响忙碌更新许可，不能跳过身份、artifact 或权限校验；全部测试仅临时安装树，不更新真实机器。
  安装后第二次 busy guard 拒绝不得留下本次未确认的 pending 指针；使用同一更新事务/既有安装锁或明确所有权 receipt 回滚，
  不能清掉别的并发更新/原先合法 pending，也不能在失败后悄悄应用新版本。
  实现使用 run/update.lock 串行化本地 archive 更新：安装前记录 pending，失败时仅在 `releaseId+archiveSha256`
  仍指向本次安装时恢复旧 pending 或删除；不按版本号猜测，也不覆盖锁外的不同 artifact。
- adapter 只返回 Duplex/服务句柄、进度/错误，无业务状态。未确认安装/升级零上传零安装命令，返回 typed install/upgrade-required。
  更新有 expectedTarget；确认后目标变更必须拒绝，不能对同 id 新地址执行旧确认。
- profile/directory 持久化复用 settings/credential，无新 DB；先写新凭据+确认 settings 成功再清理旧键，失败留旧可用。
  账号/OAuth/官方 relay 分支不恢复。

## S9-R3-1 daemon 入口与 shared 契约（本片实现边界）

本片只拥有远端 daemon 入口与 shared 纯契约，不接线 Desktop registry/transport/UI。

- `packages/shared/src/source-server/` 是新的 managed domain 模块（`module.ts` + `contract.ts`），
  只含 zod schema、版本比较、错误分类和脱敏函数；不导入 IO、进程、网络或定时器。
  对外 ABI 与上游 `3c5b2276` 同名同形；`contracts.ts` 因行数上限拆分实现，公开名字不变。
- `server-remote.ts` 只增加可选字段：`compatibility`、`migration.failedPathCount`、`identity{osUser,hostname}`、
  `capabilities.virtualProjects?`、`capabilities.processResourceTelemetry?`；新增严格输出 schema 与匿名信息 schema。
  旧 Server 缺字段仍可被客户端解析。daemon 只有在本仓真实注册 ProjectService/RPC 后才可声明 `virtualProjects`，
  本片不声明；`processResourceTelemetry` 同样只在真实事件可用时声明。
- 本片不新增 `RemoteTarget` 的 `server` 变体，也不改 `remote-workspace-identity`、`validation.ts`、Desktop registry。
  这些留给 R3 transport/registry worker；本片在 `/tmp/s9-r3-daemon-report.md` 冻结其待改 ABI。
- 兼容性：保留上游严格判定（较旧产品版本必须 >= 较新端的 `minCompatibleVersion`），不因根版本 3.15.1、
  最终 3.16.2 未定而放宽。测试显式注入版本；生产构建若未注入 `__ZCODE_MIN_COMPATIBLE_VERSION__`，
  回退为产品版本（严格相等），由构建/握手报告约束，不在本片修改根版本或构建 define。
- ingress token：Core 启动时向 `run/ingress-token` 原子写入 32 字节随机 token（临时文件 + rename，0600），
  每次 Core 启动轮换。HTTP `/api/server-info`、`/api/*`、`/api/rpc-host-capability`、`/ws`、`/ws/host`
  统一 Bearer（常量时间比较）；无 token 时保持 loopback-only fail-closed。无凭据访问 `/api/server-info`
  只返回 `{version,protocolVersion,authRequired:true,compatibility}`，其他路径 401；匿名请求永不获得 Host capability。
  `/ws`（web-remote-replayable）与 `/ws/host`（desktop-continuous）端点语义、capability 单次消费不变，只加鉴权。
- `proxy-stdio`（`zcode serve proxy-stdio` 或 `zcode proxy-stdio`）：读 ready status 的 loopback port，
  stdin/stdout 纯字节桥；stdout 不含诊断，失败只向 stderr 写结构化 `{ok:false,code,error}`；
  `daemon-not-ready` / `daemon-connect-failed` 显式分类；stdin EOF half-close、socket 关闭释放、error/abort 销毁。
- `update --from-archive <abs path>`：复用 `ReleaseInstaller` 的 target/版本/内容哈希/tar 路径校验与 immutable release；
  默认先经 control `prepare-update` 检查 running tasks，blocked 即拒绝；`--force` 只跳过忙碌 guard，
  仍执行 archive、target、哈希与身份校验。离线时安装为 pending/current；在线时安装后走既有 `apply-update`。
  同一 archive 重复安装必须幂等，不残留 `.incoming-*`；测试只用临时 server root。
- `version` / `--version` 输出 Server 产品版本（`--json` 为 `{product,version}`），不再委派 Agent bundle。
- staging：`bundledSkillsDir` 必填，复制 `README.md`+`skills` 到 `runtime/packages/bundled-skills` 并计入
  `agent-runtime` 组件 hash；`official-plugins` 只按 shared 注册表的内置 `<name>-plugin` + 当前 checkout
  有 `package.json` 的白名单，按 `BUILTIN_PLUGIN_TOP_LEVEL_PATHS` 实际过滤复制并列入组件 hash，
  `src`/`test`/`.turbo`/`node_modules`/未知插件不进入发行树；office 插件另按构建 manifest 校验完整资源闭包。
  重复 stage 先删旧 release/components。

本片验收：shared schema round-trip/兼容矩阵/发布描述符；真实 loopback HTTP+WS（token 正反例、匿名安全描述、
Host capability、`/ws` 与 `/ws/host` 均可用）；token 原子 0600 与轮换；proxy-stdio 字节透明与 not-ready；
临时 archive 幂等更新、running-task 拒绝、force 只跳过忙碌、target 不符拒绝；临时 staging 证明 bundled-skills
与白名单插件真实进入组件 hash（不是声明清单）。

## 身份与兼容迁移决定

- sourceServerId 只来自通过鉴权的握手，不从路径/主机名猜；registry 按其原子 claim，重复 profile 不创建竞争 transport owner。
  同 sourceId 但不同/未知授权范围不能盲目 join；需验证现有鉴权证明（例如不记录/不持久化的 ingress token 摘要）与已固定 profile。
  不把可被另一服务自报的普通 id 当成跨凭据合并的充分证明。
- 新 direct server scope 用 shared 构造/解析器生成稳定身份；UI 不重复格式化、不把 route 输入当握手权威。
- 已有 transport identity 的历史读/队列/绑定必须保持可达：保存经过验证的兼容 alias/legacyRouteHint，
  不批量重写历史 DB key，不按路径合并不同旧身份，不把易失 remoteSessionId 持久化。
  canonical descriptor 的新绑定与旧事实关联要有明确映射/生命周期测试；已验证的旧 route 保留原 workspace identity 作为执行/历史 key，
  新 canonical 身份仅用于无旧绑定的新路由。两旧身份即使同 path/source 也不能合并成同一个逻辑 workspace；可共享一个鉴权 transport owner。
  若不能无损完成则 typed identity-change-pending，
  不自动把旧会话重发到新 authority。新 server identity 不得覆盖不同用户/凭据的未知授权范围。
- 迟到连接成功只释放自身资源；cancel/close/owner transfer 都验证 generation。保留 WSL idle 回收、Docker专用和 SSH现有边界。
- 老 server 能力缺失时显式 legacy single-root 适配；只有真实注册了 ProjectService/RPC 才宣告 virtualProjects。
  不伪造 service/channel，严格 shared schema 加字段需向后兼容、不让旧手机整帧拒收。

## S9-R3-4/5 profile/management/release/registry 生产接线（本片实现边界）

本片把已冻结的 adapter 接到生产入口，并落地 settings/credential 迁移与管理 ABI；不接触 S8 UI/Office，
不新增 Desktop Remote Host、手机 Agent 或 Main 业务状态。

### 身份与 transport owner（补强上节）

- transport owner 去重 **不等于** logical workspace identity 合并。同一 Source 上不同 workspace 各自是独立
  logical context；同一 physical transport 可被多个 logical session 共享。
- 旧 route/legacy 绑定的 workspace 保留**原始 identity** 作为执行/历史/队列 key；握手后的 canonical
  identity 只用于没有旧绑定的新路由。旧 key 不批量重写，不按路径合并。
- 同一 `workspacePath` 的两份不同 legacy identity 必须保持两个 logical context；即使它们共享一个已鉴权
  transport owner，也不能折叠成一个 workspace 或互相复用 attachment scope。同路径 bind 即使携 canonical
  candidate 也保留 Host 已验证的 legacy 主 key；切路径重新按 transport/path 验证。新 canonical context 不反查 legacy alias。
- server provisional entry 使用真实 connector 同一 endpoint 规范化结果（scheme + authority + base path）及仅内存 credential fingerprint；
  online/connecting 均不得在不同 endpoint/credential 间绕过本次 connector/鉴权。Source claim 只发生在握手完成后。
- Main 同路径优先 Host exact descriptor；UI reconnect/history 优先消费返回的 actual workspaceIdentity，
  realpath 改变时沿已验证的 legacy 或 canonical 身份种类构造新路径候选，不把 Source legacy 自动 canonicalize。
- `sourceServerId` 单独不足以跨未知授权范围合并 owner。只有同时具备相同的**已鉴权证明**（每次连接由
  ingress secret 派生的临时摘要，未持久化、未写日志、未进 snapshot/identity）且 profile/target 已固定时才可 join；
  摘要不同或缺失即视为不同授权范围：不 join、不迁移历史、不把旧会话重发到新 authority。
- owner/lease/generation、迟到成功释放、WSL idle、Docker dedicated、SSH 复用边界全部保留；不能因新增
  server 直连而回退为按页面路径/route 猜测 owner。

### profile directory 与凭据迁移

- profile/source/history 只存 `AppSettings`（`sourceServers`/`connectionProfiles`/`sourceServerWorkspaceHistory`/
  `sourceServerDirectoryMigrationVersion`），不新建 DB；settings 与 credential 仍是唯一持久化端口。
- 迁移顺序固定：先写新 credential key，再提交 settings（引用新 key 的 profile），成功后才清理旧 key。
  任一步失败必须恢复本轮已写 key 并保留旧 key/旧 settings 可用；失败不得产生无人引用的 orphan key。
- settings/snapshot/log/identity 不含 token、口令、私钥内容或完整敏感 target；SSH 只保留 credential key 名。
- directory 以串行写队列提交；同 profile 的目标变更必须重新解析并校验 expectedTarget，不能把旧授权
  用于另一设备/账户。

### 管理 ABI（UI 下一片消费）

`ISourceServerManagementService` 是 Host 公开服务端口，实际注册到本地 Host 的 ServiceCollection：
`getSnapshot`、`connectProfile`、`connectSource`、`updateSource({force, expectedTarget})`、`disconnect`、
`rename`（Source/Profile）、`remove`（Source/Profile），以及 state/directory/operation-log 事件。
未实现的方法不得以“future stub”形式出现在公开契约中。

- 未确认安装/升级：返回 typed `source-server-install-required` / `source-server-upgrade-required` 与只读 preview，
  零上传、零安装命令；显式确认才允许安装。
- `updateSource` 的 `expectedTarget` 在 await 前后各校验一次；等待期间目标变化必须拒绝（target-changed），
  `force` 只影响 running-task busy guard，不跳过身份/制品/权限校验。
- 管理服务只操作既有 window registry owner / Host attachment；不创建 Agent、第二个 Remote Host 或 Main 队列。

### release resolver 与生产 transport

- 只解析本仓 fork 的发布来源：release base/expected version 显式注入（默认构建版本 `ZCODE_VERSION`），
  不把上游固定 URL 当权威，也不静默回退到上游制品。
- 制品策略：`release-versioned` 从显式 CDN base 下载 descriptor + archive；`development-content-addressed`
  只消费本轮本地 descriptor/archive。descriptor 必须版本绑定（`version === expectedVersion`），archive
  必须按 descriptor 的 fileName/size/sha256 校验；缓存按版本隔离，命中前重新校验。
- CDN 下载只用于测试中的 loopback fixture；生产不在测试/本片连接真实网络、不部署到真实主机。
- `setupRemoteConnection` 对 ssh/wsl/docker 在显式安装门之后切换到既有 transport adapter：probe → release
  解析（仅需要安装/升级时）→ `connectSourceServerTransport`（未确认即 typed 失败）→ 单 Duplex 握手。
  已在线且无需安装时复用 daemon status，不重启。
- ProjectHost resolver 仍按 hostId → sourceServerId → window registry 在线 owner 解析；缺失即
  `project.host-offline`，legacy 单 root 只读适配不创建新 owner。

## S9-R3-6 Source 管理 UI / 向导 / 手机非账号闭环（本片实现边界）

本片只拥有 renderer 侧远程连接向导、Source 管理列表、source-settings attachment 的 UI 入口与
跨进程最小桥；不接触 S8 UI/Office、插件设置业务、Desktop Remote Host、手机 Agent 或 Main 业务队列。

### 唯一取数点

- 管理能力只经既有 `IServiceAccessor.sourceServerManagementService`（本地 Host 服务代理）读取，
  UI 不直接调用 `window.zcode`、不新建 remote host、不为手机另起 Agent。
- 快照/状态/目录事件按 `generation` 判序：晚到旧快照直接丢弃；事件只触发重读，UI 不累计历史。
- profile/source 列表只从快照投影；`sourceServerId` 只认握手来源，UI 不用 URL/路径猜身份。
- 新增 Management ABI 必须有真实后端实现（`createProfile` 复用 directory `ensureProfile`），
  不得以 future stub 形式进入公开契约。

### 向导与入口 epoch

- 每次打开/收起/取消/切换连接类型/改目标都推进 `entryEpoch`；所有 await（连接、安装 preview、
  快照重读、目录选择、更新）返回后先校验同一 epoch，否则零导航、零历史写、零 tab 激活，
  迟到成功只释放自己创建的临时 session。
- 后台（已收起）连接成功不自动推进到目录步骤，只保留结果并展示显式「继续」；
  用户点击继续才进入目录/导航。
- 安装/升级：未确认返回 typed `source-server-install-required` / `source-server-upgrade-required`，
  UI 展示 snapshot 的 `installPreview/currentVersion/availableVersion/upgradeTarget`；
  用户显式确认后携 preview 时冻结的 `expectedTarget` 重试，目标变更返回 `remote-target-changed`，
  不得对同 profile id 的新地址执行旧确认。
- 更新（`force`）：running-task busy 只作确认附加信息，`force` 只跳过忙碌 guard，不跳过身份/制品/权限；
  确认期间任务清单读取失败不改变 force 默认拒绝。
- 删除/断开/改名等破坏性操作必须由用户显式触发；UI 不做自动清理。

### server 直连入口

- 已运行的 zcode-server 直连是真实用户入口（URL + 可选 token/名称/默认目录），不是内部表示；
  向导必须提供该表单而不是把 `kind: "server"` 判为 unsupported dead end。
- token 只存在于当前连接流程与 credential port：不进 settings/snapshot/历史/日志/tab 快照；
  持久化引用只写 `tokenCredentialKey`，重连经 credential port 读回；缺失时不伪造匿名凭据。
- 直连不创建 Connection Profile（profile 仅覆盖 ssh/wsl/docker），不伪造可复用设备记录。

### source-settings attachment

- Source 级用户设置沿用既有 `source-settings` attachment scope（`resolveSourceScopedServices`），
  不创建 Agent 会话、不复制物理连接；attachment 关闭只释放自己那一代。
- 最小平台桥只为拿到该 scope 的 services：renderer 请求 → Main 向窗口 Host 发 `AttachServicePort`
  → 端口回投 renderer → 注册到 UI store。Web/手机无该桥时按能力缺失降级，不新增 HTTP 轮询。
- 旧 `workspaceIdentity`/remoteSessionId 路由不被改写；Source 级设置只读当前 owner 的 services。

### 手机与兼容

- 项目目录的裁剪适用性与验收见 `upstream-3.16-mobile-project-directory.md`：单一 `IProjectService`、既有 Host RPC、未附着 root 显式 disabled；禁止为目录读取/选择创建 Agent、Source 连接或 RemoteSession。该规格是目标合同，不代表当前手机入口已完成接线。
- 手机 known-device 仅展示缓存（显示名/平台/错误分类），不参与鉴权/admission。
- Source 错误码只映射到既有错误分类与恢复提示，不新增 JWT/OAuth/官方 relay 或高频 HTTP 请求；
  desktop-continuous 与 web-remote-replayable 两条语义保持不变。

### 验收（本片）

- 真实 renderer 向导（假 backend + 临时 settings/credential store + loopback daemon 服务 RPC）覆盖：
  profile 列表/新建/连接、install preview/confirm + `expectedTarget`、running-task force 确认、
  收起后显式继续、关闭/取消/改目标后迟到结果零导航、跨 profile 迟到事件不导航。
- server 直连表单：URL 校验、token 只进 credential port、重连读回凭据、快照/历史无 token。
- 不连接真实 SSH/WSL/Docker 或真实用户 server；不新增依赖/ignore/baseline/gitops。

## S9-R3-7 浏览器真实入口、项目目录与手机显示缓存（最终收口）

本片补 S9-R3-6 的“纯函数通过但无 DOM”缺口。真实入口禁用真实主机：只用临时目录、临时 settings/credential、
loopback 假管理端口与真实 React 组件/hooks/store；不连接真实 SSH/WSL/Docker、真实用户 server 或外部网络。

### Source 管理 UI 浏览器验收

- 用真实 `RemoteConnectionDialog`（`SSHDialog`）、`SourceProfileList`、`SourceConnectionApprovalPanel`、
  `useSourceServerManagementSnapshot`、`useRemoteConnectionForm` 和 `sourceSettingsServiceStore` 在 Chromium 中跑；
  只替换 Host 管理服务与平台连接边界（假 backend），不另写等价 UI。
- 必须覆盖：install preview 展示 → 显式确认携 `expectedTarget` → 确认等待期间目标变化返回
  `remote-target-changed` 且 `onConnect` 零调用；running-task 只有用户点击 force 后才调用 `updateSource({force:true})`；
  收起后成功不自动导航，显式 Continue 才进入目录；关闭/取消后迟到的 `onConnect` 只释放自身 session，
  零目录导航、零历史写、零 tab 激活；已保存 profile 连接从 credential port 读回凭据。
- server 直连表单必须产生真实 `kind: "server"` target，URL/名称/token/默认目录 trim 后只进入本次连接，
  管理 profile 接口不被调用；不得把 server 判成 unsupported dead end，也不得为它伪造 profile。
- 新增测试入口只使用已有 test id；不新增依赖、ignore、baseline 或 gitops。

### Source 项目选目录

- 目录浏览优先走当前 attachment 的 `IProjectService.readDirectory`（远端 Host 项目服务），不能改用文件服务或
  另起 Agent；只有旧 Host 没有 Project 服务时才回退既有 `IFileService.readdir`。
- `hostId` 路由由真实 `createProjectService.resolveHost` 解析；缺失在线 Host 返回 `project.host-offline`，
  不创建替代 Host。列目录/读项目不启动 Agent，不写项目/任务。

### source-settings attachment 的 Main 入口

- `RequestSourceSettingsAttachment` 的 payload/window/source 校验必须是可单测的真实 handler 逻辑：
  空 id、非当前窗口拒绝；只调用 `attachSourceSettings(win, sourceServerId)`，不触碰 Agent、任务队列或
  任意 workspace scope。renderer 换代注册仍由 `sourceSettingsServiceStore` 按 entry 身份判等，
  旧端口迟到 close 不删除新 attachment。

### 手机 known-device 显示缓存

- 仅在既有 pairing URL 的 `mid`/`name`/`app_version` 字段存在时缓存桌面**显示名**；缓存只用于首页提示，
  不参与鉴权、admission、路由、重连或 Host 选择，不新增账号/JWT/OAuth/HTTP 轮询。
- 缓存公开只读、有界（固定条数上限）、损坏 JSON/未知字段/超长值静默丢弃；绝不写入 token、passHash、
  私钥或 proof。pairing 参数仍只从现有 query 读取，fragment/V2 hash 语义不改，不破坏自托管链接。
- 真实 mobile entry + 现有 LAN/自托管连接链的 Chromium smoke 继续覆盖坏 hash 终止、互踢、断线重连，
  并断言无外部网络请求、临时浏览器 profile 内显示缓存不泄漏配对 secret。

本片验收：`pnpm exec vitest run` 相关 UI/桌面/服务测试；真实 Chromium Source 管理向导脚本；
真实 mobile entry smoke；根 typecheck/lint 与已有 gate 如实报告。

## UI、手机与分发

- 向导入口 epoch 管理所有 await，关闭/切入口/取消使旧结果零导航/零历史写；后台完成需明确继续。
- force/update 携非敏感 expectedTarget；失败保留 profile，WSL 解析后固定目标。
- 手机 known-device 仅展示缓存，不参与鉴权/admission；只采纳本仓自托管链需要的契约/恢复/错误分类，
  不凭空引入 JWT token 服务或新 HTTP 请求。已有 pairing/stream/snapshot/queue/重连和主题同步必须保留。
- server stage 的 bundled-skills 与按名字白名单的 official plugin 树进入实际组件 hash，
  不吞入 node_modules、fixture、残留目录；实际复制使用已有 BUILTIN_PLUGIN_TOP_LEVEL_PATHS 和内置插件目录白名单，
  不能只把组件 hash 改白名单却仍整目录复制。Rust/TS runtime 继续按原选择分发，不替换 .395。

## 验收

临时 daemon + 实际 HTTP/WS：token 正反例、匿名信息、Host capability、两端点、close/abort/half-close/错误 stdout纯净；
假 backend + 真 Duplex：probe/兼容/install-required零副作用、一次 tunnel 复用、鉴权失败资源释放、stderr反压；
临时 archive：幂等更新/忙碌拒绝/显式force/恶意tar路径/hash/目标不符；
registry barrier：两个profile同source、一source多workspace、跨identity同path、迟到/取消/移交/stalelease；
settings/credential迁移每步失败后旧事实可用、无凭据泄漏；旧route/历史/队列可达；
真实生产向导/手机回归 + continuous/replayable；打包组件内容证明（不是声明清单）。
真实 SSH/WSL/Docker 和真实用户 server 未经明确允许不连接；只用 loopback/临时 HOME/XDG/DB/profile。
根 typecheck/lint0、三 gate/架构/格式/实际包 tests 和已有 CLI/Rust/远控验收不可削弱，未执行如实报告。
