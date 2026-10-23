# Rust TUI：输入历史、@file、MCP/usage 与队列

## 范围与授权

基线 `2f9e97af`（PR #86）。用户明确要求继续补齐输入历史、`@file` 附件、真实 MCP/usage 与队列操作。
本 spec 是第二批对齐的行为依据，覆盖原生 ratatui TUI 和必要的 Rust store/core 内部端口；不包装 TS TUI。
旧 `.agents/specs/cli-rust-tui-parity.md` 记录首批结果，本批不重复欢迎页/品牌/compact/effort。

TS 参照：`app-input-history.ts`、`app-file-mentions.ts`、CLI `tui-workspace-paths.ts`、`app-mcp-status.ts`、
`app-sidebar-mcp.tsx`、`app-input-status.tsx`、`app-queued-inputs.tsx`；队列 CAS 语义参照共享 v4 schema 和当前 Rust actor。
不把 TS 旧 TUI 的本地 optimistic queue 复制成新的业务队列。

## 所有者和顺序

```text
keyboard/paste → TUI editor / attachment draft / history cursor / queue edit draft
  → canonical Command → Core serial admission → NodeStore transaction (input + ACK + history)
  → committed snapshot/deltas → bounded View → queue/context/terminal rendering

↑ recall → internal Method::InputHistoryRecall (not a wire method)
  → SessionStore read barrier → readonly input_history query → draft+attachments (unsubmitted)

@token → bounded async workspace path query → latest-token suggestions
  → select directory (continue) / select file (draft AttachmentRef)
  → accepted sendText → core prepares actual bytes/artifact → model request

MCP/usage/history reads → existing Client token allocator → at most one ticket per read class
  → FIFO reply dispatch (also inside blocking call) → session+generation check
  → main loop applies matching read result; keyboard/stop/quit never awaits remote read completion
```

- Core actor 独占 session、admission、accepted queue、revision、权限、持久化和 usage；MCP Hub 独占连接状态。
- TUI 仅拥有未提交草稿、历史游标、filter、菜单选择、读请求票据与可丢弃投影；没有第二份 accepted queue。
- workspace key 使用 `workspaceIdentity?.trim() || workspacePath`。本地 root 构造的 Engine.workspace 已承载该 key；
  历史不能将远端 identity 解析成路径后再隔离，不能按路径/80 字符 slug 合并不同 identity。
- 公共 stdio 协议不增加历史方法；内部 `Method::InputHistoryRecall` 与 TopicSnapshot 一样不可由 Method::parse 解析。
- workspace owner/lease、跨 Host 路由、stale run、topic/replay/delivery 不变。退出仍由 root EOF/drain/termios 收尾。
- 不读真实配置、凭据、用户会话或 logs；所有 IO 验收使用临时目录和 loopback fixture。

## 1. 持久化输入历史

### 唯一写路径

复用 `state::node::input_history::{record,recall}`、既有表/附件归一化/去重/全表 100 条上限；不改历史 SQL/checksum。
新增 journal Op，让历史和 accepted input/ACK 在同一 NodeStore 事务提交，不在 TUI 额外写 DB。

- 只记录真正被接受的根会话普通 `sendText`（含 busy queue），以及 createSession firstInput；
  空输入、未知 slash、compact、审批/问答答案、重试/编辑旧轮、子代理输入和队列提升不再次记录。
- 命令重放由原 commandId/持久 ACK 幂等阻断；事务失败不留下“仅有历史”的半笔写入。
- idle 记录 kind `prompt`，busy 记录 `steered_input`。历史正文使用用户原文（trim 规则沿仓储）；
  附件使用 prepare_attachments 前的原始来源投影成 `{type,path?,content?}`，不把 AttachmentRef 对象直接塞入历史。
