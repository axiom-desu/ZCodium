# Computer Use 跨平台架构（Windows / macOS / Linux X11 / Wayland 各合成器）

配套：

- `.agents/specs/computer-use-runtime.md`（原生引擎 = cua-driver，唯一）
- `.agents/specs/computer-use-wayland-input.md`（老 GNOME 兼容层）

## 1. 目标与原则

1. **单一原生引擎**：所有平台的观察与输入最终由 `@trycua/cua-driver` 完成；ZCode 只做
   适配、协商、以及**唯一一个**兼容兜底（老 GNOME）。
2. **推荐优先**：能走 cua-driver 原生的平台一律走原生，不启用兼容层。
3. **兼容层最小化**：只有 cua-driver 原生在某合成器上确实不可用时才启用，且按版本/合成器精确判定。
4. **不新增第二条写入路径**：观察状态归 cua-driver / 平台 helper；输入会话归唯一注入器。

## 2. 统一端口与工具面

ZCode 侧保持 `ComputerUseRuntime` 形状不变：

```ts
interface ComputerUseRuntime {
  execute(input: { toolName; arguments; context; signal? }): Promise<CallToolResult>;
  closeSession(context?): Promise<void>;
  dispose(): Promise<void>;
}
```

模型可见工具面来自 cua-driver 原生工具（`cua-driver list-tools`），按职责分层：

| 类别      | 工具（示例）                                                                                                         | 说明               |
| --------- | -------------------------------------------------------------------------------------------------------------------- | ------------------ |
| 发现      | `list_apps` `list_windows` `get_accessibility_tree`                                                                  | 跨平台             |
| 观察      | `get_window_state` `get_desktop_state` `zoom` `get_screen_size` `verify_state`                                       | 可访问性树 + 截图  |
| 激活      | `bring_to_front` `set_window_frame` `launch_app` `kill_app`                                                          | 前台/窗口控制      |
| 输入      | `click` `double_click` `right_click` `drag` `scroll` `move_cursor` `hotkey` `press_key` `type_text` `mouse_button_*` | 逐平台机制不同     |
| 语义      | `set_value` `invoke_menu`                                                                                            | 直接走可访问性接口 |
| 剪贴板    | `clipboard_read` `clipboard_write`                                                                                   |                    |
| 会话      | `start_session` `end_session` `list_sessions`                                                                        | 多调用公共标签     |
| 浏览器    | `browser_*` `get_browser_state`                                                                                      | CDP，跨平台        |
| 录制/诊断 | `start_recording` `health_report` `check_permissions`                                                                |                    |

**输入类工具是唯一可能触发兼容层的类别**；观察/语义一律走 cua-driver。

## 3. 平台机制总表

| 平台 / 合成器                            | 可访问性            | 截图                                                                 | 输入注入                                    | 激活 / 前台                                           | 权限                        | cua-driver 台账     |
| ---------------------------------------- | ------------------- | -------------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------- | --------------------------- | ------------------- |
| Windows 10/11                            | UI Automation (UIA) | DXGI Desktop Dup / GDI                                               | `SendInput`；UIA 后台模式                   | `SetForegroundWindow` + UIAccess worker               | 无 TCC；提权窗口需 UIAccess | 122/122             |
| macOS 13+                                | Accessibility (AX)  | ScreenCaptureKit                                                     | `CGEvent`（前台绑定）；AX action（后台）    | `NSRunningApplication.activate` + AX raise            | TCC：辅助功能 + 屏幕录制    | 145/145             |
| Linux / X11                              | AT-SPI2             | X11/XComposite                                                       | `XSendEvent`（定向后台）；XTest             | EWMH `_NET_ACTIVE_WINDOW`                             | 无                          | 116/116             |
| Linux / Wayland / GNOME 45+              | AT-SPI2             | portal ScreenCast/Screenshot 或 ext-image-copy；helper stage capture | portal RemoteDesktop + **libei**            | 官方 `winrects@cua` `Activate` + 二次 `GetRects` 验证 | portal 会话（无 root）      | GNOME 46 GTK3 31/31 |
| Linux / Wayland / GNOME ≤44              | AT-SPI2             | **兼容层** legacy 扩展 `Capture`                                     | **兼容层** mutter 直连                      | **兼容层** legacy 扩展 `Activate`                     | 无                          | **原生不可用**      |
| Linux / Wayland / wlroots（Sway、labwc） | AT-SPI2             | ext-image-capture / wlr-screencopy                                   | `virtual-pointer` + `virtual-keyboard` 协议 | foreign-toplevel activation + layer-shell             | 无                          | Sway 116/116        |
| Linux / Wayland / KWin（KDE Plasma）     | AT-SPI2             | portal / PipeWire                                                    | portal libei（全局焦点）                    | **缺 target-addressable 适配器**                      | portal 会话                 | **缺口**            |
| Linux / Wayland / Hyprland               | AT-SPI2             | portal / screencopy                                                  | `hyprland` IPC + virtual-pointer            | `hyprland` IPC                                        | 无                          | 有后端              |

