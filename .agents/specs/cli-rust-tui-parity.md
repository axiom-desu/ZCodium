# Rust 原生 TUI 与 TS TUI 增量对齐

## 授权与范围

用户授权继续 `/compact`，并以当前 TS TUI 对齐 Rust TUI；Rust 缺少的模块可以原生补写。
保持 ratatui/crossterm + core-api frontend，不包装 TS/Node UI，不把界面完成当成 runtime 全量重写完成。
基线 `f1eb1969`，欢迎页与侧栏已有实现，不重复改造。TS 行为以当前源码为准，不以上游历史报告为准。

本 spec 管理分批交付与事实边界；每批先测试再实现，完成后记录实际验收。旧交接中的计数是历史证据。

## 当前差异与交付批次

本节记录首批（基线 `f1eb1969`）的差异与决策。输入历史、`@file`、真实 MCP/usage 与 busy queue
已在后续 workbench 批落地，命令交互和验收见 [workbench spec](cli-rust-tui-workbench.md)；
本 spec 的首批计数不随那次实现改写。

| 能力                             | TS 依据                                                | Rust 基线                                                  | 首批决策与后续状态                                                                 |
| -------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `/compact` / `/compress`         | `app-compact-timeline.ts`、`app-submit.ts`             | core 已支持 compact，TUI 白名单拦截                        | 接通本地精确命令与别名，保留附加指令；只走原 actor admission                       |
| 压缩时间线                       | `app-compact-timeline.ts`                              | actor 已发 timelineMarker，renderer 未展示                 | 显示真实 manual/auto、running/success/noop/failed 与已有 token 字段                |
| `/effort` / `/variant`           | `app-effort-command.ts`、CLI command-center            | snapshot 有 thought/thoughtLevels，已有 setter，TUI 无入口 | 列表、详情、按值设置；复用 setter + snapshot 刷新，不手改 config                   |
| slash 帮助/补全                  | `app-input.ts`、`app-keyboard-suggestions.ts`          | 一行 help，无补全                                          | 建 Rust 前端单一命令目录，help/别名/补全共用；只广告已实现命令                     |
| 模型/模式/会话选择过滤           | `app-selection-keyboard.ts`、`app-selection-panel.tsx` | 只有上下选中，打印键被忽略                                 | 有界本地 filter、Backspace、Ctrl-U、Paste、空结果；确认仍走原 owner/typed choice   |
| composer 模型状态                | `app-input-status.tsx`                                 | 底栏 session/mode/model，缺 provider/thought               | 输入框下显示 model / provider / thought，按显示宽度裁剪；不造 usage                |
| 输入历史                         | `app-input-history.ts`                                 | state 库有 history，actor 无读写接口                       | 首批未做；workbench 批已接入真实持久化 owner，不能把渲染窗口伪称 workspace history |
| `@file` 与附件草稿               | `app-file-mentions.ts`                                 | 仅启动附件，缺路径建议与草稿附件模块                       | 首批未做；workbench 批已实现原生路径建议与草稿附件生命周期                         |
| MCP / context usage              | `app-mcp-status.ts`、`app-input-status.tsx`            | 有 query Method，终端无对应查询投影                        | 首批未做；workbench 批已接真实只读查询并区分失败/刷新/会话归属                     |
| busy queue 交互                  | `app-queued-inputs.tsx`                                | actor 已有队列，TUI busy 拒绝草稿提交                      | 首批保留旧 busy 语义；workbench 批已接入 actor 队列展示/操作与 busy admission      |
| 主题、插件、workflow、子代理详情 | 当前 TS 对应组件                                       | 部分运行时/终端模块尚缺                                    | 按真实 API 逐项补模块，不在本批宣称已对等                                          |

`auto` 不在两套 TUI 的可切换菜单内（TS `app-mode.ts` 也是 plan/build/edit/yolo），不当作漏项加入。
未知 slash 不回落普通 prompt；拼错命令不能偷偷发给模型。大子系统不以空实现/假成功补齐。

## 单一所有者与事件顺序

```text
keyboard / paste → editor draft / completion / selector filter (TUI-only, bounded)
   ├─ completion confirm → canonical local command → existing slash dispatcher
   ├─ compact → Method::Command {type: sendText, payload: {text: "/compact [instructions]"}}
   │              → existing Core sendText→compact normalization → admission
   │              → durable marker/state patch → View → render
   └─ effort → SessionSetThoughtLevel → actor validation/commit → TopicSnapshot → View

selector confirm → original typed Choice + session owner guard → setter/resume
selector cancel → original draft (not filter) → editor
```

