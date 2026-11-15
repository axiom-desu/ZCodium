# 上游 3.18.2 F10 插件发现 / F9 会话读取活动分支（TS/CLI 片）

来源 `.cache/upstream-3.18.2@fec97590`（区间 `3c5b2276..fec97590`）：
`apps/zcode-cli/packages/contracts/src/{tools,interfaces}/plugin-discovery*`、
`bootstrap/src/plugin-discovery/*`、`bootstrap/src/zcode-protocol/plugin-discovery-port.ts`、
`packages/session-control/src/application/app`（仅读取分支语义）。

只读参考树未被修改。本片先写本 spec 再改代码；不提交、不改根 package/lock/policy/baseline/catalog。

## 归属与单一所有者

```text
模型工具意图 → Core 执行上下文（runtimeScope 门）→ 既有权限审批（唯一审批所有者）
             → PluginDiscoveryPort（唯一发现/安装意图所有者，bootstrap 侧）
             → 既有插件 store（overview / install / setEnabled / marketplace refresh）
             → 既有插件存储锁（withPluginStorageLock）→ 落盘
激活判定 ← 既有 resolveZCodePlugins 结果（本会话已加载 = ready；未加载 = refreshRequired）
```

- **目录唯一**：候选集只从既有插件 store 投影（`getZCodePluginsOverview` + `resolveZCodePlugins`
  - `pluginReferenceCatalog`），不再新增第二份插件目录/缓存。`plugins/referenceCatalog`、
    `plugins/list` 与发现工具读同一事实源。
- **写入唯一**：安装/启用仍走 `installZCodeMarketplacePlugin` / `setZCodePluginEnabled`；
  发现端口不直接写配置文件，也不另建安装队列。
- **审批唯一**：`SuggestPluginInstall` 的确认不是新弹窗，而是既有权限审批通道
  （`alwaysAsk: true` + `askOptions: { allowAlways: false }`）——TUI/桌面/headless 各端
  已有的审批挂载点就是唯一挂载点；用户在审批里拒绝 = skip，工具不安装、不重试。
- **读取分支唯一**：`ReadSession(view=messages)` 只投影「当前活动分支」，回滚掉的旧分支
  不返回。投影函数由 Host 既有 rewind 账本 owner（`server-operations.ts`
  `projectActiveSessionMessages`）提供，CLI 侧不自造第二套 rewind 推导。

## F10 行为规则

1. `SearchPlugins`（只读，可并发）：`query` 必填；返回 ≤10 条候选 + `cursor` + `stale`。
   排序 = 名称精确/显示名精确分档 → BM25（名称权重 4、明细 b=0.75）→ `pluginId` 稳定平局。
   中文按 bigram 分词，跨标点/字段不拼接。游标绑定目录修订号；修订号变化 → `cursor_expired`
   显式失败，不静默从头搜（模型必须重搜）。
2. `SearchPlugins` 不得返回非法/冲突候选：非官方市场条目不出现；同名插件冲突
   （`conflictingPluginIds` 非空或已启用同名不同 id）整条剔除。
3. `SuggestPluginInstall`（写，独占）：只接受 `SearchPlugins` 返回的精确 `pluginId`。
   - 非官方市场 id → `unavailable`，不安装。
   - 已在目录里 `action: "none"`（已装且启用）→ `alreadyAvailable` + `activation`。
   - 已装未启用 → `enable`（只授权**当前 workspace**；用户级禁用与其他 workspace 覆盖不动）。
   - 审批通过后**强制重读目录**：`stale` → `unavailable` 且什么都没装；目录/安装态/范围
     与确认前不一致 → `unavailable`（要求重新确认）；重读后条目消失 → `unavailable`。
   - 安装/启用写入失败 → `failed`（错误来自既有 store 诊断，不伪造成功）。
   - 写后复验：`installed && enabled` 否则 `failed`；激活状态由既有插件解析结果给出：
     `ready`（会话已加载）/`disabled`/`needsConfiguration`（必填配置为空）/`refreshRequired`。
   - 同一 `sessionId + toolCallId` 的重复派发复用同一 Promise（有界 128 条），不同调用各自审批。
4. 失败关闭（不假装可用）：
   - `runtimeScope === "subagent"` 或未注入端口 → `ConfigurationError`，两个工具都不注册。
   - `taskType === "subagent_child"` → 不注册（与 `includeSessionControl` 同门）。
   - 远程/非本机 workspace 身份解析不出本地 root 时，`SuggestPluginInstall` 返回
     `unavailable`；`SearchPlugins` 仍只读。
   - 目录刷新单飞失败 → `stale: true`（工具结果显式告知过期），不把旧结果当新鲜。
5. 刷新：官方市场按 `lastUpdated` + 10 分钟节流；并发请求共享一次 flight；
   调用方取消只摘除自己的读者，最后一个读者取消才中止 flight；失去读者的旧 flight
   不得发布结果/节流时间。刷新失败不抛给搜索，只置 `stale`。

## F9 读取分支行为规则