> 依据：cua-driver 官方 `wayland-helper/README.md`、`cua-driver list-tools`、
> `cua-driver manifest`（`features:{portal_capture,portal_input,wayland_native}`）、`doctor`。

## 4. 逐平台计划实现方式

### 4.1 Windows

- **机制**：UIA 观察；`SendInput` 物理输入；提权/UAC 窗口经 `cua-driver-uia` UIAccess worker。
- **守卫**：无 TCC；UAC 边界由 UIAccess worker 处理。
- **常驻**：`cua-driver autostart enable` 注册登录计划任务（Session 1+），`serve` 随登录启动。
- **ZCode 计划**：
  1. 嵌入 cua-driver（打包二进制 + TS SDK）。
  2. 输入/观察全部路由原生。
  3. **不建兼容层**。
- **验证**：官方 122/122 + ZCode E2E（截图→元素点击→输入→再观察）。

### 4.2 macOS

- **机制**：AX 观察；`CGEvent` 输入（前台绑定），AX action 后台；ScreenCaptureKit 截图。
- **权限**：TCC 辅助功能 + 屏幕录制。由 **ZCode.app** 一次授权，子进程继承；Electron main
  在 `app.whenReady()` 后调用 `@trycua/cua-driver/electron` 的
  `requestMacOSPermissions / hasRequiredMacOSPermissions / openMacOSScreenRecordingSettings`。
- **嵌入**：`EmbeddedCuaDriverHost(bin, bundleId)` 起私有 daemon，应用与 agent 共用同一 endpoint；
  `stop()` 前先停 daemon；授权变化需 `restart()` + 重连（generation/PID/endpoint 会变）。
- **要求**：macOS 13+。
- **ZCode 计划**：
  1. 打包时携带 cua-driver + 签名；TCC 一次授权归 ZCode.app。
  2. 输入/观察全部路由原生。
  3. **不建兼容层**。
- **验证**：官方 145/145 + ZCode E2E。

### 4.3 Linux / X11

- **机制**：AT-SPI2 观察；`XSendEvent` 定向后台输入（也可 XTest 前台）；EWMH 激活。
- **ZCode 计划**：路由原生；**不建兼容层**。
- **验证**：官方 116/116。

### 4.4 Linux / Wayland / GNOME 45+（含 Ubuntu 24.04+，**推荐**）

- **机制**：
  - 输入：portal `RemoteDesktop` + libei（focus-bound）。
  - 几何/焦点/光标/截图：官方 `winrects@cua` Shell 扩展（`org.cua.WinRects`），
    `screen = buffer_origin + AT-SPI window_xy`；注入前用二次 `GetRects` 验证焦点。
- **安装**：`~/.cua-driver/packages/current/wayland-helper/install.sh`，然后**登录/登出一次**
  （`gnome-extensions info winrects@cua` 应为 ACTIVE）。
- **ZCode 计划**：
  1. 路由原生；检测到 helper 缺失时提示安装。
  2. **不建兼容层**（官方 helper 已覆盖）。
- **验证**：官方 GNOME 46 GTK3 31/31 + ZCode E2E。

### 4.5 Linux / Wayland / 老 GNOME（≤44，Ubuntu 22.04，**兼容层**）

- **问题**：portal `RemoteDesktop` v1 无 `ConnectToEIS`（无 libei）→ 原生输入不可用；
  且 cua-driver 元素 `frame` 在本机落到错误坐标系。
- **机制**（唯一兼容层，详见 `computer-use-wayland-input.md`）：
  - 读：自写 legacy 扩展 `cua-winrects@local`（`GetRects/GetCursor/Capture/Activate`）。
  - 写：`org.gnome.Mutter.RemoteDesktop` 直连（`NotifyPointer*` / `NotifyKeyboard*`，无 portal/root）。
  - 定位：`target = 2×frame_center − 2×W + B`；多模态视觉兜底。
  - 文本：AT-SPI `set_value` → keycode → 剪贴板，分级。
  - 进程：GJS 长驻 helper（方案 C），runtime 监督。