- Core actor 独占 session、accepted queue、权限、模型/推理设置、compact 和持久化事实。
- TUI 只拥有未提交文本、命令选择下标、filter 和可丢弃展示投影；不建第二条 accepted queue。
- 设置成功后沿用 `session::set_setting` 的 actor 快照刷新；错误保留原状态、草稿与可见诊断。
- owner/session、revision/seq、stale turn、topic/reconnect、desktop-continuous 与 web-replayable 不变。
- 权限/问答优先于普通命令分流（退出例外）；例如问答里的 `/compact` 是回答，不触发压缩。
- `/quit`、Ctrl-C/D、外部信号与 root EOF/drain/termios 恢复路径不变；不添加超时兜底。

## 本批接口与产品规则

### 原生命令目录与执行

新增 `crates/tui/src/commands.rs`：Rust TUI 已实现命令的静态目录，每项有 canonical name、aliases、usage、
中英文 summary。原有 `/help /new /sessions /resume /mode /model /quit` 保留，补 `/compact`（别名 compress）、
`/effort`（别名 variant）；已有 exit 别名保留。帮助 `/help [name]` 和补全只从此表派生。
业务执行仍只有 `session::slash` 与现有 setter/Command 接口，不将 core 的全部 slash 能力虚报为 TUI 可用。

- `/compact [instructions]`、`/compress [instructions]` 按完整首 token 识别，保留后续文本内部空白/换行，
  仅去掉首尾空白。不把 `/compactfoo` 当控制命令。不附加启动时的文件附件或 tool overrides。
  使用现有 sendText→compact 归一化链路，不走普通 user turn，不插本地 user row。
- ACK 被拒绝时不假装已压缩、不插 fake marker；错误回到既有 draft-preserving 路径。
- `/effort`、`/effort list`、`/variant` 展示 actor 的当前档位和可用档位，不提供任意默认档位。
- `/effort <level>` 与 `/variant <level>` 按可用列表大小写不敏感精确匹配 canonical 值，再发送原 setter。
  不支持/无档位时给出明确错误；值由 actor 最终验证；本批 busy 时仍按原规则拒绝这些提交。

### slash 补全

新增纯前端 `completion.rs`，候选来自 commands 目录：以 `/` 开头且无空白时按 name/alias 子串过滤。
列表有界（最多 8 可见项），上下移动；Tab 把选中项写回 editor 但不发送；Enter 先解析为 canonical command
再走原 enter 分流；例如 `/mo` 可选 mode/model，`/co` 可完成 compact。
已有完整 canonical token 不得被候选默认项意外改写；别名可归一化。带参数/多行粘贴不自动改写正文。
Esc 隐藏当前补全直到草稿变化；补全是本地状态，切会话、打开选择器或交互出现时失效。
补全优先于普通上下滚动，PageUp/PageDown 继续滚动；不消费 Ctrl-C/D、Shift/Alt+Enter。
Ctrl-U 清空编辑器是本地操作，不发送命令。

### selector filter

新增 filter 字符串，不复制 typed choices；选项列表仍唯一持有 Model(Value)/Mode/Session(id)，
过滤使用标签的大小写不敏感子串；变更 filter 重置选择下标，限定 256 字符。
打印字符/Paste 只编辑 filter，Backspace 删除 Unicode 字符、Ctrl-U 清空 filter，不污染原 editor draft。
空结果有明确中英提示，Enter 是 no-op 不调用 actor；Esc 恢复原 draft。
确认被拒绝/owner stale 时保留草稿，不凭过滤后行号猜测原始选项，不回落到第一条模型。

### 展示

- composer 底栏从 `state.config.model/provider/thought` 派生，缺失为 `—`，不回退到其他模型或伪造 thought。
  清理 ANSI/OSC，按终端显示宽度截断，窄/极小终端不溢出、不 panic，NO_COLOR 保持。
- compact marker renderer 消费 `marker.type=compact`，真实 status 为 running/success/noop/failed（及实际存在的
  failure 字段），区分 origin=manual/auto，只有存在的 token 字段才显示，不从字符串猜测统计。
- 同类已有 modelChanged/rewind marker 按实际字段给出有界可读提示，不显示原始大 JSON；未知 marker 不造事实。
- 维持 MAX_ROWS / MAX_FIELD_BYTES / MAX_RENDER_BYTES 与 cache invalidation，不为每个编辑键重解析历史。
- 新 Rust 源文件均 ≤400 行；按命令目录/执行、补全、选择过滤、渲染职责拆模块，不复制三套状态。

