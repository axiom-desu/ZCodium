# 上游 3.16.1 / 3.16.2 语义同步

## 来源、范围与交付规则

用户要求跟进上游新增的两笔提交；涉及已有 Rust 重写能力时同时补齐 Rust，而不是仅改 TS。

| 版本              | 上游公开提交                               | Source-Commit                              |
| ----------------- | ------------------------------------------ | ------------------------------------------ |
| 旧对账基准 3.15.1 | `aac4755666d09fdcd70272fcf063c077a639015f` | 见旧对账 spec                              |
| 3.16.1            | `0a1fc56d279fd1001f78387bd81aec1c26767411` | `1f4d7f01beb143df0ec1224f0ed4236f42d0fd13` |
| 3.16.2            | `3c5b227649371507ddc4eb46ac5133afe6db1cab` | `5a082039a1a3b1edfe8364a33c8978689c0d68bf` |

以上版本已从各提交的根 package.json 实读确认。先对账 3.16.1，再叠加 3.16.2；相同功能按后者最终语义交付。
本地下游先保留 ACK/TUI 响应性及 lint 清零检查点（PR #88，精确 HEAD `caccb59f` 11 success / 2 条件 skip，
已 guarded rebase 合并为 `8a781353`，合并树与验收 HEAD 相同）。
该检查点不是上游同步完成证据。功能分支 `feat/upstream-3.16-sync`；不整体 merge 上游或覆盖本地重构。

完整变更包含 CLI、共享协议、项目存储/侧栏、远端连接、手机远控、分享、文档插件和 UI，不能只同步 CLI 后声称两笔完成。
逐簇分类为：已实现并验收 / 原有实现已等价且有回归证据 / 正在实现 / 等待边界设计 / 本仓明确移除而排除。
不存在同名 Rust 文件不证明缺功能；存在账本表不证明有运行引擎。最终账单须列原始来源、落点和实际证据。

## 不变量

- `workspaceIdentity?.trim() || workspacePath` 为身份 key；路径仅执行/展示。父链归属仅由持久事实证明，不能修改身份以凑匹配。
- accepted input 仍由 CLI/runtime 串行 admission，commit-before-ACK；没有第二任务队列、第二业务 owner 或超时补偿。
- 唯一 Client allocator/reader、Terminal/EventStream/View writer；保留本地非阻塞 operation、草稿保留、CAS/epoch/stale-run 防护。
- Desktop window-scoped Local Host/远端连接注册表、手机 attachment 复用现有 runtime 的架构不变。
  relay/Main 不持业务快照/队列；desktop-continuous 与 web-remote-replayable 分别验收。
- TS ↔ Rust 共用 Node SQLite 账本；旧迁移 SQL/checksum 不重写，新迁移统一镜像后再验证互操作。
- 保留已移除功能/依赖的移除决定，尤其 OffPeak、Highspeed request-auth 分叉和休眠的 CUA frame contract。
  不按上游添加并列 owner，也不按文件删除清单删除仍被本仓消费的能力。
- 原始 lint 保持 0 errors / 0 warnings；不新增 ignore/disable、提高限值或放宽门禁基线。
  Rust 每个 crates/\*/src 文件按 checker 的 split-newline 口径 ≤400 行。
- 上游结构改名/拆分按职责适配，不覆盖已提取的 typed ports、单状态 owner 和公开入口。
- 实现交给 subagent；父会话负责规格、跨域接口、独立 review、真实验收及精确 HEAD CI。
- 所有 fixture 只用临时 HOME/XDG/workspace/DB、loopback；不读真实用户数据或 logs/。
  不安装/重打本地安装包，不替换 .395，不打 tag/Release。

## 分批实施账单

