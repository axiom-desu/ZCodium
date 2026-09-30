import { z } from "zod";

/**
 * RPC 传输装配器契约：把 Host attachment 上的 MessagePort 协议消息包装成可在
 * 传输层（LAN 直连 / 用户自托管 relay）收发的有序帧。
 *
 * v1 面向 LAN 直连：一个应用消息一帧，靠 seq 保序、ack 确认、flow 做背压；
 * 分片重组留给 P5 的 relay 传输（上限由 WEB_REMOTE_CONTROL_RPC_LIMITS 统一约束）。
 */

const nonEmptyStringSchema = z.string().trim().min(1);

export const webRemoteControlRpcTransportFrameSchema = z
  .object({
    streamId: nonEmptyStringSchema,
    seq: z.number().int().nonnegative(),
    kind: z.enum(["message", "ack", "flow"]),
    /** MessagePort 协议消息（结构化克隆数据）；kind=message 时必填。 */
    message: z.unknown().optional(),
    /** kind=ack 时确认到该 seq（含）。 */
    ackSeq: z.number().int().nonnegative().optional(),
    /** kind=flow 时的背压方向。 */
    flow: z.enum(["saturated", "drained"]).optional(),
  })
  .strict();
export type WebRemoteControlRpcTransportFrame = z.infer<
  typeof webRemoteControlRpcTransportFrameSchema
>;

export const webRemoteControlRpcFrameEnvelopeSchema = z
  .object({
    zcode_type: z.literal("rpc-frame"),
    frame: webRemoteControlRpcTransportFrameSchema,
  })
  .strict();
export type WebRemoteControlRpcFrameEnvelope = z.infer<
  typeof webRemoteControlRpcFrameEnvelopeSchema
>;

export const webRemoteControlRpcFrameAckEnvelopeSchema = z
  .object({
    zcode_type: z.literal("rpc-frame-ack"),
    frame: webRemoteControlRpcTransportFrameSchema,
  })
  .strict();
export type WebRemoteControlRpcFrameAckEnvelope = z.infer<
  typeof webRemoteControlRpcFrameAckEnvelopeSchema
>;

/** 传输与装配器的统一上限；relay 与桌面两侧读同一份默认值。 */
export const WEB_REMOTE_CONTROL_RPC_LIMITS = {
  /** 单个应用消息体积上限；超过即拒绝并 degraded。 */
  maxMessageBytes: 512 * 1024,
  /** 单个物理帧（JSON 信封序列化后）上限。 */
  maxPhysicalFrameBytes: 1024 * 1024,
  /** 吞吐饱和前允许在途未确认帧数。 */
  maxInFlightFrames: 64,
  /** ack 看门狗：超过这么多毫秒没有 ack 视为半开。 */
  ackWatchdogMs: 30_000,
} as const;
