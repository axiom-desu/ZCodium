# remote-projects

本机远端项目入口 intent 的唯一 owner。Spec：`.agents/specs/upstream-3.18-worktrees-remote-projects.md`。

- 持久化只使用既有 `remote_project_entries`；连接/身份/在线事实仍归 `windowRemoteConnectionRegistry`。
- `membershipId` 来自连接 registry，写库前在同一事务内与 hosts 行 CAS；stale window 拒绝写入。
- `refreshDirectory` 只更新匹配且 `cached_deleted=0` 的入口；迟到响应不会重建已移除入口。
  远端删除只设置本机 `cached_deleted` 缓存，用于离线投影隐藏。
- `addEntry`（显式添加/恢复）清除 `cached_deleted`；`restoreEntry` 只清本机标记。
- `removeEntry` 只删本机 membership/cache，绝不发送远端删除；任务/历史数据不受影响。
- `readCatalog` = `composeProjectCatalog` 只读组合本机 ProjectService 项目与远端 directory；
  不新建第二业务 store，也不合并 connection facts。
- Renderer 只在本地 base attachment 创建 client 代理（`localHostServices`）；UI 的移除/恢复文案
  明确是本机入口/cache 操作，绝不是远端项目数据删除。