- 历史 scope 使用 root 已选定的完整 workspace key（显式 identity 在 root trim；路径 fallback 原样保留）存入既有 `project_id` 文本列；
  store 不再次 trim 整个 key，否则 `/repo` 与合法的 `/repo ` 本地路径会串历史。
  此列没有 project FK。读写共用一个 scope 函数，杜绝远端同路径或 slug 截断碰撞。
  不迁移或删除旧 TS `proj_*` 历史，不把无法证明 identity 的旧行自动混入新 scope。
- 非 Node/journaling store 需明确报告历史不可用，不假装成功持久化。

### 读端口与交互

SessionStore 新增 `recall_input_history(workspace, skip)`，NodeStore 走现有 barrier + readonly connection；
通过内部 Method 只读取该 Engine.workspace 的历史。默认 unsupported 错误，不提供静默空实现。

- ↑ 在无 selector/补全/mention/交互/队列编辑时召回；首次保存当前草稿与附件，取 skip=0。
  多行编辑器内非首/末行保留光标移动语义；PageUp/PageDown 仍滚正文。
- 再 ↑ 读取更早项；↓ 向新项移动，到最新之后恢复首次草稿和附件。无更多项不丢草稿、不推进游标。
- 一次只允许一个 history read；期间编辑、切 session 或进入其他交互会使迟到结果失效，不能覆盖新草稿。
- 启动 pinned 附件在历史浏览/编辑历史草稿时继续保留到第一次真正接受的输入；不得因 ↑ 后编辑而无声丢失。
- 某条历史含不可恢复的 artifact/content 时，当前草稿保留且明确提示；再次 ↑ 可跳到更早项，不能永远卡在该 skip。↓ 也可跳过不可恢复的新项回原草稿。
- 恢复附件重新成为未提交 draft，不能自动提交或自动批准。文件缺失由实际提交解析清晰失败；
  无法安全恢复的 artifact/content 不静默丢弃，应报错并保留原草稿。

## 2. @file 与附件草稿

- token 规则按 TS：cursor 前最后一个 `@`，之前为行首/空白，token 内无空白；编辑器提供 UTF-8 安全的 cursor offset/range replace。
- 原生 `tokio::fs` 目录建议：最多 50 结果、8 可见；目录优先、前缀优先、确定性路径排序；隐藏 VCS/node_modules，
  query 不以 `.` 开头时隐藏点文件；拒绝绝对/盘符/`..`，canonical 边界阻止 symlink 穿出 workspace。
  后台流式扫描目录时只保留排序后的最多 50 个最佳匹配，不能随意截断扫描前 4096 项而漏掉后面的精确文件；
  文件内容不在 TUI 预读。
- 文件 IO 在独立可丢弃任务完成，结果以 query/cursor/session generation 关联；旧结果不覆盖新 token，不阻塞键盘。
  每个 mention controller 至多一个在飞任务，取消/失效不靠超时同步。
- Tab/Enter 选目录只写 `@dir/`，选文件写 `@path ` 并添加去重的 draft attachment；选文件这次 Enter 不发送 prompt。
- `DraftAttachments` 是草稿附件唯一 owner；inline placeholder 被删掉则对应附件不发送。
  启动 `--attach` 是第一份草稿的附件（无 placeholder 的 pinned 项），成功接受后清理，不能每轮重复发送。
- 运行时 payload 仍为严格 `AttachmentRef{ref,fileName,mime,bytes,previewRef?}`；本地来源可以用真实相对/绝对路径 ref，
  core 会重新读取、核实并覆写字节/MIME。上传 artifact 绝不编造 bytes 或跨 session 复用不属于新会话的凭证。
- 接受后清理草稿附件；本地或 actor 拒绝保留正文、附件、游标，不因失败丢文件。历史往返保存同一附件草稿。
- busy 时可组合队列草稿附件（纯前端编辑），提交仍由 actor 解析和 FIFO 接收；权限/问答期间禁止 mention 抢走回答键。

## 3. MCP / usage

### 请求票据

只扩现有 Client token allocator，不起第二个 Client，不另建请求通道。

