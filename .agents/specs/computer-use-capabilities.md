# Computer Use 能力对接与缺口（ZCode 模型面 ↔ cua-driver）

配套：

- `.agents/specs/computer-use-runtime.md`（适配器与唯一原生引擎）
- `.agents/specs/computer-use-wayland-input.md`（老 GNOME 兼容层）
- `.agents/specs/computer-use-platform-architecture.md`（各平台机制）

本文件回答两个问题：**ZCode 需要哪些能力**、**哪些能对接、哪些对接不了**。

## 0. 本次拍板的决策

| #   | 能力                                            | 决策                                                     |
| --- | ----------------------------------------------- | -------------------------------------------------------- |
| 1   | 后台投递（不抢焦点）                            | **回退**：拿不到后台就前台，并在结果里告诉模型"只能前台" |
| 2   | 未确认身份的截图                                | **先信一把**：接受未验证截图，标记 `unverified`，不阻断  |
| 3   | `paste` 富文本 / `format`                       | **先不做**（只支持纯文本）                               |
| 4   | `select_text`、通用 `perform_action`            | **列着不做**（cua-driver 无原语，见 §4）                 |
| 5   | 多光标 `cursor_id`                              | **不做**（ZCode 未使用）                                 |
| 6   | `request_access` 的 capability 粒度             | **先全批准**：不逐项映射                                 |
| 7   | 观测 diffing / `actionSent` / 冷启动 / 身份收敛 | **做出来**（适配层状态机，见 §3）                        |

## 1. 能力总表与对接归属

| 能力                                                         | 归属                                                  | 状态                     |
| ------------------------------------------------------------ | ----------------------------------------------------- | ------------------------ |
| 应用枚举 / 绑定 / 启动                                       | cua-driver `list_apps`+`launch_app`；身份解析在适配层 | 做（§3.1）               |
| 窗口枚举 / 固定 window_id                                    | cua-driver `list_windows`                             | 做                       |
| 可访问性树                                                   | cua-driver `get_window_state`                         | 做                       |
| 窗口截图                                                     | cua-driver（原生）/ 兼容层 `capture`                  | 做（未验证截图先信）     |
| 语义动作（element click / set_value / menu）                 | cua-driver                                            | 做                       |
| 输入（click / drag / scroll / type / key / hotkey / cursor） | cua-driver；老 GNOME 走兼容层                         | 做                       |
| `select_text` / 通用 `perform_action`                        | 无原语                                                | 不做（§4）               |
| `paste`                                                      | `clipboard_write`+`hotkey(ctrl,v)`                    | 做（纯文本；富文本不做） |
| 观测 diffing / baseline                                      | 适配层状态机                                          | 做（§3.2）               |
| `actionSent` / 投递不确定性                                  | 适配层                                                | 做（§3.3）               |
| 冷启动 not-ready + 重试                                      | 适配层                                                | 做（§3.4）               |
| 前后台回退                                                   | 适配层                                                | 做（§3.5）               |
| 权限 `request_access`                                        | `check_permissions` / `permissions status`            | 做（全批准）             |
| 会话 / 停止                                                  | `start_session`/`end_session`/`revoke`                | 做                       |
| 多光标                                                       | —                                                     | 不做                     |

## 2. 工具名/参数/结果映射表

ZCode 模型面（`computer-use-client.mjs` 的 14 工具）→ cua-driver 工具：

| ZCode                   | cua-driver                                 | 参数映射                                                                                                              | 备注                     |
| ----------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `list_apps`             | `list_apps`                                | `{}`                                                                                                                  | 结果裸数组               |
| `list_windows`          | `list_windows`                             | `app_ref` → `pid`                                                                                                     |                          |
| `get_app_state`         | `get_window_state`                         | `app_ref`+`window_id` → `pid`/`window_id`；`include_screenshot`；`disable_diffing` 由适配层处理                       | 产出 `state_id`=snapshot |
| `left_click`            | `click`                                    | `target`(index)→`element_index`；`[x,y]`→`x`/`y`；`mouse_button`；`click_count`→`count`；`modifiers`；`app_ref`→`pid` | 后台不可用→前台（§3.5）  |
| `left_click_drag`       | `drag`                                     | `from_target`/`to` → `from_*`/`to_*`；`modifiers`                                                                     |                          |
| `scroll`                | `scroll`                                   | `target`；`scroll_direction`→`direction`；`scroll_amount`→`amount`；`by`                                              | 兼容层：先移指针到目标   |
| `type`                  | `type_text`                                | `text`；`target`→`element_token`；`app_ref`→`pid`                                                                     |                          |
| `set_value`             | `set_value`                                | `target`→`element_token`；`value`                                                                                     |                          |
| `key`                   | `press_key` / `hotkey`                     | `text`(chord) → `key`+`modifiers` 或 `keys`；`repeat`/`hold_seconds`                                                  |                          |
| `paste`                 | `clipboard_write`+`hotkey`                 | `text`；`format` 仅 `text`                                                                                            | 富文本不做               |
| `perform_action`        | —                                          | —                                                                                                                     | 不做（§4）               |
| `select_text`           | —                                          | —                                                                                                                     | 不做（§4）               |
| `request_access`        | `check_permissions` / `permissions status` | `capabilities` 全批准                                                                                                 |                          |
| `stop_computer_control` | `end_session` / `revoke`                   |                                                                                                                       |                          |

**目标解析**

- `app_ref{name|bundle_id|pid}` + `window_id`：适配层用 `list_apps`/`list_windows` 收敛到 `pid`/`window_id`（§3.1）。
- `target:number`：是**最近一次观测**的 element index，适配层映射到该快照的 `element_token`；无观测→`STALE_STATE`。
- `target:[x,y]`：最新 raster 的窗口本地像素 → cua-driver `x`/`y`（同一截图空间）。

