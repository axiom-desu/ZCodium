# 手机远控桌面（Web Remote Control）补齐方案

配套：

- `.agents/specs/bots-astrbot-bridge.md`（AstrBot 降级通道，与本 spec 的传输层并行）
- `packages/shared/src/task-realtime.ts`（已开源的 `web-remote-replayable` 客户端模式）
- `packages/server/src/http.ts` 的 `/ws/remote/:id`（已开源的远端 service 桥接先例）

## 背景

官方 3.14.3 安装包带 `webRemoteControl`（手机远控桌面），开源仓库只进来了**渠道选择外壳**
（`packages/ui/src/WebRemoteControlDialog.tsx` 的 botChannel 一段，15 键 + 自研 AstrBot 2 键），
远控本体未实现，是当前最大缺口（89 键）。

本 spec 的记录方式：从 `official-builds/ZCode-3.14.3-win-x64.exe` 解出 `resources/app.asar`，
对 `out/main/index.js`、`out/main/chunk-GJUBRD53.js`、`out/host/chunk-B7L5SK4K.js`、
`out/preload/index.cjs` 与 renderer chunk 做符号与字符串恢复（esbuild `keepNames` 保留了
函数名），得到官方实现的完整结构；协议字段以恢复结果为准，少数常量标注「待验证」。

**关键发现：官方手机端就是 ZCode 的 web profile。** 官方 main 进程的端点解析器产出：

```text
remoteUrl          = ${origin}/remote/v3|v4      # 按 appVersion 切换，v4 见 isWebRemoteControlV4AppVersion
webRemoteCallbackUrl = ${origin}/web-remote/callback
relayWsUrl         = ${origin}/ws
```

手机扫码打开的是**同 origin 的 web app 版本化入口**，配对一个外部 relay WS，再把 RPC 桥到
桌面已有 Host。本仓库随上游 3.14.3 开源进来的正是这一半：`ZCodeTaskClientMode` 的
`desktop-continuous | web-remote-replayable` 两模式、`task-realtime` 的 replayable 消息、
`workbenchGroupStore.configureClientMode` 的门控、以及 web 端 `?remote=<id>` 挂载。
**未开源的一半**是：配对 + relay 传输 + mobile shell UI（即那 89 键）。

## 目标与非目标

**目标**

- 同一网络下手机扫码即用（loopback/LAN 直连，零配置，fail-closed）。
- 跨网场景由**用户自行解决公网可达**（WireGuard/Tailscale、反向隧道、自己的 VPS），
  桌面端只提供「可配置端点」与「用户自托管 relay」两样东西。
- 协议与官方 wire 保持兼容（为将来互通留门），但**不依赖、不默认、不回退**任何官方服务。
- 移动端复用 `packages/web` 与 `web-remote-replayable` 模式，不另起 SPA。
- 桌面侧复用已有 Host attachment 与远端 workspace 基础设施，不为手机新起 Agent / Local Host / 会话。

**非目标（v1 明确不做）**

- 由本项目运营任何 relay / 公网服务；不买、不运维、不默认外部 relay。
- 账号体系、OAuth、`/web-remote/callback` 类登录态（自托管用配对 secret）。
- 文件内容代理、快照托管、业务状态持久化（relay 与 Main 都不存）。
- 多 relay 集群、Redis、跨 relay 路由。
- 遥测与 analytics（默认零上报，遵循 `DIAGNOSTICS.md`）。

## 决策

| #   | 决策                                                                  | 理由                                                                          |
| --- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 1   | 默认 loopback/LAN 直连；跨网必须用户显式配置端点                      | 零外部依赖；把「暴露到公网」变成用户显式选择                                  |
| 2   | 不直连官方 relay（`zcode.chatglm.site`），wire 仅保持兼容             | 与「不依赖官方服务」原则冲突；passHash/设备指纹发第三方不可接受               |
| 3   | 移动端 = `packages/web` 新增 mobile entry                             | 官方即 web profile；仓库已有 `web-remote-replayable` 与 `/ws/remote/:id` 先例 |
| 4   | 手机桥接桌面**已有** Host attachment                                  | AGENTS.md「手机远控连接桌面已有 Host attachment，复用会话运行时」             |
| 5   | relay 作为**用户自托管可选包**（`packages/relay`）                    | 公网归用户；relay 无状态，挂了不丢业务数据                                    |
| 6   | 协议契约以 `packages/shared` zod 为单一事实源                         | relay / 桌面 / 移动三端不复制定义                                             |
| 7   | 严格区分 `desktop-continuous` 与 `web-remote-replayable` 两种链路语义 | AGENTS.md 硬约束；改 stream/snapshot/queue/重连时必须同时验证两者             |

## 范围

**纳入**：桌面运行时（配对、状态机、授权 token、workspace/task 同步、attachment 调度）；
传输层（LAN 直连 + 通用 relay 客户端）；RPC 装配器（分片/ack/流控/回放）；mobile entry
（mobileShell/mobileHome + 会话视图）；可选 relay 包；89 键 i18n。

