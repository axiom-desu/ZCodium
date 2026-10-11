# Web Remote Control 的 RPC 分片与确认式装配

实现规格（**设计定稿 + 落地范围**）。上游 3.15.1 把这块做出来了；我们这边是 `ae909f67`
（PR #28，手机远控本体）留下的明确缺口：`rpcTransport.ts` 的注释写着「分片重组留给 P5」。

- 上游版本：`aac47556`（zai-org/ZCode 3.15.1）→ `packages/shared/src/web-remote-control-rpc-transport.ts`（766 行）
- 本仓相关实现：`ae909f67`（LAN 直连 + 用户自托管 relay）
- 相关 spec：[`web-remote-control.md`](./web-remote-control.md)

## 现状盘点（先看清我们已有什么，别再重复造）

| 层                                 | 我们的实现                                                                                                                          | 状态                                                 |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 应用信封                           | `packages/shared/src/webRemoteControl/envelope.ts`                                                                                  | 有                                                   |
| RPC 帧契约与限额                   | `packages/shared/src/webRemoteControl/rpcTransport.ts`（60 行）                                                                     | 有契约，**无分片**                                   |
| 物理传输                           | `packages/desktop/src/main/webRemoteControl/{relayTransport,lanEndpoint,deviceTransport}.ts`、`packages/web/src/mobile/protocol.ts` | 有，超限即 `maxPhysicalFrameBytes` 丢弃              |
| 出站缓冲/状态                      | `outboundBuffer.ts`、`transportState.ts`                                                                                            | 有                                                   |
| 自托管 relay                       | `packages/relay/{server,registry}.ts`                                                                                               | 有（鉴权/配对/心跳/转发）                            |
| bridge 装配                        | `packages/desktop/src/main/webRemoteControl/hostBridge.ts`、`packages/web/src/mobile/protocol.ts`                                   | 有保序 + ack，**乱序即丢、无重传**                   |
| v4 协议层分片                      | `packages/shared/src/zcode-protocol-v4/{wire-codec,wire-assembler,wire-reassembly,wire-binary}.ts`                                  | 有（CLI ↔ 桌面通道用），含 CRC32、base64、装配状态机 |
| 大资源通道（topic resource relay） | —                                                                                                                                   | **没有**                                             |

结论：分片所需的**原语已经在仓库里**（CRC32、canonical base64、限额、装配状态机范式），
缺的是把 RPC 帧这一层接上，以及超限/乱序的处理策略。**不新增第二套 CRC/base64/限额实现。**

## 三条前置的拍定值

1. **不取代 v4 协议层的分片，也不新建第二套帧契约。** RPC 帧沿用现有
   `webRemoteControlRpcTransportFrameSchema` 的 `streamId`/`seq`/`kind` 语义，只把
   `kind=message` 的**物理承载**改成分片（逻辑消息先 UTF-8 JSON 再 base64 分片）。
   `envelope.ts` 的 `rpc-frame` 信封结构不变。
2. **装配状态的唯一所有者：接收侧，每个方向一份单装配槽。** 只装配「下一个期望的
   `seq`」；其他 `seq` 的帧不缓存（`rpc-frame-gap`）。超时与丢弃由接收侧判定。
   身份校验用「**按第一片锁定**」而不是构造时绑定：两端各自用自己的 id 标注出站帧
   （桌面 `attachmentId`、手机 `mobile-*`），链路是点对点单流，因此只需保证同一装配器里
   身份不中途切换；需要严格绑定时可显式传 `streamId`。
3. **限额单一来源：`PROTOCOL_V4_LIMITS`。** 物理帧上限直接取 `maxFrameBytes`，消息上限取
   `logicalFrameAssemblyMaxBytes`，装配超时取 `logicalFrameAssemblyTimeoutMs`，
   id 长度取 `transportEnvelopeIdMaxChars`；RPC 专有的分片数上限（64）与在途帧上限（64）写在
   `WEB_REMOTE_CONTROL_RPC_LIMITS` 里，不复制 v4 的数值。