- **放置**：`packages/zcode-cua/compatible/`，默认不加载。
- **验证**：本机实测（点击/键盘/文本/窗口移动全通）。

### 4.6 Linux / Wayland / wlroots（Sway、labwc）

- **机制**：foreign-toplevel 激活 + `virtual-pointer`/`virtual-keyboard` 输入 + layer-shell 截图/覆盖；
  **不需要 helper 扩展**。
- **ZCode 计划**：路由原生；**不建兼容层**。
- **验证**：官方 Sway 116/116。

### 4.7 Linux / Wayland / KWin（KDE Plasma）—— 缺口

- **现状**：cua-driver 有 `kwin_helper.rs`，但官方 README 明确**尚未提供 target-addressable
  KWin 激活适配器**；仅 portal 可达不够（libei 输入是合成器全局焦点）。
- **ZCode 计划（待定）**：
  1. 优先等上游补齐 KWin 适配器，然后路由原生。
  2. 若必须提前支持：评估 KWin Scripting D-Bus（`org.kde.KWin`）做激活 + 坐标，作为第二个兼容目标
     ——但需重新论证，避免再造一套合成器私有方案。
- **当前行为**：明确返回 `ACTION_UNAVAILABLE`，不静默降级。

### 4.8 Linux / Wayland / Hyprland 及其他

- **Hyprland**：cua-driver 有 `hyprland*.rs`（IPC 激活 + 指针）；路由原生。
- **其他合成器**：能走 portal/libei + ext-image-copy 的按原生；否则按可用性探测决定
  （原生 → 兼容 → `ACTION_UNAVAILABLE`），不假设。

## 5. 检测与路由

```text
detect() →
  OS = process.platform                       // darwin | win32 | linux
  linux →
    session = XDG_SESSION_TYPE / WAYLAND_DISPLAY
    desktop = XDG_CURRENT_DESKTOP             // GNOME | ubuntu:GNOME | KDE | sway | Hyprland
    probes  = cua-driver manifest.features + doctor
              + org.gnome.Shell ShellVersion
              + org.freedesktop.portal.RemoteDesktop version
              + org.cua.WinRects GetVersion 可达性（官方 helper 或 legacy 端口）

路由（仅输入类工具）→
  win32 / darwin                      → cua-driver（原生）
  linux + X11                         → cua-driver（原生）
  linux + Wayland + wlroots/Hyprland  → cua-driver（原生）
  linux + Wayland + GNOME:
      GNOME ≥45 且 libei 可用         → cua-driver（原生 + 官方 helper）
      GNOME ≤44 或 libei 不可用       → compatible（legacy 扩展 + mutter）
  linux + Wayland + KWin              → cua-driver 尽力；不可用则 ACTION_UNAVAILABLE（缺口）
观察 / 语义类工具 → 一律 cua-driver
```

## 6. 打包、嵌入与权限

| 平台    | 嵌入形态                                    | 权限入口                         | 常驻                                     |
| ------- | ------------------------------------------- | -------------------------------- | ---------------------------------------- |
| Windows | 子进程 `cua-driver mcp`/`serve`             | 无 TCC                           | Scheduled Task（`autostart`）            |
| macOS   | `EmbeddedCuaDriverHost` 私 daemon + SDK     | Electron main TCC（`/electron`） | daemon（随 app）                         |
| Linux   | 同进程 SDK（默认）或 app 私有 daemon 子进程 | 无                               | 随 app（**不做 systemd user**，见 §6.1） |

- 同进程 SDK：`CuaDriver.create()`；`--embedded` 继承宿主授权（macOS）。
- daemon 模式：`cua-driver serve`；`--direct`（MCP 进程内持有 runtime）/`--socket`（显式服务）。
- MCP 客户端接入：`cua-driver mcp`（各 agent 自带 MCP 客户端）。

### 6.1 Linux 常驻决策：随 app 的私有 daemon，不用 systemd user

实测证据（本机 GNOME 42 / Wayland / cua-driver 0.28.2）：

- `CuaDriver.create()` 同进程 SDK：`platform.js` 设置 `CUA_DRIVER_RS_ENABLE_WAYLAND=1` 后
  `list_windows` / `get_app_state` 能看到原生 Wayland 窗口（Calculator 462 元素）。