**排除**：见「非目标」。AstrBot 通道保持既有形态，作为「无浏览器时的纯文本降级」，
不与本 spec 的富交互链路合并状态。

## 状态所有者

| 状态                                                       | 所有者                                                                                           | 说明                                                                                                               |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| 配对 secret / passHash                                     | Desktop main（credential store，key `web-remote-control:external-relay:pass_hash`）              | secret 只展示一次；passHash 落 credential，deviceSid 落 settings（对齐官方 `webRemoteControlExternalRelayDevice`） |
| 设备注册表 / 配对关系                                      | 端点（LAN 模式 = 桌面自己；relay 模式 = 用户 relay，仅内存）                                     | relay 不持久化，重启即失效                                                                                         |
| 窗口远控运行时（状态机、bridge、pendingOutbound）          | Desktop main `WebRemoteControlManager`（按窗口一份）                                             | 唯一写入路径                                                                                                       |
| workspace / task 清单                                      | 既有桌面事实源（window host / task index），经 `SyncWebRemoteControlWorkspaces/Tasks` 推给运行时 | 远控不另建索引                                                                                                     |
| 会话 RPC / owner/lease / stale run 防护                    | 既有 Host（`SessionRealtimePort` 语义）                                                          | 桥接不参与 run owner/lease                                                                                         |
| 传输进度（seq / cursor / replay / 流控）                   | 传输层（桌面 relay 客户端或 relay 服务，各自内存）                                               | 插件/对端只去重与 ack，不产生事实                                                                                  |
| 移动端视图态（activeWorkspaceKey/activeTaskId/deviceInfo） | 移动端 → `mobile-view-state-update` 回传桌面运行时                                               | 桌面只存不解释                                                                                                     |
| 启动恢复上下文                                             | settings（`webRemoteControlLastEnabledContext`）                                                 | 仅 workspacePath/Identity/initialTaskId                                                                            |

## 组件

```text
packages/shared/src/webRemoteControl/          协议契约（zod，无 IO）
  envelope.ts             app 层信封（zcode_type 全集）
  relayFrame.ts           设备 ↔ 端点 wire 帧
  rpcTransport.ts         RPC 装配器契约（分片/ack/流控/指纹）
packages/desktop/src/main/webRemoteControl/
  manager.ts              按窗口运行时、状态机、授权 token、failure 保留
  transport/lanTransport.ts       loopback/LAN 直连（默认）
  transport/relayTransport.ts     通用 relay 客户端（用户自备端点）
  authProvider.ts         secret 生成 / passHash / HMAC proof（node crypto）
  authStorage.ts          settings + credential 读写与轮换
packages/desktop/src/host/webRemoteControlHost.ts   Host attachment + RPC 装配器
packages/web/src/mobile/                   mobile entry（mobileShell/mobileHome）
packages/relay/（新增，可选）                用户自托管 relay：Node CLI + Docker
packages/ui/src/WebRemoteControlDialog.tsx 扩展：QR/复制/刷新/停止/状态
```

依赖方向：shared → services → desktop；mobile entry 经 `packages/web` 既有入口；
relay 只依赖 shared 契约子集，不 import 业务实现。

## 传输层：设备 ↔ 端点

端点三态（同一 `DeviceTransport` 接口，桌面启动时按配置选择）：

1. **LAN 直连（默认）**：桌面监听 loopback + 探测 LAN 地址，自身承担「注册/配对/转发」；
   手机与桌面同网时 QR 指向该地址。无新组件。
2. **用户隧道暴露**：用户用 cloudflared / frp / `ssh -R` / WG / Tailscale 把「页面 + WS」
   暴露到公网。桌面无需改动，仅 QR 里的对外地址来自用户配置。
3. **用户自托管 relay**：桌面 outbound 连用户填的 `wss://<用户域名>/ws`，按官方 wire 收发。

### wire 帧（与官方兼容；「待验证」项见 §开放问题）

```text
client→server  device_register_init {device_mid, pass_hash, meta, client_ts}
server→client  device_register_ack  {device_sid}
client→server  auth_init            {role, device_sid, meta, client_ts}
server→client  auth_challenge       {nonce}
client→server  auth_response        {device_sid, proof, client_ts}
server→client  auth_ack             {pair_status}
client→server  pair_status_query    {device_sid, client_ts}      # 设备心跳，~10s±jitter
server→client  pair_status_ack      {pair_status}                # waiting | matched
client→server  data                 {payload}                    # app 信封或 rpc 原始帧
server→client  data                 {payload}
server→client  error                {code, message}              # KICKED|AUTH_FAILED|INTERNAL|WRONG_PARAM
```

- `proof = HMAC-SHA256(pass_hash, "${nonce}|${role}|${device_sid}")`，base64url；
  `role` 桌面侧为 `device`，移动侧字符串**待验证**（实现为可配置，默认 `mobile`）。