## 事件顺序

```text
桌面（Host bridge）                          手机 web（replayable）
  │ 逻辑消息 seq=N
  │ → encodeWebRemoteControlRpcFrames()      （dataBase64 + crc32 + fragmentIndex/Count）
  │ ── 物理帧 seq=N, i/n（≤ maxFrameBytes） ──▶
  │                                           │ 装配槽（每 streamId 一份，只装 seq 期望值）
  │                                           │ 完整 → crc32 → UTF-8 → JSON → 交付上层
  │ ◀──────────── ack(ackSeq=N) ───────────── │ 装配成功才 ack（seq = 已连续装配到的逻辑序号）
  │ ack 推进发送侧的可发窗口                    │ 缺片/超时 → degraded(rpc-frame-gap / buffer-timeout)
  │ 断线重连：未 ack 的 seq 重放 ────────────▶ │ 装配槽按 seq 幂等，不重复交付
```

- `desktop-continuous` 链路语义不动：本 spec 只改 `web-remote-replayable` 的 RPC 物理承载，
  一帧一消息的连续链路不受影响。
- ack 的语义统一为「**已连续装配到的逻辑 seq**」（含），因此重传窗口天然是
  `(ackSeq, lastSentSeq]`，不需要第二套序号空间。

## 实现范围（第一轮：分片与装配）

1. `packages/shared/src/webRemoteControl/rpcTransport.ts`
   - 帧 schema 增加分片字段：`fragmentIndex`、`fragmentCount`、`messageBytes`、`checksum`（crc32）、
     `dataBase64`；`kind=message` 时必填，`ack`/`flow` 时禁止。
   - `encodeWebRemoteControlRpcFrames(message, { streamId, seq })`：单帧放得下就 `1/1`，
     否则按物理上限二分出每片字节预算（与 v4 `wire-codec.ts` 同法），超过分片数/消息上限即
     fail-closed 抛 `WebRemoteControlRpcEncodingError`（带 `reasonCode`）。
   - `WebRemoteControlRpcAssembler`：`push(frame)` → `message` / `ignored` / `fault`；
     单装配槽、`streamId` 归属校验、canonical base64 校验、CRC32 校验、超时清理、幂等去重。
2. `packages/desktop/src/main/webRemoteControl/hostBridge.ts`：发送侧走 encoder（多帧循环，
   超限不再直接丢而是如实上报 degraded），接收侧走 assembler（装配成功才 ack）。
3. `packages/web/src/mobile/protocol.ts`：手机侧同构改造。
4. 单测：`packages/shared/src/webRemoteControl/rpcTransport.test.ts`。

## 实现范围（第二轮：重传、ack 批量与装配槽清扫）

第二轮只补第一轮留下的三个缺口，不改第一轮的分片/装配契约，也不引入上游的
`AcknowledgedRelayProtocol` / `BatchQueue` / `Deadline` 类与双序号空间。三个单元都放在
`packages/shared/src/webRemoteControl/rpcTransport.ts`，桌面与手机共用同一份实现。

### 1. 出站重传缓冲 `WebRemoteControlRpcReplayBuffer`

- **所有者**：每条链路（桌面每个 bridge、手机每个 `MobileRemoteControlClient` 实例）各自一份，
  只管本方向的已发送未确认逻辑帧。接收侧仍由装配器单槽拥有，二者不共享状态。
- **窗口**：ack 语义仍是「已连续装配到的逻辑 seq」，所以重传窗口天然是 `(ackedSeq, lastSentSeq]`，
  不引入第二个序号空间。`acknowledge(ackSeq)` 只推进 `ackedSeq` 并释放已确认前缀；
  `replayUnacknowledged()` 返回窗口内全部逻辑帧（扁平、保序、同 seq 同片）。
