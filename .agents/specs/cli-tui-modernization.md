# 原生 Rust TUI 现代化与 TS /quit

## 用户要求与参照

用户要求 Rust CLI 以当前 TS TUI 为参照现代化，并为 TS TUI 增加 `/quit`。本轮改造实际终端界面与交互，不把 Node/TS 前端包装成 Rust 原生 TUI，也不声称凭一个视觉更新就完整实现 TS 的所有扩展能力。参考当前 `apps/zcode-cli/packages/tui/src/` 的 sidebar、theme、Logo、Markdown、工具、选择与审批面板；保留上轮 provider discovery 和已开 PR 的改动，不覆盖 `logs/`。

欢迎页标识居中、扫光效果以及输入框标题/占位提示的对外契约单独记录在 `.agents/specs/cli-rust-welcome-brand-parity.md`；侧栏分区对齐记录在 `.agents/specs/cli-rust-sidebar-parity.md`。两个 spec 同样只调整展示层，不引入新的业务状态。

## 产品规则与界面

### Rust 原生 TUI

- 继续使用 ratatui/crossterm 和既有 core-api transport。宽终端采用对话 + 常驻侧栏、底部 composer/状态栏；窄终端优先输入与正文、侧栏可隐藏/切换，不挤占或越界。遵循 `NO_COLOR` 环境设置；采用 TS 的冷静紧凑暗色/信息层级，按真实宽度显示 ZCODIUM Mark 与 Rust 身份。
- 消息按用户/assistant/思考/工具区分层级；Markdown 标题、强调、列表、代码围栏及链接有可读的终端样式，代码与工具输出保持空白与换行。工具名称、运行/完成/失败、参数/输出/错误不能混成无层级 JSON 日志；可用 diff 内容有增删区分。未经信任的模型/工具文本不能注入终端 ANSI/OSC 控制。
- 模式展示从 actor 的 `config.mode + config.planEnabled` 派生；plan 不是新的权限模式状态，不直接修改投影。旧 setter 的 HostNotification 不供终端消费时，菜单与带参命令共用 setter 后回拉 actor snapshot 的路径。
- 侧栏只消费当前投影真实存在的 model、mode、session、workspace、运行状态与可用工具/用量等字段；缺失信息明确缺失，不伪造 Git 分支、MCP 连接状态、token 用量或任务事实。中英文同步。
- `/model`、`/mode`、`/sessions` 提供键盘选择面板（上下、Enter、Escape，明确提示）；保留原带参数命令。选择面板是本地草稿，确认后才调用原 SessionSetModel/SessionSetMode/Resume；默认推理档位沿用原 registry，不选任意模型掩盖失败。
- 权限/问答有独立可读面板，完整保留明确 allow/deny/选项/多问题文本应答能力，不因空 Enter、刷新或未提供答案自动批准。取消继续通过原 stop admission。
- 编辑器支持多行/粘贴、Unicode 光标与窄屏位置，PageUp/PageDown 滚动。窗口 resize、选择面板 Escape、busy 拒绝应保留原草稿，不把未接受输入变成第二条 accepted queue。
- 所有显示投影/菜单/文本缓存有明确行数/字节上限，沿用原 MAX_ROWS / MAX_FIELD_BYTES / MAX_RENDER_BYTES；不能让新 renderer 绕开预算或每个编辑按键无条件重新解析全历史。极窄/极矮终端不能 panic；样式不改变持久化内容。
- 不修改原 `/quit`、Ctrl-C/D、SIGTERM/SIGHUP/SIGINT 的 runtime 收尾与终端恢复边界；不以关闭 runtime 假装取消、不引入超时兜底掩盖同步问题。

### TS TUI /quit

- `/quit` 是本地 TUI 生命周期命令，需出现在 TUI 帮助/补全中；提交后通过现有 onExit / close 清理路径正常退出，不作为用户消息发给模型，不调用 runtime admission 或保存到业务历史。
- 原始 composer 的附件参与正文判定；审批/问答中的独立退出手势不携带主草稿附件，不应被未提交附件阻塞。所有确认路径共用 TuiApp 唯一 requestExit 端口。
- idle、busy streaming、等待权限/问答、无模型/尚未初始化 app 时均可退出。busy 退出复用现有 abort/cleanup，不新造 stop 通道、不直接 process.exit 跳过 drain。
- 真实 PTY 的同批输入/提交中，清空草稿须同步更新现有 textarea port 和 draft ref；不能让延迟 content-change 把旧 prompt 回写，导致后续 `/quit` 被拼接并进入 busy queue。复用 InputPane 的幂等同步 helper，不用延时兜底、不改已接受队列。
- 匹配完整命令（允许首尾空白与既有命令大小写约定），`/quitfoo`、`/quit args` 或普通正文中的 `/quit` 不应误退出；有附件或粘贴长文本也不能被宽松前缀匹配吞掉。
- 审批期间的退出手势不能吞掉自定义问答中的路径（如 `/tmp/path`）或普通正文；Other 输入通过完整命令提交判定。审批瞬时队列由 TuiApp 的同步 ref setter 唯一维护，React state 仅作展示；键盘事件从同一 owner 取最新审批，避免一批按键一直读取旧 render 的 questionState。问答局部不可变更新、完成/拒绝与 abort 清理须按稳定的审批 resolve 句柄关联，而非会被每次 clone 替换的对象引用，覆盖同批快速键入 `/quit` 与取消。
- 支持键盘提交与菜单选择的同一入口，幂等一次退出；不新增 headless/app-server 退出协议，不让模型输出触发关闭。原 Ctrl-C 双击保护保留。

