# Computer Use 物理输入后端：兼容层（老 GNOME / Wayland，mutter 直连）

配套阅读：`.agents/specs/computer-use-runtime.md`（原生引擎仍只有 cua-driver）。

## 0. 分层定位（先读这段）

| 层                     | 触发条件                                                                           | 实现                                             | 地位                                   |
| ---------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------ | -------------------------------------- |
| **推荐**               | 默认；Ubuntu 24.04+ / GNOME 45+（官方台账含 GNOME 46）                             | **cua-driver 原生**（portal/libei 或合成器后端） | 首选，正常路径                         |
| **兼容（compatible）** | 老 GNOME（Ubuntu 22.04 / GNOME 42，portal v1 无 libei，cua-driver 原生输入不可用） | mutter 直连 + WinRects 扩展（本文件）            | 兜底，**不推荐**，仅在原生不可用时启用 |

本文件只描述**兼容层**。它是一段"阴间"方案（依赖合成器私有 D-Bus、强制前台、按显示器 scale 换算），
**不进入推荐路径**，放在 `packages/zcode-cua/compatible/`，默认不加载。
**cua-driver 仍是唯一原生引擎**；兼容层只补老 GNOME 上拿不到的 Wayland 物理注入。

### 0.1 平台支持矩阵（推荐 vs 兼容）

| 平台 / 合成器                         | 推荐（cua-driver 原生）   | 兼容层                          | 依据                                        |
| ------------------------------------- | ------------------------- | ------------------------------- | ------------------------------------------- |
| macOS                                 | ✅ CGEvent / AX           | 无                              | 官方台账 145/145；TCC 由 ZCode.app 一次授权 |
| Windows                               | ✅ SendInput / UIA        | 无                              | 官方台账 122/122                            |
| Linux / X11                           | ✅ XTest                  | 无                              | 官方台账 116/116                            |
| Linux / Sway                          | ✅ IPC + virtual_keyboard | 无                              | 官方台账 116/116                            |
| Linux / GNOME 45+（含 Ubuntu 24.04+） | ✅                        | 无                              | 官方台账 GNOME 46 GTK3 31/31                |
| Linux / 老 GNOME（≤44，Ubuntu 22.04） | ❌ portal v1 无 libei     | **mutter + WinRects（本文件）** | 本机实测                                    |

Windows / macOS 由 cua-driver 原生覆盖，**不建兼容层**；只有老 GNOME 需要本文件的后端。
全平台机制与计划实现方式见 `.agents/specs/computer-use-platform-architecture.md`。

## 1. 背景与决策

本机（兼容层目标机）是 Ubuntu 22.04.5 / GNOME Shell 42.9 / Wayland / x86_64，显示器 **3200×2000，scale 2**。

cua-driver 在本机能**观察**（截图、AT-SPI 树、语义 `set_value`），但**物理输入不可用**，原因已定位：

| 事实                        | 证据                                                                                                 |
| --------------------------- | ---------------------------------------------------------------------------------------------------- |
| portal 太老，无 libei       | `org.freedesktop.portal.RemoteDesktop` **version 1**，没有 `ConnectToEIS`（xdg-desktop-portal 1.14） |
| 元素 `frame` 不能当屏幕坐标 | "5" 真值 (400,928)；`frame` 中心 (312,539)，不满足任何简单平移（见 §5）                              |

兼容层结构：

```text
读（观察面）  GNOME Shell 扩展 org.cua.WinRects   窗口矩形 / 光标 / 全屏截图 / 激活
写（输入面）  org.gnome.Mutter.RemoteDesktop      相对移动 / 点击 / 键盘（合成器本体，无 portal、无 root）
定位（坐标）  多模态视觉 + 坐标换算                元素框 → 屏幕像素，含 per-output scale
文本（输入）  AT-SPI set_value / keycode / 剪贴板   分级，见 §6.4
```

## 2. 非目标

- **不覆盖 GNOME 45+ / Ubuntu 24.04+**：那里走 cua-driver 原生，不启用兼容层。
- 不做 X11 路径（X11 下 cua-driver 原生可用）。
- 不复制 cua-driver 的 AT-SPI / 语义 / 权限能力，`get_window_state`、`set_value` 仍走 cua-driver。
- 不引入 `xdotool` 等 X11 工具，不要求 root，不新增 portal 依赖。
- 不新建第二条模型面。