| 切片 | 3.16.1 / 3.16.2 增量                           | TS 落点                                      | Rust 对应                                      | 初始状态     |
| ---- | ---------------------------------------------- | -------------------------------------------- | ---------------------------------------------- | ------------ |
| S1   | 软删除、lastOutcome、只读 kind、父链列表归属   | contracts/storage/core/bootstrap/shared      | domain/state/core-api/core                     | 先实施       |
| S2   | 3.16.2 Bash 输出 tmp 隔离                      | adapters exec / bootstrap 注入               | host/tools/bash                                | 先实施       |
| S3   | 路径附件首发说明冷恢复                         | contracts/core attachment/hydrator           | domain journal/history                         | 先实施       |
| S4   | 失败 usage、空输出超窗、拒绝分类               | contracts/adapters/core                      | model/domain usage/core                        | 先实施       |
| S5   | 3.16.2 插件读锁/transport 与 ui 分类           | adapters/bootstrap/plugin API                | plugins/tools/core read lane                   | 先实施       |
| S6   | ToolSearch native/local、MCP 元数据/连接等待   | contracts/core/adapters/bootstrap/CLI/shared | domain/core/model/tools/state/protocol/CLI     | 独立大切片   |
| S7   | DWF 空闲阻塞提醒、统一 Stop 集、执行选型顺序   | core/workflow/bootstrap/adapters             | Rust 无 DWF 引擎；已有 execution scope 须回归  | 先实施 TS    |
| S8   | 项目存储/迁移/任务树/侧栏                      | services/shared/UI                           | 共享 Host 层，不造 Rust 第二项目服务           | 待跨模块设计 |
| S9   | Source Server/R3、远控 v2、打包                | shared/services/desktop/web/server CLI/UI    | 保持现有 Host attachment，Agent 协议变更需兼容 | 待所有者映射 |
| S10  | office-runtime 与四文档插件                    | 新共享运行时、插件/seed/staging/UI           | Rust 分发相同插件资产，不包装 TS TUI           | 待独立 spec  |
| S11  | side-pane-full-view、分享/插件/工具栏及其他 UI | UI/shared/services/web                       | 非原生 Agent/TUI 重写面                        | 待逐簇适配   |
| S12  | 治理/测试/依赖/生成资产/版本                   | 仅采纳与本仓策略兼容的增量                   | 生成镜像/许可证、跨平台构建                    | 最终收口     |

源码分析辅助清单保存在 /tmp/upstream-semantic-inventory.{md,json}，不是交付或测试证据。
AST 不同包含重构/改名；不得把它等同于全部新行为，亦不得把大规模文本变更归为纯格式而漏项。
新增上游测试用于理解场景；实际运行入口以本仓 package.json 为准，不直接运行未审查的上游脚本。

## S1：状态规则与接口

唯一 owner 为 SQLite session 行；TS adapter / Rust NodeStore 经各自公开 SessionStore 端口读写。

```text
turn terminal → durable session update(lastOutcome) → terminal event/index projection

delete command → identity + existence guard → soft-delete transaction
  → cancel/drain runtime through existing close path → topic/index removal → ACK

explicit session IDs → readonly row lookup → persisted auxiliary parent-chain proof
  → same workspace identity projection (no activation, no identity write)
```

1. 追加 0023：`time_deleted integer`、`last_outcome text`；历史 `time_archived` 保留，不回填删除时间，与上游一致。
   两个概念不同，不能把旧归档静默变成删除；旧归档不再作为列表排除条件。
2. soft delete 使用首时间保持的 coalesce 语义；重复操作幂等。正文/part/accepted 历史保留；upsert 不复活删除行。
3. 普通列表永不返回 deleted 行；getSession 可读删除标记，resume/send 不可复活已删会话。
4. `lastOutcome` 为 completed/error/interrupted，历史未知值不伪成功；成功/错误/取消按真实 terminal 更新。
   它是上次结果，不替代当前 running phase。持久化在相应终态发布前完成，走现有唯一事务/持久化收口。
5. wire 的 `includeArchived` 暂保留接收但忽略，避免旧 strict-schema 发送端断裂；仓库调用端停发旧开关。
   新投影使用 deletedAt/lastOutcome；若旧 archivedAt 仍有消费者，仅保留旧事实兼容，不用它推导 deletedAt。
