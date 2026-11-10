# 手机远控改造：桌面 Host 直接用 Web 客户端（方案 B）

## 决策与背景

现状（`packages/web/src/mobile/**` + `main/webRemoteControl` 信封协议）：

- 手机加载独立 `mobile.html` 与自定义 UI 子集；
- RPC 走自定义信封（`zcode_type: "rpc-frame"` + seq/ack/replay 装配器），存在两套协议与两套 UI；
- 用户实测在「打开任务」这一步直接抛出 Zod issues 原文：桌面 schema 要
  `sessionId/messageId/partId`，对端返回 `sessionID/messageID/id/time`（上游形状），
  而 `initialize` 只上报自己的 `protocolVersion`，**从不校验对端**，于是协议代际漂移被当成消息渲染。

决策：按用户选择走方案 B —— **保留桌面唯一 Host，淘汰 mobile.html 与自定义信封，手机浏览器
直接加载仓库已有的 Web 客户端**（`packages/web`，同一份产物桌面已随包分发为 `resources/web-remote`）。

不采用「`zcode --profile web` 独立起服务」作为主路径：`packages/server/src/entry-http.ts` 会
`createLocalServices()` 起**第二个 runtime**，同一 workspace 上双写 session DB/队列，违反
「单一 owner / 单一 admission」不变量，也看不到桌面正在跑的会话。`entry-http` 仍保留为
headless 服务器模式，与手机远控互斥。

## 所有者与边界

- 业务状态所有者不变：窗口 Host（`CommandInbox`、session DB、owner/lease、stale-run 防护）。
  新端点只做「HTTP/WS 传输 + 浏览器鉴权 + 静态资源」，不持 task/session 状态、不解析 RPC 内容。
- 每个 WS 连接 = 一条既有 attachment（`AttachServicePort`，`clientMode: "web-remote-replayable"`），
  与 renderer、远端 workspace 复用同一条 Host 通道；不复用就意味着新 Host，明确禁止。
- 交付语义保持分离：浏览器连接是 replayable；桌面 renderer 仍是 continuous。二者不互相改写队列。
- 鉴权：沿用现有配对事实（`sid` + `passHash` + 时间戳）换取 **HttpOnly 签名 Cookie**（同源，
  `SameSite=Lax`），WS 升级只认 Cookie，不把凭证放进 URL 长期保存；Cookie 只在端点进程内有效。
- 静态资源只从随包 `web-remote` 目录读取，`/` 之外的路径必须做目录收敛，不暴露任意文件。

```text
手机浏览器
  GET /                → Cookie 有效？ index.html : 配对页
  GET /?sid&hash&t     → 校验配对 → Set-Cookie → 302 /
  GET /assets/**       → Cookie 必需 + 目录收敛
  GET /api/server-info → 最小版本/能力描述（不泄漏身份与工作区）
  WS  /ws              → Cookie 必需
        └─ SocketProtocol ⇄ 字节桥 ⇄ MessagePortProtocol ⇄ 窗口 Host attachment
                                                              └─ 唯一 owner/队列/DB
```

## 与上游 3.17.2 手机改动的合并口径

上游本批把手机侧拆成了 `packages/web/src/web-remote-control/{contract,adapters,app,domain}`
并新增 relay v2（pairing token、push、mobile log、输入预测）。这些能力按层并入本方案，
**不再回到 `mobile.html + 信封协议`**：