## 并行实现的模块接口

- `commands::Command` 公开 crate 内字段 `name`（无 `/`）、`aliases`、`usage`、`summary_en`、`summary_zh`；
  `commands::all() -> &'static [Command]`、`find(token: &str) -> Option<&'static Command>`（允许带或不带 `/`）、
  `help(topic: Option<&str>, zh: bool) -> anyhow::Result<String>`、
  `compact_instructions(text: &str) -> Option<&str>`。命令目录是帮助与补全的唯一来源。
- `completion::Completion: Default` 是 TUI-only 状态：`reconcile(draft: &str, enabled: bool)`、
  `candidates() -> Vec<&'static commands::Command>`、`selected() -> usize`、`move_by(isize)`、`dismiss()`、
  `replacement() -> Option<String>`（canonical `/name`，不直接提交）。
  `completion::draw(frame, bounds, &completion, zh)` 绘制有界建议面板；presentation 仅调用该入口。
- `selector::Selector` 追加 `filter: String` 与 `filtered_options() -> Vec<&(Choice, String)>`、
  `push_filter(&str)`、`backspace_filter()`、`clear_filter()`；`selected` 是过滤后序号，`choice()` 返回原 typed choice 引用。
  filter 方法自行复位下标与有界化；transport 不另外复制过滤列表。
- `session::slash` 保留原调用界面，命令执行可独立 `command_dispatch` 模块但不新增业务写入端口。
  `transport::enter` 允许 crate 内测试访问，不公开到跨包 API。

## 验收（先红后绿）

| 场景                                               | 断言                                                                                               | 证据                                                     |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| idle compact / compress + instructions             | 发出 canonical sendText，经原 actor 归一化为 compact；无附件/普通用户回合；ACK 与拒绝不伪造 marker | fake transport + 真实协议解析与 Linux PTY/loopback actor |
| unknown/compactfoo、busy、pending interaction      | unknown 本地报错；busy 保留草稿；交互文本仍作为回答                                                | transport regression + PTY                               |
| effort list/set/variant/invalid/rejected           | 读取真实档位；仅 setter 成功并刷新后展示新事实，失败无写入投影                                     | fake actor + PTY                                         |
| slash complete/filter/Tab/Enter/Esc                | 选择与帮助同源；Tab 不提交；带参数不重写；未知命令不发模型                                         | pure tests + PTY                                         |
| selector filter/paste/empty/clear/cancel/typed ids | filter不污染草稿；无结果不提交；provider:model 标识原样，stale owner不提交                         | unit/transport + PTY                                     |
| composer/markers                                   | 双语、窄宽/极小、ANSI/OSC/NO_COLOR、长字段、真实状态与token、cache更新                             | ratatui TestBackend                                      |
| lifecycle/regressions                              | 多轮、Read/Write allow-deny、AskUserQuestion、cancel、continue、退出/信号与termios不回退           | 既有真实 PTY smoke 全量                                  |

验证入口以当前文件/package/Cargo 为准：目标 TUI tests、workspace locked tests/fmt/clippy、16-crate boundaries；
`pnpm typecheck`、原始 `pnpm lint`（存量 86 errors/145 warnings 如实报告）、三 gate、architecture、格式与脚本回归。
所有 E2E 使用隔离 HOME/XDG/data/workspace 与 loopback 模型，不读取真实配置/会话/logs。不安装或替换本机 `.395` 包、
不创建 tag/Release、不上传本地安装包。PR 必须验证精确新 HEAD 后才能合并，平台编译不等于人工 runtime 验收。

## 真实协议与验收探针修正

- PTY 实测发现：共享 v4 schema 的 `compact` payload 是 `z.object({})`，Rust `parse_command` 会剥离
  `payload.text`。fake transport 若只检查发出的对象，会漏掉附加指令丢失。
  本批**不扩协议**：前端发送 canonical `/compact [instructions]` 的最小 sendText payload，
  由 `core/src/app/commands.rs` 既有归一化在协议解析后转为 compact，并保留指令。
  新测试必须走真实 parse_command 后的归一化/真实 actor，不能只以 fake ACK 证明指令可达模型。
- 既有 `tui-question` fixture 使用无效的单数 question 参数，报错文本可能被误认成真正问答。
  探针须改为工具真实要求的 `questions` 数组；必须看到待回答面板，答案进入同一 AskUserQuestion 的
  tool result，且不得另起 `SMOKE_ANSWER` 普通 user turn。修正后请求数按实际事件重新核对，
  不为了守住旧的 14 这个数字保留错误场景。
  已确认的实际形态：单数参数让 Rust `QuestionInput::parse` 直接以 `unknown field \`question\`` 失败，
