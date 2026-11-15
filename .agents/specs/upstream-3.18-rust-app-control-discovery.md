# Rust native App-control 会话工具与插件发现（R7 / R7b）

本片只做 Rust native（`apps/zcode-cli-rust/**`）的工具面：App 模式的十二个会话控制工具
（`ListProjects`…`SetSessionPinned`）与插件发现的两个工具（`SearchPlugins`/`SuggestPluginInstall`）。
R7d 只补一项真实纵向验收：Rust native app-server 子进程、Node protocol client/Host 绑定、既有
`AppControlService` 与受控 loopback provider 同进程互通；不重做原生架构或插件搜索。
**不**实现 standalone CLI 的跨 workspace session-control（Rust 没有 `allowedScopes`/独立 CLI 根标记），
也不宣称它是 CLI 八工具。

**R7b 交付范围**：只完成 App 十二工具的真实纵向（注册 → Host 反向 RPC → 既有
`AppControlService`）。插件发现（`SearchPlugins`/`SuggestPluginInstall`）本轮**未接线**：
`crates/tools/src/{plugin_catalog,plugin_search}.rs` 与 `crates/domain/src/plugin_discovery.rs`
仍是未完成草稿（前者当前不编译，模块声明已从 `tools/src/lib.rs` 取下，文件保留给后续片）。

来源：`.cache/upstream-3.18.2@fec97590`（行为参照）；本仓 TS 是 schema/文案/身份规则的唯一事实源——
`packages/session-control/src/{app-tool-contracts,app-control-protocol}.ts`、
`packages/services/src/app-control/rpc.ts`、`packages/services/src/app-control/service.ts`、
`apps/zcode-cli/packages/core/src/tool/{session-control/plugin-discovery}`、
`apps/zcode-cli/packages/bootstrap/src/plugin-discovery*`。MBearo 只是参考，不作为接线依据。

## 1. 单一所有者与事件顺序（App 会话控制）

```text
Host session/create|resume（无 runtimeConfig）
  → app-server 反向 RPC session/requestRuntimePreferences
  → Host resolveSessionRuntimePreferences（唯一能力结论；只有装配了 AppControlService 的
     Desktop Local Host 回 true）
  → app-server 把可信结论写入本次 materialization 的 runtimeConfig.appControl
      （与既有 toolSearch.mode 同一通道；不是协议字段，模型/工具输入无法写）
  → Engine session.runtime.app_control（本次激活的一次性事实，不落库）
  → RunContext.app_control（本轮副本）
  → 可见性：agent_loop_turn.prepare 只在 granted && 根会话 && 非子代理时注册 12 个工具
  → 执行：tool_execution → AppControlPort（core 生产适配器 = Engine 事件通道）
  → Event::HostRequest → ServerMsg::HostRequest
       method = "appControl/<十二意图>"，params = {callerSessionId, callId, input}
  → Host 既有 client.onRequest → createAppControlRequestHandler.bind()（只看真实连接事实）
  → 唯一 AppControlService → 既有 project/task/正文/导航 owner → 原 CommandInbox
  → ClientMsg::HostReply(id) → Engine waiters → 工具结果原样回给模型
```

- **身份唯一**：`callerSessionId` 来自本轮 session，`callId` 来自 tool call id；`turnId` 不伪造
  （缺席即不传）。模型输入只提供 `input`，无法提供连接、根会话、能力或 `requestId`。
- **能力唯一**：`appControlEnabled` 只来自 Host 的偏好回包。无 Host（TUI/无头/in-process）、
  旧 Host（`-32601`）、未装配 Host、子代理、非根会话一律不注册；强行调用得到明确不可用错误，
  不发 Host 请求。冷恢复/新输入不继承旧代际的授权（每次 materialization 重新判定）。
- **根角色与 TS 逐字一致**：`mainRoot = taskType === "fork" || (!parentSessionId &&
(taskType === "interactive" || taskType === "workflow_parent"))`
  （`domain::app_control::is_main_root`）。因此带 `parentSessionId` 的 `fork` 仍是根，
  其余种类只要带父会话就不是。
- **`turnId` 不透传**：Host schema 允许缺席；Rust 没有与 Node `traceContext.turnId` 对等的可信字段，
  不从模型输入代替。
- **取消不公告**：`appControl/cancel` 只取消 Host 侧观察，不影响目标任务；Rust 侧等待被 run 取消时
  只释放自己的 waiter（`HostWait.announce = None`，既有 announce 通道的 params 形状是
  `interaction/*Cancelled` 专用，不夹带第二种方法）。连接关闭由 Host 的 `assertCurrent` 收口。
- **队列唯一**：不新增 accepted 队列/mutation 队列；写意图仍由 Host 既有 owner 经原 CommandInbox 串行。
  请求/回执只走既有 `waiters` + `outbox`，stop/close 的 `release_waiters` 会撤销等待。