**结果映射**

- `state_id` ← `snapshot_id`；`elements` ← `elements`；`window`/`app` ← 观测元数据。
- `frame_id`：cua-driver 无签名 → 用 `snapshot_id` 代替，标记 `unverified`（决策 2）。
- `action_sent`：由适配层推导（§3.3）。
- 文本/图片块 ← `text`/`images`；`structuredContent` 透传。

## 3. 适配层状态机（要做）

### 3.1 身份收敛

- `app_ref` 有 `name` 时用 `list_apps` 解析到 `pid`+`bundle_id`，之后所有调用只带 `pid`/`window_id`（输入严格）。
- pinned `window_id` 观测后若发现落回别的窗口 → `STALE_STATE`，不静默继续。

### 3.2 观测缓存与 diffing

- 每个 `(pid, window_id)` 持有最近一次快照：`{ stateId, elements, baselineShown }`。
- `tree_shown_to_model=false`（绑定时的探测）不置 baseline；模型首次看到树后置 baseline。
- 之后观测只发相对 baseline 的 diff；`disable_diffing=true` 强制全量。
- 这是适配层**唯一**允许的缓存（观测状态），仍不缓存窗口坐标/剪贴板。

### 3.3 `actionSent` / 投递不确定性

- 成功且无歧义 → `actionSent:true`。
- 校验阶段失败、未下发 → `false`。
- **不确定投递**（如超时、连接中断）→ `possibly_sent`，`retry:"reobserve"`，禁止盲重试。
- cua-driver 的 `action`/`verification` 字段是否足以判定"不确定"，实测后定；不足则按"下发即 true"。

### 3.4 冷启动 not-ready

- 首次调用若 driver/daemon 未就绪 → 返回非错误 envelope `kind:"CUA_NOT_READY"`，重试 6 次、退避 250/500/750/1000/1500ms；`possibly_sent` 不重试。
- 次数耗尽→`TIMEOUT`；不可重试→`CONTROLLER_BUSY`。

### 3.5 前后台回退（决策 1）

- 输入类工具默认期望后台；driver 返回 `background_unavailable` 时，**自动重试一次** `delivery_mode:"foreground"`，结果 `_meta.deliveryMode:"foreground"`、`foregroundFallback:true`。
- 兼容层（老 GNOME）本身只能前台：直接前台并在 `_meta` 标注，不假装后台。
- 模型面据此知道"当前只能前台"，`FOREGROUND_REQUIRED` 不再作为硬失败。

### 3.6 未验证截图（决策 2）

- 观测返回的截图没有身份签名（或 `surface_identity_unproven`）时**不丢弃**：照常投影，标记 `_meta.screenshotUnverified:true`。

## 4. 不做/暂不做（写在这里，避免反复论证）

| 项                    | 原因                                                                               | 重新评估的条件                          |
| --------------------- | ---------------------------------------------------------------------------------- | --------------------------------------- |
| `select_text`         | cua-driver 无"按文本定位并设选区"原语（AT-SPI Text 未暴露）                        | 上游加 `select_text` 或 `set_selection` |
| 通用 `perform_action` | cua-driver 只有 `set_value`/`invoke_menu`/element click，无"按名字执行任意 action" | 上游加通用 action 调用                  |
| `paste` 富文本        | 无 format 语义                                                                     | 上游支持 rich clipboard                 |
| 多光标 `cursor_id`    | ZCode 未使用                                                                       | 有并发多指针需求                        |
| capability 粒度权限   | 先全批准                                                                           | 需要最小权限时                          |
| Wayland 后台投递      | 平台无 per-window 目标                                                             | 合成器协议支持                          |

## 5. 实施顺序

| 阶段 | 内容                                        | 状态                                                                                                                                                             |
| ---- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0   | 本文件（决策 + 映射 + 缺口）                | 本文件                                                                                                                                                           |
| M1   | 工具名/参数/结果映射 + 目标解析（§2、§3.1） | **已完成**（`packages/zcode-cua/surface.js`；86/86 单测；本机 ZCode 14 工具名驱动 `list_apps`/`list_windows`/`get_app_state`/`left_click`/`type`/`scroll` 全通） |
| M2   | 前后台回退 + 未验证截图（§3.5、§3.6）       | **部分**（截图已标 `screenshotUnverified`；driver 后台不可用→前台的自动重试待做）                                                                                |
| M3   | 观测缓存与 diffing（§3.2）                  | **已完成**（baseline 指纹 + `disable_diffing` + `tree_shown_to_model`；结果标 `_meta.diff`）                                                                     |
| M4   | `actionSent` 与冷启动（§3.3、§3.4）         | **已完成**（成功/失败/possibly_sent 推导；not-ready 退避重试）                                                                                                   |
| M5   | `request_access` 全批准 + 停止（§2）        | 已完成（全批准）                                                                                                                                                 |
| M6   | 端到端：桌面 App 表单填写 / 文件管理器归档  | 待开始                                                                                                                                                           |

## 6. 验收

1. 用 ZCode 的 14 个工具名能驱动 `createComputerUseRuntime`，未映射项返回 `ACTION_UNAVAILABLE`。
2. `target:number` 绑最新快照，无观测→`STALE_STATE`，快照过期→拒绝。
3. 后台不可用时自动前台，结果带 `foregroundFallback`，不硬失败。
4. 观测首次全量、之后 diff，`disable_diffing` 强制全量。
5. 不确定投递→`possibly_sent` 且不重试。
6. `pnpm typecheck`、`pnpm lint`、`architecture:check --changed` 全绿。
