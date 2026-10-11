/* eslint-disable max-lines -- RPC 帧契约、精确计量编码器与单槽装配状态机共享同一组物理不变量（限额、canonical base64、CRC32、单槽），拆分会让不变量分叉，与 v4 wire-* 同一口径。 */
import { z } from "zod";
import { PROTOCOL_V4_LIMITS } from "../zcode-protocol-v4/core.js";
import {
  crc32WireBytes,
  decodeWireBase64,
  encodeWireBytesBase64,
} from "../zcode-protocol-v4/wire-binary.js";

/**
 * RPC 传输装配器契约：把 Host attachment 上的 MessagePort 协议消息包装成可在
 * 传输层（LAN 直连 / 用户自托管 relay）收发的有序帧。
 *
 * 逻辑序号 `seq` 一条消息一个（kind=message），物理承载按字节分片：消息先经
 * UTF-8 JSON 编码，再 base64 分片，装配侧按 seq 单槽拼回并校验 CRC32。
 *
 * 设计定稿见 `.agents/specs/web-remote-control-acked-relay.md`：
 * - 限额单一来源 `PROTOCOL_V4_LIMITS`（不复制数值，也不新建第二套 CRC/base64）；
 * - 装配状态的唯一所有者在接收侧，每个 streamId 一份单装配槽，只装配期望的 seq；
 * - ack 的语义是「已连续装配到的逻辑 seq」，因此重传窗口天然是 (ackSeq, lastSentSeq]。
 */

export const WEB_REMOTE_CONTROL_RPC_LIMITS = {
  /** 单个物理帧（整条 relay 信封序列化后）上限。 */
  maxPhysicalFrameBytes: PROTOCOL_V4_LIMITS.maxFrameBytes,
  /** 单条逻辑消息（UTF-8 JSON）上限；超过即在发送侧 fail closed。 */
  maxMessageBytes: PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes,
  /** 单条消息最多分几片；超过即在发送侧 fail closed。 */
  maxFragments: 64,
  /** 接收侧装配槽的存活上限。 */
  assemblyTimeoutMs: PROTOCOL_V4_LIMITS.logicalFrameAssemblyTimeoutMs,
  /** 吞吐饱和前允许在途未确认帧数。 */
  maxInFlightFrames: 64,
  /**
   * ack 看门狗：超过这么多毫秒没有推进 ack 视为半开（relay 静默死亡时不会触发 close）。
   * 与上游 `web-remote-control-heartbeat.ts` 的 `HEARTBEAT_ACK_TIMEOUT_MS` 同值；
   * 目前只作为契约面与观测依据，接半开探测是后续工作。
   */
  ackWatchdogMs: 30_000,
  /** streamId 等传输身份的长度上限。 */
  transportIdMaxChars: PROTOCOL_V4_LIMITS.transportEnvelopeIdMaxChars,
} as const;

/** 传输故障原因码；降级上报与日志共用同一组字面量。 */
export const WEB_REMOTE_CONTROL_RPC_FAULT_REASONS = {
  /** 帧结构不合法（schema 解析失败、base64 非 canonical、校验和不符）。 */
  transportFault: "rpc-transport-fault",
  /** 收到的 seq 不是当前期望值（缺片、乱序或跨代帧）。 */
  frameGap: "rpc-frame-gap",
  /** 装配暂存的字节超过消息上限。 */
  bufferOverflow: "buffer-overflow",
  /** 装配槽超时。 */
  bufferTimeout: "buffer-timeout",
  /** 单条消息本身超过上限。 */
  oversize: "rpc-transport-oversize",
} as const;
export type WebRemoteControlRpcFaultReason =
  (typeof WEB_REMOTE_CONTROL_RPC_FAULT_REASONS)[keyof typeof WEB_REMOTE_CONTROL_RPC_FAULT_REASONS];

const positiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const nonnegativeSafeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const webRemoteControlRpcStreamIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(WEB_REMOTE_CONTROL_RPC_LIMITS.transportIdMaxChars);

export const webRemoteControlRpcChecksumSchema = z
  .object({
    algorithm: z.literal("crc32"),
    value: z.string().regex(/^[0-9a-f]{8}$/u),
  })
  .strict();
export type WebRemoteControlRpcChecksum = z.infer<typeof webRemoteControlRpcChecksumSchema>;

