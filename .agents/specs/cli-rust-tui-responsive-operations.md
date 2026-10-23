# Rust TUI：慢 ACK 下保持交互与安全收尾

## 范围与已确认原因

基线 main `59ddf0bc`。用户要求修复调查确认的 ACK 等待限制，而非取消 actor 串行或更改 durable ACK 契约。
`Client::call` 在键盘 handler、boot、setter、queue mutation、picker 与 gaprepair 内等待回包，使 transport 的键盘与重绘循环停下。
隔离 PTY + 临时 DB `BEGIN IMMEDIATE` 已证明：慢 admission 期间新文字不显示，Ctrl-D 延迟；解锁后恢复。
外部 SIGTERM 在同样锁等待期间已实测能退出 143 并恢复 termios，不能将其描述为完全失效。

## 所有者与唯一调用路径

```text
keyboard / paste / resize → sole transport event loop → local View draft + operation intent
  → Client sole token allocator + bounded nonblocking dispatch
  → core serial admission → original atomic transaction → durable ACK / snapshot
  → sole Client reply dispatcher → matching operation continuation → View projection

Ctrl-C → bounded stop intent → original guarded stop command → actor committed stop facts
Ctrl-D / /quit → root cancellation intent → existing actor cleanup / EOF / drain → terminal restored
```

- Terminal、EventStream、View 的写入者始终只有一个。禁止嵌套 UI-aware await 泵、后台 clone View 或多个 server reader。
- Core 保持 session、accepted queue、revision/epoch、owner/lease、权限、历史和持久化的唯一 owner；不并发执行 admission。
- Client 独占 token 分配、收包和发送顺序；MCP/usage/history 读票据继续同一 allocator/dispatcher。
- 运行期 RPC 采用非阻塞 operation 票据/续步：boot、会话切换、普通提交、交互回答、setting、queue、picker、snapshot/resync 全覆盖。
  每次事件循环只处理已完成回复和有界本地工作，不 await 新 ACK/快照或通道容量。
- 同时仅一条 UI mutation workflow 在飞；只读 class 各单飞。不得用前端待提交 prompt 队列模拟 actor queue。
- 满通道/满槽给明确可重试的本地结果并保留草稿，或使用有界唯一 outbox 保序；绝不丢请求后假装发送成功。
- 票据绑定 token、session、generation 和具体 UI intent 身份；同 id 重开、TopicClosed、菜单重开、编辑 revision 改变会使旧 UI effect 失效。
  旧 ACK 不允许改新会话或覆盖新编辑；不自动重发不确定已接受的命令。

## 输入与草稿规则

- 等待 ACK 时仍能重绘、resize、滚动、编辑下一份未提交草稿、粘贴和响应全局退出。
- 发出的正文及附件从当前 draft 转移给唯一 pending operation；不能在 View 与 operation 各存一份可写 pending payload。
- 只有 actor accepted 才结算该份已发送 draft；ACK 不能清掉等待期间新输入的正文、附件或历史游标。
- 仍有 mutation 在飞时再次 Enter 必须明确拒绝并保留当前草稿，不重复 admission，不偷偷排本地队列。
  actor 正在运行但没有 UI mutation 等待时，普通输入仍按已有 requestedDelivery:queue 提交。
- 拒绝/传输失败：若没有新的草稿，整份恢复；否则保留新草稿及一份明确可恢复的拒绝草稿。
  恢复需用户显式操作：`/draft` 查看、`/draft swap`（`restore` 别名）交换、`/draft discard` 明确丢弃备用稿；Ctrl-Y 只是交换的便捷键，不依赖普通 TTY 无法区分的 Ctrl-Shift-Y。
  不丢旧稿、不覆盖新稿、不任意拼接文本。
  有未处理拒绝草稿时不得再产生第二份拒绝草稿：阻止新 mutation 并提示恢复/编辑后重新提交。
  禁止 planner 建议的“超过 N 份就丢最旧”策略。
- interaction、queue edit、selector、mention、completion、history 的优先级保持；权限回答不能误用排队编辑正文。
- 编辑中的 queue item 若保存后又修改，迟到成功只能结算所发版本，不清掉更新后的本地编辑。
  fresh snapshot 中仍是同 id、同 logEpoch、queued 且正文等于本次 accepted 的版本时，可用该 committed revision 更新本地编辑基线，
  使续写能再次显式保存；若内容已被其他 owner 改变，不自动覆盖/重试，保留原稿并明确报告冲突。stale/reserved 拒绝保留草稿。
- DraftOps 与 Flow Mutation 共享一条全局 mutation 门禁（双向检查）；完成结果不允许丢最旧，不把未结算 ACK 当可丢弃遥测。
  当前有序连接上的同会话快照只更新事实，不清待 ACK draft overlay、不强制把用户上滚位置拉到底部。