## 单一所有者与事件顺序

```text
Rust terminal input → local editor / selector draft
  → confirm → existing ClientMsg/Method → Engine actor/admission (single owner)
  → snapshot/deltas/persisted rows → bounded View → themed render/sidebars

permission/question → explicit answer → existing resolveInteraction → committed state patch
quit/signal → existing root Eof/cancel → concurrent actor drain → terminal restore → exit

TS /quit → TUI submit/lifecycle owner (before submitPrompt/sendInput/interaction answer)
  → abort active frontend task → existing onExit → renderer teardown
  → runTuiCommand finally / promptHandler.close → runtime cleanup → exit
```

No new business owner, persistence schema, workspace identity, owner/lease, stale-run, desktop-continuous or web-remote-replayable behavior changes. Theme/selector/scroll/editor are local UI state only. Package imports remain public; Rust new files follow 400-line crate/source boundaries.

## 验收（实现前）

1. 先补 Rust buffer/render 单测：宽/窄/极小布局，品牌/状态、角色样式、Markdown/代码/工具/错误、Unicode 包裹与光标、显示预算/控制字符；选择确认/取消及既有命令关联测试。
2. 扩展真实 Rust PTY：新 welcome/sidebar、选择面板与 Escape/确认、resize、多轮/Read/Write allow/deny/AskUserQuestion、取消、continue/history、正常退出与信号/termios。全部使用临时 HOME 与本地模型。
3. TS 真 TuiApp renderer 通过键盘输入 `/quit`，验证 idle/busy/审批中退出、abort/close、没有模型调用/用户 row/队列/敏感回显；纯命令边界与补全回归。再以构建后的真实 CLI + PTY 验证正常退出与终端恢复。
4. Rust locked tests/fmt/Clippy/boundaries、Node 脚本测试、根 pnpm typecheck/lint、CLI 相关包 typecheck、architecture 与格式检查（不读写 logs）。当前 Linux 运行与其他平台 CI/人工证据分开报告。
5. 不读取真实用户配置/凭据/会话，不安装软件、不上传本地安装包、不打 tag/release。不自动将未验收的新 UI 推送/并入现有 PR。用户后续明确授权：独立检查新 HEAD 的 CI，确认无阻断后合并。

## 实施与本地验收

- 原生 Rust 展示拆为 presentation/cache、Markdown/工具、侧栏/面板、cell 包裹模块；run-scoped cache 由 transport 唯一持有，display_revision 覆盖同 seq reset，字节和物理显示行受限，编辑/idle 不重新解析全历史。
- 模型选择保留带冒号的完整 typed ref；模式/模型 setter 共用写入后 actor snapshot 回拉，plan 从 mode + planEnabled 派生。恢复当前 session 不释放同名新 topic。上述边界均未修改 core/协议/存储。
- Rust buffer 测试覆盖宽/窄/极小、overlay、Unicode/光标、NO_COLOR、角色/Markdown/代码/工具/diff、ANSI/OSC、同 seq reset、最新历史及显示预算。真实 PTY 覆盖欢迎/侧栏/快捷键/resize、模型/模式/会话选择与 Escape、14 次本地模型请求、多轮/Read/Write allow-deny/问答/取消/continue/history、信号及 termios。
- TS `/quit` 的键盘、补全确认、审批手势统一到 TuiApp 幂等 requestExit；在 admission 前判定原文/补全与附件/多行边界。等待审批的独立退出手势不携带主草稿附件。原始主草稿附件、Other 路径和普通正文不被吞。
- 真实 CLI 同批输入发现 textarea 延迟回写会复活已提交 prompt，导致后续 `/quit` 被拼接后排队；复用同步 editor port 清空后，构建 CLI 的 idle/真实 streaming /quit 均 exit 0、恢复终端。该 PTY 场景进入 Linux interop CI，不依赖截图或全局用户配置。
- 独立审查发现审批对象 clone 后按对象引用清理/读旧 state 的阻断；以稳定 resolve 句柄与同步 UI owner 修正。同批文本+连续 Enter 完成、连续 Escape 拒绝回归先红后绿；审批/问答/Other/附件/取消与退出均有 renderer 键盘测试。
- 本地全库：Rust 510 项、Node CI 脚本 359 项通过；typecheck、Lint（0 errors、50 条既有 warnings）、Clippy/fmt、16-crate 边界、architecture、actionlint 通过；格式检查排除既有 logs。新 HEAD 仍必须经远端 CI，不以旧 PR 绿灯代替。
- 本轮是原生基础体验对齐：未宣称完整 TS 插件、MCP 管理、文件导航、图形/富 HTML 或完整语法高亮/主题能力对等；未重打/安装或公开新的安装包。