/** canonical base64：先按字符串长度硬闸，再解码比对，避免恶意超长 base64 先分配缓冲。 */
function isCanonicalBase64(value: string): boolean {
  if (value.length < 4 || value.length > WEB_REMOTE_CONTROL_RPC_LIMITS.maxPhysicalFrameBytes) {
    return false;
  }
  const decoded = decodeWireBase64(value);
  return decoded !== null && decoded.byteLength > 0 && encodeWireBytesBase64(decoded) === value;
}

const messageFrameSchema = z
  .object({
    streamId: webRemoteControlRpcStreamIdSchema,
    seq: positiveSafeIntegerSchema,
    kind: z.literal("message"),
    fragmentIndex: z
      .number()
      .int()
      .nonnegative()
      .max(WEB_REMOTE_CONTROL_RPC_LIMITS.maxFragments - 1),
    fragmentCount: z.number().int().positive().max(WEB_REMOTE_CONTROL_RPC_LIMITS.maxFragments),
    /** 该逻辑消息的 UTF-8 JSON 总字节数；装配侧据此先做上限判定再拼接。 */
    messageBytes: z.number().int().positive().max(WEB_REMOTE_CONTROL_RPC_LIMITS.maxMessageBytes),
    checksum: webRemoteControlRpcChecksumSchema,
    dataBase64: z
      .string()
      .min(4)
      .max(WEB_REMOTE_CONTROL_RPC_LIMITS.maxPhysicalFrameBytes)
      .refine(isCanonicalBase64),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.fragmentIndex >= value.fragmentCount) {
      context.addIssue({
        code: "custom",
        path: ["fragmentIndex"],
        message: "fragmentIndex must be smaller than fragmentCount",
      });
    }
    if (value.fragmentCount > value.messageBytes) {
      context.addIssue({
        code: "custom",
        path: ["fragmentCount"],
        message: "non-empty fragments cannot exceed message bytes",
      });
    }
  });

const ackFrameSchema = z
  .object({
    streamId: webRemoteControlRpcStreamIdSchema,
    seq: nonnegativeSafeIntegerSchema,
    kind: z.literal("ack"),
    /** 已连续装配到该 seq（含）。 */
    ackSeq: nonnegativeSafeIntegerSchema,
  })
  .strict();

const flowFrameSchema = z
  .object({
    streamId: webRemoteControlRpcStreamIdSchema,
    seq: nonnegativeSafeIntegerSchema,
    kind: z.literal("flow"),
    flow: z.enum(["saturated", "drained"]),
  })
  .strict();

export const webRemoteControlRpcTransportFrameSchema = z.discriminatedUnion("kind", [
  messageFrameSchema,
  ackFrameSchema,
  flowFrameSchema,
]);
export type WebRemoteControlRpcTransportFrame = z.infer<
  typeof webRemoteControlRpcTransportFrameSchema
>;
export type WebRemoteControlRpcMessageFrame = z.infer<typeof messageFrameSchema>;

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

/** 端点（LAN 服务 / relay）wire 信封的固定外壳字节数：`{"type":"data","payload":…}`。 */
function relayEnvelopeByteLength(frame: WebRemoteControlRpcTransportFrame): number {
  return new TextEncoder().encode(
    JSON.stringify({ type: "data", payload: { zcode_type: "rpc-frame", frame } }),
  ).byteLength;
}

export class WebRemoteControlRpcEncodingError extends Error {
  constructor(readonly reasonCode: WebRemoteControlRpcFaultReason | string) {
    super(reasonCode);
    this.name = "WebRemoteControlRpcEncodingError";
  }
}

function utf8Bytes(value: unknown): Uint8Array {
  const json = JSON.stringify(value);
  if (json === undefined) {
    throw new WebRemoteControlRpcEncodingError(WEB_REMOTE_CONTROL_RPC_FAULT_REASONS.transportFault);
  }
  return new TextEncoder().encode(json);
}

export interface EncodeWebRemoteControlRpcFramesOptions {
  streamId: string;
  seq: number;
  /**
   * 物理帧计量函数；缺省按 relay wire 信封（`{type:"data",payload:…}`）计量，
   * 调用方有别的外壳时注入自己的实现（限额仍来自 WEB_REMOTE_CONTROL_RPC_LIMITS）。
   */
  measurePhysicalFrameBytes?: (frame: WebRemoteControlRpcTransportFrame) => number;
}