- **触发**：发送侧收到 ack 时调用 `acknowledge`；只要返回的待重传帧非空（即 `ackSeq < lastSentSeq`）
  就按序重发。接收侧本地装配器报 `rpc-frame-gap`/`buffer-timeout`（对端丢片）时，先把「最后连续
  装配到的 `ackSeq`」再 ack 一次作为 nudge，对端据此从 `ackSeq+1` 重传；同时本方向也调用
  `replayUnacknowledged()` 做同向 go-back-N。nudge 复用现有 ack 帧（含 `ackSeq = 0`），不新增 wire 类型，
  仍只有单序号空间。重发复用原帧对象，装配器对同 seq 幂等，不重复交付。
- **有界**：`record(seq, frames)` 在入队前按「条数 + 字节数」做整批 admission，超上限返回
  `replayBufferOverflow`，调用方降级，不发出半条消息。确认后立即释放 payload 引用，只保留轻量空槽
  并按阈值 compact，避免每 ack 都 `splice` 成 O(n²)。
- **限额**：`WEB_REMOTE_CONTROL_RPC_LIMITS.replayBufferMaxMessages`、`replayBufferMaxBytes`。

### 2. ack 批量调度 `WebRemoteControlRpcAckScheduler`

- **所有者**：接收侧每个装配器一份，只拥有「下一个待发 `ackSeq` + 定时器」。
- **合并**：`record(ackSeq)` 只在单调推进时更新待发值，不立即发送；窗口内多次装配合并成一个 ack
  （取最高 `ackSeq`）。
- **刷新**：pending 条数达到 `ackMaxPendingCount` 立即刷；否则在距首个待发 ack 的合并窗口
  `ackCoalesceWindowMs` 到期时刷。`ackDeadlineMs` 是硬 deadline——即使合并窗口被后续 `record` 不断
  推后（debounce），距首个待发 ack 超过 deadline 也必须刷，保证最后一个 ack 不漏发。
  `ackDeadlineMs` 远小于对端 `ackWatchdogMs = 30_000`（半开探测兜底）。
- **无变更不刷**：定时器只在有待发 ack 时存在；flush 后立即清定时器，空转不产生帧。
- **拆除**：`clear()` 取消待发与定时器（重连 / 换 workspace），`dispose()` 永久停用。

### 3. 装配槽周期清扫

- `WebRemoteControlRpcAssembler.sweep(now)` 已是显式入口。桌面 `hostBridge` 与手机 `protocol`
  各挂一个 `setInterval`（间隔 `assemblySweepIntervalMs`），把 `sweep()` 产出的 `buffer-timeout`
  故障走与收帧相同的降级路径；静默链路不再让残片永久占槽。
- close / dispose 时清掉定时器：手机在 socket close 与 `dispose()` 清，桌面在 `dispose()` 清。

## 验收场景

1. **分片与还原**：一条超过物理帧上限的消息自动分片，接收侧装配后与发送侧逐字节一致；
   CRC32 不符时拒绝并给出 fault，不交付。
2. **单帧快路径**：小于物理上限的消息仍是 `1/1` 一片，行为与改造前一致（无额外往返）。
3. **fail-closed**：超过 `maxMessageBytes` 或分片数上限的消息在**发送侧**就抛错，不上线。
4. **乱序/缺片**：收到非期望 `seq` 的帧不缓存，返回 `rpc-frame-gap`；期望 `seq` 的分片不齐时
   超时返回 `buffer-timeout`，装配槽释放。
5. **幂等**：同一 `seq` 的重复分片（重连重放）不会重复交付已装配完成的消息。
6. **限额单一来源**：改 `PROTOCOL_V4_LIMITS.maxFrameBytes` 即同时改变编码与装配的物理上限。
7. **不回归**：`desktop-continuous` 实时链路与既有 LAN/relay 配对流程不受影响；
   `pnpm typecheck`、`pnpm lint` 与基线一致。