- `EmbeddedCuaDriverHost(bin, bundleId)` 在 Linux **可启动**（起 `cua-driver mcp --embedded --socket`，
  有 generation / `restart()` / `waitForExit()`），但其 `environment` 受**固定安全白名单**约束：显式传
  `CUA_DRIVER_RS_ENABLE_WAYLAND` 报 `EmbeddedDriverError.Configuration: ... is not in the embedded
safe allowlist`；白名单只含 `DISPLAY` / `WAYLAND_DISPLAY` / `XDG_*` / `HOME` / `PATH` /
  `DBUS_SESSION_BUS_ADDRESS` 等，**不含 Wayland 开关**，默认继承同样被过滤，`dangerouslyBypassApprovals`
  也不能放行 → daemon 只看到 XWayland 窗口（实测 2 个）。故 `EmbeddedCuaDriverHost` 是 macOS（TCC）
  设施，在 Linux Wayland 不可用。

结论：

- **macOS**：`EmbeddedCuaDriverHost`（TCC 归 ZCode.app，daemon 必须由 app 进程起；Wayland 开关无关）。
- **Windows**：子进程 + Scheduled Task（另一路）。
- **Linux**：默认走 node_repl host 内**同进程 SDK**（当前实现，已验证）；如需多窗口共享 daemon，由
  Desktop main 自己 spawn `cua-driver serve --socket <app socket>`（env 自控，可设 Wayland 开关），
  所有窗口 host 用 `CuaDriver.connect(socket)`。**不引入 systemd user**：
  1. 二进制/契约漂移——daemon 必须是 app 打包的那份（`contractVersion` / generation），systemd unit
     固定路径，app 升级后残留旧 daemon 且无版本协商入口；
  2. 发行假设——systemd 不覆盖 WSL / 容器 / 非 systemd 发行版，且多一个安装注册步骤；
  3. 安全边界——session 全局 socket 对同用户任意进程开放，app 私有 socket 权限更紧；
  4. 跨平台一致——macOS/Windows 都是 app-owned 子进程，Linux 同模型可复用生命周期/重启/父存活逻辑。

代价：app 重启后 daemon 冷启动一次；driver 冷启动成本低，可接受。

## 7. 失败语义

| 场景                         | 行为                                               |
| ---------------------------- | -------------------------------------------------- |
| 平台不支持某原语             | 透传 cua-driver 结构化 refusal，`actionSent:false` |
| 兼容层判定适用但 helper 缺失 | 明确错误 + 安装指引，不静默降级                    |
| KWin 等缺口                  | `ACTION_UNAVAILABLE`，不伪造成功                   |
| 动作可能已下发               | `actionSent:true`，不自动重试                      |
| abort                        | 传播 `AbortError`，无新副作用                      |

## 8. 验收矩阵（计划）

| 平台               | 观察 | 元素点击 | 键盘/文本 | 再观察复核          |
| ------------------ | ---- | -------- | --------- | ------------------- |
| Windows            | 待   | 待       | 待        | 待                  |
| macOS              | 待   | 待       | 待        | 待                  |
| Linux/X11          | 待   | 待       | 待        | 待                  |
| GNOME 45+          | 待   | 待       | 待        | 待                  |
| 老 GNOME（兼容层） | 已通 | 已通     | 已通      | 部分（截图/AT-SPI） |
| Sway               | 待   | 待       | 待        | 待                  |

## 9. 状态：已实现 / 计划 / 缺口

| 项                                                   | 状态                                                          |
| ---------------------------------------------------- | ------------------------------------------------------------- |
| cua-driver 适配器 `createComputerUseRuntime`         | 已实现（单测 + 真实 driver 验证）                             |
| 老 GNOME 兼容层（legacy 扩展 + mutter）              | 已实现并验证（`compatible/`）                                 |
| 跨平台路由 `detect()` / `resolvePlatformPath()`      | 已实现（纯函数 + 单测）                                       |
| 平台装配 `packages/zcode-cua/platform.js`            | 已实现（Linux compat / macOS native / 缺 client fail-closed） |
| host 接线 `captureComputerUseRuntimeFromEnvironment` | 已接入（按平台装配；driver 缺失保持 fail-closed）             |
| macOS TCC 归属                                       | 待做（嵌入宿主 ZCode.app）                                    |
| Windows 嵌入 / autostart                             | 由另一路负责                                                  |
| Linux 本机 UI 限制                                   | 已解锁（`local-linux` supported:true）                        |
| KWin/KDE Wayland                                     | **缺口**（等上游或另行论证）                                  |
| 三平台 E2E                                           | 计划                                                          |

## 10. 待定

1. KWin 适配器：等上游 vs 自建（§4.7）。
2. macOS/Windows 的 E2E 环境与 runner。
3. 兼容层是否登记为受管模块（当前 `packages/zcode-cua` 不在策略受管列表）。
4. Linux 是否需要 app-owned 共享 daemon（当前默认同进程 SDK，见 §6.1）。