function buildMessageFrame(params: {
  options: EncodeWebRemoteControlRpcFramesOptions;
  checksum: WebRemoteControlRpcChecksum;
  messageBytes: number;
  fragmentIndex: number;
  fragmentCount: number;
  dataBase64: string;
}): WebRemoteControlRpcMessageFrame {
  return {
    streamId: params.options.streamId,
    seq: params.options.seq,
    kind: "message",
    fragmentIndex: params.fragmentIndex,
    fragmentCount: params.fragmentCount,
    messageBytes: params.messageBytes,
    checksum: params.checksum,
    dataBase64: params.dataBase64,
  };
}

/**
 * 把一条逻辑消息编码成物理帧序列。
 *
 * 单帧放得下就是 `1/1`（与改造前等价的快路径）；否则按物理上限二分每片字节预算。
 * 任何超限都在这里 fail closed，不会把超限帧交给传输层再被静默丢弃。
 */
export function encodeWebRemoteControlRpcFrames(
  message: unknown,
  options: EncodeWebRemoteControlRpcFramesOptions,
): WebRemoteControlRpcMessageFrame[] {
  const measure = options.measurePhysicalFrameBytes ?? relayEnvelopeByteLength;
  const bytes = utf8Bytes(message);
  if (bytes.byteLength > WEB_REMOTE_CONTROL_RPC_LIMITS.maxMessageBytes) {
    throw new WebRemoteControlRpcEncodingError(WEB_REMOTE_CONTROL_RPC_FAULT_REASONS.oversize);
  }
  const checksum: WebRemoteControlRpcChecksum = {
    algorithm: "crc32",
    value: crc32WireBytes(bytes),
  };

  const single = buildMessageFrame({
    options,
    checksum,
    messageBytes: bytes.byteLength,
    fragmentIndex: 0,
    fragmentCount: 1,
    dataBase64: encodeWireBytesBase64(bytes),
  });
  if (measure(single) <= WEB_REMOTE_CONTROL_RPC_LIMITS.maxPhysicalFrameBytes) {
    return [single];
  }

  // 二分片长。索引位数按最坏情况（片数 = 逻辑字节数）计量，实际帧只会更小。
  let low = 1;
  let high = bytes.byteLength;
  let chunkBytes = 0;
  while (low <= high) {
    const candidate = Math.floor((low + high) / 2);
    const shell = buildMessageFrame({
      options,
      checksum,
      messageBytes: bytes.byteLength,
      fragmentIndex: bytes.byteLength - 1,
      fragmentCount: bytes.byteLength,
      dataBase64: encodeWireBytesBase64(bytes.subarray(0, candidate)),
    });
    if (measure(shell) <= WEB_REMOTE_CONTROL_RPC_LIMITS.maxPhysicalFrameBytes) {
      chunkBytes = candidate;
      low = candidate + 1;
    } else {
      high = candidate - 1;
    }
  }
  if (chunkBytes < 1) {
    throw new WebRemoteControlRpcEncodingError(WEB_REMOTE_CONTROL_RPC_FAULT_REASONS.transportFault);
  }

  const fragmentCount = Math.ceil(bytes.byteLength / chunkBytes);
  if (fragmentCount > WEB_REMOTE_CONTROL_RPC_LIMITS.maxFragments) {
    throw new WebRemoteControlRpcEncodingError("proto.frameFragmentCountExceeded");
  }

  const frames: WebRemoteControlRpcMessageFrame[] = [];
  for (let fragmentIndex = 0; fragmentIndex < fragmentCount; fragmentIndex += 1) {
    const start = fragmentIndex * chunkBytes;
    const frame = buildMessageFrame({
      options,
      checksum,
      messageBytes: bytes.byteLength,
      fragmentIndex,
      fragmentCount,
      dataBase64: encodeWireBytesBase64(bytes.subarray(start, start + chunkBytes)),
    });
    // 计量漂移一律 fail closed，不把超限帧交给下游。
    if (measure(frame) > WEB_REMOTE_CONTROL_RPC_LIMITS.maxPhysicalFrameBytes) {
      throw new WebRemoteControlRpcEncodingError(
        WEB_REMOTE_CONTROL_RPC_FAULT_REASONS.transportFault,
      );
    }
    frames.push(frame);
  }
  return frames;
}

export type WebRemoteControlRpcAssemblyEvent =
  | { kind: "message"; streamId: string; seq: number; message: unknown }
  | { kind: "pending"; streamId: string; seq: number; received: number; total: number }
  | {
      kind: "ignored";
      streamId: string;
      seq?: number;
      reason: "ack" | "flow" | "duplicate" | "stale";
    }
  | {
      kind: "fault";
      streamId: string;
      seq?: number;
      reasonCode: WebRemoteControlRpcFaultReason | string;
    };