待回答面板从未出现，`SMOKE_ANSWER`只能作为普通 prompt 得到一个`answer: SMOKE_ANSWER`回显。
现在 fixture 传`questions:[{question,header,multiSelect,options:[{label,description}]}]`（恰好 2 个选项，
使 6 行帮助区能同时显示问题、选项与问答页脚）；PTY 以问题文本 + `• SMOKE_ANSWER`+ 问答页脚三者
同时可见作为交互挂起证据，只等 Tool result 之后模型的唯一新 completion`question answered: SMOKE_ANSWER`。
OpenAI chat 线上会剥离 `\_zcode_tool_failed`，因此「同一 tool_call_id + 问题文本的真实答案关联」
就是非错误判据；错误文本与 `tool done`都不含该关联。修正后原 14 请求基线变为 13
（旧伪问答多出一次普通`SMOKE_ANSWER` 请求），加新增 7 条共 20，报告按实际事件计数。
- 独立回归 `scripts/tests/zcode-cli-rust-tui-question-fixture.test.mjs`（`node --import tsx --test`，
  随 `pnpm test:zcode-cli-rust-drivers` 执行）不读 PTY 与二进制：它用 TS zod 契约与 Rust 实际下发的
  `tool_schemas.json` 双向校验 fixture 产出的参数，再用真实 loopback modelServer 断言成功答案 →
  `question answered:`、参数错误/普通 prompt/异 id → 不完成、Read 结果仍是 `tool done`，避免自证。

## 取证与边界

架构门禁基线 0 violations，Rust 16 crate boundaries 通过。仓库的 feature graph 暂无 Rust TUI seed：
这是 graph-drift-candidate，不把 TS bootstrap 图节点伪装成 Rust owner；本批不增加新的跨进程协议或业务 owner。
输入历史、@file、真实 MCP/usage、busy queue 已在后续 workbench 批实现（待最终验收，见该 spec）；
高级插件/workflow 仍不在首批范围。本 spec 的验收在实现后回填真实结果，不引用旧截图/旧 deb 证明新源码。

## 展示层实现与验收

- 实现：`crates/tui/src/presentation_status.rs`（model/provider/thought，按显示宽度裁剪，缺省 `—`，
  清理 ANSI/OSC 与控制字符）、`crates/tui/src/presentation_markers.rs`（compact 的
  running/success/noop/failed/cancelled + manual/auto + 真实 `tokensBefore`/`tokensAfter`/错误字段，
  `modelChange`/`checkpointRestored`/`goalVerify`/`forkNotice` 按实际字段，未知 marker 不输出）、
  `presentation.rs` 在 `render_rows` 接入 marker 并调用 `completion::draw` 与 `draw_selector_localized(..., view.zh)`。
- `presentation_parity_tests` 覆盖宽/窄/极小 composer、长 CJK/emoji 与 ANSI/OSC、NO_COLOR、marker 全状态与
  缺失 token、`row.upserted` 后缓存刷新；marker 空行边界独立到 `presentation_marker_spacing_tests.rs`，
  不放宽单文件 400 行上限。既有欢迎页/侧栏用例保留。
- 模型、用量、MCP 不补假数字；输入补全、选择过滤与命令分流已集成，完整结果见下文。

## 真实问答探针与 compact 验收

- 改动范围：`scripts/lib/zcode-cli-rust-interop-fixture.mjs` 的 `tui-question` 分支（真实 `questions` 参数、
  按 tool_call_id + 问题文本解析答案关联、非问答工具保持 `tool done`）、`scripts/zcode-cli-rust-tui-smoke.mjs`
  与 `scripts/lib/zcode-cli-rust-tui-pty.py` 的问答断言与计数、新增独立注册测试。Rust `tool_schemas.json`
  未改（仍由 `generate-zcode-cli-rust-tool-schemas.mjs --check` 守护），不扩协议、不改 schema。
- 真实 PTY 证据（重建 debug binary 后执行）：`node scripts/zcode-cli-rust-tui-smoke.mjs --keep` 与
  `--provider-discovery` 均 `status: passed`；`modelRequests=20`、`baselineRequests=13`、`addedRequests=7`、
  `compactRequests=2`、`askUserQuestion.toolResultAnswered=true`。会话库中该 tool part 为
  `status=completed`，`output` 含 `"Choose the TUI smoke answer"="SMOKE_ANSWER"`，随后 assistant 文本为
  `question answered: SMOKE_ANSWER`；不存在以 `SMOKE_ANSWER` 为正文的 user part。