## 3. 组件与位置（`packages/zcode-cua/compatible/`）

| 组件   | 路径                                                        | 职责                                                           | 语言                                     |
| ------ | ----------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------- |
| 检测   | `compatible/detect.js`                                      | 判断是否启用兼容层（GNOME 版本 / portal / WinRects 可用性）    | Node                                     |
| 后端   | `compatible/backend.js`                                     | 组合高层操作（click / hotkey / typeText / scroll）             | Node                                     |
| 客户端 | `compatible/helper-client.js`                               | spawn / 监督 GJS helper，JSON-lines 请求响应                   | Node                                     |
| 坐标   | `compatible/geometry.js`                                    | 元素→屏幕、屏幕→相对位移、per-output scale                     | Node 纯函数                              |
| 键位表 | `compatible/evdev.js`                                       | evdev 码、修饰键、字符→键位                                    | Node 纯函数                              |
| helper | `compatible/helper/cua-wayland-input.js`                    | **长驻**，建 mutter session，D-Bus 读写，JSON-lines over stdio | **GJS**（GNOME 自带，无 npm D-Bus 依赖） |
| 扩展   | `~/.local/share/gnome-shell/extensions/cua-winrects@local/` | `GetRects / GetCursor / Capture / Activate`                    | GJS（legacy API，已上线）                |

扩展**无需改动**：per-output scale 从标准接口 `org.gnome.Mutter.DisplayConfig.GetCurrentState` 取（见 §5.6），
避免再次重启 Shell。

## 4. 接口（D-Bus）

### 4.1 `org.cua.WinRects`（`/org/cua/WinRects`，Shell 扩展）

| 方法                                 | 签名              | 语义                                                                                 |
| ------------------------------------ | ----------------- | ------------------------------------------------------------------------------------ |
| `GetVersion`                         | `() → u`          | 返回 `8`                                                                             |
| `GetRects`                           | `() → s`          | JSON `[{id,pid,title,x,y,w,h,buffer_x,buffer_y,focused,minimized,visible,stacking}]` |
| `GetCursor`                          | `() → (i x, i y)` | 物理指针坐标（本机 0..3199 / 0..1999）                                               |
| `Capture`                            | `() → s`          | 全舞台 PNG base64，3200×2000                                                         |
| `Activate`                           | `(u id) → b`      | 激活并确认焦点（100ms 回执）                                                         |
| `MoveCursor/ClickPulse/HideCursor/…` | —                 | 光标叠加 no-op                                                                       |

`buffer_x/buffer_y` 与 `x/y` 分开上报，用于补偿 GTK CSD 阴影（§5）。

### 4.2 `org.gnome.Mutter.RemoteDesktop`（合成器直连注入）

```text
CreateSession() → object path                      （普通客户端可用，无需 portal/root）
Session.Start() → ()
Session.NotifyPointerMotionRelative(dx, dy)        dx/dy 为**逻辑**单位，物理位移 = 输入 × scale
Session.NotifyPointerButton(button, state)         button 为 **evdev 码**（BTN_LEFT=272）
Session.NotifyKeyboardKeycode(keycode, state)      evdev 码
Session.NotifyKeyboardKeysym(keysym, state)        X keysym（仅当前布局可映射的键）
```

**按钮码依据**：`GNOME/mutter/gnome-42 src/backends/meta-remote-desktop-session.c:497`
`translate_to_clutter_button()` 用 `BTN_LEFT/BTN_RIGHT/BTN_MIDDLE = 272/273/274`。用 `1` 是非法键 → 左键无效（早期根因）。

**Session 生命周期**：绑定 D-Bus 连接，断开即失效 → 必须长驻（§8.3）。

### 4.3 `org.gnome.Mutter.DisplayConfig`（scale 来源）

```text
GetCurrentState() → (serial, monitors, logical_monitors, properties)
logical_monitors: (x, y, scale, transform, primary, [monitors], [properties])
```

用于按目标点所在逻辑显示器取 scale（§5.6）。

> **不要用 `get_screen_size` 取 scale**：本机该工具返回 `{width:3200,height:2000,scale_factor:1}`，
> 即物理尺寸 + `scale_factor=1`，并未上报真实的 2。scale 必须来自 DisplayConfig。