- `nonce` 一次性、TTL ≤ 60s；`device_sid` ≥128 bit 随机，不可枚举。
- 握手连接带 `?mid=<deviceMid>` 与 `X-Device-ID` 头（对齐官方，便于端点侧限速）。
- 心跳 10s±jitter；ack 看门狗可配（默认 3 周期）。桌面断链进宽限（默认 ~30s），
  期内移动端保持、桌面重连续配为 `matched`，手机无感。
- `error` 语义：`KICKED`（同 sid 第二个移动端接入 / 端点踢出）、`AUTH_FAILED`
  （hash 不符或 sid 失效，直接关闭不泄露存在性）、`INTERNAL`（端点过载或内部错误）、
  `WRONG_PARAM`（超限帧等，可配置为丢弃+通知或关闭）。
- 单帧上限 `maxPhysicalFrameBytes` 默认 1 MiB 可配（官方实际值待验证）；超限丢弃并
  通知发送方，对应桌面 `bridge-degraded{reason:"rpc-transport-fault"}`。
- 未配对（`waiting`）状态的 `data` 丢弃；端点不缓存、不补投——补投是两端语义。

## 配对与二维码

- secret：24 随机字节 base64url，一次性；`passHash = SHA256(secret)` base64。
- QR/链接 URL：`<remoteUrl>?sid&hash&t&mid&name&app_version&theme`（对齐官方
  `buildWebRemoteControlExternalQrUrl`）；`theme` 取桌面当前主题种子
  （`packages/web/src/webThemeSeed.ts` 的 `light|dark|zai-light|zai-dark|system`）。
- 同一配对同一时刻只允许一个手机页面；第二个接入触发 `KICKED`（UI 呈现
  `failure.sessionConflict` + `singlePageNote` 提示）。
- 「刷新二维码」= 清除存量 auth 并重新注册（新 sid），旧 sid 立即失效；需二次确认。
- 配对空闲 TTL 默认 24h 可配；过期后该 sid 连接按 `AUTH_FAILED` 处理。

## 应用层信封（`zcode_type` 全集，逆向恢复）

| zcode_type                    | 方向 | 关键字段                                                                          | 桌面动作                                                                                                                 |
| ----------------------------- | ---- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `bootstrap-request`           | M→D  | requestId                                                                         | 回 `bootstrap-response`：windowControlSessionId、desktopAppVersion、workspaces、tasks、initialViewState、mobileViewState |
| `workspace-list-request`      | M→D  | requestId                                                                         | 回 `workspace-list-response`；清单变化时主动推 `workspace-list-updated`（带签名去重）                                    |
| `platform-request`            | M→D  | requestId, method, args                                                           | 调 `platformHandlers[method]`，回 `platform-response`                                                                    |
| `mobile-view-state-update`    | M→D  | viewState, deviceInfo                                                             | 仅存不解释                                                                                                               |
| `workspace-bridge-open`       | M→D  | requestId, workspaceKey, taskId?, bridgeSessionId, bridgeGeneration?, recoveryId? | 挂 Host attachment，回 `workspace-bridge-ready{bridge}` 或 `workspace-bridge-error`                                      |
| `workspace-reconnect-request` | M→D  | requestId, workspaceKey                                                           | 触发桌面侧重连，回 `workspace-reconnect-response`                                                                        |
| `rpc-frame` / `rpc-frame-ack` | 双向 | 装配器帧                                                                          | 进出 RPC 装配器（见下）                                                                                                  |
| `app-error`                   | D→M  | reason, error                                                                     | 运行时失败下发                                                                                                           |
| `bridge-degraded`             | D→M  | bridgeSessionId, reason                                                           | 原始链路降级通知                                                                                                         |
| `telemetry-report`            | M→D  | event                                                                             | **丢弃**（本仓库零上报；仅本地 diagnostics 可选）                                                                        |
| `mobile-diagnostic`           | M→D  | event/state/pairStatus/closeCode…                                                 | 本地日志                                                                                                                 |

`platformHandlers`（对齐官方恢复集合，全部走既有服务，不建新业务状态）：
`isDockerAvailable`、`listWSLDistros`、`listDockerContainers`、`listSSHConfigAliases`、
`createTempTextAttachment`、`loadMcpFromUserDirectory`、`saveMcpToUserDirectory`、
`migrateLegacyCommonMcp`。

## RPC 桥接（手机 ↔ 桌面已有 Host）

- `attachWorkspaceHost(windowId, {workspacePath, workspaceIdentity, remoteSessionId, initialTaskId, kind})`
  返回 `{attachmentId, entryId, port}`；port 为到窗口 Host 的 MessagePort。
  复用模式见 `packages/services/src/bots/botRemoteWorkspaceBridge.ts` 与
  `packages/desktop/src/host/hostRemoteWorkspaceProxyState.ts`。