| 上游行为                                         | 落点（本方案）                                                  | 状态                             |
| ------------------------------------------------ | --------------------------------------------------------------- | -------------------------------- |
| relay v2 配对 token / 二维码                     | 现有 `qrUrl` + `lanEndpoint` 配对表；token 只是换 Cookie 的凭证 | 保留现有实现，B 阶段只改兑换出口 |
| 手机事件推送（push）、日志通道                   | 浏览器直接用既有 `Broadcast`/事件 RPC，不再需要独立 push 封装   | 由 Web 客户端天然覆盖            |
| 移动端输入预测（ghost hint）                     | `packages/ui` 组合输入层；与传输无关                            | 独立小片，不阻塞 B               |
| 任务读取/视图（`webRemoteControlTaskRead/View`） | Web 客户端既有 `IZCodeSessionService`/`IZCodeTaskService` 路径  | 由 Web 客户端天然覆盖            |
| 断线恢复（`bridgeRecovery`、degraded）           | WS 断开 = attachment 释放；重连重新见面（Web 客户端已有重连）   | B 阶段验收                       |

上游**不并入**的部分：`packages/web/src/mobile/**`（本仓专属旧路径，B 完成后删除）、
本仓已移除的遥测（`telemetry`、`localTtftObserver` 等）。

## 分片

| 片            | 内容                                                                                                                                     | 验收                                                                       |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| B1 传输与鉴权 | 新增 `webClientEndpoint`：静态托管、配对换 Cookie、`/api/server-info`、`/ws` 字节桥接到 Host attachment                                  | 真实 HTTP+WS+真实 `ChannelServer` 往返；无 Cookie 拒绝；跨目录路径拒绝     |
| B2 桌面接线   | manager 以 feature flag 启动该端点；attachment 走 `attachWorkspaceHostPort`（local scope）；`resources/web-remote/index.html` 为默认入口 | 桌面真实启动后浏览器能连上并完成一次真实 RPC；旧 mobile 路径仍可用（灰度） |
| B3 频道面     | 浏览器需要的频道按证据放宽（插件 UI、client-config 等），Electron/窗口专属必须显式拒绝                                                   | 浏览器逐屏走查 + 未审阅频道默认拒绝的回归                                  |
| B4 远端工作区 | `?remote=` / 项目内远端 scope 在 Web 客户端可用，复用窗口 remote registry                                                                | 远端 attach 真实回环 + identity/session 隔离用例                           |
| B5 下线旧路径 | 删除 `mobile.html`、`web/src/mobile/**`、信封协议（`WebRemoteControlRpc*`）、`servicePipe` 与相关测试                                    | 全仓引用清零、无 dead code、gate 通过                                      |

顺序：B1 → B2 灰度 → B3/B4 逐屏 → B5 删除。B5 之前旧路径保持可用，不做「一半切换」。

## 不变量与失败语义

- 协议代际漂移必须在 **B 的传输层之前**被识别：`initialize` 增加对端 `protocolVersion` 校验，
  不匹配返回可读错误（含双方版本），禁止把 Zod issues 原文当消息内容渲染。
- 端点进程重启即失效所有 Cookie 与配对（内存事实），不做持久化，不写业务状态。
- 断线/超时不得靠延时兜底：WS 关闭即 `attachment.dispose()`；重连由客户端重新见面。
- 不新增跨模块依赖：端点只依赖 `@zcode/rpc`、`@zcode/shared` 与 node 内置模块。

## 验收

- 目标测试：真实 `node:http` + `ws` + 真实 `ChannelServer`/`ChannelClient` 的往返；未鉴权拒绝；
  Cookie 兑换与过期；静态目录收敛；attachment 释放。
- 浏览器验收：真实 Chromium 加载 `resources/web-remote` 产物，完成首屏、工作区列表、打开会话、
  发送消息；断网重连一次；手机视口与桌面视口各一次。
- 门禁：`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`、改动文件格式。
- 版本：本次改动并入 3.17.2 线，不单独升版本；B5 删除旧路径后重新出包。

## 实施状态（本轮）

已落地：