6. readonly agent kinds = subagent_child / workflow_child / nested_workflow_child；selection_side_chat 可输入。
   auxiliary kinds = readonly 三种 + selection_side_chat。fork/workflow_parent 不沿辅助父链绕过归属。
7. 只有显式 ID 查询可沿持久 parentID 证明辅助子会话归属；每层路径/显式 identity 严格校验，环/缺父/已删/跨工作区拒绝。
   不能把远端同路径的不同身份拼到一起；普通分页仍由当前 workspace key 隔离，保原帧预算。
8. 删除失败不发布 removed；重复删除成功不重复发布事实。保留已有 lease、foreground guards、EOF/drain/权限与 accepted queue 所有权。

验收：两侧真实临时 SQLite 迁移/幂等/部分已存在列、旧 22 checksum 保持、三 outcome 往返、正文保留、upsert 不复活；
删除后 list/resume/input 均正确，ACK/removed 顺序与失败路径；四 kind 输入矩阵与显式 ID 父链正反例；Node/Rust 双向互操作。

## S2–S5、S7：运行期窄修规则

### Bash 输出

```text
Bash admission → prepare tmp directory + frozen output path/handle → cancellation check
  → spawn → foreground/background/Read/TaskOutput share exact path → existing completion cleanup
```

首选 os tmpdir 下的进程生命周期 zcode-bash-\* 目录，不把持续写输出放进递归搜索的数据根。
准备发生在 spawn 前；EACCES/EPERM/EROFS/ENOENT/ENOTDIR/ENOSPC/EDQUOT 才回退原 artifacts/exec 路径。
其他错误明确 spawn_error；准备期取消/close 不 spawn、不泄漏句柄；不迁移历史输出。
准备期取消/close 的结果分类与运行期取消一致：返回 `status: "cancelled"` 的结果（Node `createStoppedResult`），
不是 tool error；两侧都不为它创建输出文件或登记后台任务。
tmp 父目录的唯一注入点是 shell 工具构造参数（Node `bashOutputTempDir` 对位）；storage path 解析不重复持有该值，
避免与工具实际使用的目录分叉；测试经同一构造参数注入。
单个既定路径贯穿前台、显式后台、timeout 转后台及 persistedOutputPath/Read；不在 capture 阶段重新选路径。
验收实际 shell、输出回读、回落、取消及前后台交接，Windows/macOS 路径使用注入而非硬编码 /tmp。

### 附件

首发完整路径说明存入 `AttachmentStorageMetadata.pathReferenceText`（不是 preview）。
冷恢复优先原样使用；旧行无该字段才走原兼容占位。保留本地/远端、媒体 modelContentLayout 与 artifact 的既有边界。
验收首发/持久化/冷恢复模型内容字节相同，旧行兼容，不能持久化真实用户 fixture。

### 模型失败与 usage

```text
provider terminal + raw finish + usage → classification
  empty + context-limit → ModelContextExceeded with usage
  refusal/content-filter → terminal non-retry, never empty-response backoff
  partial output → preserve upstream partial-output semantics
failed network status(usage?) → single usage ledger fact
success → existing ModelComplete only (no double accounting)
```

保留原始 finish reason/provider metadata fallback；特别不能将 Anthropic model_context_window_exceeded 压成输出长度上限后续写。
错误/取消/重试的 usage 仅按真实账单证据结算，不猜零、不与成功重复计数。缺 usage 明确缺失。
验收真实 HTTP loopback stream/nonstream、context/refusal/filter/partial、失败后重试与成功 usage 去重、冷恢复 usage。

### 插件读路径