- read class：MCP status、session usage、input history；同一 class 最多一笔在飞或未消费完成结果。
- `Client::call` 和 `observe` 都分流 background reply，不能吞进永久 replies map；正常 reply/event 顺序不改。
- 每张票据绑定 sessionId + View.generation（切 session、TopicClosed 时推进）；切回来同 id 也不能接收旧票据。
  完成结果在主循环应用前再次验证，历史还需验证草稿 revision。未知/已过期 token 不无限累积。
- MCP 首次打开、轮次结束、侧栏重开、显式 `/mcp` 触发只读 `mcp/list {workspace, mode:"status"}`；
  不为显示状态调用 connect/强制重连/启动 server，不在 50ms redraw 中反复发查询。
- `/usage` 请求原有 `session/usage` 或 `v4/conversation/usage`，非阻塞地展示真实累计数与错误。
- 查询失败可恢复、有可见提示；MCP 刷新失败保留上次值并标错误，不变永绿。空结果是无状态而非“全部已连接”。

### 展示

侧栏补 MCP 分区：connected/disabled/failed、工具数/transport、failureKind/error、加载/空/失败，最多 5 行服务器。
模型上下文 badge 仅用 `state.usage.contextWindow.{usedTokens,maxTokens}`；有 used 才展示，有正 window 才计算比例；
不得用 cumulative token 代替 context。缺失数据显式未知，不造百分比。
窄屏/双语/NO_COLOR/ANSI 清理/显示字节预算保持；不因查询到来重解析全部历史。

- `/usage` 的“累计”来自 `queryTaskUsage` 对 source baseline 的增量，不是把每轮 billed input 机械相加；
  同一稳定上下文后续轮只增加输出。context badge 独立读 `contextWindow`，不能用累计 token 代替。

## 4. 队列与 busy admission

本批明确替代旧“busy 一律拒绝普通正文”的规则：普通 busy 输入使用原 sendText admission，显式请求 FIFO queue。
成功 ACK 才清草稿；accepted queue 只从 actor snapshot/deltas 显示，不能先插本地 user row 或另起 Agent。
未知 slash 仍本地报错；权限/问答优先，退出/取消不被菜单或草稿编辑吞掉。

### UI 与命令

- composer 上方展示 actor queue（最多 3 行 + 更多数量）、autoDrain/paused 状态。
- `/queue` 打开 typed queue 项目选择器，再选择操作；同时支持 `/queue list|pause|resume`、
  `/queue delete <id>`、`/queue send <id>`、`/queue up <id>`、`/queue down <id>`、`/queue edit <id>`。
- edit 使用独立本地 QueueEdit.editor，不复制 accepted queue；保存原 session、queueItemId、revision、logEpoch。
  Enter 发 editQueueItem，Esc 仅取消本地编辑；失败保留编辑草稿。TopicClosed/旧 generation 后保留失效编辑缓冲并消费触发键，
  显示不能提交的原因，直到用户 Esc 取消；不得落到主 editor 意外发送。编辑弹层在权限/问答到来时暂停，
  原 main editor 仍专门用于回答，不能把排队编辑文本误当答案。
- delete/edit/reorder/sendNow/setAutoDrain 使用既有 Command payload 和捕获的 baseRevision/baseLogEpoch；
  stale/reserved/已消费/不允许编辑 compact 必须显示原拒绝，不重试覆盖、不按菜单下标猜最新 id。
- mutations 成功后回拉 snapshot；noop 仅表示 actor 明确未变化，不伪造新的队列事实。
- pause/resume 显式调用 setAutoDrain；held queue 的新 prompt 不擅自 clearQueueAndSend，需先显式恢复/选择队列动作。
  paused 队列条显示 `/queue resume to continue`，新普通输入被拒绝时保留草稿并提示该命令。
  sendNow 是用户明确提升一项，不等于运行整条暂停队列。