- **取消**：等待期间 run 取消 → 取消语义错误，不返回 Host 结果、不写成功；已释放的 waiter 不会
  被之后到达的回执唤醒（回执按 id 归属，不会串到新调用）。
- **请求身份**：工具面只有 `retryOf`（与 TS 一致）。`requestId = retryOf || toolCallId`，
  仅在工具面声明了 `retryOf` 的写意图注入；只读意图带 `retryOf` → 参数错误，不发送。
- **结论形状**：只接受 Host 的封闭回执 `{ok:true,result}` / `{ok:false,error:{code,message}}`。
  失败回执成为工具错误；其它任何形状（含 `null`：传输层把 `-32601`/`-32602` 投影成空结果）
  是明确的“Host 拒绝或不可用”，绝不伪成功。Host 自己给出的 `status/admission:"unknown"` 原样保留，
  Rust 不改写成成功或失败。缺失回执的文案只说**结论未知**（`…; the outcome is unknown.`），
  不得写成「意图未生效」：Host 可能已执行而只是没能回答。

## 2. 单一所有者（插件发现）

```text
SearchPlugins/SuggestPluginInstall（模型工具）
  → 既有权限门（SuggestPluginInstall 用生成能力表：needsApproval+alwaysAsk+allowAlways:false，
    即“既有安装建议 approval”；用户拒绝则 handler 不执行）
  → plugins 现有 owner（同一 config/存储根、同一 storage 锁、同一 marketplace 刷新）：
       discover / overview / market::known / plugins/install / plugins/setEnabled / 既有 refresh
  → 候选投影 + 排序/分页（纯函数，本片新增 domain 模块）→ 工具结果
```

- 不新建 marketplace、目录缓存、安装队列或第二把锁；搜索只读既有目录投影。
- 目录新鲜度用既有的 `lastUpdated` 记录 + 既有 marketplace 刷新（10 分钟节流，失败则 `stale:true`），
  不新增进程内单飞 owner。
- 安装/启用走既有 `plugins/install`、`plugins/setEnabled`（同一把 storage 锁内复验状态）；
  回读复核 `installed && enabled`，否则失败。
- 激活事实只来自既有解析结果：本会话冻结目录（`Event::PluginCatalog`，唯一 owner 在 Engine）
  未包含该插件 → `refreshRequired`，绝不伪报 ready。子代理不注册；强行调用 → 明确不可用错误。

## 3. 明确缺口（不得宣称完成）

- standalone CLI 八工具（本机会话库跨 workspace 控制）未移植：Rust 没有独立 CLI 根标记与
  `allowedScopes`/owner fence，注册即绕过授权边界。
- `createSession`/`forkSession`/`sendToSession` 的**首条输入/operation** 仍由 Host 的既有 owner
  落地；Rust 只把意图与 `requestId` 交给 Host，不自行建会话或投递（V4 createSession 的
  `runtimeConfig` 通道也未接偏好授权，仍为 false）。
- 工具级 timeout：Rust 工具层没有通用计时器；`WaitSessions` 的等待由 Host 自身 deadline 与
  本 run 的 stop 收口（与 `CronPauseSelf` 同一约定）。
- `turnId` 不透传（Rust 没有与 TS `traceContext.turnId` 对等的可信字段），Host schema 允许缺席。
- 插件激活的 `needsConfiguration` 只判定非敏感必填项（Rust 尚无插件私有 secret 层）；
  敏感必填项不据此判定。
- 进程内两语言（Node Host + Rust 二进制 + 真实模型）单进程纵向由 R7d 补齐，见 §4 与执行记录；
  Rust Engine 真实 NodeStore/loopback + Host 自构帧测试仍保留作分层回归，不单独等同纵向验收。
- 插件发现两工具（`SearchPlugins`/`SuggestPluginInstall`）本轮未交付：domain 只有草稿，
  `tools` 侧实现不编译且未注册，`tool_schemas` 也没有它们的生成 schema。
- 子代理/带父会话的负向场景由 domain 规则测试覆盖，未做子代理 run 的 E2E。

## 4. R7d Node Host ↔ native app-server 纵向

**所有者与顺序**：Node 测试 Host 独占 NodeStore 临时数据库、Host 请求应答和连接代际；Rust
app-server 子进程通过真实 NDJSON stdio 持有 Engine/session/tool waiter；loopback provider 只决定
有限的模型 tool call，不访问公网。

```text
Node 启动 native binary --surface desktop --stdio（临时 HOME/data/workspace/model config）
  → session/create
  → Rust 反向发 session/requestRuntimePreferences
  → Node 返回 toolSearchMode + appControlEnabled:true（原 request id）
  → Rust materialize granted root；loopback model 依次调用 ListProjects / ReadSession / RenameSession
  → Node ZCodeProtocolClient 收到 serverRequest，绑定活跃连接并交给 createAppControlRequestHandler
  → 真实 AppControlService 查询临时 Repo / 执行受控 rename mutation
  → Node response 使用原 serverRequest id；Rust Engine 回到同一 tool waiter 并结束 turn
```

