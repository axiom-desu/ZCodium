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
2. **装配状态的唯一所有者：接收侧，每个 `streamId` 一份单装配槽。** 只装配「下一个期望的
   `seq`」；其他 `seq` 的帧不缓存（`rpc-frame-gap`）。超时与丢弃由接收侧判定。
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

## 实现范围（本轮）

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
4. 单测：`packages/shared/src/webRemoteControl/rpcTransport.test.ts`（node:test）。

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

## 落地状态

已完成（同一提交内，两端一起切，不存在版本偏斜：手机页面由桌面 `mobileAppAssets` 随包提供）：

| 位置                                                        | 改动                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/shared/src/webRemoteControl/rpcTransport.ts`      | 帧契约加分片字段（`fragmentIndex/Count`、`messageBytes`、`checksum`、`dataBase64`）并强制极性；`encodeWebRemoteControlRpcFrames`（单帧快路径 + 二分片长 + fail closed）；`WebRemoteControlRpcAssembler`（单槽、乱序归位、CRC32/UTF-8/JSON 全通过才交付、超时清扫、幂等） |
| `packages/desktop/src/main/webRemoteControl/hostBridge.ts`  | 发送侧走编码器（超限不再静默丢弃，按 `reasonCode` 降级）；接收侧走装配器，装配成功才 ack                                                                                                                                                                                 |
| `packages/desktop/src/main/webRemoteControl/runtime.ts`     | 删掉手写的那份帧字段表，改引用 shared 的 `WebRemoteControlRpcTransportFrame`（契约单一来源）                                                                                                                                                                             |
| `packages/web/src/mobile/protocol.ts`                       | 手机侧同构：发送侧编码、接收侧装配、装配成功回 ack；fault 上报 `bridge-degraded`                                                                                                                                                                                         |
| `packages/shared/src/webRemoteControl/rpcTransport.test.ts` | 14 例：限额单源、schema 极性、canonical base64、单帧快路径、分片往返一致、超限 fail closed、乱序装配、gap、幂等、CRC 拒绝、超时释放、跨 streamId 拒绝                                                                                                                    |

验证：vitest 14 例通过；`pnpm typecheck`、`pnpm lint`（51 warnings / 0 errors，与基线一致）、`pnpm fmt:check`、`pnpm architecture:check --changed`（new: 0）通过；`packages/web` 构建与 `@zcode/desktop build:no-runtime-assets` 通过；`packages/desktop` 的 `tsconfig.main.json` 错误数 63 = 基线（未新增）。

本层仍未做：

- **重传与 replay buffer**：ack 现在只推进观测窗口，没接重放队列；断线后已发送未装配的消息仍会变成 gap。
- **ack 批量与 deadline**：上游的 `BatchQueue`/`Deadline` 未引入（未有消费方时先不造状态）。
- **装配槽的周期清扫**：超时目前由“下一帧到达/主动 `sweep()`”收敛，未挂到 manager 的定时器。

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
| 重传与 replay buffer | 现在 ack 只用于推进窗口与观测；断线重连的重放窗口要等 `ackSeq` 消费方确定后落地                  |
| ack 批量与 deadline  | 上游有 `BatchQueue`/`Deadline` 两个策略件，我们按需再引入，避免先造无人消费的状态                |
| topic resource relay | 协议面大资源通道（`TOPIC_RESOURCE_RELAY_*` + 4 个 schema）+ `zcodeEndpoint.ts` 的 relay 地址解析 |