- boot/setting/queue 等在飞状态有可见双语提示；boot 在飞时不悄悄接受随后失效的菜单命令，而是明确拒绝并保留草稿。

## Queue 续写（E2E 目标）

真实 PTY + 临时 DB + loopback 模型的 P1 场景必须证明续写目标不丢：

```text
slow 真实请求占住 actor → 普通输入按 queue 入队 → /queue pause → 弹层 Edit（正文 = actor 旧版）
  → 持有 SQLite BEGIN IMMEDIATE → Enter 显式保存（被锁阻塞）→ 继续输入 CONTINUED
  → 弹层仍显示“旧版 + CONTINUED”（锁未释放，未提交、未发请求）
  → 解锁：actor 提交第一版，快照把本地编辑基线推进到 committed revision 8
  → 二次显式 Enter（用 base 8 保存续写）→ 不得 stale 拒绝
  → actor /queue list 显示续写正文 → /queue resume → 模型真实执行续写正文一次
```

任何一环都不能静默丢目标：锁内续写可见、迟到 ACK 不清续写、基线推进只来自
同 id / 同 logEpoch / queued 且正文等于本次 accepted 的快照、二次保存被接受、真实模型请求与
DB promoted 行都携带续写正文。

验证边界：`input_history` 只记录 admission 时的原始提交，queue edit 不改写该表；
续写正文必须出现在 promoted message 的 text part（恰好一次），并以真实模型请求正文复核。

## 取消与退出

- Ctrl-C 不再等待 stop ACK 才响应 UI；已有会话中合并一份 stop 意图，显示“停止请求待处理”，不伪造 idle/cancelled。
  原 expectedForegroundExecutionId、revision/epoch、stale-run 防护保持；actor 忙于事务时 stop 的真实生效可以等 admission 完成。
- Ctrl-D 与 /quit 在慢 ACK、boot、setting、snapshot、queue 保存期间均可及时发出 root 退出意图并恢复终端。
  退出不承诺撤销已被 actor 接受的输入，不删 accepted queue，不发补偿删除命令；复用 root cancellation/EOF/drain 所有权。
- 外部 SIGINT/TERM/HUP 退出码与收尾语义保持。不能先释放 owner lock 再遗留 runtime/工具进程。
- 不加 timeout、sleep 或多次重试来掩盖请求时序；测试的 deadline 仅用于判定失败。

## 接口与模块边界

可按职责新增 operation ticket/continuation/boot/draft-recovery 模块，各 Rust src（含测试）≤400 行。
保留原公共 Request/run 入口，必要的内部适配不得形成两套真实发送路径；仅测试可使用驱动 helper 推进同一状态机。
不改共享 wire schema、SQL migration、crate 依赖方向或桌面 continuous / 手机 replayable 语义。
新增提示复用现有终端样式、双语与 NO_COLOR。Rust TUI 在 feature graph 暂无 seed，仍记录 graph-drift-candidate。

## 测试与验收

先补红测，再实现；旧业务断言不得因 async 接口改动删除。

- fake actor 暂不回复 submit/setting/boot/queue/snapshot：按键编辑、Paste、resize、重绘仍可进行；重复 Enter 不重复发送。
- accepted/拒绝回包前有新正文/附件：新草稿不被清，拒绝草稿可显式恢复，无静默丢弃。
- 同 id 新 generation、TopicClosed、selector epoch、queue edit 新 revision 拦住迟到效果。
- 通道满与旧读票据交错：唯一 token、保序、有界、无 busy-loop 风暴或永久占槽。
- 慢 ACK 下 Ctrl-C 显示意图；Ctrl-D、/quit、boot 取消、外部 SIGTERM 及时恢复 termios；停止不删 accepted queue。
- 真实 Linux PTY：临时 HOME/XDG/DB/workspace + loopback 模型，持有 SQLite 写锁验证文字在解锁前已可见，
  Ctrl-D 和 /quit 解锁前结束交互并恢复 terminal，外部 SIGTERM 仍为 143。只访问本次临时 DB。
- Queue 续写 E2E：锁内弹层可见续写正文、解锁后基线推进到 committed revision（fixture 为 8）、
  二次显式保存被接受、actor 队列列表与真实模型请求都携带续写正文且只执行一次；
  `input_history` 保留 admission 原始提交，promoted message 的 text part 为续写正文。
- 旧 35 项 workbench 及原 20 请求 PTY 两种配置、Node/Rust interop 继续通过。
- Rust locked workspace tests/fmt/clippy -D warnings/16-crate boundaries、Node drivers/CI、root typecheck、raw lint、三 gate、architecture、contract assets 检查。

不读真实用户配置/会话/日志，不触碰 logs/，不替换本机 .395、不打包安装或发布。精确 PR HEAD CI 通过后才 guarded rebase merge。
