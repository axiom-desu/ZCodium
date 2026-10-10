# Computer Use 运行时：复用 cua-driver（单一实现）

## 决策

原生执行层不再自研。`createComputerUseRuntime()` 的实现复用唯一一个开源项目：

**`trycua/cua` 的 `@trycua/cua-driver`** —— MIT，Rust，npm `@trycua/cua-driver` / pip `cua-driver`
（当前 `0.28.x`），MCP over stdio + 同进程 TS/Python SDK + Electron 嵌入路径。

被否决的候选：

| 候选                              | 否决理由                                                                      |
| --------------------------------- | ----------------------------------------------------------------------------- |
| 自研 `desk-pilot`（Rust）         | 重复实现；四平台后端 + Wayland portal/libei 从零做，无 E2E 证据               |
| `lahfir/agent-desktop`            | 实际仅 macOS：`crates/linux`、`crates/windows` 是空壳（各 13 文件）           |
| `iFurySt/open-codex-computer-use` | 模型面与 Codex 同构，但 Windows/Linux 是"功能性第一版"，成熟度低于 cua-driver |
| `generic-cua-runtime.md` 方案     | shell 调 `xdotool` 等，等于自研原生层，且 Wayland 无输入路径                  |

选 cua-driver 的决定性证据：

- `rust/crates/` 四个平台 crate：`platform-macos`(97 文件)、`platform-windows`(81)、`platform-linux`(70)，另有 `cua-driver-uia`（Windows UIAccess worker）。
- `platform-linux/src/wayland/` 已有 `portal.rs`、`portal_screencast.rs`、`portal_screenshot.rs`、`libei.rs`、`ext_screencopy.rs`、`ext_toplevel.rs`、`hyprland*.rs`、`kwin_helper.rs`、`sway_ipc.rs`、`virtual_keyboard.rs`、`persistent_vptr.rs`。
- 公开 `docs/action-support.md` 逐平台/逐合成器 E2E 台账（Win32 122/122、macOS 145/145、X11 116/116、Sway 116/116、GNOME 46 GTK3 31/31）。
- `typescript/src/electron.ts` + `EmbeddedCuaDriverHost` + `Skills/cua-driver/EMBEDDING.md`：为"签名桌面 App 内嵌入、TCC 一次授权、子进程继承"设计，正是 ZCode 桌面端需要的形态。

## 非目标

- 不保留两条模型面。`desk.*` / `desk-pilot` 停止维护。
- 不移植闭源 `ZCode Computer Use.app`，不移植其 14 工具 envelope 契约。
- 不新写原生后端，不引入需要 root 的方案。

## 只保留一条链路

```text
模型 cell (node_repl js)
└─ @zcode/zcode-cua-plugin/scripts/*            模型可见面（保留，改写内部）
   │  Symbol.for("zcode.node-repl.computer-use-bridge")
└─ node-repl-host/src/cua-bridge.ts             通用，保留
   │  JSON 行 / socket
└─ node-repl-host/src/cua-broker.ts             通用，保留
   │  runtime.execute({toolName, arguments, context, signal})
└─ @zcode/zcode-cua  createComputerUseRuntime()  ← 本次唯一实现
   └─ @trycua/cua-driver                        ← 复用，唯一原生引擎
      ├─ 同进程 CuaDriver.create()             （Electron main 持有）
      └─ 或 CuaDriver.connect(socket) / cua-driver mcp --embedded
```

**唯一所有者**

| 状态                         | 所有者                                             | 其他层                                |
| ---------------------------- | -------------------------------------------------- | ------------------------------------- |
| 桌面观察 / snapshot / ref    | cua-driver（唯一）                                 | bridge 不缓存，每次向 driver 取当前值 |
| 输入投递 / 后台/前台策略     | cua-driver                                         | runtime 只透传                        |
| session / 多调用标签         | cua-driver `start_session` / `end_session`         | runtime 把 `context.sessionId` 映射之 |
| 权限授权（macOS TCC）        | **ZCode.app**（cua-driver 嵌入继承，不自建信任链） | `check_permissions` 只报告            |
| workspace / subagent / trace | ZCode bridge + runtime context                     | driver 不感知                         |

不新增第二条写入路径：runtime 不缓存窗口列表、坐标、剪贴板。

## 平台输入：推荐 + 兼容两层（Wayland / Linux）

- **推荐路径始终是 cua-driver 原生**，覆盖 Ubuntu 24.04+ / GNOME 45+（官方台账含 GNOME 46）。
- **兼容层（compatible）** 只服务老 GNOME（Ubuntu 22.04 / GNOME 42，portal v1 无 libei、元素 `frame` 坐标系错位）：
  `click / type_text / hotkey / press_key / scroll / drag` 兜底到
  **mutter 直连注入 + WinRects 扩展**；观察与语义（`get_window_state` / `list_windows` / `set_value`）仍只走 cua-driver。
  兼容层放 `packages/zcode-cua/compatible/`，默认不加载，仅在原生不可用时启用。
  路由已接入：`createComputerUseRuntime({ client, compat })`，`compat.applies` 为真且工具属输入类时
  走 `compatible/executor.js`；观察/语义始终走 cua-driver。
  完整接口、坐标公式、键盘/文本映射、helper 进程与验证记录见 `.agents/specs/computer-use-wayland-input.md`。
  全平台（Windows / macOS / Linux X11 / 各 Wayland 合成器）的机制与计划见 `.agents/specs/computer-use-platform-architecture.md`。