- 装配器职责：应用消息 ↔ 物理帧的分片与重组（`maxMessageBytes` / `maxFragments` /
  `maxPhysicalFrameBytes`）、`seq` 单调有序、`ack` 确认与超窗回放、帧指纹去重、
  流控（`saturated` / `drained` 背压）、`measureFrameBytes` 度量。
- `readyAnnounced` 之前或 `degraded` 之后不出帧；降级路径发 `bridge-degraded` 并保留
  window 运行时失败状态（不因二次失败覆盖首次 failure）。
- 断链：装配器标记 degraded → 桌面经端点重连 → `recoveryId` 续配 → 未确认帧回放。
- 语义归属：`web-remote-replayable`（快照 + 回放），与桌面 `desktop-continuous`
  （实时流）严格分离；`workbenchGroupStore` 等消费方已有 `configureClientMode` 门控。

## 桌面运行时（`WebRemoteControlManager`，按窗口）

- 用户态状态机：`idle → starting → connecting → running ⇄ active → error`；
  `running` = 等待手机（端点 `waiting_terminal`），`active` = 已配对。
- 传输态（端点上报）：`connecting / registering / authenticating / waiting_terminal /
paired / kicked / error`；`paired` 时若有移动端在途则保持 `active` 并启动断链宽限。
- 授权：`authorizeStart` 发一次性 token（绑定 windowId + workspaceKey + remoteSessionId，
  短 TTL，消费即焚），`startAuthorized` / `resetPairingAuthorized` 消费后执行；
  不匹配抛错且不改状态。
- 状态广播：`onStatusChanged(windowId, status)` → preload → renderer；
  `getStatus` 在 feature gate 关闭时返回 `idle` + `failure.unsupported-action`。
- 生命周期：`disposeWindow`（窗口关闭：清授权、停运行时、释放该窗口全部 attachment）、
  `failRemoteSession`（远端会话关闭：向对应 bridge 发 `workspace-bridge-error`）、
  `syncAvailableWorkspaces/Tasks`（清单变化推送）、`restorePreviouslyEnabled`（启动恢复）。
- settings 三键：`webRemoteControlExternalRelayDevice.deviceSid`、
  credential `web-remote-control:external-relay:pass_hash`、
  `webRemoteControlLastEnabledContext`。日志脱敏对齐官方 `safeAuthLogFields`
  （只记 deviceSid 末 6 位、布尔位，不记 secret/hash/proof）。

## 桌面 UI（扩展现有弹层）

`WebRemoteControlDialog` 在既有 botChannel 区之外补齐：

- 二维码区（`mobileQr.*` / `qrAlt` / `generating`）：QR 数据图由 `qrUrl` 生成，
  就绪前显示 `generating`。
- 复制链接（`copyLink.*`）：写剪贴板，失败给 `copyLinkFailed{error}`。
- 刷新二维码（`refreshQr.*`）：二次确认（confirmTitle/confirmDescription）后重置配对。
- 停止（`stop` / `stopSuccess` / `stopFailed`）。
- 会话状态（`statusLabel` / `status.*` / `statusDetail.*` / `statusTag.phone|ready`）与
  trigger 状态（`triggerStatus.idle|starting|connecting|waiting|connected|error`）。
- 单页面提示（`singlePageNote`）、无可切换工作区（`noSwitchableWorkspaces` / `noTasks`）。
- 轮询兜底（1s）+ `WebRemoteControlStatusChanged` 推送双通道；`themeMenu.trigger`
  主题切换（移动端键，桌面弹层不展示）。

IPC 面（preload ↔ main，`packages/shared/src/channels.ts` 新增）：
`StartWebRemoteControl`、`StopWebRemoteControl`、`GetWebRemoteControlStatus`、
`ResetWebRemoteControlPairing`、`SyncWebRemoteControlWorkspaces`、`SyncWebRemoteControlTasks`、
事件 `WebRemoteControlStatusChanged`、`WebRemoteControlReconnectWorkspace`。

## 移动端（`packages/web` mobile entry）

- 路由/入口：`/remote`（自托管单版本，不做官方 `v3/v4` 分流）；二维码里的
  `sid/hash/t/mid/name/app_version/theme` 由入口读取并 drive 配对。
- mobileShell：`chatTitle`（任务会话）、`backHome`、`reconnecting`。
- mobileHome：`sectionTitle` / `summary{workspaceCount,taskCount}` / `taskCount{count}` /
  `updatedAt{time}` / `workspaceEmpty` / `organize`（`organizeByTimeline|organizeByWorkspace`）/
  `sortBy`（`sortByCreated|sortByUpdated`）/ `refresh` / `reconnect` / `reconnecting` /
  `connected` / `disconnected` / `notice` / `collapseAll` + `collapseNavigation` /
  `expandNavigation` / `workspaceKind.local|remote|conversation` / `taskStatus.*` /
  `openTask{title}` / `switchWorkspace`。
