# 上游 3.18.2 CLI 工具/权限面（F13–F17）

父片：`.agents/specs/upstream-3.18-sync.md`（C3 组）。上游固定 `fec97590`（3.18.2），区间
`3c5b2276..fec97590`。本片只做 F13–F17，不碰 C1（context/history）、C4（bootstrap create-app /
server）、F9/F10/F11/F12。

## 1. 范围与所有者

| 项  | 行为                                      | 唯一所有者                                       |
| --- | ----------------------------------------- | ------------------------------------------------ |
| F13 | 动态工作流每个 ask 的 WebSearch 预算      | driver 的 `SessionState` 计数；端口只读扣减      |
| F14 | `CronPauseSelf` 自暂停当前 automation     | Host 准入注入的 `automationId`（不是模型输入）   |
| F15 | Hook 自身出错的 `onError: allow \| deny`  | 每条 Hook 配置；runner 只执行决定                |
| F16 | 自定义命令 `!` shell 块移交 Bash 工具     | contracts 的 hand-off 改写；模型 / Bash 工具执行 |
| F17 | local 模式的 `LocalToolSearch` 独立工具名 | contracts 常量 + 可见性归一                      |

## 2. F13 每 ask WebSearch 预算

```text
startAsk(session)              → state.webSearchesUsed = 0（nudge/repair 轮不归零）
core WebSearch handler         → budget.charge()（同步）
  charged                      → 发内部模型请求
  exhausted(limit,message)     → ToolHandlerFailure{errorCode:2}，不发请求
```

- 计数唯一来源是 driver 会话状态（`webSearchesUsed` / `webSearchLimit`），端口按 sessionId 晚查，
  模型不能改路由；端口缺席 = 无预算（主会话、Agent 子代理）。
- 上限：persona 的 `budget.webSearch`，缺席用默认 128，钳制在 0–1024（非整数/负数回落默认）。
- 扣减点固定在 provider 能力校验之后、发请求之前，所以超额调用不产生任何内部模型请求；
  回失败而非正常结果，`errorCode` 让 `tool_usage` 的 error 计数可观测，不新增事件。
- 边界：`@zcode/dynamic-workflow` 引擎的 persona `budget` 类型/校验属另一片；本片按结构读取，
  引擎补上后无需改动。生产装配的最后一跳在 `create-app-dynamic-workflow.ts`（C4，见第 8 节）。

## 3. F14 CronPauseSelf

```text
Host 准入 automationId → RegularTurnLoopState.automationId
  → provider 边界：无 automationId 时 CronPauseSelf 进 disallowlist
  → executor 把 state.automationId 注入 ToolExecutionContext.automationId
  → handler：身份校验 → 输入校验 → 端口校验 → automationPort.pause({id})
```

- 输入 schema 是空严格对象：模型不能指定目标、不能改定义；`automationId` 只来自执行器注入。
- 不并入 `AUTOMATION_MUTATION_TOOL_NAMES`（那组是「执行轮隐藏」，本工具是「非执行轮隐藏」）。
- 注册门与 `CronList` 同门（`includeAutomation`），可见性由 turn 状态决定。
- 显式 Capability 失败：端口不支持 `pause` 时回明确 `ConfigurationError`，不返回假成功。
- 未接线（跨 writer，见第 8 节）：`automation/pause` 的 Host 侧 handler 与 shared 协议 schema。

## 4. F15 Hook `onError`

- 契约：`HookOnError = "allow" | "deny"`，`onError` 逐 Hook 可选，缺省 `allow`（= 引入前行为）。
- `deny` 只在 `PreToolUse`、且 Hook 真的运行过并失败时生效；用户中断（cancelled）不算失败。
- 生效形状与「退出码 2 拦截」同形：合并 `permissionDecision: "deny"`，事件发
  `HookRunBlocked` + `blockReason`，失败日志带上 `onError: "deny"`，`outcome = blocked`。
- 异步 hook / 未受信任而未运行的工作区 hook 不受影响。
- 判定与输出形状拆到 `core/src/hooks/on-error.ts`（runner 接近 max-lines 上限）。
- 边界：项目（workspace）hook 的 `onError` 需要信任摘要（`packages/shared/src/workspace-hook-digest.ts`、
  workspace hook config schema）与重新信任流程。TS 侧该摘要/审核已落地；Rust 对齐：`onError` 进入
  `domain::hooks::{workspace,digest}` 的 canonical entry 与声明摘要（加/改触发 `stale_digest` 重新审核），
  但 `workspaceEntryToHookConfig` 的等价实现（`workspace::registrations`）不把它转给执行注册，
  项目 hook 的执行失败语义仍按缺省 `allow`。`onError` 永远不是 HookEvent，不新增 `OnError` 事件。

## 5. F16 自定义命令 shell 块移交