- **B1 传输与鉴权**：`main/webRemoteControl/webClientEndpoint.ts`
  - `/` 托管随包 Web 客户端（`index.html` + 静态资源，目录收敛，SPA 回退）；
  - 配对链接（`sid`/`hash`/`t`）兑换同源 HttpOnly 签名 Cookie（12h，进程内密钥，重启即失效），
    302 回 `/` 且不在地址栏保留凭证；
  - `/api/server-info` 只给版本与 `authRequired`，不复制工作区投影；
  - `/ws` 升级必须带 Cookie，桥接为 `SocketProtocol` ⇄ attachment 字节双工；连接关闭即释放 attachment。
- **B2 桌面接线**：`webClientAttachment.ts` 用既有 `attachWorkspaceHostPort`（local scope）打开窗口 Host
  attachment，`MessagePortProtocol` 直连；`manager` 在 LAN 模式下按 flag 启动端点并把 QR base 换成浏览器入口。
  **flag 默认关闭**（`ZCODE_WEB_CLIENT_REMOTE=1` 开启）：B3/B4 未验收前不能顶掉现有入口。

实测（Node 24.14.0）：

- `webClientEndpoint.test.ts` 6 项通过：无 Cookie 401、配对 302+Set-Cookie、Cookie 后可读 bundle 与资源、
  非法配对不发 Cookie、跨目录路径不可读、**带 Cookie 的 WS 完成真实 `ChannelClient` → `ChannelServer` 往返**、
  无 Cookie 的 WS 升级被拒（401）、socket 关闭后 attachment 被释放。
- 回归：`servicePipe.test.ts`、`windowHostAttachmentRpcPolicy.test.ts` 通过。
- `pnpm typecheck` 通过、`pnpm lint` 0/0、`pnpm architecture:check --changed` 0 violation。

未完成（下一轮，按序）：

1. **B3 频道面**：用真实浏览器逐屏走查，确认完整 Web 客户端所需频道（`client-config`、`plugin-ui-*`、
   `settings-sync` 等）与必须拒绝的 Electron/窗口专属频道；未审阅频道仍默认拒绝。
2. **B4 远端 scope**：`?remote=` 与项目内远端导航接到窗口 remote registry（identity + session 校验）。
3. **B5 下线旧路径**：删除 `mobile.html`、`web/src/mobile/**`、信封协议与 `servicePipe`，翻默认值。
4. 端到端：真实 Electron 启动 + 真实 Chromium 加载 `resources/web-remote`，完成首屏/列表/打开会话/发消息/断线重连。

3.17.2 其余语义同步（CLI 上下文与生命周期、数据同步中心、项目管理、UI 大面、远端 stop/restart 等）
仍是 `upstream-3.17-sync.md` 的独立账单，本轮未动。

## 本轮追加：B3 频道面与默认开关

- attachment 增加可选 `surface: "mobile" | "web-client"`（shared strict schema 可选字段，旧客户端不传即手机子集）。
- `web-client` 面 = 手机面 + `client-config`、`skill-sync`、`plugin-sync`、完整 `gen-ui`；
  显式排除 `window-controller`（桌面窗口操作）、`provider-provisioning-target`、`source-server-management`
  （本机设备/凭据写面）。未审阅频道与 override 仍默认不发布。
- 浏览器 attachment 以 `surface: "web-client"` + `web-remote-replayable` 打开，交付语义不变。
- 回归：`windowHostAttachmentRpcPolicy.test.ts` 新增 2 项（web-client 放行/拒绝矩阵、未声明 surface 时
  手机子集不变），`packages/desktop/src/host` + `main/webRemoteControl` + `packages/rpc` 共 231 项通过。
- 默认开关翻为「开启」：`ZCODE_WEB_CLIENT_REMOTE=0` 可回退旧 `mobile.html` 入口（B5 前的逃生阀）。

## 仍未完成（下一轮必须先做）

1. **协议握手门禁**（截图里的 Zod 原文）：见 `agent-protocol-handshake.md`——首轮
   `session/list` 探针不含身份，不能真正校验版本，已改为 `runtime/capabilities` 协议身份声明/比较。
   探针总预算 10s 且只读 observation，不回收 Agent；旧 Agent 未声明版本时明确
   `protocolVerified:false`（未验证，不宣称兼容）。响应错误正文不再含原始 issues/对端值。
