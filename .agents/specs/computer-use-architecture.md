# Computer Use 架构总览

本文件是 Computer Use 的顶层架构入口，只描述**组件、数据流、所有者与进程模型**；逐项细节见配套 spec：

- `.agents/specs/computer-use-runtime.md` — 原生引擎 = cua-driver、适配器契约与迁移边界
- `.agents/specs/computer-use-platform-architecture.md` — 各平台机制、路由与常驻形态
- `.agents/specs/computer-use-capabilities.md` — ZCode 模型面 ↔ cua-driver 能力对接与缺口
- `.agents/specs/computer-use-wayland-input.md` — 老 GNOME 物理输入兼容层

## 1. 唯一链路

```text
模型 cell (node_repl js)
└─ @zcode/zcode-cua-plugin/scripts/*            模型可见面（14 工具 + computer 逃逸口）
   │  Symbol.for("zcode.node-repl.computer-use-bridge")
└─ node-repl-host/src/cua-bridge.ts             通用（sandbox globals → broker）
   │  JSON 行 / 本地 socket（带 token）
└─ node-repl-host/src/cua-broker.ts             通用（IPC → runtime.execute）
   │  runtime.execute({ toolName, arguments, context, signal })
└─ @zcode/zcode-cua
   ├─ runtime.js    createComputerUseRuntime()  适配器 + 输入路由 + 状态机（diffing/actionSent/冷启动）
   ├─ surface.js    ZCode 14 工具名 ↔ cua-driver 工具映射 + app/window/element 目标解析
   ├─ platform.js   平台探针 → 路由 → 组装 compat / 原生
   ├─ permissions.js 权限契约 + cua-driver 后端（check_permissions）
   └─ compatible/*  老 GNOME 兼容层（默认不加载，见 wayland-input spec）
      └─ @trycua/cua-driver（唯一原生引擎） 或 org.gnome.Mutter.RemoteDesktop 直连
```

约束：观察/语义（`get_window_state` / `list_windows` / `list_apps` / `set_value`）**始终**走
cua-driver；只有**输入类**工具可能被老 GNOME 兼容层接管。不存在第二条写入路径。

## 2. 状态所有者

| 状态                              | 唯一所有者                                 | 其他层禁止                                 |
| --------------------------------- | ------------------------------------------ | ------------------------------------------ |
| 桌面观察 / snapshot / element ref | cua-driver                                 | bridge/broker/runtime 不缓存，每次取当前值 |
| 输入投递 / 前后台策略             | cua-driver；老 GNOME 兼容层                | runtime 只透传，不重试已投递动作           |
| session / 多调用标签              | cua-driver `start_session` / `end_session` | runtime 把 `context.sessionId` 映射之      |
| 权限授权（macOS TCC）             | ZCode.app（cua-driver 继承，不自建信任链） | `permissions.js` 只报告，不授权            |
| workspace / subagent / trace      | ZCode bridge + runtime context             | driver 不感知                              |
| 输入未提交草稿 / pending overlay  | Renderer                                   | Host owner/lease 负责路由                  |

## 3. 进程与常驻

| 平台            | 引擎形态                                                                                 | 常驻           |
| --------------- | ---------------------------------------------------------------------------------------- | -------------- |
| Linux（默认）   | node_repl host 内同进程 SDK `CuaDriver.create()`                                         | 随 host        |
| Linux（可选）   | Desktop main 自起 `cua-driver serve --socket`，窗口 host `CuaDriver.connect`             | 随 app         |
| macOS           | ZCode.app 起 `EmbeddedCuaDriverHost` 私 daemon，socket 经 `ZCODE_CUA_DRIVER_SOCKET` 注入 | daemon 随 app  |
| Windows         | 子进程 `cua-driver mcp`/`serve`（另一路）                                                | Scheduled Task |
| 老 GNOME compat | 独立长驻 GJS helper（stdio JSON-lines），runtime 监督                                    | helper 随 host |

