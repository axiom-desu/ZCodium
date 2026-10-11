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
  /** ack 合并窗口：首个待发 ack 入队后至少等这么久再刷，窗口内的多次装配合并成一个 ack。 */
  ackCoalesceWindowMs: 8,
  /** ack deadline 兜底：距首个待发 ack 最多这么久必须刷（远小于 ackWatchdogMs）。 */
  ackDeadlineMs: 250,
  /** ack 阈值：待发 ack 条数达到即立即刷，不等合并窗口。 */
  ackMaxPendingCount: 8,
  /** 装配槽周期清扫间隔；静默链路也据此收敛残片。 */
  assemblySweepIntervalMs: 5_000,
  /** 重传缓冲：最多保留多少条已发送未确认的逻辑消息。 */
  replayBufferMaxMessages: 128,
  /** 重传缓冲：最多保留多少字节的已发送未确认物理帧。 */
  replayBufferMaxBytes: 8 * 1024 * 1024,
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
  /** 重传缓冲不足以容纳新的未确认消息。 */
  replayBufferOverflow: "rpc-replay-buffer-overflow",
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

/** 只解析 ack 帧；非 ack 或结构非法返回 null（收帧方先判 ack 再决定是否进装配器）。 */
export function parseWebRemoteControlRpcAckFrame(
  frame: unknown,
): { streamId: string; ackSeq: number } | null {
  const parsed = ackFrameSchema.safeParse(frame);
  return parsed.success ? { streamId: parsed.data.streamId, ackSeq: parsed.data.ackSeq } : null;
}

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

export interface WebRemoteControlRpcReplayBufferOptions {
  /** 同时保留的未确认逻辑消息条数上限。 */
  maxMessages?: number;
  /** 同时保留的未确认物理帧字节数上限。 */
  maxBytes?: number;
  /** 物理帧计量函数；缺省按 relay wire 信封计量，与编码器同口径。 */
  measureFrameBytes?: (frame: WebRemoteControlRpcMessageFrame) => number;
}

export type WebRemoteControlRpcReplayRecordResult =
  | { accepted: true }
  | {
      accepted: false;
      reasonCode: typeof WEB_REMOTE_CONTROL_RPC_FAULT_REASONS.replayBufferOverflow;
    };

interface ReplayBufferEntry {
  seq: number;
  frames: readonly WebRemoteControlRpcMessageFrame[];
  bytes: number;
}

/**
 * 出站重传缓冲：保存最近已发送、尚未被对端 ack 覆盖的逻辑帧。
 *
 * 单序号空间：ack 的语义是「已连续装配到的逻辑 seq」，因此待重传窗口自然是
 * `(ackedSeq, lastSentSeq]`。只由发送侧拥有；接收侧的装配状态仍归
 * `WebRemoteControlRpcAssembler`。重复重发是幂等的：同 seq 同片再次到达时装配器判为
 * `stale`/`duplicate`，不会重复交付。
 */
export class WebRemoteControlRpcReplayBuffer {
  private readonly maxMessages: number;
  private readonly maxBytes: number;
  private readonly measureFrameBytes: (frame: WebRemoteControlRpcMessageFrame) => number;
  /** 已确认前缀用游标推进，避免每次 ack 都 `shift()` 成 O(n²)。 */
  private entries: Array<ReplayBufferEntry | undefined> = [];
  private headIndex = 0;
  private bytes = 0;
  private acknowledged = 0;
  private lastSent = 0;

  constructor(options: WebRemoteControlRpcReplayBufferOptions = {}) {
    this.maxMessages = options.maxMessages ?? WEB_REMOTE_CONTROL_RPC_LIMITS.replayBufferMaxMessages;
    this.maxBytes = options.maxBytes ?? WEB_REMOTE_CONTROL_RPC_LIMITS.replayBufferMaxBytes;
    this.measureFrameBytes = options.measureFrameBytes ?? relayEnvelopeByteLength;
  }

