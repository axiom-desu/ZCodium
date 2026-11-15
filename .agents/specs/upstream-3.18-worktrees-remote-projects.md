# 上游 3.18.2 受管 worktree 与远端项目入口（W1）

来源：只读 `.cache/upstream-3.18.2@fec97590`，行为参考 `docs/git/worktree.md` 与 services/UI 实现。总边界见 `upstream-3.18-sync.md`；盘点见 `/tmp/sync318-coverage-audit.md`、`/tmp/sync318-services-inventory.md` B2–B4。

## 状态所有者 / 边界

```text
Renderer create/fork/delete → Host IManagedWorktreeService → GitWorktreeRepo(复用现有 gitCommandProvider)
                                                    ├─ tasks-index 原子预留/实际 task admission
                                                    └─ 项目 CLI CommandInbox 执行创建/分叉
远端用户意图 → RemoteProjectService → project-storage.remote_project_entries
远端连接/身份/连接事实 → windowRemoteConnectionRegistry（唯一连接管理者）
RemoteProjectCatalog = ProjectService + RemoteProjectService 只读组合
手机 pendingInteractions → 既有 mobile-project-directory 投影（不新建第二业务 store）
```

W1 不更换远端连接 owner、不建第二 connection manager、不触碰 E1 扩展/A1 app navigation；Host 共享集合/index 仅做必要窄接线。Remote project entry 是用户选择的持久意图，不是连接事实；采用现有 `remote_project_entries`，允许在同一表追加 `cached_deleted`，不新增另一个 entry 数据库。缓存删除/恢复/移除入口与远端项目真实数据删除完全不同：entry 删除只删本机 membership/cache，绝不发远端 delete。

## managed worktree 合同

最终收口补充：`not-reserved` 只证明当前没有 receipt，不能证明命令从未转发；
当前任务投影为空、CLI暂未返回驻留会话也不能把未知结果变成未接纳。
失败自动清理只接受现有 receipt 的明确 `released`（未认领）事实，并继续要求CLI无会话证明；
receipt缺失一律保留目录并提供管理入口重试。主代理补充“已转发但投影不再可见”的负向回归。

- 新增共享合同、严格路径布局及 trust identity resolver；identity 只把真实受管 worktree 映射回源仓库，未经验证路径不继承信任。
- Host 是受管 worktree 唯一 owner，事实来自 Git `worktree list` + 布局和 git-common-dir 验证；禁止操作任意用户仓库路径。bucket 原子预留，cleanup 失败必须保留可诊断结果，绝不能吞错。
- Git IO 复用现有 Git command provider；新增 GitWorktreeRepo port/adaptor，不把 git 执行塞 UI。创建/放置任务通过既有项目 CLI CommandInbox admission，不复制第二条 task 接纳队列。
- 删除前重新校验受管归属、共享引用、dirty 与任务/terminal/创建/删除租约；有任务使用时 dirty 拒绝，未使用时确认后可 force。运行任务、待提交输入、pending interaction 由实际 task admission/CLI owner 判定；Host 镜像只展示，不是忙闲权威。
- 数据/共享目录布局与 Trust identity 不因 workspacePath fallback 改写；workspaceIdentity 做隔离，workspacePath 仅用于 IO。
- UI 支持新任务 worktree 创建、fork 当前 cwd/新 worktree 选择、任务 cwd 放置、受管 worktree 管理及带明确后果的安全操作。远端项目、Web/mobile 创建入口不可用；不得按任意目录执行删除。

## 远端目录

- `RemoteProjectService` 持久化用户显式添加的远端项目意图；host membershipId 必须 CAS 校验；远端刷新只更新匹配的存活 entry，迟到刷新不得重建已移除入口。
- 缓存 `deleted` 只用于离线投影隐藏远端已删除项目，显式添加/恢复刷新可清除此标记；removeEntry 不调用远端删除。remote project payload 必须与 connection registry 的事实分离。
- `ProjectCatalog` 只读组合本机项目与远端 directory，身份不混淆。窗口/手机继续用既有 mobile-project-directory，pendingInteractions 只能作为现有投影派生叠加，不引入新持久业务 store。
- 保持本机/远端失败可见；旧远程 Agent 缺方法不可当成功。

