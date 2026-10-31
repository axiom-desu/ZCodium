# 3.16 最终审查修复与验收纪律

父规格：upstream-3.16-sync 及各域 spec。来源仍区分 3.16.1 `0a1fc56d` / 3.16.2 `3c5b2276`。
本轮独立审查报告 /tmp/upstream-final-independent-review.md；修复先补测试，不以报告中的推测代替源码核对。

## 1. Source 身份阻断项

```text
form draft (request key only, no identity)
  → Host authenticated handshake (serverInfo.serverId + auth proof)
  → descriptor {sourceServerId, target.serverId, workspaceIdentity?}  [Host is authority]
  → Main forwards descriptor; bind may only rebuild from sourceServerId
  → UI realpath + choose path
  → canonical identity + token credential key -> history/credential slot
  → failure / wrong advertised id / late cancel: no history, no slot
```

- server identity 只能从已鉴权握手的 serverId/sourceServerId 与实际 workspacePath 构造。
  display name、URL hostname、profile label 不参与身份，不当作缺失 serverId 的 fallback。
- 连接前的表单/request key 是临时 UI 草稿，不是 workspaceIdentity。缺握手 ID 时不得写历史/凭据 workspace slot。
- Main 不覆盖 Host 返回的权威 descriptor；旧 transport route 只有通过 Host 验证的 legacy hint 才能保留旧 identity。
- 两个 Sources 同名不得碰撞；重命名不重置身份；server token 只在鉴权完成、匹配真实身份后进既有 credential port。
  失败/取消/迟到不能写新 history/slot，不得误用另一 Source 凭据。旧有错误 provisional key 不自动跨 authority 迁移。
- 验收必须从无 serverId 的真实用户表单开始，经过真实 Host handshake/Main route；不能测试时预塞 synthetic serverId 绕过问题。

### 鉴权前复用与 legacy descriptor 的进一步反例

- 鉴权前连接 key 不能只用 URL host：隔离 scheme、规范化完整 base path 与凭据范围（仅内部摘要，不记录/不持久化）。
  不同 token/base path 的请求必须实际握手，再以验证证明决定是否共享 transport；connecting 与 online 都适用。
- 两个已验证 legacy identities 即使共享 Source/path/proof，descriptor/execution/history/attachment key 仍各是原 key；
  不能仅保留 alias 却把主 descriptor 都改 canonical。新无旧绑定的 canonical logical context 不应反查到多个旧上下文。
  Main 尊重 Host descriptor，不重新 canonicalize 旧绑定；UI 历史和手机 exact-scope 使用同一实际 key。
- legacy hint 的验证由 Host registry 唯一负责：握手必须成功，identity 必须与本次 SSH/WSL/Docker
  的 shared builder（含用户、authority、路径）严格一致；Source canonical hint 必须等于已鉴权 id/path。
  不能证明的 direct-server provisional/跨传输 hint 返回 typed identity-change-pending，不盲保留、不生成 canonical alias。
  已验证 legacy 主 key 在同路径 bind/reconnect 中保留；切目录仍须按真实 transport/path 或 Source canonical 验证。
- 事件顺序：表单 → 完整 endpoint + 内存 credential fingerprint 的 provisional entry → 本次握手证明
  → Source owner claim → 验证 logical identity → exact descriptor → Main/desktop continuous 与 mobile replayable attachment。
  两种交付复用同 owner，但不改变各自队列、重放、lease 或 stale-run 语义；取消/失败不得发布 scope 或写新凭据。

## 2. 资源与数据完整性

- 分享 code 明确拒绝 `.`/`..` 路径段（含解码变体）；URL 编码不代表不会被 URL 标准归一化。
  不请求 code 目标以外的 endpoint。
  - 判定在解码后按**整段相等**进行：`.`、`..` 及 `%2e`/`%2E` 组合（`.%2e`、`%2e.`、`%2e%2e`）一律拒绝；
    其它位置的点号（`a..b`、`.abc`、`abc.`、`a~b.c-d`）只要整体仍在 code 字符集内就原样保留并原样转发，
    不做 trim/大小写/点段归一化，也不改写 endpoint 形状来“容忍”非法 code。
  - data URL 在 decode 分配前先按合同预算（`maxBytes`，默认 `CONVERSATION_SHARE_ARTIFACT_MAX_BODY_BYTES`）拒绝明显超长输入：
    base64 用长度与 padding 算出**确定**的解码字节数，percent-encoding 用编码长度算出**最小**解码字节数；
    超过 `maxBytes` 直接报 `limit_exceeded`，不得先 `atob`/`decodeURIComponent` 分配再判断。