## 5. 坐标换算（已验证，含窗口移动与变 scale）

### 5.1 三个坐标系

| 空间        | 定义                                                 | 来源                                                      |
| ----------- | ---------------------------------------------------- | --------------------------------------------------------- |
| 窗口 frame  | `x,y,w,h`                                            | `GetRects`                                                |
| 窗口 buffer | `buffer_x,buffer_y`                                  | `GetRects`；`frame − buffer = CSD 阴影`（本窗口 (52,46)） |
| 元素 frame  | cua-driver `element.frame`（**scale=1 的中间空间**） | cua-driver                                                |

### 5.2 公式

```text
target_screen = 2 × frame_center − 2 × window_frame_origin + buffer_origin
```

等价每窗口常量：`target = 2 × frame_center − (2W − B)`。

### 5.3 验证矩阵

| 锚点        | frame 中心 | 公式 → screen | 真值                    | 偏差                                 |
| ----------- | ---------- | ------------- | ----------------------- | ------------------------------------ |
| "5"         | (312,539)  | (398,928)     | (400,928) 用户光标      | 2（光标非正中心，仍在 60×44 按钮内） |
| "="         | (504,611)  | (784,1072)    | (781.5,1071.5) 绿色质心 | 2.5                                  |
| "7"         | (248,491)  | (272,832)     | (274,833) 截图          | 2                                    |
| "9"（点击） | (376,491)  | (528,832)     | 显示变 **"59"**         | —                                    |

**窗口移动后自洽**（(174,104)→(1641,633)，元素 frame 同步平移）：公式 (400,928)→(1865,1457)，
点击得 "595" ✅。

### 5.4 反推解读

- 缩放因子 **2** = 显示 scale（物理 = 逻辑 × 2）。
- cua-driver 的 `frame` 是 **scale=1、原点偏移** 的中间空间，直接当屏幕坐标必然错位。
- `2W − B` 只与当前窗口位置有关，随窗口移动自动更新。

### 5.5 屏幕 → 相对位移（mutter）

```text
(cx, cy) = GetCursor()
scale   = scaleOf(logical monitor containing target)     # §5.6，本机 2
NotifyPointerMotionRelative((tx−cx)/scale, (ty−cy)/scale)
```

开环定位误差 0。`GetCursor` 是唯一可靠指针来源（XWayland `XQueryPointer` 不跟随合成器注入移动）。

### 5.6 变 scale

- 物理目标点 (tx,ty) → 所在 logical monitor（由 `DisplayConfig` 的 logical_monitors 位置/尺寸判定）→ 取该 monitor `scale`。
- 同 monitor 内换算精确；**跨 monitor 移动**为边界情况（指针跨越输出时的 scale 断层），接入时标注为已知限制。
- 公式里的 `2` 与位移 `/scale` 都改为按输出动态取值；单一 scale 时退化为常量 2。

## 6. 键盘与文本（已验证）

### 6.1 按键路径

| 能力               | 方法                             | 结果 | 证据                                                                         |
| ------------------ | -------------------------------- | ---- | ---------------------------------------------------------------------------- |
| 数字/功能键        | `NotifyKeyboardKeycode`（evdev） | ✅   | "595" → ⌫×3 → "123"                                                          |
| 修饰键             | keycode down/up                  | ✅   | Shift+= 出 "+"，`7+8⏎`=15                                                    |
| ASCII keysym       | `NotifyKeyboardKeysym`           | ✅   | `9*2⏎`=18                                                                    |
| **Unicode keysym** | `(0x01000000+cp)`                | ❌   | π 你好 えー **全丢**                                                         |
| GTK Unicode        | Ctrl+Shift+U + 十六进制          | ✅   | 插入 π                                                                       |
| Ctrl+C / Ctrl+V    | evdev keycode                    | ✅   | 往返一致                                                                     |
| 剪贴板任意 Unicode | `wl-copy` + Ctrl+V               | ✅   | `PASTE 你好 π 😀 42` 全渲染（探索结论；实现改用 Ctrl+Shift+U，不依赖剪贴板） |

### 6.2 evdev 对照表（常用子集）

