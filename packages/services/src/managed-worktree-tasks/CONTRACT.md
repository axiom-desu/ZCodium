# managed-worktree-tasks

受管 Git worktree 的唯一服务 owner。Spec：`.agents/specs/upstream-3.18-worktrees-remote-projects.md`。

- 事实来源：`GitWorktreeRepo`（`git worktree list` + 受管布局 + git-common-dir 反向验证）与 tasks-index
  `tasks.worktree_root`。服务不缓存 worktree 列表，也不维护第二份任务/运行状态。
- 本地模型：任务 workspace 就是 worktree 根目录，`workspaceIdentity` 必须为空；远端 Host 不注册此服务。
- 创建/ fork 先要求 CLI 的 `runtime/capabilities.worktreeCwd`；旧 CLI 返回 `unsupported-agent`。
- 创建：`createTask` 只在项目 primary root 所属仓库创建，随后调用既有 Host 会话入口
  `zcodeAgentService.createSession`（预分配 sessionId）→ 项目 `reserveCreatedTask(worktreeRoot)` → CLI CommandInbox。
  会话启动失败时**不得猜测未创建**：只有现有 receipt 明确释放了未认领预留，
  且 CLI `session/releaseUnderDirectory` 证明目录内无驻留会话时，才清理本次新建 worktree；
  其余情况保留目录并返回带保留路径的可操作 `session-failed`。
- fork：`forkTask` 从父任务 cwd 新建受管 worktree，预分配 `childSessionId` 并在同一事务预留任务归属，
  再发真实 v4 `forkAssistant { target, targetCwd { cwd, childSessionId } }`；CLI 子会话 cwd 必须是该目录。
  失败时只有能证明未认领、且父 workspace 的 `session/releaseUnderDirectory` 报告目录内无会话时
  才回滚本次新 worktree；childSessionId 与 ACK 不一致一律保留。
- 跨 Host 创建/删除租约：`<dataBaseDir>/.zcode/worktree-leases` 的 per-worktree + per-source
  advisory lock（pid 存活回收，无超时猜测）；不使用进程内 Set 充当全局事实。
- 删除闸门顺序：受管归属 → 源仓库/删除租约（原子 acquire）→ 活跃任务（syncer live active-set）→ 共享目录引用
  → force+任务 → 终端 cwd（Linux 读 PTY 进程/后代真实 cwd；非 Linux 或无法证明时保守拒绝）
  → dirty → 项目 CLI `session/releaseUnderDirectory`（等待真实 ACK；busy/running 或请求失败即中止）
  → 再检查终端/任务集合（await 期间可能新增）→ 重新验证受管归属 → Git remove。
  任意用户仓库/非受管路径一律 `not-managed`；不关闭用户终端。
- 任务释放：`listTasksByWorktree` 只读未删除行；任务行释放（删除/CLI 删除事实）后 dirty/引用检查通过
  即可删除。force 不能替代释放任务。
- 公开入口：`index.ts`、`contract.ts`。`ports.ts` 只由 Host composition 使用。
