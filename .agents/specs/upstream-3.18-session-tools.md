# 上游 3.18.2 会话控制工具 / 插件发现（C5）

## 范围与来源

- 上游：`.cache/upstream-3.18.2@fec97590`
  - 根包 `packages/session-control`（`contract/*`、`domain/*`、`application/{common,cli}`、`testing`）
  - `apps/zcode-cli/packages/core/src/tool/{types.ts,session-control/*,handlers/index.ts}`
  - `apps/zcode-cli/packages/bootstrap/src/{cli-session-control/*,app/{create-app.ts,types.ts}}`
  - `apps/zcode-cli/packages/cli/src/{prompt-command.ts,tui-prompt-handler.ts}` 的 `standaloneSessionControl: true`
- 本仓基线：`feat/upstream-3.18.2-sync`，既有 owner：`SessionStorePort`（持久事实）、
  `ZCodeApp`/`AgentRuntime`（每会话唯一执行所有者）、`CommandInbox`（accepted 输入队列）、
  权限服务（`permissionService`/`permissionBroker`）。
- 本片只做 F9 的**独立 CLI 8 个会话工具**与包内公共契约。App 面（ListProjects / OpenSession /
  SetSessionArchived / SetSessionPinned、`app-control` 协议、客户端类 caller）**不在本片**，
  见「未完成」。F10 插件发现同样未在本片完成。
- Rust 参考（MBearo）无对应实现：本片不宣称 Rust 对等，Rust 侧 `session_control` 无蓝图。

## 单一所有者与事件顺序

```text
模型工具调用（8 个 Session* 工具）
  → core 工具层：只做 schema 校验 + 请求身份注入（retryOf → requestId）
  → CliSessionControl（packages/session-control，纯用例层）
       resolveSessionId（可信端口在本机会话库解析完整引用）
       → 授权（allowedScopes + owner fence）
       → 端口调用（sessions / execution / observations / deadlines）
  → bootstrap cli-session-control（真实适配器）
       create → createZCodeApp（独立 root，新 sessionId）
       send   → 既有 CommandInbox / executeTurn（root.prepared 后走原 FIFO；无第二队列）
       fork   → 既有 forkStableConversationAtMessage + 新 root app
       wait   → 订阅 SessionEvent 投影的 operation 快照（只观察，不驱动执行）
       interrupt → runtime.stopActiveForegroundExecution(expectedExecutionId)
       rename → app.setCustomSessionTitle
```

- 执行队列唯一所有者仍是 Core `CommandInbox`；适配器只保留**幂等回执**（requestId → 结果）与
  **operation 观察快照**，不缓存 accepted 输入，不重试 mutation。
- 身份：`workspaceIdentity.trim() || workspacePath` 为 workspaceKey；CLI 引用 = workspace + sessionId。
  会话 ID 兼容 `sess_*` 与历史 `session_*`，按原身份精确查找，不改写前缀。
- 子代理不可逃逸：`runtimeScope === "subagent"` 或绑定根与会话不一致直接 `forbidden`；
  任务成员关系由 `taskType` 收口（非 interactive/fork/workflow_parent 不注册也不执行）。
- wait 语义：`accepted/queued/running/idle` 不算完成；`completed/interrupted/failed/needs_attention`
  满足条件；`timeoutMs=0` 收齐全量快照后再判断；self wait 与重复 operation 在访问端口前拒绝；
  epoch 变化、revision 不递增、身份变化一律 `invalidated`（`unknown`）。
- wait 不得克隆可信上下文：App control 等的连接事实是 WeakMap 身份绑定，`{...ctx}` 会丢绑定
  使 waitSessions 失败；取消通过显式 signal 传给 observation port，授权仍用原 ctx。
  App 观察的 initial 必须是 owner 真实快照，否则合成 unknown 会让 wait 立即结束。
- 工具名用 PascalCase（`ListSessions`…），权限键 `session_control.<method>`；结果 budget 走 artifact，
  超时/取消时错误文案携带 `requestId`，模型只能以 `retryOf` 对账。

## 失败语义

- 无绑定（`context.sessionControl` 缺席）、kind 不符、根会话不符 → `forbidden`；
  工具层不再回退到别的 surface。
- 端口解不出 sessionId、引用越权、owner 未验证、workspace 不符 → `forbidden`/`unavailable`；
  返回引用越权、view 不一致、fork 返回同一会话 → `invalid_output`。
- 同一 requestId 不同请求体 → `conflict`；mutation 没有结论 → 回执 `unknown` 并保留身份。
- 适配器关闭后新请求 `unavailable`；未决 mutation 结算后 `close()` 才返回。

## 兼容与迁移边界

- 不新增 runtime、accepted 队列、跨进程 owner 路由；命令、远端鉴权、账号与遥测一律不恢复。
- `ZCodeAppOptions.standaloneSessionControl` 只在独立 CLI 根启用；桌面/远程 Host 会话不写该标志，
  因此这些入口不注册 8 个工具（无第二个控制面）。
- 新包 `packages/session-control` 需要主代理在 `pnpm-lock.yaml`、根 `typecheck` 与
  `architecture-policy.yaml` 登记；并行 writer 不自行安装或改锁。

## 验收

- 包内契约测试：schema 严格性、请求身份注入、授权/fence、self-wait、重复 operation、
  过期 revision、越权输出、未知回执。
- bootstrap 适配器测试：真实 `SessionStorePort`（临时 HOME/XDG）+ 真实 `ZCodeApp`
  与权限服务，覆盖 list/read（含历史会话只读）、create→send→wait 终态、并发 admitted 排队、
  interrupt 期望执行不符、rename、fork 边界、取消未决等待、关闭后拒绝。
- `pnpm --filter @zcode/session-control typecheck|test`、`--filter @zcode/core`、
  `--filter @zcode/bootstrap`，以及 `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`。