interface AssemblySlot {
  streamId: string;
  seq: number;
  fragmentCount: number;
  messageBytes: number;
  checksum: WebRemoteControlRpcChecksum;
  chunks: Map<number, Uint8Array>;
  stagedBytes: number;
  startedAt: number;
}

export interface WebRemoteControlRpcAssemblerOptions {
  /**
   * 期望的 streamId。缺省表示「按第一片锁定」：两端各自用自己的 id 标注出站帧
   * （桌面用 attachmentId、手机用 `mobile-*`），链路是点对点且单流，因此只校验
   * 身份在流中途不发生切换；需要严格绑定时再显式传这个字段。
   */
  streamId?: string;
  /** 期望的下一条逻辑 seq（含）。默认 1，与 hostBridge/protocol 的起始序号一致。 */
  expectedSeq?: number;
  now?: () => number;
  assemblyTimeoutMs?: number;
  maxStagedBytes?: number;
}

/**
 * 单装配槽的接收侧装配器：每个 streamId 一份，只装配当前期望的 seq。
 *
 * - 收到非期望 seq 不缓存（单槽设计），直接给 `rpc-frame-gap` 让上层降级；
 * - 分片可以乱序到达（同一 seq 内），按 index 归位后按序拼接；
 * - 只有 `messageBytes` 与 CRC32 都一致才交付，任何校验失败都不推进 `expectedSeq`；
 * - 重复分片与已装配过的 seq 幂等忽略（重连重放不重复交付）。
 */
export class WebRemoteControlRpcAssembler {
  private expectedSeq: number;
  private readonly now: () => number;
  private readonly assemblyTimeoutMs: number;
  private readonly maxStagedBytes: number;
  private slot: AssemblySlot | undefined;
  /** 锁定的对端流身份；显式传入即固定，否则由第一片决定。 */
  private lockedStreamId: string | undefined;

  constructor(options: WebRemoteControlRpcAssemblerOptions = {}) {
    this.lockedStreamId = options.streamId;
    this.expectedSeq = options.expectedSeq ?? 1;
    this.now = options.now ?? (() => Date.now());
    this.assemblyTimeoutMs =
      options.assemblyTimeoutMs ?? WEB_REMOTE_CONTROL_RPC_LIMITS.assemblyTimeoutMs;
    this.maxStagedBytes = options.maxStagedBytes ?? WEB_REMOTE_CONTROL_RPC_LIMITS.maxMessageBytes;
  }

  /** 已连续装配到的逻辑 seq（发送侧据此推进 ack 窗口）。 */
  get acknowledgedSeq(): number {
    return this.expectedSeq - 1;
  }

  /** 供测试与诊断读取当前装配进度。 */
  get pendingFragments(): { seq: number; received: number; total: number } | null {
    if (!this.slot) return null;
    return {
      seq: this.slot.seq,
      received: this.slot.chunks.size,
      total: this.slot.fragmentCount,
    };
  }

  /** 时间兜底：由低频 tick 调用，超时的装配槽释放并上报 buffer-timeout。 */
  sweep(nowMs: number = this.now()): WebRemoteControlRpcAssemblyEvent[] {
    if (!this.slot) return [];
    if (nowMs - this.slot.startedAt < this.assemblyTimeoutMs) return [];
    const { seq } = this.slot;
    this.slot = undefined;
    return [
      {
        kind: "fault",
        streamId: this.lockedStreamId ?? "",
        seq,
        reasonCode: WEB_REMOTE_CONTROL_RPC_FAULT_REASONS.bufferTimeout,
      },
    ];
  }

