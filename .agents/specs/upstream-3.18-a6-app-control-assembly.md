# 上游 3.18.2 A6：App control 生产装配（Desktop 导航桥 + Host 注入 + CLI 12 工具）

上游来源 `.cache/upstream-3.18.2@fec97590`（`packages/desktop/src/app-control-navigation/*`、
`packages/services/src/{node,zcode-agent/zcodeAgentService}.ts`、`apps/zcode-cli/.../server-operations.ts`）。
A5 只交付了契约与用例层（`packages/services/src/app-control`、`packages/session-control` 的 App 契约、
`bootstrap/src/app-control` 传输）。本片补完**真实装配**：没有注入的服务、没有窗口桥、没有工具注册面都视为未完成。

## 归属与单一 owner

```text
CLI 模型工具（12 个 App 变体）
  → CLI App binding（只传输；身份=执行上下文）
  → 既有 CLI↔Host stdio（client.onRequest）
  → Host 唯一 AppControlService.bind()（连接事实）+ 既有项目/任务/正文 owner
  → AppControlNavigationPort（desktop/app-control-navigation hostBridge）
  → parentPort 消息 app-navigation-open/cancel（Host→Main）
  → Main 窗口 surface（BrowserWindow + renderer generation）
  → preload IPC（zcode:app-control-navigation）
  → renderer Root 公开动作（addTab / activateTabByPath / setActiveTaskId）
```

- 导航 owner 仍是 renderer 的 Root/actions；本片**不新建**导航 store、第二任务队列或第二项目目录。
- Host 只持有在途请求关联；Main 只按可信窗口注册表路由，不成为导航 owner。
- 12 个 App 工具只在 `appControlEnabled === true`（Host 可信初始化能力）时注册；独立 CLI 仍走原 8 个 CLI 工具。
- 手机/Web/远端 Host 不注入 `appControl`，不注册该 IPC 能力，`openSession` 保持 `unavailable`。

## 不变量

1. **能力来源**：CLI 的 `appControlEnabled` 只来自既有 `session/requestRuntimePreferences` 的 Host 回包；
   Host 侧取值 = 本 Host 是否真的装配了 AppControlService（`resolveAppControlService()`）。
   旧 Host / 独立 app-server / 兼容 fallback 一律 `false`，不回退成 App 工具。
2. **绑定不可伪造**：App binding 的 `sessionId/workspacePath/workspaceIdentity` 来自会话物化参数；
   `callerSessionId/callId/turnId` 由工具执行上下文注入；子代理、非主根 taskType、根会话不符时不注册也不执行。
3. **窗口绑定**：`uiTarget` 只来自 Main 在 `init-local` 中给出的 `window:<BrowserWindow.id>`；
   Host 不接受模型或 CLI 自报。Main 的显式目标只从当前窗口注册表解析，缺失即 `ui-target-unavailable`，不回落到当前窗口。
4. **generation**：renderer 注册一个 generation；reload/`render-process-gone`/窗口关闭使 generation 与全部 pending
   失效；旧 generation 的回执不能被新请求接受。
5. **关闭/替换清理**：Host 退出 dispose 桥并取消在途；Host 进程替换/窗口关闭由 Main `child.once("exit")`
   解绑并 `detach` 全部 pending；renderer 卸载 abort 在途并 `unregister`。无超时推断。
6. **真实提交才 opened**：只有 renderer 实际完成 tab 激活 + 任务切换后的回执返回 `opened`；
   发送事件本身不代表打开。取消/超时/旧代际一律 `unavailable`。
7. **审批 owner**：App 工具沿用既有 `needsApproval`/permission 通道，owner 是执行会话本身；
   本片不新增第二条审批路径，也不让工具绕过 owner 读取/写目标会话。

## 验收（真实执行）

- `packages/desktop/test/appControlNavigationLoopback.test.ts`（vitest）
  - Host bridge → Main `bindAppControlNavigationHost`（fake UtilityProcess/BrowserWindow）→
    renderer `registerAppControlNavigationHandler` → 真实 Root 动作函数：list/read/send/openSession
    经 `createAppControlRequestHandler` 反向 RPC 落到 renderer 公开动作，`openSession` 返回绑定窗口。
  - 负向：未注册 generation、旧 generation 回执、显式外部窗口目标、跨 Host/未知调用方、
    renderer 卸载后取消、Host dispose。
- `apps/zcode-cli/packages/core/test/session-control-tools.test.ts`：App 变体 12 个、子代理/异根拒绝、
  CLI 8 个保持。
- `apps/zcode-cli/packages/bootstrap/test/app-control-binding.test.ts`：`appControlEnabled` 门、
  装配 12 工具、独立 CLI 8 工具、传输层拒绝伪造根/子代理、取消只释放观察。
- `packages/services/test/appControl.test.ts` 既有 6 项保持。

## 明确不做

- 不移植 SCT07 远端只读发现解析（本仓尚无该 source registry 合同）。
- 不新增 E6 extensions / B6 browser 域能力。
- `plugins/mentionItems` 的 UI `@` 消费者如未闭环，在本片结果中明说，不冒充完成。