- 客户端模式：`web-remote-replayable`（经 `configureClientMode`），不恢复桌面 groups、
  不写桌面 localStorage。
- 打开任务 → `workspace-bridge-open` → RPC 会话；权限 / elicitation 以既有
  selection 文本契约应答（与 bots 侧 `astrbotSelectionPayload` 的 canonical 文本同源，
  序号 + 命令格式）。
- 重连：visibility/online 事件驱动；`recoveryId` 续配后拉 snapshot 回放。

## relay 需求（用户自托管，摘要）

完整 FR/NFR/AC 见本次讨论定稿（随本 spec 归档），要点：

- 只做鉴权、配对、心跳、转发；零业务状态、零持久化；可随时重启。
- WebSocket 默认路径 `/ws`；`perMessageDeflate`；`device_sid` 高熵随机；nonce 一次性。
- 单配对单移动端 + `KICKED`；刷新配对立即使旧 sid 失效；配对 TTL 默认 24h。
- 单帧上限默认 1 MiB 可配；超限丢弃并通知；未配对帧丢弃；不缓存不补投。
- `/healthz`（+ 可选 `/metrics`）；结构化日志不落 secret/hash/完整 sid；
  per-IP 限速；优雅退出（明确 close code）。
- 部署：Docker 镜像 + compose；裸 Node CLI 非 root 可跑；TLS 由前置
  （Caddy/traefik/隧道）或内置证书；全部配置经环境变量。
- 资源：2C/2G 支撑 ≥200 并发配对；空闲内存 <150MB；socket/配对上限可配（默认 1000）。

## i18n

`webRemoteControl.*` 官方 zh 表共 104 键；仓库现有 17 键 = 官方 15 键 + 自研 AstrBot
2 键（`botChannel.astrbot.title/description`）。**需新增 89 键**（与 README 缺口表口径一致，
2026-09-29 用官方安装包 IntlProvider 表复核）。新增键按上文 UI/移动端分节落
`packages/ui/src/i18n/locales/{zh-CN,en-US}.ts`；`telemetry-report` 相关键不落（零上报）。

## 失败语义（12 种，桌面 UI 文案映射）

| failure.reason              | 触发                                       | 文案键                              |
| --------------------------- | ------------------------------------------ | ----------------------------------- |
| `sessionNotFound`           | 链接失效/未知 sid                          | `failure.sessionNotFound`           |
| `sessionExpired`            | 配对 TTL 过期 / 会话已结束                 | `failure.sessionExpired`            |
| `sessionConflict`           | 同 sid 第二页面（`KICKED`）                | `failure.sessionConflict`           |
| `kicked`                    | 端点踢出                                   | `failure.kicked`                    |
| `workspaceClosed`           | 桌面共享窗口/远端会话关闭                  | `failure.workspaceClosed`           |
| `desktopDisconnected`       | 桌面主动断开                               | `failure.desktopDisconnected`       |
| `invalidMobileConnection`   | 手机连接失效                               | `failure.invalidMobileConnection`   |
| `desktopBootstrapTimeout`   | 桌面启动响应超时                           | `failure.desktopBootstrapTimeout`   |
| `connectionRecoveryTimeout` | 手机恢复超时                               | `failure.connectionRecoveryTimeout` |
| `relayUnavailable`          | 端点不可用                                 | `failure.relayUnavailable`          |
| `unsupportedAction`         | feature gate 关闭 / 目标工作区不在当前窗口 | `failure.unsupportedAction`         |
| `unexpectedError`           | 其他                                       | `failure.unexpectedError`           |

失败保留规则：`error` 态运行时的 failure 不因二次失败覆盖；`getStatus` 在 gate 关闭时
返回 `idle` + `unsupported-action`。

## 验收场景

1. 同网手机扫码 → `bootstrap-response` 列出桌面当前窗口的工作区/任务；打开任务完成一轮对话。
2. 刷新二维码后，旧链接全部失效（`sessionNotFound` / `AUTH_FAILED`），新链接可用。
3. 同一链接第二个手机页面接入 → 旧页面收到 `sessionConflict`，桌面状态回退正确。
4. 桌面断开 30s 内重连 → 自动续配，手机无感；超时 → `connectionRecoveryTimeout`。
5. 桌面窗口关闭 → 该窗口运行时与全部 Host attachment 释放，手机收到 `workspaceClosed`。
6. 跨网（4G）经用户隧道/自建 relay：配对与 RPC 全通，p95 附加延迟 <100ms。
7. 权限 / elicitation 在移动端以序号命令应答，原任务继续并收口。
8. 流控背压生效：saturated/drained 切换；超限帧被丢弃且 `bridge-degraded` 上报。
9. 远控全程不新起 Agent / Local Host / 会话（对照 AGENTS.md）；owner/lease 与
   stale run 防护行为与桌面一致。