- dev/filesystem/SEA 的内置 Office seed 与最终 staging 一样验证完整 assets manifest（字体/worker/wasm/NOTICE/哈希），
  缺一个资源失败且不激活半成品缓存；不能只检查入口 5 文件。
  - 校验发生在把 staging promote 成官方插件缓存**之前**，复用的仍是 `validateOfficeViewerRuntimeAssets` 同一份
    Node 适配器 + 纯 manifest 契约（安全相对路径、按 kind 的 pdf/xlsx 闭包、字体 97 片、NOTICE），
    不新增第二份闭包规则，也不跨模块复用私有实现。office profile（`package.json` 的 `office.kinds`）缺失但
    存在 `dist/ui/assets.json` 时同样按 seed 不完整失败。
  - seed 源文件哈希不符、staging 闭包校验失败都按「seed 不完整」降级：保留旧可用缓存，只清理本次
    `*.tmp-<pid>-<ts>` staging，不删除其它进程/版本的目录。
  - fresh checkout 没有 dist **不是**通过条件：dev seed 需要真实构建产物，缺产物就如实失败（降级并告警），
    测试/CI 不得用「dist 不存在所以跳过」冒充通过。四个文档插件的 runtime 依赖不能被改成可选/关闭。
- 分组单节点移动在事务内读取完整层级并更新 ordinal，隐藏/过滤外/归档节点不丢失、不因 sort_order 碰撞重排。
  - 「完整层级」= `task_group_members` / `task_group_view_node_orders` 的**全部原始行**加缺失 order 行的 group，
    不是某一视图过滤后的可见快照；过滤器只用于授权（来源 group、目标 group、group 锚点必须在当前 Host 可见集合内），
    不参与排序写集。写集覆盖该层全部节点后，同层 `sort_order` 在全库唯一，任何视图（含隐藏/归档/无 CLI 行）都不会因碰撞换位。
  - 事务内只改被移动节点的 membership（一个任务最多换一次 group）与其目标层 ordinal；其它成员只被重新编号，
    不删除 membership、不删除 `task_group_view_node_orders` 行、不改项目归属。读不出的历史 `node_key` 行保持原样（无法映射就不重排）。
- draft reservation 有独立 owner receipt；只释放确定未认领且无被接受 CLI 内容的本次预留。项目切换/取消/预热 dispose 不积累新孤儿，
  但绝不能删除已接受、用户整理或未知来源历史任务；通过实际 CLI 关闭/回执与现有仓储事务证明，不能只按 cli_created_at NULL 猜。

### 2.1 draft 创建预留的所有者与事件顺序

```text
UI draft prewarm（唯一创建发起者）
  dispatch createSession(projectId) ──► Host sendConversationCommandV4
        │                                ├─ reserveV4CreateSession → repo.reserveCreatedTask
        │                                │    └─ 同一写事务：tasks 空行(created_at=0) + 预留 receipt
        │                                └─ forward 到 CLI
        │  ◄── ack（accepted/failed）
        │
  未 promote → dispose / 项目切换 / transport 换代
        dispatch deleteSession(sessionId) ──► Host forward
                                              └─ ack accepted/noop = CLI 关闭回执
                                                   └─ repo.releaseCreatedTaskReservation
                                                        （唯一释放点，Host 侧）
  promote（首条输入）
        dispatch sendText(sessionId) ──► Host 先 claim（删 receipt）再 forward
                                          └─ 此后该行永不进入释放路径
```

- receipt 是 project-storage 迁移建的表（`task_creation_reservations`，同一 tasks-index 库），与 tasks 行同一事务写入，
  记录 workspace/task/host/project 与冻结 `execution_directories` 快照；它不是第二个任务 owner，也不参与可见列表。
- 释放判据全部来自权威事实，缺一即保留任务行：
  1. receipt 存在且 `(workspace_key, task_id, host_id)` 与命令目标一致（只释放本次预留）；
  2. 行仍是空预留：`created_at=0`、`cli_created_at/cli_updated_at/cli_deleted/cli_title/cli_last_outcome/task_status` 全为空、
     `pinned/archived/deleted/read/title_overridden` 未被触碰，且 `project_id`、`execution_directories` 与 receipt 快照逐字段相等；
  3. 没有被用户整理的证据：无 `task_group_members`、无 `task_group_admissions.user_organized`、无该任务的顶层 order 行；
  4. CLI 已关闭：Host 收到该会话 `deleteSession` 的 accepted/noop ACK（CLI 侧 `closeSession` 成功回执）。