8. **重传**：发送侧记录 seq=1..3，对端只 ack 1；`acknowledge(1)` 返回 seq 2、3 的全部原帧，
   重发后装配器幂等（已装配过的 seq 不重复交付）。接收侧缺片时报 gap/timeout，并把最后
   连续装配到的 `ackSeq` 再 ack 一次（nudge），触发发送侧从 `ackSeq+1` 重传。
9. **重传有界**：条数或字节数超 `replayBuffer*` 上限时 `record` 返回 `replayBufferOverflow`，
   调用方降级，不发半条消息；ack 确认后缓冲释放。
10. **ack 合并**：窗口内多次装配只产生一个 ack，值取最高 `ackSeq`。
11. **ack deadline**：合并窗口被不断推后时，距首个待发 ack 到 `ackDeadlineMs` 必刷一次，
    保证最后一个 ack 不漏发；无待发 ack 时定时器空转不产生帧。
12. **装配槽清扫**：链路静默时周期定时器触发 `sweep()`，装配槽释放并上报 `buffer-timeout`；
    close/dispose 后不再触发。
13. **定时器清理**：桌面 bridge / 手机 client dispose 后，ack 调度与清扫定时器都不再存在。

## 落地状态

已完成（同一提交内，两端一起切，不存在版本偏斜：手机页面由桌面 `mobileAppAssets` 随包提供）：

| 位置                                                        | 改动                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/shared/src/webRemoteControl/rpcTransport.ts`      | 帧契约加分片字段（`fragmentIndex/Count`、`messageBytes`、`checksum`、`dataBase64`）并强制极性；`encodeWebRemoteControlRpcFrames`（单帧快路径 + 二分片长 + fail closed）；`WebRemoteControlRpcAssembler`（单槽、身份按第一片锁定、乱序归位、CRC32/UTF-8/JSON 全通过才交付、超时清扫、幂等） |
| `packages/desktop/src/main/webRemoteControl/hostBridge.ts`  | 发送侧走编码器（超限不再静默丢弃，按 `reasonCode` 降级）；接收侧走装配器，装配成功才 ack                                                                                                                                                                                                   |
| `packages/desktop/src/main/webRemoteControl/runtime.ts`     | 删掉手写的那份帧字段表，改引用 shared 的 `WebRemoteControlRpcTransportFrame`（契约单一来源）                                                                                                                                                                                               |
| `packages/web/src/mobile/protocol.ts`                       | 手机侧同构：发送侧编码、接收侧装配、装配成功回 ack；fault 上报 `bridge-degraded`                                                                                                                                                                                                           |
| `packages/shared/src/webRemoteControl/rpcTransport.test.ts` | 15 例：限额单源、schema 极性、canonical base64、单帧快路径、分片往返一致、超限 fail closed、乱序装配、gap、幂等、CRC 拒绝、超时释放、跨 streamId 拒绝                                                                                                                                      |

验证：vitest 15 例通过；`pnpm typecheck`、`pnpm lint`（51 warnings / 0 errors，与基线一致）、`pnpm fmt:check`、`pnpm architecture:check --changed`（new: 0）通过；`packages/web` 构建与 `@zcode/desktop build:no-runtime-assets` 通过；`packages/desktop` 的 `tsconfig.main.json` 错误数 63 = 基线（未新增）。

第二轮已完成（同一提交，两端共用 shared 单元）：

| 位置                                                        | 改动                                                                                                                                                                                                                                              |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/webRemoteControl/rpcTransport.ts`      | 新增 `WebRemoteControlRpcReplayBuffer`（单序号空间 `(ackedSeq, lastSentSeq]`、条数/字节双封顶、确认即释放）、`WebRemoteControlRpcAckScheduler`（合并 + 阈值 + deadline 兜底、无变更不刷）、`parseWebRemoteControlRpcAckFrame`；限额与故障原因扩展 |
| `packages/desktop/src/main/webRemoteControl/hostBridge.ts`  | 发送侧记录到 replay buffer（超限降级）；收 ack 推进窗口并重发；收到本地 gap/timeout 故障时同向重发；ack 改走批量调度；挂装配槽周期清扫定时器并在 dispose 清理                                                                                     |
| `packages/web/src/mobile/protocol.ts`                       | 手机侧同构：记录/重发、ack 批量、装配槽周期清扫；close 与 dispose 清理定时器                                                                                                                                                                      |
| `packages/shared/src/webRemoteControl/rpcTransport.test.ts` | 扩例：重传窗口、有界与释放、重复帧幂等、ack 合并/deadline/无变更不刷                                                                                                                                                                              |