  /** 已确认到的逻辑 seq。 */
  get ackedSeq(): number {
    return this.acknowledged;
  }

  /** 最后一条已发送的逻辑 seq。 */
  get lastSentSeq(): number {
    return this.lastSent;
  }

  /** 当前保留的未确认逻辑消息条数。 */
  get pendingMessageCount(): number {
    return this.entries.length - this.headIndex;
  }

  /** 当前保留的未确认物理帧字节数。 */
  get pendingBytes(): number {
    return this.bytes;
  }

  /**
   * 记录一条刚发送的逻辑消息。入队前对整批做「条数 + 字节数」admission，
   * 超限返回 `replayBufferOverflow` 且不改动缓冲，调用方据此降级，不发半条消息。
   */
  record(
    seq: number,
    frames: readonly WebRemoteControlRpcMessageFrame[],
  ): WebRemoteControlRpcReplayRecordResult {
    if (seq <= this.lastSent) return { accepted: true };
    let bytes = 0;
    for (const frame of frames) bytes += this.measureFrameBytes(frame);
    if (this.pendingMessageCount + 1 > this.maxMessages || this.bytes + bytes > this.maxBytes) {
      return {
        accepted: false,
        reasonCode: WEB_REMOTE_CONTROL_RPC_FAULT_REASONS.replayBufferOverflow,
      };
    }
    this.entries.push({ seq, frames: [...frames], bytes });
    this.bytes += bytes;
    this.lastSent = seq;
    return { accepted: true };
  }

  /**
   * 对端 ack：推进已确认前缀并返回 `(ackSeq, lastSentSeq]` 的待重传帧。
   * ack 超过 `lastSentSeq` 属非法输入，不推进（调用方决定是否降级）。
   */
  acknowledge(ackSeq: number): WebRemoteControlRpcMessageFrame[] {
    if (ackSeq > this.lastSent) return [];
    if (ackSeq > this.acknowledged) this.acknowledged = ackSeq;
    this.releaseAcknowledgedPrefix();
    return this.replayUnacknowledged();
  }

  /** gap / 超时故障：返回窗口内全部待重传帧（扁平、保序、同 seq 同片）。 */
  replayUnacknowledged(): WebRemoteControlRpcMessageFrame[] {
    const frames: WebRemoteControlRpcMessageFrame[] = [];
    for (let index = this.headIndex; index < this.entries.length; index += 1) {
      const entry = this.entries[index];
      if (!entry || entry.seq <= this.acknowledged) continue;
      frames.push(...entry.frames);
    }
    return frames;
  }

  clear(): void {
    this.entries = [];
    this.headIndex = 0;
    this.bytes = 0;
    this.acknowledged = 0;
    this.lastSent = 0;
  }

  private releaseAcknowledgedPrefix(): void {
    while (this.headIndex < this.entries.length) {
      const entry = this.entries[this.headIndex];
      if (!entry || entry.seq > this.acknowledged) break;
      this.bytes -= entry.bytes;
      // 确认后立刻断开 payload/frame 引用，不把大消息留在内存里。
      this.entries[this.headIndex] = undefined;
      this.headIndex += 1;
    }
    // 只推进游标，达到阈值再 compact，避免逐条 ack 触发 O(n²) 搬移。
    if (this.headIndex > 0 && this.headIndex * 2 >= this.entries.length) {
      this.entries = this.entries.slice(this.headIndex);
      this.headIndex = 0;
    }
  }
}

export interface WebRemoteControlRpcAckSchedulerOptions {
  /** 合并窗口：首个待发 ack 入队后至少等这么久才刷。 */
  coalesceWindowMs?: number;
  /** deadline 兜底：距首个待发 ack 最多这么久必须刷。 */
  deadlineMs?: number;
  /** 阈值：待发 ack 条数达到即立即刷。 */
  maxPendingCount?: number;
  /** ack 发送回调（由平台侧负责真正发帧）。 */
  onFlush: (ackSeq: number) => void;
  now?: () => number;
}

