# A1 — App control、插件 mention caller 与启动预算接线

父规格：`.agents/specs/upstream-3.18-sync.md`；基线核对：`/tmp/sync318-coverage-audit.md`、`/tmp/sync318-C5-result.md`、`/tmp/sync318-C8-result.md`。官方只读源 `.cache/upstream-3.18.2@fec97590`。

## 状态所有者与顺序

```text
App/可信 caller → 服务端反向 RPC → active CLI session binding/lease → session-control use case
  ├─ Send/Fork/Wait/Interrupt → 既有 runtime/CommandInbox/SessionStore/权限审批
  ├─ project/session listing → 既有 ProjectService/TaskService
  └─ OpenSession/Archived/Pinned → 既有 window Host navigation/task row owner

Composer @plugin → services ZCodeAgent client → plugins/mentionItems（已驻留 session）
  → callMcpToolForUi（原授权链）→ 版本绑定结果 → 最新请求更新 UI

startup → bootstrap real entry (bounded default) → 原插件发现/初始化 → 预算内结果或可诊断降级
MCP trust change → event → 每个已驻留 runtime 的插件/MCP refresh owner（不启动新 runtime）
```

App 12 方法复用 `packages/session-control` 和 Host 现有项目、会话、Task 与窗口导航权威；不引入独立 App runtime、接受队列、导航真相或存储。`cancel` 只终止同调用身份的观察，不隐式停止执行。所有调用绑定 `workspaceIdentity?.trim() || workspacePath`、source/connection lease 与 generation；异步后复验，迟到结果不得写入新绑定。桌面 continuous 和 Web replayable 边界不混用。根 TUI 权限/审批保持现有唯一挂载。

插件 mention 服务只请求当前已绑定会话；变更请求计数保证 UI 仅应用最新响应。真实激活状态由插件 store/runtime 得到，禁止默认把 `refreshRequired` 当作 ready。启动预算必须在默认正式启动入口生效且可通过有界选项覆盖；降级是可观测 warning，不得掩盖 MCP trust fail-closed。

## 验收

- 12 个 App 方法 + cancel 严格协议、reverse-RPC/window bridge fixture、SQLite/真实 Host owner；核验权限、scope identity、lease stale、取消只取消观察、路由与单 owner。
- Chromium 真实 Composer mention component 从真实客户端请求候选，latest-response wins；bootstrap protocol fixture 验证权限拒绝/失效连接；插件经 refresh 后 activation ready。
- 真实默认 app startup 触发有界预算；超时有 warning、迟到插件结果不会污染启动；MCP trust admission update 只刷新已驻留 owner且拒绝仍 fail-closed。
- 新增源码每文件 ≤400 行；更新对应模块契约/manifest，按需在 `/tmp` 输出依赖清单；不改锁/策略/baseline/生成物。