- stop 携带当前已知 activeWorks.foregroundExecutionId，保留原 stale-run 防护；不通过启动新进程实现取消或提升。

## 并行模块与接口约定

- 历史 backend worker 只改 core-api/domain/state/core：新增内部 Method、SessionStore 读端口、事务 journal 与 admission记录；
  不扩共享 wire schema、不改 TUI。可将 SessionStore trait 按职责移到 contract_store 模块再公开 re-export，以守 400 行。
- `Client::start_query(&mut self, view:&View, kind:QueryKind, method:Method, params:Value)->Result<bool>`：只发送不等回复；
  `QueryKind::{McpStatus,Usage,History{skip:u32}}`；同 class 在飞或完成未消费时 false。
  `Client::take_read_replies()->Vec<ReadReply>`，ReadReply 包含 kind/session/generation/result。
  请求票据和完成队列都由 Client 独占；main loop 验证归属后交 telemetry/history controller 应用。
- `View.generation:u64`、`View.telemetry:telemetry::Telemetry` 由 telemetry worker 添加；只改 projection 对应字段/重置锚点。
  `telemetry::pump(client,view,request)` 处理 dirty MCP；`request_usage`/`request_mcp` 为 slash 入口；
  `telemetry::apply_reply(view,reply)` 只处理本模块 read kinds，history 由前端集成模块分流。
- `View.draft_attachments:draft_attachments::DraftAttachments` 与 `View.file_mentions:file_mentions::FileMentions`
  由附件 worker 添加；只编辑 projection 中 completion 相邻字段，其他 fields/reset 留给集成 worker。
  `DraftAttachments::{from_startup,refs_for_text,retain_for_text,clear,from_history}`，保存/恢复可 Clone，
  `from_startup(Vec<Value>)->Result<Self>` 明确拒绝非法/超量项，不能静默跳过；
  `from_history(attachments:&Value,directory:&str,text:&str)->Result<Self>` 支持本地 file/image/pdf，
  用历史正文判断 inline 占位或 pinned（启动附件可能没有 @token）；不能安全恢复的 artifact/content 明确报错。
  refs_for_text 输出 Vec<Value> 严格 AttachmentRef；历史不能安全恢复则 Result::Err 而非丢项。
  `FileMentions::{sync,poll,visible,move_by,dismiss,accept}`：sync/poll 不等待在飞 IO；
  accept 修改 editor + draft_attachments，返回是否消费该 Enter/Tab；`draw(frame,bounds,&state,zh)`。
- queue worker 添加 `View.queue_edit:Option<queue::QueueEdit>`（只在 selector 相邻字段）；
  `queue::{open,dispatch,confirm,handle_key,render_lines,draw_edit}`；Choice 新增 Queue(QueueChoice)，
  由既有 picker::confirm 委派，typed choices 带 id 和 revision/epoch；不改 transport/session/projection 的其他逻辑。
- 最后由 frontend 集成 worker 独占 transport/session/presentation 路径：输入优先级为全局退出/取消 > 权限/问答 >
  queue edit > selector > file mention > slash completion > history > 普通 editor/scroll；
  poll 文件结果与 drain read replies 只做已完成结果的有界处理，不阻塞等待。
- 每个 Rust src ≤400 行；crate 依赖方向不变，新增模块用公开入口；无同步文件/网络 IO。

## 验收矩阵（测试先行）