/**
 * ack 批量调度：把窗口内的多次装配合并成一个 `ackSeq` 再发，避免逐条 ack。
 *
 * - 合并：`record` 只在单调推进时更新待发值，窗口内多次装配合并成最高 `ackSeq`；
 * - 刷新：达到条数阈值立即刷，否则在合并窗口到期时刷；
 * - deadline 兜底：距首个待发 ack 超过 `deadlineMs` 必刷（远小于对端 `ackWatchdogMs`），
 *   即使合并窗口被后续 `record` 不断推后也不会漏发最后一个 ack；
 * - 无变更不刷：定时器只在有待发 ack 时存在，flush 后立即清除。
 */
export class WebRemoteControlRpcAckScheduler {
  private readonly coalesceWindowMs: number;
  private readonly deadlineMs: number;
  private readonly maxPendingCount: number;
  private readonly onFlush: (ackSeq: number) => void;
  private readonly now: () => number;
  private pendingAckSeq: number | null = null;
  private pendingCount = 0;
  private firstPendingAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timerTargetAt: number | null = null;
  private disposed = false;

  constructor(options: WebRemoteControlRpcAckSchedulerOptions) {
    this.coalesceWindowMs =
      options.coalesceWindowMs ?? WEB_REMOTE_CONTROL_RPC_LIMITS.ackCoalesceWindowMs;
    this.deadlineMs = options.deadlineMs ?? WEB_REMOTE_CONTROL_RPC_LIMITS.ackDeadlineMs;
    this.maxPendingCount =
      options.maxPendingCount ?? WEB_REMOTE_CONTROL_RPC_LIMITS.ackMaxPendingCount;
    this.onFlush = options.onFlush;
    this.now = options.now ?? Date.now;
  }

  get hasPending(): boolean {
    return this.pendingAckSeq !== null;
  }

  /** 当前定时器计划刷新的时刻；无定时器为 null（诊断/测试观察点）。 */
  get nextFlushAt(): number | null {
    return this.timerTargetAt;
  }

  /** 记录一次装配完成。返回 true 表示本次已同步刷出。 */
  record(ackSeq: number): boolean {
    if (this.disposed) return false;
    if (this.pendingAckSeq !== null && ackSeq <= this.pendingAckSeq) return false;
    if (this.pendingAckSeq === null) {
      this.firstPendingAt = this.now();
      this.pendingCount = 0;
    }
    this.pendingAckSeq = ackSeq;
    this.pendingCount += 1;
    if (this.pendingCount >= this.maxPendingCount) {
      this.flush();
      return true;
    }
    this.armTimer();
    return false;
  }

  /** 立即刷出待发 ack（若有）。返回刷出的 `ackSeq` 或 null。 */
  flush(): number | null {
    if (this.disposed) return null;
    const ackSeq = this.pendingAckSeq;
    this.clearTimer();
    this.pendingAckSeq = null;
    this.pendingCount = 0;
    if (ackSeq === null) return null;
    this.onFlush(ackSeq);
    return ackSeq;
  }

  /** 重连 / 换 workspace：丢弃待发与定时器，但不永久停用。 */
  clear(): void {
    this.clearTimer();
    this.pendingAckSeq = null;
    this.pendingCount = 0;
    this.firstPendingAt = 0;
  }

  dispose(): void {
    this.disposed = true;
    this.clear();
  }

  private armTimer(): void {
    const now = this.now();
    // debounce + maxWait：后续 record 可把合并窗口推后，但绝不越过 deadline。
    const target = Math.min(now + this.coalesceWindowMs, this.firstPendingAt + this.deadlineMs);
    if (this.timerTargetAt !== null && this.timerTargetAt >= target) return;
    this.clearTimer();
    this.timerTargetAt = target;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        this.timerTargetAt = null;
        this.flush();
      },
      Math.max(0, target - now),
    );
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.timerTargetAt = null;
  }
}