10. `desktop-continuous` 与 `web-remote-replayable` 两种模式回归通过
    （groups 门控、snapshot/queue/重连语义）。
11. 日志审计：grep 不到 secret / passHash / proof / 完整 deviceSid；无任何上报请求。
12. `pnpm typecheck` / `pnpm lint` / 架构检查保持基线。

## 分期

| 阶段 | 内容                                                                                  | 验收                            |
| ---- | ------------------------------------------------------------------------------------- | ------------------------------- |
| P0   | 本 spec + `packages/shared/src/webRemoteControl/` zod 契约（信封 / wire 帧 / 装配器） | typecheck/lint；契约无 IO       |
| P1   | 桌面运行时 + LAN 直连传输 + 配对/QR + UI 扩展 + 89 键                                 | 场景 1/2/3/5                    |
| P2   | Host attachment + RPC 装配器（复用存量端口挂载）                                      | 场景 7/8/9                      |
| P3   | mobile entry（mobileShell/mobileHome + 视图态 + 重连）                                | 场景 1/4/10                     |
| P4   | 可配置对外端点 + 通用 relay 客户端传输                                                | 场景 6；未配置时仅 LAN          |
| P5   | `packages/relay` 自托管包 + Docker/compose + 部署文档                                 | 场景 6/11；relay 重启无业务损失 |
| P6   | hardening（TLS/限流/TTL/互踢/脱敏）+ 全量验收                                         | 场景 1–12                       |

## 迁移边界

- 新功能，无数据迁移。既有 botChannel 外壳保留为降级入口（AstrBot），
  与富交互链路**不共享状态**：bots 绑定归 `BotsService`，远控配对归桌面运行时。
- 与官方 wire 兼容是「留门」不是「依赖」：默认端点绝不指向官方域名；
  若将来启用官方 relay，必须为用户显式选项并在文档中标注第三方可见性。

## 已知限制与开放问题

1. **逆向待验证**：`maxPhysicalFrameBytes` 官方实际值；移动端 `auth_init.role` 字符串与
   proof 拼接格式；`meta` 字段全集；trigger 状态中出现的 `deviceToken/expiresAt`
   （疑似更新版 schema，恢复样本中未见产生路径）。实现先按可配置默认 + 实测校准。
2. **官方 `/web-remote/callback` 不需要**：自托管以配对 secret 鉴权，无账号体系。
3. **单点**：用户自托管 relay 或隧道失效时仅影响跨网路径；LAN/WG 不受影响。
4. **公网暴露面**：默认只绑 loopback/LAN；`0.0.0.0` 绑定与对外地址必须显式配置，
   文档需置顶推荐 WG/Tailscale。
5. **E2E 可选**：官方无应用层加密；relay 在公网时建议以配对 secret 派生 AES-GCM
   信封（P6 评估，默认关闭）。
6. **README 缺口表**在本 spec 落地实现后更新（89 → 0），不在本 spec 内修改。

## 实现状态（2026-09-29 更新）

| 阶段                                 | 状态 | 落地位置                                                                                                                                                                                                                                                                  |
| ------------------------------------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0 协议契约                          | ✅   | `packages/shared/src/webRemoteControl/`（envelope / relayFrame / rpcTransport / status）+ `channels.ts` 8 个 IPC + settings 4 键 + `IPlatformService` 8 方法                                                                                                              |
| P1 桌面运行时 + LAN 直连 + UI + i18n | ✅   | `packages/desktop/src/main/webRemoteControl/`（manager / lanEndpoint / deviceTransport / authProvider / authStorage / qrUrl / mobileAppAssets / ipc）；`WebRemoteControlDialog` + `WorkspaceWebRemoteControlTrigger` + `useWebRemoteControl`；89 键已落 `zh-CN` / `en-US` |
| P2 Host bridge + RPC 装配器          | ✅   | `hostBridge.ts`（AttachServicePort `web-remote-replayable` + MessagePortProtocol + ChannelClient + 服务代理）+ `bridgeController.ts`                                                                                                                                      |
| P3 移动端 mobile entry               | ✅   | `packages/web/mobile.html` + `src/mobile/`（protocol 配对客户端 / MobileApp mobileHome+mobileShell）；vite 多入口构建                                                                                                                                                     |
| P4 可配置对外端点 + relay 客户端传输 | ⬠    | settings 已有 `webRemoteControlEndpointMode/CustomEndpointUrl`；`DeviceTransport` 接口已留位，WS 客户端传输未实现                                                                                                                                                         |
| P5 `packages/relay` 自托管包         | ⬠    | 未开始；wire 契约已在 shared，relay 侧按同一份 schema 实现                                                                                                                                                                                                                |
| P6 hardening + 全量验收              | ⬠    | TLS/限流/TTL/互踢/脱敏已随 P1–P2 落地（ secret 只展示一次、日志脱敏、KICKED、TTL 24h）；E2E 信封与全量验收场景待跑                                                                                                                                                        |

