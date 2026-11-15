# 上游 3.18.2 整合接缝（I1）

范围：`.cache/upstream-3.18.2@fec97590`，`3c5b2276..fec97590`；Rust 参考只读。
本片只做并行 writer 已声明但未接线的共享接缝与 UI/策略注册，不新建第二 owner、不改参考树、
不恢复遥测 / off-peak / request-auth / highspeed 执行分叉 / CUA 休眠帧。

## 1. 单一所有者与事件顺序

```text
CronPauseSelf: CLI loop(activeAutomationId) → CommandInbox turn → executor context
  → AutomationPort.pause(id) → automation/pause → Host 最近准入 id 校验
  → AutomationRepo.pause（DB 单写者，active+enabled→paused）→ {paused}
```

- `automationId` 的唯一来源是 Host 准入写入的 loop 状态；Host 另存「本 workspace 最近准入 id」，
  请求参数与该记录不一致时返回 `-32602`，不得凭参数暂停任意任务。
- 条件暂停由 `AutomationRepo` 一次 UPDATE 完成；先读后写在并发下不是唯一真值，服务层不得另存状态。

```text
Workspace MCP 信任：mcp/list（只读 workspaceTrust）→ 设置页行内 Review
  → IMcpSyncService.setWorkspaceMcpTrust → Host read-only client → workspace/mcp/trust
  → bootstrap workspace-mcp-trust（锁 + 摘要重验 + 原子私有写）→ 下次 mcp/list connect 生效
```

- 摘要只来自 `mcp/list`；UI 不自行计算、不缓存授权状态。拒绝/摘要变更必须显式提示。
- 手机 / Web 新方法默认拒绝（`MOBILE_MCP_SYNC_ALLOWED_METHODS` 不放宽）。

```text
Plugin 后台保留页执行：pluginUiPageRetention（声明 backgroundRetention 且 4 页软阈值）
  → plane.setExecutionActive(active) → preload zcodePluginSandbox.setExecutionActive
  → Main ipcMain（owner/当前 guest 校验）→ guest.setBackgroundThrottling(!active)
```

- 旧 preload 无桥面时保持 Electron 默认节流，不伪造已解除；旧 sandboxId 的迟到请求不得影响换代 guest。
- 嵌套 frame 的导航生命周期仍由 `guestPolicy` / `isSandboxDocumentNavigation` 判定，桥面只改节流。

## 2. 配置 / Hook

- 用户与插件 hook：`hookProcessSchema` / `hookCommandSchema` 增加 `onError: allow|deny`（与 contracts 同词），
  配置 `.passthrough()` 保留到注册；缺省 allow 不变。
- 工作区 hook：`onError` 进入 `workspace-hook-config`、canonical entry、`WORKSPACE_HOOK_SCHEMA_FIELDS`
  与声明摘要 payload。摘要变化触发一次重新信任（stale_digest），不绕过审核；执行语义仍为缺省 allow。
  Rust 侧同形：`domain::hooks::workspace::Entry.on_error` 参与 `declaration_digest` 与 bundle 摘要，
  `registrations` 仍固定 `allow`，也没有 `OnError` 事件；`workspace-hooks.json` 由 TS oracle 重放生成。

## 3. v4 生命周期闸门

`v4/command` 在进入 CommandInbox 前调用 `assertV4CommandSessionReady`：`sessionLifecycle.isReady=false`
（stopping/starting/faulted）返回 `sessionUnavailable` + `{code:"runtimeNotReady"}`，与 legacy
`requireSession` 同义；`createSession`（sessionId=null）与非法信封保持原路径。

## 4. 预算装配

动态工作流 actor 的 `webSearchBudgetPort` 从 driver 会话 closure 经
`DynamicWorkflowActorRuntimeInput` → `createScriptWorkflowAgentRuntime` → runtime deps
`webSearchBudget`；计数只在 driver `SessionState`，`startAsk` 归零，无第二条计数路径。

## 5. 模块与注册

- `architecture-policy.yaml` 登记 `settings-search`、`ui-file-menu`、`session-control`（与各自 module.ts 一致）。
- 根 `package.json` 只登记测试入口（UI smoke / settings smoke）；`knip.json` 只加测试 fixture 与
  session-control 入口，不放宽任何棘轮基线。
- `packages/contracts` 的 public-export-surface fixture 按实际新增显式契约导出更新，不弱化断言。

## 6. 验收

- 临时 HOME/XDG/DB/loopback；真实 Chromium 只用隔离 profile。
- 重点：`automationPause.test.ts`、`mcpWorkspaceTrust.test.ts`、`workspaceHookOnError.test.ts`、
  `v4-stopping-fault.test.ts`、`upstream-318-ui-smoke.mjs`。
- 根 typecheck / lint / architecture:check 零新增；未验证的真实手机/远端矩阵在结果报告列明。