验收必须断言偏好 capability 字段、反向 RPC method/params、响应 envelope 与 id 完整一致，且
ListProjects/ReadSession 有真实 Repo 读取、RenameSession 的结果可从临时 Repo 回读；仅 Rust Engine
fake frame 和 Node handler 自构帧测试不等于该纵向。至少保留未授权不暴露工具、伪 caller 被拒、旧连接
拒绝、stop 后 late ACK 不改变 unknown 结论等关键负例；根会话可以使用 ReadSession，而 standalone
surface 不暴露该 Host-only 工具。测试不得改写根 CI/knip/锁管理；CI 入口由主代理纳入。

## 5. 验收

- 域测试：十二意图表/根会话判定、`retryOf`→`requestId` 注入与只读意图拒绝、回执形状穷举、
  `unknown` 原样保留；插件搜索分词/排序/游标失效与严格输入。
- Engine E2E（真实 NodeStore + loopback provider + 真实 WorkspaceTools + 真实 Host 帧）：
  授予时注册且 `appControl/<intent>` 参数只有 `{callerSessionId,callId,input}`；未授予/子代理不注册
  且不发请求；Host 拒绝（空回执）失败；`{ok:false}` 失败；取消不写成功；回执 id 不串调用。
- app-server：偏好回包里 `appControlEnabled:true` 只进本次 materialization 的 `runtimeConfig.appControl`，
  `false`/旧 Host 不写。
- 插件：SearchPlugins 从真实临时插件存储投影候选；SuggestPluginInstall 未获批准不执行（权限门），
  已批准路径走既有 install/setEnabled（临时 HOME/存储根，不联网）。
- `cargo fmt --check`、`cargo check --locked`、`cargo test --locked --workspace`、
  `cargo clippy --workspace --all-targets -- -D warnings`、`pnpm check:zcode-cli-rust`。

已执行（R7b）：

- `cargo check --locked`、`cargo test --locked --workspace`（58 个测试二进制全绿）、
  `cargo clippy --locked --workspace --all-targets -- -D warnings`（全绿）、
  `cargo fmt --check`（新改文件全绿；仅剩 R7 遗留 `domain::plugin_discovery*` 两文件的格式差异）。
- `tests/app_control_e2e.rs`：授予注册/身份帧、未授予隐藏、`retryOf` 注入、只读拒绝、
  缺失回执 unknown、Host `unknown` 原样、回执 id 不串调用、stop 取消不落成功。
- `crates/app-server/src/server_rpc_tests.rs`：偏好回包 `appControlEnabled===true` 才写
  `runtimeConfig.appControl`，与 `toolSearch.mode` 同一次 materialization。
- `packages/services/test/appControlRustFrames.test.ts`：Host 侧对 Rust 帧的接受测试
  （只读/写意图/伪身份 -32602/缺身份 -32602/未装配 unavailable/非 appControl 不认领）。

已执行（R7d）：

- `cargo build --locked --manifest-path apps/zcode-cli-rust/Cargo.toml -p zcode-cli-rust`；临时 HOME/XDG 下
  运行 `node --import tsx --test packages/services/test/rustAppControlVertical.test.ts`，Node
  `ZCodeProtocolClient` + 真实 stdio 子进程 + loopback provider + 临时 SQLite Repo / 真实
  `AppControlService` 全链通过。
- 真实 session/create 偏好响应包含 `toolSearchMode` 与 `appControlEnabled:true`；服务端反向请求均由 Node
  复用原 JSON-RPC id 回应，成功 envelope 为 `{ok:true,result}`。真实模型顺序调用
  `appControl/listProjects`、`appControl/readSession`、`appControl/renameSession`，rename 后 Repo 回读为新标题。
- R7d 增加 Host 假 caller 输入 `-32602`、旧连接拒绝；R7b Rust E2E 继续覆盖无能力隐藏/不发请求、stop
  期间取消不写成功、late ACK 不改 unknown。根会话 ReadSession 已通过真实纵向；standalone 默认
  `surface=terminal` 不请求 Host 偏好，`granted(false,...)` 与 `without_the_host_capability...`
  覆盖工具隐藏规则。没有新增 standalone 子进程第二条纵向。
- CI 候选入口（主代理收口，不在本片改 root/package/workflow）：先构建 Rust binary，再执行
  `node --import tsx --test packages/services/test/rustAppControlVertical.test.ts`；需临时 HOME/XDG，
  仅绑定 `127.0.0.1`，不需要凭据或外网。