落地时对 spec 的两处修正（以代码为准）：

1. **设备侧握手在 LAN 模式走同进程直连**：`LanRemoteControlEndpoint.registerDevice` 复用与 WS 相同的
   challenge/proof 语义，但不产生真实 loopback 帧；relay 传输（P5）才走完整 wire。
2. **rpc 装配器 v1 不做分片重组**：一个应用消息一帧，靠 seq 保序 + ack 确认；分片与回放留给
   relay 传输（上限常量已在 `WEB_REMOTE_CONTROL_RPC_LIMITS`）。

### 冒烟实测（2026-09-29）

脚本：真起 `LanRemoteControlEndpoint`，用 `ws` 客户端模拟手机走完整握手（authenticate →
pair → data 双向 → 互踢 → 拒绝路径）。覆盖验收场景 1/2/3 与失败语义：

```text
PASS endpoint listening: 4 addresses（loopback + 3 个 LAN IPv4）
PASS device registered, state=waiting_terminal
PASS qr url carries sid/hash
PASS mobile paired (matched)
PASS device sees paired
PASS mobile payload routed to desktop（bootstrap-request）
PASS desktop payload delivered to mobile（bootstrap-response）
PASS second mobile kicks first（error KICKED → session-conflict）
PASS wrong proof rejected（AUTH_FAILED）
PASS unknown sid rejected（AUTH_FAILED）
PASS healthz
```

冒烟抓到并修复的两个真 bug（均已回归通过）：

1. `registerDevice` 返回的 device handle `sendPayload` 是空桩——桌面出站会被静默丢弃；
2. 互踢只 `close()` 不发 `error{KICKED}`——旧页面静默掉线，无法映射 `session-conflict`。

未覆盖项：真实 Electron 窗口的 Host attachment 桥接（需桌面运行时）、移动端浏览器端到端、
跨网（4G/relay）路径——分别属于 P2 联调、P3 联调与 P4/P5。

## 实测证据（2026-09-29，附录）

来源：`official-builds/ZCode-3.14.3-win-x64.exe` → `$PLUGINSDIR/app-64.7z` →
`resources/app.asar`。关键符号（esbuild keepNames 保留）：

| 符号                                             | 位置                                    | 说明                                                                                                          |
| ------------------------------------------------ | --------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `createWebRemoteControlManager`                  | `out/main/index.js`                     | 按窗口运行时全量恢复（状态机/授权/失败保留/同步）                                                             |
| `WebRemoteControlDeviceTransport`                | `out/main/index.js`                     | 设备 ↔ relay wire 全量恢复（register/auth/pair_status/data/error、心跳、stale 恢复、KICKED/AUTH_FAILED 处理） |
| `buildWebRemoteControlExternalQrUrl`             | `out/main/chunk-GJUBRD53.js`            | QR URL 参数 sid/hash/t/mid/name/app_version                                                                   |
| `resolveWebRemoteControlRelayWsUrl`              | `out/main/chunk-GJUBRD53.js`            | 默认 `wss://zcode.chatglm.site/ws`                                                                            |
| `WebRemoteControlRpcTransportAssembler`          | `out/main/chunk-GJUBRD53.js`            | 分片/ack/流控/指纹/超限                                                                                       |
| `createNodeWebRemoteControlRelayAuthProvider`    | `out/main/index.js`                     | secret 24B base64url；passHash SHA-256；proof HMAC-SHA256                                                     |
| `createWebRemoteControlRelayAuthStorageProvider` | `out/main/index.js`                     | credential key `web-remote-control:external-relay:pass_hash`                                                  |
| 端点解析器                                       | `out/main/chunk-GJUBRD53.js`            | `remoteUrl=${origin}/remote/v3\|v4`、`webRemoteCallbackUrl`、`relayWsUrl=${origin}/ws`                        |
| `registerWebRemoteControlIpcHandlers`            | `out/main/index.js`                     | 5 IPC + 2 事件                                                                                                |
| `platformHandlers`                               | `out/main/index.js`                     | 8 个平台方法（见上）                                                                                          |
| 移动端 UI                                        | renderer chunk（offset≈317.3MB）        | mobileShell/mobileHome/QR/复制/刷新/停止 + preload API 用法                                                   |
| i18n                                             | `out/renderer/assets/IntlProvider-*.js` | `webRemoteControl.*` 104 键全量恢复                                                                           |

注：官方移动端页面托管在 `zcode.chatglm.site`（web origin），从本机与测试 VPS 均不可达
（DNS 解析到内网地址），未做页面级抓取；移动端结论以上表符号 + i18n 键集合为据。

## 附录 A：relay 需求全表（用户自托管）

### A.1 功能需求