## 验收

- 临时真实 git repo 覆盖 create/place/remove、仅自有路径、布局/identity、防 dirty、活跃 task、shared reference、残留 bucket / 清理失败、跨平台路径分隔符。
- 实际 task admission 并发/拒绝证明无第二 accept queue；UI 用真实组件测试创建/fork/移除确认和 disabled/失败状态。
- SQLite 临时数据库验证 add/refresh/remove/restore、membership CAS、cached_deleted、迟到响应、entry 与远端数据删除分离。
- 不触碰已有 #92 手机导航/抽屉语义；覆盖现有用例。
- 只定向追加 schema；不得改历史迁移 checksum。根 `package.json` / lock / `architecture-policy.yaml` 不由本片编辑，模块 manifest/注册建议写 `/tmp/sync318-W1-manifest.md` 交主代理集成。

## W5 落地（垂直接线 + 远端 intent）

### 受管 worktree（本机）

- 唯一服务 owner：`services/src/managed-worktree-tasks`（channel `managed-worktrees`，仅本机 Host 注册）。
  Git 事实复用 `services/git/managed-worktree`（`gitCommandProvider` + 受管布局/git-common 验证），
  不新增 Git 执行路径。
- 本地模型：任务 `workspacePath` 就是 worktree 根目录，`workspaceIdentity` 必须为空；项目归属由
  `projectId` 表达。`tasks.worktree_root`（迁移 `0010_task_worktree_root`）是受管关系的唯一记录，
  由项目仓储 `reserveCreatedTask({worktreeRoot})` 在同一写事务写入；这是唯一 admission 路径。
- 创建链：UI 项目行 → 服务 `createTask` → Git 新建受管 worktree → 既有
  `zcodeAgentService.createSession`（项目预占 → CLI CommandInbox）→ 返回真实 sessionId。
  会话启动失败只清理本次新建 worktree；清理失败返回 `session-failed`，不伪成功。
- 删除顺序：项目 root 归属/受管验证 → 创建中 → 删除租约 → `listTasksByWorktree` 活跃任务
  （syncer live active-set）→ `listDirectoryReferencingTasks` 共享目录引用 → force+任务 →
  dirty → Git remove。任意用户仓库/非受管路径一律 `not-managed`。
- UI：`ProjectWorktreeDialog`（项目行菜单）经 `useManagedWorktree` 只消费服务事实；
  创建成功后走既有 `onSelectTask` 导航，删除必须确认，force 只在无任务时可选。
- 接缝：终端占用与 CLI 会话卸载仍未接入（现有 TerminalService 无列表查询）；会话级
  `forkAssistant` 的 worktree cwd 需要协议 cwd 字段，当前只提供“新 worktree 新任务”。

### 远端项目 intent（本机）

- 唯一 owner：`services/src/remote-projects`（channel `remote-projects`，仅本机 Host 注册）。
  持久化只写既有 `remote_project_entries`；连接/身份/在线事实仍由 `windowRemoteConnectionRegistry` 持有。
- `membershipId` 写入前与 hosts 行 CAS；stale window/旧连接写库失败。
- `refreshDirectory` 只更新已存在且未缓存删除的入口；迟到刷新不重建已移除入口。
  远端删除只置 `cached_deleted`（离线投影隐藏），`addEntry/restoreEntry` 显式清除。
- `removeEntry` 只删本机 membership/cache，不发送远端删除。
- `readCatalog` = `composeProjectCatalog(本地 ProjectService.readProjects, remote entries)` 只读组合，
  不新建第二业务 store；Web/mobile 频道未加入 allowlist，默认拒绝。

## W6 卸载闸门 / fork cwd / 远端入口 UI

### 删除链（唯一 owner 不变）

`IManagedWorktreeService.removeWorktree` 在 W5 闸门后追加：

