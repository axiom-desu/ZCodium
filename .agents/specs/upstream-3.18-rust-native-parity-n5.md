# N5 Rust native parity: CronPauseSelf 与剩余原生工具缺口

本文件收口 N1/R3 明确列为「未实现」的 Rust native 工具面。范围仅 Rust
（`apps/zcode-cli-rust/**`）；TS 侧 `CronPauseSelf` 与 Host `automation/pause` 权限已存在
（`apps/zcode-cli/packages/core/src/tool/handlers/cron-pause-self.ts`、
`packages/services/src/zcode-agent/zcodeAgentService.ts` 的 `automationPause` 分支），本片不改 TS。

来源：`.cache/upstream-3.18.2@fec97590`（行为参照）、本仓 TS 契约（schema/文案/权限键的事实源）。
MBearo Rust 树仅作参考，不作为接线依据。

## 1. 单一所有者与事件顺序

```text
Host 信封（payload.automationId 或 inputId = automation-<id>[:…]）
  → Rust Submission（唯一准入事实，进程内，不落 intent）
  → Engine.run.RunContext.automation_id（本轮唯一副本）
      ├── 工具可见性：CronPauseSelf 仅在本轮有该值时注册（agent_loop）
      └── 执行边界：tool_execution 只把该值交给 AutomationPort
  → AutomationPort（core 生产适配器 = Engine 事件通道，公开 trait 在 core-api）
  → Event::HostRequest → Engine 生成 requestId（不写进 params）
  → ServerMsg::HostRequest { id, method:"automation/pause", params:{automationId} }
  → Host（既有 automationOwner：lastAdmittedAutomationIdByWorkspace 校验）
  → automationService.pause → {paused:boolean}
  → ClientMsg::HostReply(id) → Engine waiters → 工具结果
```

- **身份唯一**：暂停目标只来自 Host 准入的本轮 `automationId`。工具输入是严格空对象，
  模型无法提供 id；`AutomationPort` 不接受外部 id 参数。
- **请求 id 唯一**：`automation/pause` 的 Host schema 是 strict（只允许 `automationId`），
  所以 requestId 由 Engine 生成并只在 Engine 的 waiter 表里存在，不进入 `params`。
- **队列唯一**：不新增 accepted 队列；工具执行仍由 `EngineCommandInbox` 准入后的 run 驱动，
  Host 往返只经 `waiters` + `outbox`。无第二 runtime / store。
- **停止/关闭**：waiter 的 owner 是本轮 session，`release_waiters(session)` 会一并撤销，
  工具得到取消错误，不产生假成功。
- **无应答方**：TUI 与无头驱动没有 Host 应答方，按既有约定对该请求回 `null`
  （`tui/src/client_observe.rs`、`headless/src/driver.rs`），于是工具按「Host 未给出结论」失败，
  不会静默成功。

## 2. 行为规则

1. `CronPauseSelf` 定义与 TS entry 一致：严格空输入 schema、`shouldDefer`、
   `permission: "automation.pause"`（risk `medium`、scope `workspace`、`needsApproval: false`）、
   结果 budget 32 000 字节截断。
2. 可见性：仅当本轮 `automation_id` 非空时注册（`agent_loop` 过滤），否则从定义中移除；
   子代理 profile、会话 tools 过滤、tool disallowlist 仍按既有顺序生效。
3. 执行顺序与 TS 一致：先判定本轮身份（无 id → `PermissionDenied` 文案
   “CronPauseSelf is only available while running a scheduled automation.”），再校验输入
   （多余字段 → 输入校验失败，绝不读取其中的 id）。Rust 的 `AutomationPort` 由本 run 的事件
   通道构成，因此“port 未配置”这一 TS 分支在 Rust 不可达；等价事实是 Host 端不支持（`-32601`），
   见下一条。
4. Host 结果只接受严格 `{paused: boolean}`：
   - `{paused:true}` → “Paused automation <id>. It will not run on schedule until the user resumes it.”
   - `{paused:false}` → “Automation <id> is not active (already paused, completed, failed, or deleted),
     so nothing changed.”
   - 任何其它形状（含空/`Null`：旧 Host 的 `-32601`、Host 拒绝的 `-32602`）→ 工具失败并带
     “automation/pause was rejected by the Host”，不返回假成功。
5. 取消：等待期间 run 被停止/取消 → 失败且文案为取消语义，不写暂停结果。
6. 不落库：可见性/身份不进入 session 事实；冷恢复后由新的输入信封重新决定。

## 3. 明确缺口（不得宣称完成）

- **8 个 native session-control 工具**（`ListSessions`/`ReadSession`/`CreateSession`/`ForkSession`/
  `SendMessage`/`WaitSession`/`InterruptSession`/`RenameSession`）未落地：TS 的授权事实源是
  `packages/session-control` 的 `allowedScopes`/owner fence/requestId 回执，只在 standalone CLI
  根注册。Rust 有 `session/list`、`session/read`、`session/create`、`session/fork`、`stop`、
  `session/title` 等 Engine 命令，但没有该授权层与 standalone 根标记；直接注册工具会绕过 fence。
- **插件发现 `SearchPlugins`/`SuggestPluginInstall`** 未落地：目录/安装 owner 在 TS
  （`getZCodePluginsOverview` / `installZCodeMarketplacePlugin` / `withPluginStorageLock`），
  Rust 只有冻结的 `plugin_catalog` 只读投影，没有安装授权与目录修订号。
- **WebSearch 每 ask 预算** 未落地：消费者必须由 workflows/ask owner 计费，Rust 没有该 owner 端口；
  不以任意轮次推断 ask 边界。
- **workspace MCP grant** 仍 typed unavailable：provenance/digest/持久化锁权威在 TS，
  Rust 不得自建第二信任库。
- 工具级 timeout（TS `CRON_TOOL_TIMEOUT_MS = 30s`）在 Rust 工具层没有通用实现，本片不新增
  第二套计时器；等待由 run 取消/stop 收口。

## 4. 验收

- 域测试：空 schema 严格性（含伪造 `automationId` 被拒）、身份优先于输入、Host 结果形状穷举、
  文案与 data 一致。
- Engine E2E（真实 NodeStore + loopback provider + 真实 WorkspaceTools）：
  1. `payload.automationId` 与 `inputId` 前缀两条注入路径都能让 `CronPauseSelf` 出现在请求 tools，
     且 `automation/pause` 的 params 恰为 `{automationId}`（无额外键、无模型输入）；
  2. 普通轮不注册该工具，强制调用返回身份错误且不发 Host 请求；
  3. `{paused:true}`/`{paused:false}` 两条成功语义；
  4. Host 拒绝（回执为空）→ 工具失败，无“Paused”假成功；
  5. 冷恢复后普通轮仍不注册。
- `cargo fmt --all -- --check`、`cargo clippy --locked --workspace --all-targets -- -D warnings`、
  `cargo test --locked --workspace`。