- 所有权变更：CLI 不再执行 `!cmd` / ` ```! ` 块；改写成「来自 `/<name>` 命令文件
  （scope/source）」的说明 + `bash` 代码块，由模型的 Bash 调用执行，权限服务决定放行/询问/拒绝。
- 改写早于参数替换：参数文本永不被当成 shell 块。
- 插件变量就地替换（`*_PLUGIN_ROOT/_DATA/_ID/_NAME`，Windows 反斜杠改正斜杠）；`*_SKILL_DIR`
  等命令拿不到的变量整块不转交，改写为「未运行 + 原因」，避免审批时看到的命令与实际不同。
- 解析无失败路径：不再抛 `unsupported dynamic syntax`，`custom_command_unsupported_dynamic_syntax`
  诊断码随能力一起删除；`expandCustomCommandTemplate` / `formatCustomCommandPrompt` 收为内部函数。
- 删除 `bootstrap/src/custom-command-shell-expansion.ts`（原 CLI 侧执行器）。

## 6. F17 LocalToolSearch

- local 模式对外工具名是 `LocalToolSearch`，`ToolSearch` 保留为 registry 别名（模型可混用）。
- 可见性/权限/规则匹配归一：`normalizeToolNameAlias("LocalToolSearch") === "ToolSearch"`。
- 历史投影：`isToolSearchName` 判定成功搜索；请求副本按当前模式改名，不改原始历史与持久化。
- Native 模式仍用 `ToolSearch`；Off 模式不公告、不提升。

## 7. 验收

- `node:test`（本仓 runner，不用上游 vitest）：
  - `core/test/hooks-on-error.test.ts`：缺省 allow、deny 拦截、非 PreToolUse 不拦截、cancelled 不拦截。
  - `core/test/cron-pause-self.test.ts`：无 automationId 拒绝、忽略模型输入、只暂停注入 id、端口缺 pause 报错。
  - `core/test/websearch-budget.test.ts`：耗尽不发请求且 `errorCode=2`、有预算正常扣减。
  - `core/test/tool-search-local-alias.test.ts`：别名归一、local 暴露名、请求副本改名。
  - `core/test/tool-search-exposure.test.ts`：local 模式断言改为 `LocalToolSearch`。
  - `contracts/test/custom-command-handoff.test.ts`：改写先于参数替换、块内 `!` 不被执行、provenance、变量。
  - `bootstrap/test/workflow-web-search-budget.test.ts`：默认/自定义上限、耗尽文案、无在飞 ask 不拦。
  - `bootstrap/test/hook-on-error-config.test.ts`：用户配置/插件 hooks 的 `onError` 到达注册表。
  - `bootstrap/test/tool-search-cli-e2e.test.ts`：真实 loopback 断言 local 暴露名（别名仍可调用）。
- 全量：`pnpm --filter @zcode/{contracts,core,bootstrap,cli} typecheck`、`pnpm typecheck`、`pnpm lint`。

## 8. 未接线与移交（exact manifest）

已接线（本片完成）：契约常量/端口、core handler 与注入、executor 传递、runtime 字段、driver 计数与端口、
自定义命令 hand-off、Hook `onError` 契约与 runner、可见性归一与历史改名。

仍需跨 writer 的接线（**未接线，不计完成**）：

| 位置                                                                                                    | 需要的改动                                                                                                                                                                                                                               | 归属                        |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `packages/shared/src/zcode-protocol/index.ts`                                                           | `zcodeProtocolMethods.automationPause: "automation/pause"`；`zcodeAutomationPauseParamsSchema = z.object({ automationId: z.string().min(1) }).strict()`；`zcodeAutomationPauseResultSchema = z.object({ paused: z.boolean() }).strict()` | shared 协议（集成）         |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/automation-port.ts`                               | `async pause(input) { const r = await context.requestClient(zcodeProtocolMethods.automationPause, { automationId: input.id }, zcodeAutomationPauseResultSchema); return r.paused; }`（随后可把 `AutomationPort.pause` 收紧为必选）       | CLI bootstrap（依赖上一行） |
| `packages/services/src/zcode-agent/zcodeAgentService.ts`                                                | 处理 `automationPause`：仅 active+enabled 转 paused，返回 `{paused}`                                                                                                                                                                     | Host 服务（D1/集成）        |
| `apps/zcode-cli/packages/bootstrap/src/app/create-app-dynamic-workflow.ts`                              | `createActorRuntime` 入参解构增加 `webSearchBudgetPort`，并在 `deps` 增加 `webSearchBudget: webSearchBudgetPort`（否则 F13 在生产装配里没有预算；driver 与端口已就绪）                                                                   | C4                          |
| `apps/zcode-cli/packages/bootstrap/src/app/create-app-runtime.ts`                                       | 删除传给 `resolveZCodeCustomCommandPrompt` 的 `executionPort`/`sessionId`/`signal`/`traceContext`（解析已不读；`@deprecated` 字段仅为兼容此调用点）                                                                                      | C4                          |
| `apps/zcode-cli/packages/adapters/src/config/schema.ts`                                                 | `hookProcessSchema`/`hookCommandSchema` 增加 `onError: z.enum(["allow","deny"]).optional()`（行为已生效：`.passthrough()` 保留该字段并到达注册，测试已覆盖）                                                                             | 配置适配器（类型收紧）      |
| `packages/shared/src/workspace-hook-{config,digest}.ts` + `contracts/src/hooks/workspace-hook-trust.ts` | 项目 hook 的 `onError` 进声明摘要与 canonical entry（需重新信任），本片不做                                                                                                                                                              | 后续片                      |