- **不引入 systemd user**（版本漂移 / 发行假设 / 安全边界 / 跨平台一致，见 platform-architecture §6.1）。
- Wayland 会话下 `platform.js` 在 import 原生 SDK **之前**自动设 `CUA_DRIVER_RS_ENABLE_WAYLAND=1`；
  不带它 cua-driver 只枚举 XWayland 窗口，原生 Wayland 窗口不可见。
- `EmbeddedCuaDriverHost` 的 `environment` 受固定安全白名单约束，**不含** Wayland 开关，故它是
  macOS（TCC）设施，Linux Wayland 不可用。

## 4. 权限

权限契约独立于原生引擎，位于 `@zcode/zcode-cua/permissions`（`ICuaPermissionService` /
`CuaPermissionStatus`），由设置页长期消费；实现 `createCuaDriverPermissionService`：

- 状态：cua-driver `check_permissions` → macOS 映射 `accessibility` / `screen_recording` 为
  `granted | denied | unknown`；无 client 或 driver 报错 → `available:false` + 原因（fail-closed）。
- 授权：cua-driver `/electron` 的 `requestMacOSPermissions` / `openMacOSScreenRecordingSettings`，
  在 Electron main `app.whenReady()` 后调用，TCC 归 ZCode.app。
- 旧闭源 `ZCode Computer Use.app`（`dev.zcode.cua-helper`）的安装/验签/拖拽入 TCC 与私有 broker
  正在移除；其实现从未进入本开源仓库（`broker-server.js` 一直是 stub）。

## 5. 平台路由

仅输入类工具参与路由；判定输入来自 `detect.js` + `probeGnomeEnvironment`：

```text
win32 / darwin                     → cua-driver（原生）
linux + X11                        → cua-driver（原生）
linux + Wayland + wlroots/Hyprland → cua-driver（原生）
linux + Wayland + GNOME ≥45 + libei→ cua-driver（原生 + 官方 winrects helper）
linux + Wayland + GNOME ≤44        → compatible（legacy 扩展 + mutter）
linux + Wayland + KWin             → ACTION_UNAVAILABLE（上游缺口）
```

## 6. 迁移状态

| 阶段                                                                  | 状态             |
| --------------------------------------------------------------------- | ---------------- |
| 适配器 `createComputerUseRuntime` + `surface.js` 14 工具映射          | 已完成           |
| 老 GNOME 兼容层 + 坐标/键盘/滚动/拖动                                 | 已完成并本机验证 |
| 平台装配 `platform.js` + host 接线                                    | 已完成           |
| Wayland 窗口后端开关自动注入                                          | 已完成           |
| 权限契约 + cua-driver 后端 `@zcode/zcode-cua/permissions`             | 已完成           |
| 权限服务接入 Desktop main / 设置页改接                                | 进行中           |
| 移除闭源 Helper 链（broker / 安装验签 / 拖拽 / PiP / `node.ts` 编排） | 进行中           |
| macOS 嵌入宿主 + TCC 归 ZCode.app                                     | 待做             |
| 打包 Desktop app 端到端                                               | 待做             |

## 7. 目录

```text
packages/zcode-cua/
├─ runtime.js           适配器 + 路由 + 状态机
├─ surface.js           ZCode 工具名 ↔ cua-driver 映射
├─ platform.js          平台装配（同步 / 异步）
├─ permissions.js       权限契约 + cua-driver 后端
├─ compatible/          老 GNOME 兼容层（默认不加载）
│  ├─ backend.js executor.js detect.js evdev.js geometry.js helper-client.js
│  └─ helper/           GJS 长驻 helper + legacy GNOME 扩展 + 安装脚本
└─ test/                纯函数与路由单测

apps/zcode-cli/packages/
├─ zcode-cua-plugin/    模型可见面（scripts / skill / docs）
└─ node-repl-host/      cua-bridge.ts + cua-broker.ts（通用 IPC）
```