```text
ESC=1  1..9=2..10  0=11  MINUS=12  EQUAL=13  BACKSPACE=14  TAB=15
Q..P=16..25        ENTER=28  LEFTCTRL=29
A..L=30..38        LEFTSHIFT=42
Z..M=44..50  COMMA=51  DOT=52  SLASH=53  RIGHTSHIFT=54
LEFTALT=56  SPACE=57  CAPSLOCK=58
DELETE=111  LEFTMETA=125  RIGHTCTRL=97  RIGHTALT=100
鼠标：BTN_LEFT=272  BTN_RIGHT=273  BTN_MIDDLE=274
```

> 踩坑：`V=47`（写成 53=斜杠会让 Ctrl+V 变 Ctrl+/）。

### 6.3 hotkey 组合

```text
hotkey([mods...], key) = down(mods) → tap(key) → up(mods，逆序)
例：ctrl+shift+t = d29,d42,tap20,u42,u29
```

### 6.4 type_text 分级策略（要**分级测试**）

```text
1. 有可访问可编辑元素 → AT-SPI set_value        （不抢焦点、任意文本、走 cua-driver）
2. 纯 ASCII          → keycode 直打
3. 含 Unicode        → Ctrl+Shift+U + 十六进制 + Enter （UTF-8 码点，Linux/GTK 标准）
```

不依赖剪贴板（`wl-copy` 会 fork 持有 selection，Node `spawnSync` 会卡死），也不依赖
mutter 听不懂的 Unicode keysym。

分级测试用例（接入时执行）：

| 级别 | 输入        | 目标                         | 期望                     |
| ---- | ----------- | ---------------------------- | ------------------------ |
| 1    | "hello"     | 有 AT-SPI 文本框（如 gedit） | set_value 命中或回退到 2 |
| 2    | "ABC123!@#" | 任意聚焦输入                 | 逐键正确                 |
| 3    | "你好 π 😀" | GTK 应用                     | Ctrl+Shift+U 逐码点插入  |

### 6.5 滚动与拖拽（mutter 原生原语，已验证）

mutter `Session` 提供：

- `NotifyPointerAxisDiscrete(axis, steps)`：**axis 0 = 垂直**（steps>0 向下）、**axis 1 = 水平**（steps>0 向右）；
  `steps<0` 反向，`steps=0` 报错。滚动按**指针位置**生效，注入前必须把指针移到目标。
- `NotifyPointerAxis(dx, dy, flags)`：连续滚动；flags 位 `FINISH=1<<0 / WHEEL=1<<1 / FINGER=1<<2 / CONTINUOUS=1<<3`，默认 FINGER。
- 拖拽 = 按住按钮 → 分步 `NotifyPointerMotionRelative` → 抬起。

`backend.scroll(direction, amount)` 把 up/down/left/right 映射到 `(axis, ±steps)`；
`backend.drag(from, to, { steps })` 持有按钮分步相对移动。窗口本地截图像素 → 屏幕：
`screen = buffer_origin + scale × local`。

验证：gedit 长文档 `axis=0 steps=8` 从第 1 行滚到第 42 行（≈5 行/步）；拖标题栏使窗口移动
`(124,54) → (1287,304)`。

## 7. 事件顺序与状态所有权

### 7.1 click(x, y)

```text
ZCode 后端                      helper（GJS，长驻）              mutter session
  │ input.activate(id) ─────────────►│ WinRects Activate
  │ ◄──────────── activated:true ────│
  │ read.cursor() ──────────────────►│ GetCursor
  │ ◄──────────── (cx,cy) ───────────│
  │ 算 scale（DisplayConfig）         │
  │ input.moveRel((x−cx)/scale,…) ──►│ ─────────────────────────► NotifyPointerMotionRelative
  │ input.button(272,true) ─────────►│ ─────────────────────────► NotifyPointerButton
  │ input.button(272,false) ────────►│ ─────────────────────────►
```

### 7.2 type_text("你好")（分级）

```text
分级 1: cua-driver set_value ──► AT-SPI EditableText
分级 2: keycode 逐键 ──► helper → mutter
分级 3: Ctrl+Shift+U + 十六进制 + Enter ──► helper → mutter（逐码点）
```

### 7.3 唯一所有者