- 输入屏障（要求 4 之外的独立条件）：Host 转发任何可产生 turn 的会话命令前先 claim（删除 receipt）。CLI 的持久会话只能由
  首条输入产生，因此「CLI 已接受但 sessions-index 帧在途、`cli_created_at` 仍为 NULL」的窗口里 receipt 已消失，
  释放不会发生——不需要等待/超时，也不靠 `cli_created_at IS NULL` 猜。
- 其余所有情况（行已被 CLI 认领、用户整理过、receipt 缺失、未知来源历史行）都只删除 receipt，保留任务行与冻结目录；
  失败不得部分删除。CLI 侧不新增方法、不改 v4 线上的命令字段：清理完全是 Host 侧 + 现有仓储事务。

### 2.2 Office 文件 IO 与 fresh Agent 构建

- `@zcode/shared/office-viewer-assets` 是唯一 Node 文件闭包校验 owner；真实 manifest/package/资源读取与 stat 必须使用异步文件 IO，不保留同步校验器或以 Promise 包装同步 IO。
- bootstrap seed、cache 复用/回退与发布 staging 都 await 同一校验器；97 片字体、worker/wasm、NOTICE、大小和 sha256 均 fail closed。纯 manifest 契约仍无 IO；SEA `getRawAsset` 是虚拟资产读取，可同步返回字节。
- 事件顺序：`await seed source → 获取唯一 seed lock → await cache 校验 → await 复制/闭包校验 → promote → 释放 lock → discovery`。锁必须等异步 action 完成才释放；失败只清理本次 staging，旧完整缓存保留。既有锁预算不变。
- CLI build 只为 package.json 已公开的 `office-viewer-assets` 与 `office-viewer-assets-contract` 增加精确 alias，位于通用 shared alias 之前；不导入私有子路径、不扩宽 alias。
- 回归先验证精确 alias/异步文件调用及既有 dev/SEA 缺资源与旧缓存保留场景，再执行 fresh `build:desktop-agent`、不带 reuse 的原完整 MCP Apps 71 项和 Gen UI；Node 使用仓库已有 24.14.0，入口自行隔离所有 HOME/XDG/数据目录。

### UI 异步资格与远端执行设备

项目 prepare/save/move/restore 的 await 后比较当前 owner ref/token（含卸载/关闭重开/服务换代），
不能用旧 render 的 captured epoch 和自身比较；成功/失败/finally 后效同一资格门禁，旧回包不能导航或关闭新表单。
远端项目不展示脱离项目/在项目外工作的入口，执行回调也复检当前 path+identity+remoteTarget/remoteSessionId；
陈旧回调不能把远端草稿移到本地执行设备。按源已有规则修复，不新增另一路 owner。

A3/A4 最终验收（测试先于实现）：

```text
Sidebar 唯一 readTree generation owner → opaque token + isCurrentToken(token)
  A 命令阻塞 → scope/service 换代或 dialog 关闭/卸载 → B 新草稿/请求
  → A success/catch/finally 全部失效；不能导航、关 B、解除 B busy 或显示旧错误
pane 实例当前精确 scope(path, identity, remoteTarget, remoteSessionId)
  → detach 入场复检 → guarded 本地 cwd resolve → 同 scope 复检 → draft transfer/navigation
```

- 不增加 readTree 订阅/epoch state；读取请求和命令共用已有 generation owner。对话框只拥有其打开实例的 liveness，关闭重开不能复用资格。
- 服务换代也关闭旧编辑器；旧 refresh 闭包不能以新 generation 启动旧 service 读取。
  token 是 generation owner 发出的不透明对象，当前 render 的 scope/service 即使在 effect 前也必须拒绝旧闭包；dialog 仅组合打开实例的 liveness，不创建第二份树代际。
  浏览器 barrier 覆盖成功/拒绝与 B busy 保留，并直接调用旧 refresh 验证旧 service 读取次数不增加。