已缓存/已安装 describe、list、overview 不等无关 install 下载；仅 manifest 懒加载写阶段使用现有写锁且二次检查。
未知市场的并发填充仍 single-flight；validate 如需纯读取应收窄锁，不把写行为伪装成读。
transport 只给明确的插件只读方法独立处理，普通 mutation admission/帧边界/EOF 顺序不变。
旁路串行队列不等于脱离 transport 生命周期：EOF 半关闭要等已受理只读请求的回复写出（既有 100ms 上限不变），
不能因为串行链为空就丢弃已受理回复。
官方四文档插件 componentTypes 保持 ui（包括卸载后的可恢复项，两侧同源）；不解除 CUA env 门控。
已安装插件的 ui 分类只看插件清单 `ui.surfaces[]`，Rust 复用发现阶段已解析的 manifest，不另建缓存。
验收阻塞安装 A 时读 B 实际完成、同一缺失市场并发只写一次、失败释放锁及普通命令顺序。

### DWF / 选型

TS 在飞 run 的 pending questions/holes 由现有任务注册表提供；父会话空闲阻塞提醒是进程内事实，不进 DWF journal、
不扩旧 WorkflowNotificationMeta kind 闭集。每 run 的两次提醒与 user_steer 重置遵循上游状态机；不擅加新截断字段。
并发 governor 与 runner 使用同一 failure Stop 集：不可重试配额不能按 rate-limit 冻结桶，可恢复限流仍退避。
执行级选型不改会话默认；接纳固定顺序沿单 command inbox。Rust 现有等价作用域必须回归，不恢复 requestAuth/highspeed/offpeak。
验收手控 clock 的提醒次数/重置/关闭/互斥、真实 governor 配额与可重试限流、接纳时选型与迟到完成顺序。

## S6：ToolSearch 所有者与协议

具体语义以两版最终源的 tool/19-tool-search.md、contracts 和真实编码器为依据；计划草稿不是权威。

```text
CLI/startup preferences → runtime configuration(mode)
  → one request preparation after scope/permission filtering
    → current catalog + committed reference/announcement/compact facts
    → native/local/off tool exposure + history projection → provider encoder
  → same executor (unwrap target before target events/permissions/hooks)
  → committed tool result / metadata → history restore / active compact boundary
```

- mode = auto/native/local/off，缺省沿上游实际入口（CLI off；其他入口读取既有 startup preferences），不伪造 auth capability。
- native 仅 Anthropic Messages 能力支持；auto 的 coding-plan 默认谓词读真实非凭据配置；local 需 tool calls。
- providerNative、alwaysLoad、ToolSearch/DeferredToolCall 控制入口不 deferred；基于实际注册目录，不注册不存在的工具凑 allowlist。
- ToolSearch query/max_results schema、select/mcp 前缀/+required/alias/评分/稳定顺序、native/local 文案按上游；模型 JSON schema 的 required 与执行默认分别验收。
- local 只发常驻与控制 schema，目标通过同一 DeferredToolCall 展开执行；native 只发真实已发现 deferred schema 并标 defer_loading。
- 控制入口缺失或无 deferred 时退化为全目录，不能 silently 丢工具。全部 local 提升后控制入口仍可用。
- `tool_reference` 内部字段 toolName；HTTP Anthropic 字段由真实协议编码，不能把 AI SDK 的 providerOptions 对象当成 HTTP wire。
  非 Anthropic 不发送 beta、defer_loading 或原生 reference。已有 beta 大小写无关合并去重，不能覆盖其他 beta。
- 发现集、增量公告 metadata 与 compact 的 preCompactDiscoveredTools 来源为提交历史/有效边界；
  不能另建跨请求缓存或从失败/取消/未提交工具结果猜发现。恢复/切模式/重绕/fork 按真实有效历史。
- TS 与 Rust 都须保持公告提交与请求快照顺序，不接受仅因方便而将 Rust 公告降为重启后无条件重复的临时提示。
  复用既有 JSON metadata/journal，不为此加数据库列。compact 保留有效发现，不让请求投影再写主历史。