```text
受管归属 → creating → 删除租约 → 活跃任务 → 共享引用 → force+任务
  → 终端 listTerminalIdsUnderPath（有 → in-use/terminal）
  → dirty（拒绝先于任何卸载副作用）
  → 既有项目 CLI session/releaseUnderDirectory（只对任务 workspace + 项目 roots 请求，directory 限定 worktree 根）
  → 等待真实 ACK：busy → in-use/running；请求失败 → session-close-failed，worktree 保留
  → force 且 released>0 → in-use/tasks（镜像滞后不得强删）
  → 重新验证受管归属（sourceRoot 相同）
  → GitWorktreeRepo.remove（内部再次验证受管布局/git-common）→ 释放租约
```

- CLI 驻留表是“谁在用/是否忙”的唯一权威；Host 不以 tasks-index 镜像或 timeout 猜测释放。
- 只请求与当前 worktree 的 task workspace 和本项目 roots 相关的既有 CLI 进程；不启动新 CLI，不释放其他 workspace/Host/generation。
- 终端只读检查；存在初始 cwd 位于 worktree 内的终端时拒绝删除，不关闭其他终端。
- `createTask` 与 `forkTask` 先要求 CLI 声明 `runtime/capabilities.worktreeCwd`，否则返回 `unsupported-agent`，UI 禁用入口。

### fork 到新 worktree

```text
UI/Service.forkTask(parent task, target row, baseRevision/baseLogEpoch)
  → 能力探测 worktreeCwd → Git 新建受管 worktree（源 = 父任务 cwd）
  → reserveCreatedTask(childSessionId, workspace=worktree 根, worktree_root=根)
  → v4 forkAssistant { target, targetCwd { cwd, childSessionId } }
  → CLI 复制父会话历史，child 的 directory/path=targetCwd.cwd，session ID 必须等于预分配 ID
  → 失败：只有能证明未认领的预留才回滚本次新 worktree；无法证明时保留给管理入口
```

- UI 只消费服务事实；能力缺失时创建/删除按钮禁用，不允许“创建了 task 却仍按父 cwd 运行”。
- 已知差异：尚未带入父目录未提交改动（从源 HEAD 检出），记为后续项。

#### Rust 侧未实现 targetCwd：显式 fail-closed（不允许静默同 cwd fork）

Rust runtime 没有 `targetCwd` / `session/releaseUnderDirectory` 的 native 实现，也不会把子会话
切到目标 cwd。如果只依赖 JSON Schema，`forkAssistant` 非 strict 会接受并剥离 `targetCwd`，
结果是“命令成功但 fork 在父 cwd”——这是假支持，因此三层同时成立：

| 层                 | 事实                                                                                                                | 作用                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 线格式（生成物）   | `schema/v4-command.json` 含 `forkAssistant.targetCwd {cwd, childSessionId}`（两条 `x-zcode-trim`）                  | 与 shared TS 契约一致，未知字段仍被拒绝，不放宽 strict                        |
| 准入（唯一判定点） | `crates/protocol/src/command_schema.rs` 的 `refinements` 对携带 `targetCwd` 的 `forkAssistant` 返回显式 unsupported | 直接/旧客户端下发不会退化成同 cwd fork；无第二条校验路径                      |
| 能力               | `runtime/capabilities.worktreeCwd = false`                                                                          | Host `=== true` 判定因此不下发 targetCwd，不发 targetCwd 的普通 fork 不受影响 |

- 普通 `forkAssistant`（无 `targetCwd`）语义不变。
- 去掉该拒绝必须同时交付真实 native 语义（子会话 cwd/目录持久化 + `releaseUnderDirectory` 驻留释放），
  并把 `worktreeCwd` 改为 `true`；不能先放宽解析再补实现。
- `history_commands.rs` 不消费 `targetCwd`，也不新增第二处检查：解析层是唯一准入边界。

### 远端项目入口 UI / client

- `RemoteServiceAccess` 仅在本地 base attachment（`localHostServices`）创建
  `managedWorktreeService` / `remoteProjectService` 代理；远程、手机、Web 不声明。