| 状态                       | 所有者                  | 其他层               |
| -------------------------- | ----------------------- | -------------------- |
| 窗口矩形 / 光标 / 截图     | WinRects 扩展           | 后端不缓存，每次现取 |
| 注入 session（含指针位置） | helper 进程（唯一长驻） | 调用方只传目标       |
| 元素框 / AT-SPI / 语义     | cua-driver              | 后端只做坐标换算     |
| 目标窗口 focus             | WinRects `Activate`     | 后端不假设焦点       |

不新增第二条写入路径：后端不缓存窗口列表、坐标、剪贴板、指针位置。

## 8. 接入 `createComputerUseRuntime`

### 8.1 路由（先推荐、后兼容）

```text
runtime.execute({toolName, arguments})
  ├─ 输入类（click/type_text/hotkey/press_key/scroll/drag）
  │    ├─ cua-driver 原生可用 → 走 cua-driver          （推荐，GNOME 45+ / 其他平台）
  │    └─ 原生不可用 且 detect() 判定兼容层适用 → compatible/backend
  ├─ 观察/语义（get_window_state/list_windows/set_value） → 只走 cua-driver
  └─ 其他                                              → 只走 cua-driver
```

### 8.2 `detect.js` 判定

```
适用兼容层 ⇔ Linux ∧ Wayland ∧ GNOME 且
             （GNOME Shell < 45 ∨ portal RemoteDesktop version < 2）
             ∧ WinRects GetVersion 可达
推荐路径 ⇔ 否则（含 Ubuntu 24.04+ / GNOME 45+）
```

### 8.3 helper 进程（决策：方案 C，GJS）

session 绑定连接、必须长驻。选定**独立 helper 进程（C）**：

- **GJS** 实现：GNOME 自带，`Gio.DBus` 内置，**不需要给 Node 引 D-Bus 依赖**；兼容层本就只在 GNOME 上启用，gjs 一定在。
- runtime（Node）`spawn` 并监督其生命周期；helper 退出/断开即重建 session。
- 协议：stdin/stdout **JSON-lines**，`{id, method, params}` → `{id, ok, result|error}`。
- 高层逻辑（坐标、hotkey、文本分级）在 Node `backend.js`，helper 只做 D-Bus 原语代理，便于用假 helper 单测。

### 8.4 后端端口

```ts
interface WaylandInputBackend {
  listWindows(): Promise<WinRect[]>;
  capture(): Promise<{ pngBase64: string; width: number; height: number }>;
  getCursor(): Promise<{ x: number; y: number }>;
  monitors(): Promise<LogicalMonitor[]>;
  activate(windowId: number): Promise<boolean>;
  moveTo(x: number, y: number): Promise<{ x: number; y: number; scale: number }>;
  click(x: number, y: number, button?: "left" | "right" | "middle"): Promise<void>;
  hotkey(mods: string[], key: string): Promise<void>;
  pressKey(key: string): Promise<void>;
  typeAscii(text: string): Promise<void>;
  typeUnicode(text: string): Promise<void>; // Ctrl+Shift+U + 十六进制 + Enter
  typeText(
    text: string,
    opts?: { trySetValue?: (text: string) => Promise<boolean> },
  ): Promise<{ level: string }>;
  scroll(
    direction: "up" | "down" | "left" | "right",
    amount?: number,
  ): Promise<{ axis: number; steps: number }>;
  drag(
    from: Point,
    to: Point,
    opts?: { button?: string; steps?: number },
  ): Promise<{ steps: number }>;
}
```

`packages/zcode-cua` 仍是 `ComputerUseRuntime` 形状（`execute/closeSession/dispose`）不变；
兼容后端经依赖注入传入，缺省或不可用时保持 fail-closed。

## 9. 限制

- **只服务老 GNOME**：GNOME 45+ 用 cua-driver 原生（推荐）。
- **强制前台**：`Activate` + focus 绑定可接受。
- **变 scale**：按目标点所在 logical monitor 取 scale；跨输出移动为已知边界。
- **单指针**：mutter session 操作全局唯一指针，非并发安全。
- **Unicode keysym 不可用**：只能 set_value 或 Ctrl+Shift+U 码点。
- **无 portal/root**。
- **gjs 依赖**：兼容层要求 gjs（GNOME 环境天然满足）。

## 10. 验证记录（本次实现）

### 10.1 观察 / 坐标 / 点击