第三轮（透明转发修复）已完成：

| 位置                                                                     | 改动                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/desktop/src/main/webRemoteControl/servicePipe.ts`（新增）      | main 只做透明字节管道：Host port 收到的每条消息走 `sendToMobile`（编码分片 + 重传入队 + 发射），手机装配出来的消息直接 `hostPort.postMessage`。**不在 main 建 `MessagePortProtocol`**：它会把 `{__zcodeRpcControl:"connection-flow-v1"}` 流控消息分流掉，插在中间会截断手机↔Host 的端到端流控；这里流控与二进制一视同仁当普通 payload 透传（二进制沿用既有 `{__zcodeBytes}` 约定）                                                                              |
| `packages/desktop/src/main/webRemoteControl/hostBridge.ts`               | 删掉 main 侧 `MessagePortProtocol` + `ChannelClient` + 四个 service 代理与 `OpenHostBridgeResult.services`（它们无任何消费方，且造成「链路两端都是客户端、没有服务端」）。改为 `wrapElectronPort(attachment.port)` + `createWebRemoteControlServicePipe`；Host→手机出口抽成具名 `sendToMobile`；`acceptFrame` 装配成功的消息交 `pipe.acceptMobileMessage`；`dispose()` 一并拆 pipe。服务端唯一仍在 Host 进程的 `exposeServicesOnMessagePort`（`ChannelServer`） |
| `packages/desktop/src/main/webRemoteControl/servicePipe.test.ts`（新增） | 5 例：内存假 `MessagePortLike` 一侧起真实 `ChannelServer` + `ProxyChannel.fromService`，另一侧 `ChannelClient` + `ProxyChannel.toService`，中间穿过 pipe 与 shared 的分片/装配层；断言 Initialize 可达、异步方法返回正确值、服务端主动 push 事件、>1MB 载荷分片往返逐字节一致、未发出时只 warn 一次                                                                                                                                                             |

本层仍未做：

- **topic resource relay**：协议面大资源通道（`TOPIC_RESOURCE_RELAY_*` + 4 个 schema）+ `zcodeEndpoint.ts` 的 relay 地址解析，需要先定 gateway 侧所有者与 UI 消费方。

## 不做什么

- 不实现 `TOPIC_RESOURCE_RELAY_CHANNEL` 那套协议面大资源通道（`read`/`cancel`/`relayChunk`/
  `relayMetadata`）——它是 v4 协议层的另一条链路，需要先定 gateway 侧的所有者与 UI 消费方。
  本轮只记录在「剩余」一节。
- 不搬上游 `packages/client/src/webRemoteControl*`（≈989 行）与 `packages/shared/src/web-remote-control-rpc-transport.ts`
  ——那是上游另一套命名与布局；我们只借用其**不变量**（单装配、精确计量、fail-closed），
  不引入第二套契约与消费者。
- 不改 `desktop-continuous` 语义；不动 LAN 直连与 relay 的鉴权/配对/心跳。

## 剩余（本轮之后）

| 项                   | 说明                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| topic resource relay | 协议面大资源通道（`TOPIC_RESOURCE_RELAY_*` + 4 个 schema）+ `zcodeEndpoint.ts` 的 relay 地址解析 |