- `RemoteProjectsDialog` 只经 `IRemoteProjectService` 列出 entry，`removeEntry` 是“从本机移除入口”，
  `restoreEntry` 只清 `cached_deleted`；两者都不发送远端项目删除。
- 列表同时读取 `listEntries`（含离线缓存）与 `readCatalog`（本机项目 + visible remote 的只读组合），不新增 store。
- 连接/身份/在线事实仍由 `windowRemoteConnectionRegistry` 持有；本批未改 mobile pendingInteractions 派生。

## W7 创建失败的 worktree 所有权 / 跨 Host 租约 / 终端真实 cwd

### 创建失败不得猜测“未创建”

`createTask`/`forkTask` 在调用会话入口前**预分配 sessionId**，并把它交给既有创建 port
（`zcodeAgentService.createSession` / `forkAssistant.targetCwd.childSessionId`）；
不新增第二条 admission、不在本服务里预占任务行。

失败时的唯一收口顺序：

```text
foreground 失败
  → (create) settleCreatedTaskReservation(cli-closed) 只用现有 receipt 的明确 released 证明“未认领”
  → 未释放（not-reserved / claimed / organized / task-missing / 结算异常）→ 保留 worktree + 可操作错误
  → 明确释放了未认领预留 → 再向 CLI owner 查询该目录的驻留会话
  → CLI 报告任何 released/busy 或请求失败 → 保留 worktree + 可操作错误
  → CLI 证明目录内无会话 → 本次新建 worktree 可清理；清理失败如实上报
```

- receipt 只在 CLI 首发前存在：`input-forwarded`/CLI 事实到达都会先丢弃它。
  因此“receipt 已释放且未认领”证明本次会话入口没有转发；`not-reserved` 只表示 receipt 不存在，
  即使任务行暂不可见，也不能推断从未预占；此时一律保留 worktree。
- 线索未知时保留目录，错误 detail 必须包含保留路径与后续操作（管理入口重试删除），
  不允许把 `failed` 当成 `not-created`。
- `forkTask` 保留 W6 的 settle 逻辑，并额外用父 workspace 的
  `session/releaseUnderDirectory { directory: worktreeRoot }` 查询子会话：
  任何 released/busy 都保留；`childSessionId` 与 ACK 不一致时一律不删除。

### 跨 Host 创建/删除租约

`creating`/`removing` 不能是 Host 进程内 `Set`。唯一事实改为
`<dataBaseDir>/.zcode/worktree-leases` 下的 per-worktree + per-source advisory lock 文件：

- acquire 用“临时文件写完整 JSON → `link()` 原子发布”，已存在即 `EEXIST`；
- 同一 worktree 的 `creating`/`removing` 互斥，同一源仓库的 create 与 remove 在
  “建目录 → 取得 per-worktree 租约”这段窗口内互斥，避免另一个 Host 删除刚建好、尚未登记的目录；
- 持有者只按 `pid` 存活性回收残留租约；**没有超时/重试猜测**。无法解析/无法证明已死的租约按持有处理，
  保守拒绝删除。
- `listWorktrees.creating` 由租约文件推导；删除前用锁的原子 acquire 取代“先读 Set 再删”。

### 终端占用必须读真实进程 cwd

`listTerminalIdsUnderPath` 不再只比较创建时的初始 cwd：

```text
Linux: /proc/<pty pid>/cwd + 其全部后代 cwd（按 /proc/<pid>/stat 的 ppid 建树）
非 Linux 或 /proc 读取失败: 无法证明 shell 没有 cd 进目标目录 → 保守视为占用
初始 cwd 在目录内: 占用
```

- 任何“占用/无法证明”都只让删除返回 `in-use/terminal`，**不关闭用户终端**。
- `releaseSessionsUnderDirectory` 成功后要再检查一次终端与任务行集合（新终端/新任务可能在 await 期间出现）。
- 已知限制（明确留账）：Linux 下脱离进程树的后台孤儿进程、非 Linux 平台无法读取真实 cwd，
  都按“无法证明无持有者 → 拒绝删除”处理。
