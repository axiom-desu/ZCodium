# 上游 3.18.2 A5：App control 十二意图 + 反向 RPC（TS 片）

上游来源 `.cache/upstream-3.18.2@fec97590`（`packages/session-control/src/{contract/app,application/app}`、
`packages/services/src/app-control/*`、`packages/desktop/src/app-control-navigation/*`）。先契约后实现。

## 归属与单一 owner

```text
模型工具意图（CLI core: List*/Read/…）
  → CLI 侧 AppSessionControl 绑定（只传输，不建 runtime/队列）
  → 既有 CLI↔Host stdio 连接（requestClient → Host 的 client.onRequest）
  → Host 唯一 AppControlService.bind()（只从这条实际连接构造可信上下文）
  → 既有 owner：项目(readTree/readProjects/prepareSession)、任务(create/send/stop/rename/pin/archive)、
     正文(IZCodeAgentService.readSessionMessages)、导航(AppControlNavigationPort → 窗口 Host → Main → renderer)
```

- **不新建**第二项目目录、第二会话队列、第二导航 owner，也不新增 remote manager。
- 十二个意图封闭：`listProjects/listSessions/readSession/createSession/forkSession/sendToSession/
waitSessions/interruptSession/renameSession/openSession/setSessionArchived/setSessionPinned` + `appControl/cancel`。
- `cancel` 只取消同一实际连接内该 callId 的观察，不中断目标任务。
- 手机/Web/远端 Host 默认拒绝：`createLocalServices` 只有显式注入 `appControl` 时装配；
  没有导航 owner 时 `openSession` 返回 `unavailable`，不回退到别的导航方式。
- `forkSession` 在本 Host 没有「按稳定消息边界 fork」的 owner：明确 `unavailable`，
  `availableActions` 不列 `forkSession`。

## 不变量

1. 身份只由 `AppControlBinding` 产生（连接代际 `connectionId`、`callerSessionId`、绑定窗口 `uiTarget`）；
   模型参数不提供身份、权限或绕过。`assertCurrent()` 只核对连接代际，永远同步抛错。
2. 跨 Host：`sourceServerId` 不一致、会话不在本 Host 目录快照、(workspacePath, workspaceIdentity) 不一致、
   会话项目来源不一致 → `forbidden`，且不调用任何写 owner。
3. 读取正文只走 `readSessionMessages`（CLI 持久只读接口），不 resume、不标已读、不制造导航事实。
4. `createSession` 目录由项目 owner `prepareSession` 冻结；首条输入与创建分别报告。
5. `interruptSession` 只在已确认 `running` 时发 `stopGeneration`；否则 `rejected(not_running)`。
6. 导航只在导航 owner 真正完成后返回 `opened`；Main 只做路由，不成为导航 owner。

## 验收（`packages/services/test/appControl.test.ts`，node:test）

- list/read/send/openSession 走真实用例层，导航收到绑定窗口；`searchScope` 来自本 Host 项目归属。
- 跨 Host 目标、未知调用方根、无导航 owner 的 availableActions 均有负向断言。
- 连接代际变化后，导航端口拿到的绑定同步失效。
- 反向 RPC：未装配服务 → `unavailable`；无效取消参数 → `-32602`；非 appControl 方法不认领。
- session-control/Core 既有 CLI 用例与 12/12 契约测试保持通过。

## 明确未完成（本片不宣称）

- **Desktop `app-control-navigation`（Host↔Main↔renderer 的窗口导航传输）与 renderer 注册/激活未接线**：
  端口 `AppControlNavigationPort` 已存在且被测；`packages/desktop/src/app-control-navigation/` 与
  main/preload/renderer 的路由尚未移植，因此真实 Electron 窗口打开仍走旧 UI 路径。
- **CLI 注册面**：`createAppSessionControlTransport`（`bootstrap/src/app-control`）与
  `appSessionControlTools`（12 个 `ToolEntry`）已实现，但尚未在 `server-operations`/`create-app`
  按 `appControlEnabled` 注入绑定与工具表，故模型目前看不到这 12 个工具。
- `plugins/mentionItems` 的 services/UI `@` 面板调用与激活后 refresh 端口仍未接。