| 项           | 结果                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------ |
| 元素字段形状 | `get_window_state` → `{frame:{x,y,w,h}, label, role, action, element_token}`；文本在 **`label`**       |
| 计算器 "5"   | frame `{x:282,y:517,w:60,h:44}`、buffer `(122,58)` → **(398,928)**；mutter 左键 272 命中，截图显示 "5" |
| 完整 runtime | C4：`get_window_state` 由 driver 提供 462 元素，`press_key`/`click` 由 compat 注入，命中 "5"           |
| detect       | 本机 `{applies:true, gnomeShellVersion:42, portalRemoteDesktopVersion:1, winRectsVersion:8}`           |

### 10.2 文本分级（gedit）

| 级别        | 输入             | 结果                                        |
| ----------- | ---------------- | ------------------------------------------- |
| 1 set_value | `L1 hello world` | gedit 文档不支持 set_value → 回退 `keycode` |
| 2 keycode   | `L2 ABC123!@#`   | `keycode` 下发成功                          |
| 3 codepoint | `L3 你好 π`      | `codepoint`（Ctrl+Shift+U）下发成功         |

> gedit 文档文本不通过 AT-SPI `value` 暴露（恒为空），自动读回不适用；靠截图确认渲染。

### 10.3 已知坑

- **`spawnSync("wl-copy")` 卡死**：`wl-copy` fork 的孙进程继承 stdio 管道，`spawnSync` 等管道关闭而挂起
  → 已弃用剪贴板路径，Unicode 改 **Ctrl+Shift+U 码点**。
- `get_screen_size` 本机返回 `scale_factor:1`（不上报真实 2）→ scale 必须取 DisplayConfig（§4.3）。
- 后台进程（计算器/gedit）不跨 shell 调用存活，端到端验证需**同一次调用内**启动。

### 10.4 脚本（`/tmp/cua-test/`，不入库）

| 脚本                                  | 用途             |
| ------------------------------------- | ---------------- |
| `validate-c1/c3/c4/c5.mjs`            | 各阶段端到端     |
| `calcvalidate.mjs` / `geditprobe.mjs` | 真实元素字段探查 |
| `moveclick.js` / `keyinject.js`       | gjs 注入 smoke   |

## 11. 实施顺序

| 阶段 | 内容                                                        | 状态                                                                                                                                      |
| ---- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| D0   | spec 定稿（分层 / 放置 / helper C / 变 scale / 文本分级）   | 本文件                                                                                                                                    |
| C1   | `compatible/evdev.js`、`geometry.js`（纯函数）+ 单测        | **已完成**（32 测试通过；真实点击命中 "5"，元素 frame 形状确认为 `{x,y,w,h}`、文本字段是 `label`）                                        |
| C2   | `compatible/helper/cua-wayland-input.js`（GJS，D-Bus 原语） | **已完成**（本机 smoke：ping/version/monitors/getCursor/listWindows/moveRel/button 全通，version=8）                                      |
| C3   | `compatible/backend.js` + `detect.js`（spawn/监督、路由）   | **已完成**（`helper-client.js` + backend + detect；54 测试通过；真实 helper 端到端 click "5" 命中）                                       |
| C4   | 接 `createComputerUseRuntime` 兜底路由                      | **已完成**（`runtime.js` 路由 + `compatible/executor.js`；真实链路：driver 观察 → compat `press_key`/`click` 命中 "5"；70 测试通过）      |
| C5   | 分级 type_text 测试（§6.4 表）+ 变 scale 验证               | **已完成**（gedit 三级：set_value 回退 keycode、ASCII keycode、Unicode codepoint；单一显示器，变 scale 有单测与逻辑支持，跨输出仍为限制） |
| C6   | `scroll` / `drag` 原语（§6.5）                              | **已完成**（`axisDiscrete`/按钮拖动；单测 75/75；真实 gedit 滚动与窗口拖动均生效）                                                        |

## 12. 待定

1. 跨输出移动的 scale 处理细节（先标注为限制）。
2. `mouse_button_down/up`、`mouse_drag`（MPX 多指针）仍返回 `ACTION_UNAVAILABLE`，需要时再评估。
3. `packages/zcode-cua` 是否登记为受管模块（当前策略 `managedOnly`，未含该包）。