- 当前 tab 按 path 和 identity 精确匹配，不以空 identity 通配同路径远端 tab；remoteTarget/session/identity 任一存在都禁止 detach。
- 每个 shared pane 的资格 ref 独立；await 后导航不能调用旧 scope 的父闭包。Root resolve 在本地文件 IO 前后消费调用方资格，不污染新 scope 错误。
- 本地「在项目外工作」、独立「对话 +」及 pluginCreator 普通流程保持；不把远端 detach 限制扩散为全局禁用本地对话。
- 真实 Sidebar/三个生产 dialogs + 临时 ProjectService/SQLite 的 deferred barriers 覆盖 prepare/save/delete/move/restore，成功和拒绝；浏览器覆盖 remote 入口隐藏、旧 callback 在切 local/同 path 不同 identity/session 后零 ensure/transfer/navigation，合法 local 成功。

## 3. 测试入口隔离

Electron/MCP Apps E2E 入口自身必须在加载会触发业务 IO 的模块之前建立临时 HOME/XDG/应用 data/config/storage/browser userData
并把同一隔离环境传给所有 Node/Electron/Agent 子进程；不能依赖调用者记住一组环境变量。
`ZCODE_SESSION_DB` 是数据库文件路径，只预建其父目录，不能将 `session.sqlite` 本身 mkdir 成目录；普通 bootstrap 入口同样必须能在隔离环境中打开 SQLite。
主脚本必要时以仅 Node builtins 的薄启动器创建隔离环境并启动原 runner，避免 ESM 静态 import 先于 env 设置。
不读真实 HOME/配置/凭据/会话/DB/log，不向默认应用目录追加日志；测试对路径解析进行断言，不通过读取真实日志验证。
保留所有既有断言和预算，不把托管/采样失败归为无关直至有源码/因果证据；不得加 timeout/sleep/skip 掩盖。

已知事件：前次现有 E2E 缺 ZCODE_DATA_BASE_DIR 时向默认应用诊断目录追加了两次测试退出记录；未作为验收通过证据。
已向用户说明，不读取/删除这些日志以隐藏事实；本修复目标是入口默认隔离、之后所有证据可复验。

- managed/rows/sampling fixture 创建窗口时先 `showInactive` 并 `moveTop`，确保被测窗口参与真实可见合成；多窗口 native-permission fixture 结束后，后续原窗口的 80 次锚点移动/真实帧断言必须显式恢复原窗口参与合成（`showInactive`/`moveTop`，不抢焦点）。隔离 fresh 运行已复现：权限窗口关闭后原窗口首个双 rAF 永不完成；临时产物探针恢复窗口后原 40 组 input/result 与 80 次切换逐项完成。只恢复 fixture 前台窗口，不增预算、不替换 rAF、不跳过 feed/状态断言。

- 测试按**依赖真实归属**放到能合法拥有该依赖的包：Source 鉴权 loopback 集成测试
  `packages/desktop/test/sourceAuthorityLoopback.test.ts` 归 Desktop（它同时驱动真实 Main manager、
  Host registry 与 UI reconnect 消费端，需要 `electron` / `ws`）。UI 包不为它新增 electron/ws 依赖，
  也不加 ignore、不删断言。跨包加载 UI 源码时由 `packages/desktop/vitest.config.ts` 镜像 `@` → `../ui/src`
  别名（UI 源码统一使用该别名），CI 以 `pnpm vitest run --config packages/desktop/vitest.config.ts` 真实执行。
- 浏览器回归同样是真实 CLI 入口：`test:conversation-detach` = `node scripts/ci/conversation-detach-smoke.mjs`，
  CI 在 renderer assets 产出后真实执行；它用 Vite 编译并加载的夹具
  `packages/ui/test/fixtures/conversation-detach.jsx` 只按「真实加载路径 + 执行证据」登记给静态分析，
  不用空 entry 或 ignore 掩盖未使用诊断。

## 4. 发布前总门禁

先修 P1/P2，再在冻结的真实源码执行全套 root/workspace types、raw lint0、root0.41/CLI0.47格式、三 gate、架构、
生成资产/许可/root+plugin notices、Rust locked workspace/fmt/clippy/每文件边界、Node/CI tests、全部修改交互 E2E、
原 TUI/workbench/responsive/Node-Rust互操作及真实 Desktop/MCP Apps/Gen UI。
无新忽略/宽限/假入口/假消费；只收紧已消除基线。版本/兼容宏待完整对账后一次收口为 3.16.2，精确 PR HEAD CI 全绿再 guarded merge。
旧 nested pnpm 图已证实任务前过期：不复制假锁、不恢复删除依赖；当前根图与支持命令真实验证，清理旧图独立治理并如实记录。