- completed/error modelContent 必须兼容旧字符串和有效 text/reference 数组；坏 metadata 不导致 display/媒体布局整份丢失。
- 模型 port 若需选项扩展优先向后兼容方法/请求对象；不要让所有既有 mock 被迫无关重写。
- MCP alwaysLoad/searchHint 来自配置/descriptor，strict 配置不能因此整段丢弃；等待指定 server 仅等待已有连接任务，
  不启动额外连接、不等其他 server，owner 失效及时返回。Rust 当前急切 prepare 的路径是否需等待须以实际执行入口证明。
- CLI/TUI/stdin/Host 使用真实既有配置入口；不能因旧规划误称 Rust 无交互 CLI 就跳过已有原生 TUI/CLI flag。

验收：两侧纯算法/校验/切模式、权限/钩子/取消/媒体/turn-stop 原路径；真实 loopback HTTP request body/headers，
临时 SQLite close/reopen/compact/fork/rewind 后下一请求一致；MCP 连接与重启；原 PTY/互操作全保留。

## 运行期首批本地整合状态（不是完整版本对齐）

S1–S7 已落地到 TS 与适用的 Rust 运行期，并经独立审查修复半升级迁移、close/delete 区分、
插件读 EOF drain、ToolSearch 权限/Off 公告/目标身份/goal 投影、UTF-8 搜索和 raw finish 显式 null 等回归。

- 本地 Rust workspace：869 passed / 1 ignored / 0 failed；clippy `-D warnings`、fmt、16-crate 边界通过。
- TS core/adapters/contracts/bootstrap：139/50/29/98 passed；Node drivers 63、CI scripts 445 passed。
- root 与现有 workspace 类型检查、raw lint 0/0、三 gate、架构通过；CLI 0.47 changed-only 格式通过。
- protocol/config/tools/permissions/reminders/projection/domain/state fixtures 从真实 TS owner 重生成，`--check` 通过；
  state fixture 不再依靠手填期望。knip 1128→1127 仅删除一个已被真实消费的旧 key，不增加容许量。
- 真实 TS/Rust engine + loopback HTTP + 临时 SQLite 覆盖搜索/包装执行/权限/取消/compact/冷恢复；
  进程级 Host 启动偏好探针也已执行。新构建的 Node CLI 与 Rust release binary 实际通过：
  原 TUI direct/provider-discovery 各 20 assertions / 20 requests / 2 compactions；workbench 35 / 17 requests；
  responsive 62 / 4 requests；互操作 alternate/crash/concurrent 共 7 sessions 冷读相等、零状态/行/历史差异。
  精确提交 CI 仍待首批 PR 验收。

仍开放：Rust 的跨工具 typed input-validation 所有者缺失，尚无与 TS 相同的「参数校验失败 → ToolSearch 搜索指引」统一挂接点；
不为一句提示增加第二校验器或按错误文本猜分类。此为明确架构缺口，不计为已补齐。
S8–S12（项目树/侧栏、远端/手机、office、分享/完整视图/其余 UI、版本）尚未交付；根版本不提前升为 3.16.2。

## 后续大面与最终验收

S8–S11 在读 DESIGN.md/CONTEXT.md 和模块 context 后补逐域 spec，尤其项目树与 R3 所有者不能直接并列两套。
新 managed module 先登记公开 contract/依赖方向；不得复制上游大块 architecture baseline 豁免。
采纳依赖需先审 manifest/锁图/许可/离线分发闭包；新 office 运行时不是空壳或仅声明 package。
最终版本目标为 3.16.2；不把部分切片提前标为完整版本对齐。

每切片记录计划/真实执行分离的测试证据；最后必须跑 root typecheck/lint（0/0）、格式与三 gate、架构、
Rust locked workspace/fmt/clippy/16-crate boundary、schema/contract/domain 资产、两侧实际包测试、Node drivers、CI scripts、
原 TUI/workbench/responsive PTY、Node/Rust 互操作及修改交互的 E2E。环境受限如实报告。
精确最终 PR HEAD CI 全通过后 guarded rebase merge；没有 pass 的 check 不写成通过。