| ID    | 需求                                                                                                                                    |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| FR-1  | 监听 WebSocket，默认路径 `/ws`，支持 `perMessageDeflate`                                                                                |
| FR-2  | 设备注册：`device_register_init{device_mid, pass_hash, meta, client_ts}` → `device_register_ack{device_sid}`；sid ≥128 bit 随机不可枚举 |
| FR-3  | 挑战鉴权：`auth_init` → `auth_challenge{nonce}` → `auth_response{proof}` → `auth_ack{pair_status}`；proof 公式见正文                    |
| FR-4  | `role` 至少 `device` 与移动侧角色（待验证，可配置）；nonce 一次性、TTL ≤60s 防重放                                                      |
| FR-5  | 鉴权失败回 `error{AUTH_FAILED}` 后直接关闭，不泄露 sid 存在性（fail-closed）                                                            |
| FR-6  | sid↔passHash 对应仅存内存；重启全部失效，客户端走新注册                                                                                 |
| FR-7  | 一个 sid 同一时刻最多一个移动端 socket；第二个接入时旧连接收 `error{KICKED}` 并被关闭                                                   |
| FR-8  | 桌面刷新配对 = 重新注册生成新 sid；旧 sid 立即失效                                                                                      |
| FR-9  | 配对空闲 TTL 默认 24h 可配；过期后该 sid 按 AUTH_FAILED 处理                                                                            |
| FR-10 | `pair_status` 取值 `waiting                                                                                                             | matched`，设备心跳查询返回 |
| FR-11 | 设备心跳 ~10s±jitter；ack 看门狗可配（默认 3 周期）                                                                                     |
| FR-12 | 桌面断链宽限默认 ~30s：期内移动端保持，桌面重连续配 `matched`，手机无感                                                                 |
| FR-13 | 移动端断开：立即清理配对，桌面下次查询得 `waiting`                                                                                      |
| FR-14 | 任一侧异常断开：清理半开状态，不遗留幽灵配对                                                                                            |
| FR-15 | `data{payload}` 双向原样转发；payload 为 app 信封或 rpc 原始帧                                                                          |
| FR-16 | 单帧上限 `maxPhysicalFrameBytes` 默认 1 MiB 可配；超限丢弃并可通知/关闭发送方                                                           |
| FR-17 | 未配对（`waiting`）的 `data` 丢弃；不缓存、不补投                                                                                       |
| FR-18 | 配对态 p95 附加延迟 <100ms；零解析转发（仅校验大小与 JSON 合法性）                                                                      |
| FR-19 | 可选静态托管 mobile web app（`--static-root`，SPA fallback）                                                                            |
| FR-20 | `/healthz`（连接数/配对数/丢弃帧数）+ 可选 `/metrics`                                                                                   |
| FR-21 | 结构化 JSON 日志；禁止记录 pass_hash/proof/完整 sid（只允许末 6 位）                                                                    |
| FR-22 | per-IP 限速：连接频率、鉴权失败次数、帧速率；超限关闭                                                                                   |
| FR-23 | 优雅退出：SIGTERM 以明确 close code 关闭全部 socket，不写盘                                                                             |
| FR-24 | 配置全经环境变量/flag：`PORT/PATH/MAX_FRAME_BYTES/PAIR_TTL_HOURS/DESKTOP_GRACE_MS/STATIC_ROOT/ALLOWED_ORIGINS/ROLE_MOBILE`              |

### A.2 非功能需求

| ID    | 需求                                                                        |
| ----- | --------------------------------------------------------------------------- |
| NFR-1 | 单进程 Node 24（或 Bun）；空闲内存 <150MB；2C/2G 支撑 ≥200 并发配对         |
| NFR-2 | 有界资源：socket/配对上限可配（默认 1000），达限拒绝新连接（`INTERNAL`）    |
| NFR-3 | 无状态：可随时 kill/重启/迁移，不丢业务数据                                 |
| NFR-4 | 部署：Docker 镜像 + compose；裸 Node CLI 非 root 可跑；TLS 由前置或内置证书 |
| NFR-5 | 不绑定官方域名/服务；默认无遥测；无第三方 CDN 依赖                          |
| NFR-6 | 协议以 `packages/shared` zod 契约为单一事实源，relay 不复制定义             |

### A.3 relay 验收场景

1. 桌面注册得 sid；移动端持 sid+hash 接入 → `matched`；双向 data 按序到达。
2. 错误 hash → `AUTH_FAILED` + 关闭，无信息泄露。
3. 同 sid 第二移动端接入 → 旧端 `KICKED`，桌面呈现 session-conflict。
4. 刷新配对 → 旧 sid 全拒；新 sid 可用。
5. 桌面断 30s 内重连 → 自动续配；超时按宽限规则处理。
6. 超限帧丢弃 + 通知，配对不断。
7. relay 重启 → 全部 socket 关闭；两端重连恢复，无业务损失。
8. 200 并发配对压测 10 分钟：p95 <100ms，内存平稳。
9. 日志审计 grep 不到 secret/hash/完整 sid。
10. `--static-root` 托管 mobile app，SPA 深链不 404。
