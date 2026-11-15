# Session control（独立 CLI 面）

实现规格：[`upstream-3.18-session-tools.md`](../../../.agents/specs/upstream-3.18-session-tools.md)。

公开入口：`@zcode/session-control/contracts`、`/cli`、仅测试用的 `/testing`。
工厂 `createCliSessionControl` 返回 8 个方法：listSessions / readSession / createSession /
forkSession / sendToSession / waitSessions / interruptSession / renameSession。

- 调用形态始终为 `(trustedContext, input)`。`TrustedContext` 只能由启动装配构造，
  模型输入不能提供身份、权限、workspace 或「能否读全库」。`readAnyLocalSession` 只放宽
  list/read，写操作仍只看 `allowedScopes` 与 owner fence。
- 目标会话：工具面只有 `sessionId`；端口 schema 允许 `session` 或 `sessionId` 二选一。
  工具层注入请求身份（`retryOf ?? toolCallId` → `requestId`），回执把它返回给模型对账。
- 结果在返回前按 schema 复验：越权引用、非 CLI 引用、view 不一致、fork 返回同一会话、
  `admission` 与 `delivery` 互相矛盾都是 `invalid_output`；输入不合法是 `invalid_input`。
- `waitSessions` 默认 30 秒、上限 300 秒；`timeoutMs=0` 只读取 baseline。`accepted` / `queued` /
  `running` / `idle` 不算完成；self-wait 与重复 operation 在访问端口前拒绝；epoch 变化或
  revision 不递增必须 `invalidated`（`unknown`）。取消只影响观察，不停止目标。
- 本包不保存 ledger、队列或重试状态：只做用例编排、授权前置检查与输出复验。
  owner 的准入、去重与执行队列仍在生产适配器与 Core `CommandInbox`。

App 面（ListProjects / OpenSession / SetSessionArchived / SetSessionPinned、`app-control` 协议、
客户端类 caller）尚未移植，见 spec「未完成」。