2. **B4 远端 scope**：attachment 固定 local scope，远端工作区依赖窗口 Local Host 的项目投影；
   未在真实 SSH workspace 上验证过浏览器侧导航与 identity 隔离。
3. **B5 删除旧路径**：`mobile.html`、`web/src/mobile/**`、信封协议、`servicePipe` 仍在（灰度期保留）。
4. **真实浏览器 E2E**：真实 Electron + Chromium 加载 `resources/web-remote`，验证首屏/列表/打开会话/
   发消息/断线重连；本轮只有端点层测试（真实 HTTP/WS/RPC 往返）与策略矩阵测试。

## B5 删除前复核（暂不删除）

代码复核确认：`payloadRouter` / `openWebRemoteControlHostBridge` / `servicePipe` / shared
`rpcTransport` 不仅供旧 LAN 入口使用，也由 `endpointMode: custom` 的 `relayTransport` 调用；
relay 托管的手机页面仍依赖 `mobile.html`。当前 Web 客户端端点只在 LAN 模式启动。
因此“直接删约四千行、不影响 relay”不成立；未迁移 relay 前，不执行整链删除。

后续删除的前置决策：

1. 自定义 relay 先迁移到 Web 客户端，或由用户明确同意下线该能力，不能静默删坏。
2. 浏览器 WS attach/detach 必须成为 manager 连接状态的传输事实来源；目前旧状态链路仍依赖
   LAN envelope 回调，删旧链路前要补接线，不能留下永远 waiting 的状态。
3. 保留 `surface` 默认拒绝策略及 mobile-project-directory 权限/identity/epoch 测试；只替换
   引用了旧客户端 bundle 的 E2E 测试，不跟随删掉安全断言。
4. 新入口 HTTP+Cookie+WS+RPC 冒烟先替代旧 mobile smoke，再删 vite 多入口和旧资源打包项。

此复核不改变运行行为；B5 仍未实施，既有 relay 与回退入口保持不动。

## 发行

- `3.17.2-20261031.427` 已重新打包并安装到 `/opt/ZCodium Exp`（AppImage + deb，未签名、仅本机自测）。
  打包后核对：asar 版本一致、`resources/web-remote/index.html` 与 `mobile.html` 同时存在。
- deb `4975c042…1136b`，AppImage `f78774c7…400618`。

## 首轮真机反馈修复（3.17.2 重打包）

用户实测：浏览器入口已能正常打开；关闭远控时 main 进程抛原生错误；二维码必须刷新页面才出现。

1. **关闭时 `o.dispose is not a function`**：`WebClientRpcAttachment.dispose` 里对
   `MessagePortProtocol` 调了不存在的 `dispose()`。该协议只有 `disconnect()`，异常从 WS close
   处理器逃逸，直接触发 Electron main 未捕获异常弹窗。已改为 `disconnect()`；attachment 释放
   语义不变（`DetachServicePort` + `port.close()`）。
2. **二维码要刷新才出现**：首次启动 `deviceSid` 是 `"pending"`，二维码要等设备注册完成；
   旧实现在 `onRegisteredAuth` 只写 sid 与持久化，既不重建 `qrUrl` 也不 `emitStatus`，
   UI 的 1s 轮询拿到的还是空 `qrUrl`，只有刷新后重新 `start`（此时读回持久化 sid）才出码。
   现在注册完成即重建 `qrUrl` 并推送状态。

验证：`pnpm typecheck` 通过、`pnpm lint` 0/0、`architecture:check --changed` 0 violation、
`packages/desktop/src/host` + `main/webRemoteControl` 167 项通过。
未覆盖：真实 Electron 关闭流程与二维码首帧的自动化回归（需真实窗口与设备注册），本轮由用户真机复验。