6. `ReadSession(view=messages)` 只返回活动分支：按会话持久化的 rewind 账本
   （`RewindTriggered` 事件 + runtime 保存的 `keptMessageIDs`）裁剪；连续的 rewind 以账本
   为准，不用旧事件前缀推导；不可用的 rewind 事件（无 `createdMessageId`）不参与裁剪。
7. 读取不因裁剪而改身份：分页游标仍按裁剪后的顺序；`id`/`role`/`text` 语义不变；
   没有 rewind 账本的历史会话行为完全不变。

## 接口

`contracts`：

```ts
interface PluginDiscoveryPort {
  search(input: SearchPluginsInput, ctx: PluginDiscoveryContext): Promise<SearchPluginsOutput>;
  suggest(
    input: SuggestPluginInstallInput,
    ctx: PluginDiscoveryContext,
  ): Promise<SuggestPluginInstallOutput>;
}
```

`PluginDiscoveryContext` 只由 Core 执行上下文构造（`sessionId/turnId/toolCallId/traceId/signal`）。
端口不得从工具 JSON 读会话身份；`PluginActivationPort` 本仓不注入（回答 `refreshRequired`
之外的激活事实由既有插件解析结果给出）。

`ToolExecutionContext.pluginDiscoveryPort` 与 `AgentRuntimeDeps.pluginDiscoveryPort` 只透传，
不在 Core 内缓存候选或改写安装态。

## 验收场景（node:test，临时 HOME/XDG/DB，loopback）

- 搜索：命中/未命中、中文 query、名称分档、平局稳定、分页游标、游标失效、`stale` 透传、
  非官方与冲突条目剔除、结果上限 10 条。
- 安装：审批拒绝路径（端口未收到 apply）、`alreadyAvailable`、`enable` 只写 workspace、
  确认后目录变化 → `unavailable`、安装失败 → `failed`、写后复验、同 toolCallId 去重。
- 门：subagent/未注入端口 → 两个工具都不注册；`SearchPlugins` 只读，`SuggestPluginInstall`
  `alwaysAsk` 且不可 `allowAlways`。
- 读取分支：rewind 后旧消息不返回；连续 rewind；无 rewind 历史不变；分页游标仍正确。

## `plugins/mentionItems`（F10 补全，C8）

8. 协议方法 `plugins/mentionItems` 只在**已驻留会话**上执行，不冷恢复会话、不新建 MCP 连接。
   `pluginId` 先按会话冻结的 `getPluginReferenceCatalog()` 解析；插件不可用或同名冲突 →
   `plugin_mention_plugin_unavailable`。`tool` 只接受插件 MCP server 上的原始工具名（不含 `mcp__`）。
9. server 归属：按 `entry.mcpServerNames` 排序后第一个提供该工具的 server；工具不存在 →
   `plugin_mention_tool_not_found`；存在但 `getMcpToolVisibility` 不含 `app` →
   `plugin_mention_tool_not_app_visible`（只给模型的工具不能从 App 绕过）。
10. 调用走与 `mcp/uiCallTool` 同一条既有授权链 `callMcpToolForUi`（schema → PreToolUse →
    权限/审批 → 连接代际复验），不新增宿主旁路。拒绝 → `plugin_mention_tool_denied`；
    工具报错 → `plugin_mention_tool_failed`；`structuredContent.items` 不合严格 schema →
    `plugin_mention_result_invalid`（只报路径，不回显值）。
11. 候选严格 schema 在 `@zcode/shared`：`items[]` 上限 50，字段长度上限固定；不设计取消，
    App 只采用最新请求结果。

## 明确不在本片（未实现，不宣称完成）

- `packages/services` 的 mentionItems 客户端与 UI `@` 面板调用链：本片只交付协议契约 +
  bootstrap 处理面；services/UI 侧接入属其 owner，未接线。
- App 12 方法面（`appControl/*`：ListProjects/ListSessions/ReadSession/Create/Fork/Send/Wait/
  Interrupt/Rename/OpenSession/SetArchived/SetPinned + `appControl/cancel`）**未实现**：
  端口是 Desktop Host 的项目/导航/组织（`setArchived`/`setPinned`/`openSession` 属窗口 Host
  行状态），CLI 侧没有该事实源，本仓当前也没有 app-control 协议面；本片没有留半成品类型。
  接入时的落点见本文件末尾「接入清单」。
- 遥测/账号鉴权/off-peak/highspeed/CUA 休眠帧未恢复；无新增第二 runtime、队列或远端 manager。

## 接入清单（后续批次）

1. `packages/shared/src/app-control/contract.ts`：12 方法 + `cancel` 严格 schema，绑定
   `@zcode/session-control/contracts` 的 App 变体。
2. `packages/session-control/src/contract/app.ts` + `application/app/index.ts`：端口化用例层
   （access/sessions/execution/observations/projects/organization/navigation/deadlines）。
3. Desktop Host：`appControl/*` 分派到既有项目/会话/窗口 Host 行 owner；`openSession` 复用
   绑定窗口路由；`setPinned/Archived` 复用 Host 行状态唯一写入口。
4. TUI/桌面审批：沿用本片 `SuggestPluginInstall` 审批挂载；`appControl/cancel` 只取消观察。
