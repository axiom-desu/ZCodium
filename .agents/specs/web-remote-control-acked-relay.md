# Web Remote Control 的分片与确认式中继（Acked Relay）

评估记录，**不含实现**。判断的是：上游 3.15.1 新加的那一整块分片 / 确认式中继，要不要跟、
跟到什么程度、以及跟之前必须先定什么。

- 上游版本：`aac47556`（zai-org/ZCode 3.15.1）
- 本仓基线：`chore/upstream-3.15.1-sync` 分支（评估时 `main` = `e3dce772`）
- 相关既有 spec：[`web-remote-control.md`](./web-remote-control.md)

## 结论

**跟，但作为独立工作项，不并入本轮同步。** 理由是这条不是「上游多写了点东西」，而是
**本仓库自己注释里写明尚未完成的那一段**：

```text
packages/shared/src/webRemoteControl/rpcTransport.ts
  v1 面向 LAN 直连：一个应用消息一帧，靠 seq 保序、ack 确认、flow 做背压；
  分片重组留给 P5 的 relay 传输（上限由 WEB_REMOTE_CONTROL_RPC_LIMITS 统一约束）。
```

上游 3.15.1 已经把这段「P5」做出来了。所以它属于白拿线，而不是改革线。

## 事实对照

|                  | 上游 3.15.1                                                                                                                                                                                                                        | 本仓库                                                                                                                                                    |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 帧契约与装配     | `packages/shared/src/web-remote-control-rpc-transport.ts`：限额（`maxPhysicalFrameBytes`、`maxMessageBytes` 16 MiB、`maxFragments` 64、`assemblyTimeoutMs` 30 s）、CRC32 校验、base64 wire 编解码、分片 schema、**单一装配状态机** | `packages/shared/src/webRemoteControl/rpcTransport.ts`（60 行）：只有帧字段 `{streamId, seq, kind: message\|ack\|flow, …}` 与限额占位，**无分片、无装配** |
| 确认式中继       | `packages/client/src/`：`AcknowledgedRelayProtocol`(384) + `ProtocolTypes`(155) + `BatchQueue`(92) + `Deadline`(82) + `RelayProtocol`(224) + `RelayPayloadSerializer`(52) ≈ **989 行**，另有 7 个测试文件                          | 无（`acknowledgedRelay` / `RelayPayloadSerializer` 全仓 0 命中）                                                                                          |
| 背压             | 高低水位 + replay buffer + ack 批次 + 装配超时                                                                                                                                                                                     | 只有 `kind: "flow"` 的 `saturated` / `drained` 两个取值，无水位实现                                                                                       |
| 协议侧大资源通道 | `TOPIC_RESOURCE_RELAY_CHANNEL = "host-topic-resource"`（384 KiB 分块）+ `read` / `cancel` / `relayChunk` / `relayMetadata` 四个 schema，见 `packages/shared/src/zcode-protocol/index.ts`                                           | 无该 channel                                                                                                                                              |
| 我们已有的相邻层 | —                                                                                                                                                                                                                                  | `envelope.ts`(324) 应用层信封契约、`relayFrame.ts`(173) 配对与 wire 帧、`status.ts`(128) 状态机                                                           |

## 为什么不能直接抄进来

三条必须先定，否则会违反「一份状态、一个入口」：

1. **不能两套帧契约并存。** 我们已经有 `webRemoteControl/rpcTransport.ts` 的帧字段，上游在
   `web-remote-control-rpc-transport.ts` 里另有一套更完整的（含 CRC32 与 base64 编码）。
   是要**取代**（把我们的帧契约删掉、调所有使用方），还是**在其上叠加**（我们保留字段、
   只补装配与限额）？这决定了 `envelope.ts` / `relayFrame.ts` 是否要跟着改。
2. **装配状态的唯一所有者。** 上游的装配状态机是「单一 assembly」——每侧同一时刻只装一条消息。
   接进我们的链路前必须明确：装配状态归谁（每 stream 一份，还是每 transport 一份），
   超时与丢弃由谁判定，`seq` 与装配的关系（同一条消息的分片共享 seq 还是各自 seq）。
3. **限额的来源。** 上游把 `maxPhysicalFrameBytes` 绑到 `PROTOCOL_V4_LIMITS.maxFrameBytes`，
   而 v4 协议层在本仓库也是既有的（`zcode-protocol-v4`）。限额必须来自单一来源，
   不能出现「远控说 16 MiB、v4 说另一个数」。

另外 `TOPIC_RESOURCE_RELAY_CHANNEL` 是**协议面**的改动，属于本仓库 `AGENTS.md` 里
「协议改动同步更新 `packages/shared/src/zcode-protocol/index.ts`」那一类，要和上面第 1、2 条
一起定，不能只搬 client 侧。

## 事件顺序（设计草案，实现前需确认）

```text
桌面 main（GuestView）                      手机 web（replayable）
  │ 应用消息 → 分片(message, fragment i/n)
  │ ── 物理帧（≤ maxFrameBytes, CRC32） ──▶
  │                                        │ 装配状态机：按 seq 收集分片
  │                                        │ 超时/缺片 → 请求重发该 seq
  │ ◀────────────── ack(ackSeq) ────────── │ 装配完成 → 交付上层
  │ ack 批次 + deadline 收敛重发             │
  │ 水位 saturated/drained 控制发送速率 ──▶  │
```

## 验收场景（草案）

1. 单条消息超过物理帧上限时自动分片，接收侧装配后交付的上层消息与发送侧逐字节一致
   （含 CRC32 校验失败时拒绝并请求重发）。
2. 丢片 / 乱序：注入丢片与乱序，装配仍成立；超过 `maxFragments` 或 `assemblyTimeoutMs`
   时明确失败而不是静默截断。
3. 背压：接收侧饱和时发送侧停止新帧而不是丢弃；drained 后恢复，顺序不乱。
4. 重连（`web-remote-replayable`）：缓存帧可按 seq 重放，不会重复交付已装配完成的消息。
5. 与 `desktop-continuous` 实时链路互不影响：本轮改动不得改变连续链路的一帧一消息语义。
6. 限额单一来源：修改限额只改一处，协议校验与远控两侧同时生效。

## 不做什么

- 本轮同步**不实现**这条，只记录评估结论与前置条件。
- 不从上游整包搬 `packages/client/src/webRemoteControl*`：我们是自有布局
  （`packages/shared/src/webRemoteControl/`），搬运会同时带来两套命名与两套消费者。
- 不动 `desktop-continuous` 的实时语义；`web-remote-replayable` 的 snapshot / gap repair
  边界保持现状，除非第 1、2 条定下来。