## 接口

`packages/zcode-cua` 保持 `ComputerUseRuntime` 形状不变（`execute` / `closeSession` / `dispose`），
但实现从 fail-closed 占位改为 cua-driver 适配器：

```ts
createComputerUseRuntime(options?: {
  client?: CuaDriverClient;        // 注入点：同进程 SDK、daemon connect、或测试假件
  sessionLabel?: string;
  env?: Record<string, string | undefined>;
}): ComputerUseRuntime
```

- 注入 `client` 时不得自行创建原生资源（可单测）。
- 未注入且环境未提供 driver 时，保持今天的 fail-closed 行为，并给出明确原因，不伪造成功。
- `execute()`：把 ZCode 工具名/参数翻译到 cua-driver 工具，把 `ToolResult` 投影成
  bridge/broker 期望的形状；`actionSent` 语义由 driver 的投递证据推导。

## 模型面变化（用户可见）

闭源 Helper 的 14 工具与 envelope（`state_id` / `frame_id` / `diffing` / `window_id_fallback`）
只服务于那个私有二进制，无法也无必要在 cua-driver 上忠实复刻。因此：

- `computer` 逃逸口改为枚举 cua-driver 的原生工具（见其 contract，如 `click`、`get_window_state`、
  `type_text`、`press_key`、`hotkey`、`scroll`、`drag`、`list_apps`、`list_windows`、
  `clipboard_read/write`、`start_session`/`end_session`、`check_permissions`）。
- `agent.computerUse` 的绑定式 API（`getApp` / `app.click` / `app.getAXState` …）保留，
  内部改调 cua-driver；`SKILL.md` 与 `docs/computer-use.md` 按 cua-driver 的真实工具/结果重写。
- 迁移期若某闭源工具在 cua-driver 无对应物，明确返回 `ACTION_UNAVAILABLE`，不做静默降级。

## 失败路径

| 场景                 | 行为                                                              |
| -------------------- | ----------------------------------------------------------------- |
| driver 不存在/未授权 | `createComputerUseRuntime` 返回 fail-closed runtime，原因可达模型 |
| 平台不支持某原语     | 透传 cua-driver 的结构化 refusal，`actionSent:false`              |
| 动作可能已下发       | `actionSent:true`，不自动重试                                     |
| 参数校验失败         | `actionSent:false`                                                |
| abort                | 传播 `AbortError`，不产生新副作用                                 |

## 迁移边界

- 保留并在原位改写：`apps/zcode-cli/packages/zcode-cua-plugin`、`node-repl-host` 的 CUA bridge/broker。
- 重写：`packages/zcode-cua`（占位 → 真实适配器）。
- 移除（已完成）：`packages/desk-pilot`、`.agents/specs/desk-pilot.md`、
  `.agents/specs/generic-cua-runtime.md` 及其 `architecture-policy.yaml` / `typecheck` /
  `knip.json` / `.gitignore` 注册；未提交的 desk-pilot 改动一并放弃。
- 复核：`packages/services/src/cua-permission-broker/*`、`packages/desktop/src/main/cua*` 中只服务
  闭源 Helper 的安装/信任链部分，改为对接 cua-driver 的权限报告与 Electron 入口；不删仍需的权限 UI。

## 实施顺序

| 阶段 | 内容                                                                        | 状态                                       |
| ---- | --------------------------------------------------------------------------- | ------------------------------------------ |
| P0   | `createComputerUseRuntime` 适配器 + 注入点 + 假 client 单测                 | 已完成（13/13 单测；已用真实 driver 验证） |
| P1   | Desktop 嵌入 cua-driver（bin + TS SDK）、打包、macOS 权限继承               | 未开始                                     |
| P2   | bridge/broker 与 runtime 接线，删 `ZCODE_CUA_PERMISSION_BROKER_SOCKET` 依赖 | 未开始                                     |
| P3   | 模型面 / SKILL / docs 对齐 cua-driver 工具；UI 工具渲染块复核               | 未开始                                     |
| P4   | 清理 Helper 残留；NOTICE / 第三方清单                                       | 未开始                                     |
| P5   | E2E：macOS/Windows 截图→元素点击→输入→再观察闭环                            | 未开始                                     |

## 验收场景

1. 注入假 client 时，14 个旧工具名与 cua-driver 原生工具名都能路由，未映射项返回 `ACTION_UNAVAILABLE`。
2. driver 缺失时 `execute()` fail-closed，错误信息可操作，绝不留假成功。
3. `actionSent` 语义：已投递 → `true`；校验阶段 → `false`。
4. macOS 权限由 ZCode.app 一次授权，不出现第二个权限弹窗/第二个 App 条目。
5. `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 全绿。