| 范围                | 必须证明                                                                                                                                              |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| history transaction | 接受/重放/失败回滚/queue提升只记录一次；正文+本地附件去重；100 cap；重启可读；两远端同路径不同 identity 不串                                          |
| history UI          | ↑/↓ 跨会话召回 + 原草稿/附件恢复；空/越界/不可用不丢草稿；编辑后迟到 reply 不覆盖；不是只读渲染窗口                                                   |
| @file               | 目录继续/文件附件真实到模型；中文/Unicode cursor；50/8 bounds；点文件/VCS/绝对/.. 与 symlink escape；删占位不发；拒绝保留；--attach只首份草稿         |
| query               | delayed MCP/usage 不阻止 stop/quit；same-id新generation旧reply丢弃；回包穿插同步call仍正确；无请求风暴/无限replies；状态/错误/无数据真实              |
| queue               | busy输入被接受并串行；display只来自actor；edit/delete/reorder/sendNow/pause/resume真实效果；stale/reserved不误写；edit遇审批不误答；停止保留队列      |
| E2E                 | 隔离HOME/DB/临时workspace+loopback模型与MCP；重启history、真实附件内容、慢run排队和操作、usage/MCP；旧compact/effort/问答/权限/continue/termios全保留 |

必须执行 Rust locked workspace tests、fmt、clippy -D warnings、16-crate boundaries、Node driver/CI scripts、
根 typecheck、原始 lint（存量如实报告）、三 gate、architecture、格式与协议/contract资产 check。
不读取真实用户数据，不替换本机 `.395`，不打 tag/Release、不上传本地安装包。精确 PR HEAD CI 通过再合并。

## 继承的生命周期边界

本批非阻塞保证只覆盖 MCP/usage/history 三类只读票据：`Frontend::poll` 从完成队列 drain 这三类结果时
不 await 读回包。继承的 gaprepair 仍使用串行 `Client::refresh(TopicSnapshot).await`；bootstrap
（`session::open` 的 `TopicOpen`）与会话 setter 路径也仍用串行 `call` 后再 `View::snapshot`。
这些 owner 调用期间主循环无法处理按键/退出，因此不能宣称键盘在这些调用卡死时仍可退出。
既有变更命令仍串行等待 durable ACK，并未改成可抢占/可撤回的 admission。若 actor 的命令 ACK 本身永久不返回，
既有提交调用仍可能阻塞按键处理；这是既有前端生命周期限制，不能用超时丢弃已接收输入来“修复”。
本批不宣称解决所有命令等待场景，另需独立生命周期切片。

## 状态

实现与最终源码本地复验已完成，远端精确 PR HEAD CI 待验；本批新增只覆盖输入历史、`@file`/草稿附件、真实 MCP/usage
与队列/busy admission，不涉及插件/workflow/语法高亮/图片剪贴板等其他完整 TS TUI 能力。
原有 feature graph 暂无 Rust TUI seed，仍作为 graph-drift-candidate，不把 TS bootstrap 节点当 Rust 状态 owner。
最终证据按实际命令回填，旧截图/旧 deb 不证明新功能。

- 最终源码本地复验：Rust locked workspace 714 passed / 1 ignored / 0 failed，其中 TUI 222 passed；
  Node drivers 59 passed、CI scripts 429 passed。16-crate boundaries、所有 src ≤400 行、fmt、clippy `-D warnings` 通过。
- 根 typecheck、协议/contract/domain fixture assets `--check`、architecture 与三 gate 通过；
  原始 lint 仍为既有 86 errors / 145 warnings，未清零、未放宽基线。
- TUI 新 dev-dependency `tempfile` 改变 Cargo.lock 摘要；已用现有生成器重验 279-crate 许可闭包并更新 provenance 和根声明，
  没有新增 Rust crate 版本。根声明同时同步当前 pnpm 锁图中已有的四项依赖材料，不改依赖版本。
- Linux 真实 PTY workbench 35 checks 全绿：attachments 9、queue 13、usage 10、shutdown 3；
  既有 20-request baseline 与 provider-discovery 两种模式实际通过。
- 待完成：精确 PR HEAD 的远端 CI 与通过后的 guarded rebase merge。
  本文不宣称 PR 已合并或 CI 已通过；本地 loopback/PTY 也不等于 Windows/macOS 人工 runtime 或安装包验收。
- 旧 `.agents/specs/cli-rust-tui-parity.md` 的首批 95/580 计数保持历史证据，不作为本批全量复验结果。