  push(frame: unknown): WebRemoteControlRpcAssemblyEvent[] {
    const parsed = webRemoteControlRpcTransportFrameSchema.safeParse(frame);
    if (!parsed.success) {
      return [
        {
          kind: "fault",
          streamId: this.lockedStreamId ?? "",
          reasonCode: WEB_REMOTE_CONTROL_RPC_FAULT_REASONS.transportFault,
        },
      ];
    }
    const value = parsed.data;
    if (this.lockedStreamId === undefined) {
      this.lockedStreamId = value.streamId;
    } else if (value.streamId !== this.lockedStreamId) {
      // 流中途换身份：宁可 fail closed，也不能把两个流混进同一个单槽装配器。
      return [
        {
          kind: "fault",
          streamId: this.lockedStreamId,
          seq: value.kind === "message" ? value.seq : undefined,
          reasonCode: WEB_REMOTE_CONTROL_RPC_FAULT_REASONS.transportFault,
        },
      ];
    }
    if (value.kind !== "message") {
      return [{ kind: "ignored", streamId: value.streamId, reason: value.kind }];
    }

    const events = this.sweep(this.now());
    if (value.seq < this.expectedSeq) {
      // 已装配完成或重放：幂等忽略，不重复交付。
      return [
        ...events,
        { kind: "ignored", streamId: value.streamId, seq: value.seq, reason: "stale" },
      ];
    }
    if (value.seq > this.expectedSeq) {
      return [
        ...events,
        {
          kind: "fault",
          streamId: value.streamId,
          seq: value.seq,
          reasonCode: WEB_REMOTE_CONTROL_RPC_FAULT_REASONS.frameGap,
        },
      ];
    }

    const decoded = decodeWireBase64(value.dataBase64);
    if (!decoded) {
      return [
        ...events,
        {
          kind: "fault",
          streamId: value.streamId,
          seq: value.seq,
          reasonCode: WEB_REMOTE_CONTROL_RPC_FAULT_REASONS.transportFault,
        },
      ];
    }

    if (!this.slot || this.slot.seq !== value.seq) {
      this.slot = {
        streamId: value.streamId,
        seq: value.seq,
        fragmentCount: value.fragmentCount,
        messageBytes: value.messageBytes,
        checksum: value.checksum,
        chunks: new Map(),
        stagedBytes: 0,
        startedAt: this.now(),
      };
    }
    const slot = this.slot;
    if (slot.fragmentCount !== value.fragmentCount || slot.messageBytes !== value.messageBytes) {
      this.slot = undefined;
      return [
        ...events,
        {
          kind: "fault",
          streamId: value.streamId,
          seq: value.seq,
          reasonCode: WEB_REMOTE_CONTROL_RPC_FAULT_REASONS.transportFault,
        },
      ];
    }
    if (slot.chunks.has(value.fragmentIndex)) {
      return [
        ...events,
        { kind: "ignored", streamId: value.streamId, seq: value.seq, reason: "duplicate" },
      ];
    }
    slot.chunks.set(value.fragmentIndex, decoded);
    slot.stagedBytes += decoded.byteLength;
    if (slot.stagedBytes > this.maxStagedBytes) {
      this.slot = undefined;
      return [
        ...events,
        {
          kind: "fault",
          streamId: value.streamId,
          seq: value.seq,
          reasonCode: WEB_REMOTE_CONTROL_RPC_FAULT_REASONS.bufferOverflow,
        },
      ];
    }
    if (slot.chunks.size < slot.fragmentCount) {
      return [
        ...events,
        {
          kind: "pending",
          streamId: value.streamId,
          seq: value.seq,
          received: slot.chunks.size,
          total: slot.fragmentCount,
        },
      ];
    }

    const assembled = new Uint8Array(slot.messageBytes);
    let offset = 0;
    for (let index = 0; index < slot.fragmentCount; index += 1) {
      const chunk = slot.chunks.get(index);
      if (!chunk || offset + chunk.byteLength > assembled.byteLength) {
        this.slot = undefined;
        return [
          ...events,
          {
            kind: "fault",
            streamId: value.streamId,
            seq: value.seq,
            reasonCode: WEB_REMOTE_CONTROL_RPC_FAULT_REASONS.transportFault,
          },
        ];
      }
      assembled.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if (offset !== assembled.byteLength || crc32WireBytes(assembled) !== slot.checksum.value) {
      // 校验失败的消息无法修复（本层不做重传），释放槽位并如实上报。
      this.slot = undefined;
      return [
        ...events,
        {
          kind: "fault",
          streamId: value.streamId,
          seq: value.seq,
          reasonCode: WEB_REMOTE_CONTROL_RPC_FAULT_REASONS.transportFault,
        },
      ];
    }

    let message: unknown;
    try {
      message = JSON.parse(new TextDecoder().decode(assembled)) as unknown;
    } catch {
      this.slot = undefined;
      return [
        ...events,
        {
          kind: "fault",
          streamId: value.streamId,
          seq: value.seq,
          reasonCode: WEB_REMOTE_CONTROL_RPC_FAULT_REASONS.transportFault,
        },
      ];
    }

    const seq = slot.seq;
    this.slot = undefined;
    this.expectedSeq = seq + 1;
    return [...events, { kind: "message", streamId: value.streamId, seq, message }];
  }
}