- 断言覆盖：20 条原/新增场景全绿——welcome/侧栏/尺寸、model/mode 选择器、新会话与新 id、本地 help/unknown/
  compactfoo/effort-invalid、`/` 与 `/odel` 补全、alias compact noop、多轮 + Read、Write allow/deny、
  真实 AskUserQuestion 面板与 tool result、慢流 Ctrl-C 取消、sessions 恢复、continuation 历史、
  selector 中文 paste/空结果/Ctrl-U/Esc/下箭头 typed 模型、effort list/variant set/invalid、
  compact alias running/cancelled、Tab+Enter 真实 compact success、post-compact 上下文、`/quit`+`--continue`
  退出、SIGTERM 143 与 termios 恢复。
- 首批未做/不宣称：真实人工 runtime 验收、deb 打包；输入历史/@file/MCP·usage/busy queue
  已转由后续 workbench 批实现，首批验收不把它们记作完成。本次不改动本机 `.395` 包，不创建 tag/Release。

## 后续 workbench 批（交叉引用）

首批未做的输入历史、`@file`、真实 MCP/usage 与 busy queue 已由
[workbench spec](cli-rust-tui-workbench.md) 实现，当前处于最终验证阶段。本 spec 的 95/580 等计数
保持首批历史证据，不把 workbench 结果并成首批全量复验。

Rust 命令目录统一广告新增交互：`/queue [list|pause|resume|edit|delete|send|up|down <id>]`、
`/mcp`（只读状态刷新）、`/usage`（真实累计与独立 context）、`↑`/`↓`（持久历史草稿召回）、
`@` 路径建议（Tab/Enter：目录继续、文件加草稿附件）。paused 队列遇到新 prompt 需显式
`/queue resume`；sendNow 只提升一项，不等同运行整条暂停队列。历史只读新 Rust scope，不混旧 TS
`proj_*` 行；artifact/inline content 不能安全恢复时保留原草稿并明确报错，再按 `↑` 跳过该项；
启动 pinned 附件保留到第一次接受。`/usage` 的累计是 `queryTaskUsage` 的 source baseline 增量，
不是机械相加各轮输入；context badge 独立读 `contextWindow`。

本地 workbench PTY 35 checks 全绿（attachments 9 / queue 13 / usage 10 / shutdown 3），
既有 20-request baseline 与 provider-discovery 模式通过。最终源码本地复验为 Rust 714 passed / 1 ignored，
其中 TUI 222 passed；Node drivers 59、CI scripts 430 通过。精确 PR HEAD CI 仍待完成。

## 首批总体验收（提交前本地证据）

以下为首批历史证据（`f1eb1969` 基线），不随 workbench 批重跑改写：

- Rust `cargo test --locked --workspace`：**580 passed / 1 ignored / 0 failed**；其中 TUI **95 passed**。
- `pnpm check:zcode-cli-rust`：16-crate boundaries、workspace fmt、all-targets clippy `-D warnings` 全部通过。
- Node 24.14.0：`pnpm test:zcode-cli-rust-drivers` **58 passed**；`scripts/ci/*.test.mjs` **423 passed**。
- 两种真实 Linux PTY 模式各通过 20 个断言、20 次 loopback 模型请求（13 原功能事件 + 7 新增，2 次摘要）。
  `AskUserQuestion` 参数经 TS zod 与 Rust tool schema 交叉验证，真实答案与 tool_call_id 关联；
  错误结果即使含答案样式但无真实成功前缀，也不判为问答完成。
- 根 `pnpm typecheck`、协议 schema/contract assets 的 `--check`、architecture（0 violations）、格式检查通过。
- 原始 `pnpm lint` 仍为 **86 errors / 145 warnings**，不是清零；lint/format 棘轮无回归。
  knip **1140 / baseline 1141**，改进 1（fixture 的 `contentText` 有了真实消费），未刷新基线。
- 未变更共享协议、生成 schema、Core admission/队列/存储、Desktop owner/lease 或恢复语义。
  不将 Linux loopback/PTY 验收写成真实模型、Windows/macOS 人工 runtime 或安装包验收。
- 远端 CI 尚待精确 PR HEAD 验证；通过前不标为已合并，也不宣称 TS TUI 全功能对等。
