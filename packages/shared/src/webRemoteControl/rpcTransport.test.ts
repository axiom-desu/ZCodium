import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_V4_LIMITS } from "../zcode-protocol-v4/core.js";
import { decodeWireBase64, encodeWireBytesBase64 } from "../zcode-protocol-v4/wire-binary.js";
import {
  encodeWebRemoteControlRpcFrames,
  WEB_REMOTE_CONTROL_RPC_FAULT_REASONS,
  WEB_REMOTE_CONTROL_RPC_LIMITS,
  WebRemoteControlRpcAckScheduler,
  WebRemoteControlRpcAssembler,
  WebRemoteControlRpcEncodingError,
  WebRemoteControlRpcReplayBuffer,
  webRemoteControlRpcTransportFrameSchema,
} from "./rpcTransport.js";

const STREAM = "stream-1";

/** 与传输层同口径的物理帧计量（含 `{type:"data",payload:…}` 外壳）。 */
const relayEnvelopeBytes = (frame: unknown) =>
  new TextEncoder().encode(
    JSON.stringify({ type: "data", payload: { zcode_type: "rpc-frame", frame } }),
  ).byteLength;

function encode(message: unknown, seq = 1) {
  return encodeWebRemoteControlRpcFrames(message, {
    streamId: STREAM,
    seq,
    measurePhysicalFrameBytes: relayEnvelopeBytes,
  });
}

function assembleAll(
  assembler: WebRemoteControlRpcAssembler,
  frames: readonly unknown[],
): ReturnType<WebRemoteControlRpcAssembler["push"]> {
  return frames.flatMap((frame) => assembler.push(frame));
}

describe("web remote control rpc transport · 限额与契约", () => {
  it("限额来自 PROTOCOL_V4_LIMITS 单一来源", () => {
    expect(WEB_REMOTE_CONTROL_RPC_LIMITS.maxPhysicalFrameBytes).toBe(
      PROTOCOL_V4_LIMITS.maxFrameBytes,
    );
    expect(WEB_REMOTE_CONTROL_RPC_LIMITS.maxMessageBytes).toBe(
      PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes,
    );
    expect(WEB_REMOTE_CONTROL_RPC_LIMITS.assemblyTimeoutMs).toBe(
      PROTOCOL_V4_LIMITS.logicalFrameAssemblyTimeoutMs,
    );
  });

  it("ack/flow 帧不接受分片字段，message 帧必须带分片字段", () => {
    const ack = { streamId: STREAM, seq: 3, kind: "ack", ackSeq: 3 };
    expect(webRemoteControlRpcTransportFrameSchema.safeParse(ack).success).toBe(true);
    expect(
      webRemoteControlRpcTransportFrameSchema.safeParse({ ...ack, dataBase64: "AAAA" }).success,
    ).toBe(false);
    const message = encode({ hello: "world" })[0]!;
    expect(webRemoteControlRpcTransportFrameSchema.safeParse(message).success).toBe(true);
    const { messageBytes: _drop, ...withoutBytes } = message;
    expect(webRemoteControlRpcTransportFrameSchema.safeParse(withoutBytes).success).toBe(false);
  });

  it("拒绝非 canonical base64", () => {
    const message = encode({ hello: "world" })[0]!;
    // 长度不是 4 的倍数、填充位错位，都不能进入 decode/装配。
    for (const dataBase64 of [
      "AAA",
      "AAAA=",
      "AA=A",
      `${message.dataBase64}${message.dataBase64}`.slice(0, 3),
    ]) {
      expect(
        webRemoteControlRpcTransportFrameSchema.safeParse({ ...message, dataBase64 }).success,
      ).toBe(false);
    }
    expect(
      webRemoteControlRpcTransportFrameSchema.safeParse({ ...message, dataBase64: "AAAA" }).success,
    ).toBe(true);
  });
});

describe("web remote control rpc transport · 编码", () => {
  it("小消息走单帧快路径，片数 1/1", () => {
    const frames = encode({ method: "ping" });
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      seq: 1,
      kind: "message",
      fragmentIndex: 0,
      fragmentCount: 1,
    });
  });

  it("超过物理帧上限的消息分片，每片都在上限内，装配后逐字节一致", () => {
    const message = { content: "x".repeat(3 * 1024 * 1024) };
    const frames = encode(message);
    expect(frames.length).toBeGreaterThan(1);
    expect(frames.every((frame) => frame.fragmentCount === frames.length)).toBe(true);
    expect(new Set(frames.map((frame) => frame.fragmentIndex)).size).toBe(frames.length);
    for (const frame of frames) {
      expect(relayEnvelopeBytes(frame)).toBeLessThanOrEqual(
        WEB_REMOTE_CONTROL_RPC_LIMITS.maxPhysicalFrameBytes,
      );
    }

    const assembler = new WebRemoteControlRpcAssembler();
    const events = assembleAll(assembler, frames);
    const delivered = events.filter((event) => event.kind === "message");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ seq: 1, message });
    expect(assembler.acknowledgedSeq).toBe(1);
  });

  it("超过消息上限的消息在发送侧 fail closed", () => {
    const tooLarge = { content: "x".repeat(WEB_REMOTE_CONTROL_RPC_LIMITS.maxMessageBytes + 1) };
    expect(() => encode(tooLarge)).toThrowError(WebRemoteControlRpcEncodingError);
    try {
      encode(tooLarge);
    } catch (error) {
      expect((error as WebRemoteControlRpcEncodingError).reasonCode).toBe(
        WEB_REMOTE_CONTROL_RPC_FAULT_REASONS.oversize,
      );
    }
  });

  it("物理预算小到放不下任何片时 fail closed，不产生超限帧", () => {
    expect(() =>
      encodeWebRemoteControlRpcFrames(
        { content: "y".repeat(4096) },
        {
          streamId: STREAM,
          seq: 1,
          measurePhysicalFrameBytes: () => WEB_REMOTE_CONTROL_RPC_LIMITS.maxPhysicalFrameBytes + 1,
        },
      ),
    ).toThrowError(WebRemoteControlRpcEncodingError);
  });
});

describe("web remote control rpc transport · 装配", () => {
  it("同一 seq 内分片乱序到达仍能装配，逐片 pending 进度可见", () => {
    const message = { content: "z".repeat(3 * 1024 * 1024) };
    const frames = encode(message);
    const shuffled = [...frames].reverse();
    const assembler = new WebRemoteControlRpcAssembler();

    const first = assembler.push(shuffled[0]);
    expect(first.filter((event) => event.kind === "pending")).toHaveLength(1);
    expect(assembler.pendingFragments).toMatchObject({ seq: 1, total: frames.length });

    const rest = assembleAll(assembler, shuffled.slice(1));
    expect(rest.filter((event) => event.kind === "message")).toHaveLength(1);
    expect(assembler.pendingFragments).toBeNull();
  });

  it("非期望 seq 不缓存：给 rpc-frame-gap 且不推进期望值", () => {
    const frames = encode({ late: true }, 2);
    const assembler = new WebRemoteControlRpcAssembler();
    const events = assembleAll(assembler, frames);
    expect(events.some((event) => event.kind === "fault")).toBe(true);
    expect(
      events.some(
        (event) =>
          event.kind === "fault" &&
          event.reasonCode === WEB_REMOTE_CONTROL_RPC_FAULT_REASONS.frameGap,
      ),
    ).toBe(true);
    expect(assembler.acknowledgedSeq).toBe(0);
    expect(assembler.pendingFragments).toBeNull();
  });

  it("重复分片与已装配过的 seq 幂等忽略，不重复交付", () => {
    const message = { content: "w".repeat(3 * 1024 * 1024) };
    const frames = encode(message);
    const assembler = new WebRemoteControlRpcAssembler();
    assembleAll(assembler, frames);
    const replay = assembleAll(assembler, frames);
    expect(replay.filter((event) => event.kind === "message")).toHaveLength(0);
    expect(replay.some((event) => event.kind === "ignored" && event.reason === "stale")).toBe(true);

    const secondRound = encode({ again: true }, 2);
    const once = assembleAll(assembler, secondRound);
    const twice = assembler.push(secondRound[0]);
    expect(once.filter((event) => event.kind === "message")).toHaveLength(1);
    // 已装配完成后同一 seq 的重复片一律 stale。
    expect(twice.some((event) => event.kind === "ignored")).toBe(true);
  });

  it("CRC32 不符时拒绝交付且不推进期望值", () => {
    const frames = encode({ content: "v".repeat(3 * 1024 * 1024) });
    expect(frames.length).toBeGreaterThan(1);
    const corrupted = frames.map((frame, index) => {
      if (index !== 1) return frame;
      const decoded = decodeWireBase64(frame.dataBase64)!;
      decoded[0] = (decoded[0]! + 1) % 256;
      return { ...frame, dataBase64: encodeWireBytesBase64(decoded) };
    });
    const assembler = new WebRemoteControlRpcAssembler();
    const events = assembleAll(assembler, corrupted);
    expect(
      events.some(
        (event) =>
          event.kind === "fault" &&
          event.reasonCode === WEB_REMOTE_CONTROL_RPC_FAULT_REASONS.transportFault,
      ),
    ).toBe(true);
    expect(events.some((event) => event.kind === "message")).toBe(false);
    expect(assembler.acknowledgedSeq).toBe(0);
  });

  it("装配槽超时后释放并上报 buffer-timeout", () => {
    let nowMs = 0;
    const frames = encode({ content: "t".repeat(3 * 1024 * 1024) });
    const assembler = new WebRemoteControlRpcAssembler({ now: () => nowMs });
    assembler.push(frames[0]);
    expect(assembler.pendingFragments).not.toBeNull();
    expect(assembler.sweep(nowMs + 1_000)).toHaveLength(0);

    nowMs += WEB_REMOTE_CONTROL_RPC_LIMITS.assemblyTimeoutMs + 1;
    const swept = assembler.sweep();
    expect(swept).toHaveLength(1);
    expect(swept[0]).toMatchObject({
      kind: "fault",
      reasonCode: WEB_REMOTE_CONTROL_RPC_FAULT_REASONS.bufferTimeout,
    });
    expect(assembler.pendingFragments).toBeNull();
  });

  it("结构非法的帧给 rpc-transport-fault；ack/flow 被忽略", () => {
    const assembler = new WebRemoteControlRpcAssembler();
    expect(assembler.push({ nonsense: true })[0]).toMatchObject({
      kind: "fault",
      reasonCode: WEB_REMOTE_CONTROL_RPC_FAULT_REASONS.transportFault,
    });
    expect(
      assembler.push({ streamId: STREAM, seq: 5, kind: "flow", flow: "saturated" })[0],
    ).toMatchObject({ kind: "ignored", reason: "flow" });
    expect(assembler.push({ streamId: STREAM, seq: 6, kind: "ack", ackSeq: 4 })[0]).toMatchObject({
      kind: "ignored",
      reason: "ack",
    });
  });

  it("显式绑定 streamId 时，别的 streamId 的帧被拒绝", () => {
    const frames = encodeWebRemoteControlRpcFrames(
      { hello: 1 },
      {
        streamId: "other-stream",
        seq: 1,
        measurePhysicalFrameBytes: relayEnvelopeBytes,
      },
    );
    const assembler = new WebRemoteControlRpcAssembler({ streamId: STREAM });
    expect(assembler.push(frames[0])[0]).toMatchObject({
      kind: "fault",
      reasonCode: WEB_REMOTE_CONTROL_RPC_FAULT_REASONS.transportFault,
    });
  });

  it("缺省按第一片锁定身份：中途换身份 fail closed", () => {
    // 两端各自用自己的 id 标注出站帧（桌面 attachmentId、手机 mobile-*），
    // 所以缺省模式必须接受链路上先出现的那个 id；但同一装配器里出现第二种身份就是串流，必须拒绝。
    const assembler = new WebRemoteControlRpcAssembler();
    const local = encode({ hello: 1 });
    expect(assembler.push(local[0]).filter((event) => event.kind === "message")).toHaveLength(1);

    const foreign = encodeWebRemoteControlRpcFrames(
      { hello: 2 },
      {
        streamId: "other-stream",
        seq: 2,
        measurePhysicalFrameBytes: relayEnvelopeBytes,
      },
    );
    expect(assembler.push(foreign[0])[0]).toMatchObject({
      kind: "fault",
      reasonCode: WEB_REMOTE_CONTROL_RPC_FAULT_REASONS.transportFault,
    });
  });
});

describe("web remote control rpc transport · 重传缓冲", () => {
  it("ack 推进窗口，并返回 (ackSeq, lastSentSeq] 的待重传帧", () => {
    const buffer = new WebRemoteControlRpcReplayBuffer();
    const seq1 = encode({ n: 1 }, 1);
    const seq2 = encode({ n: 2 }, 2);
    const seq3 = encode({ n: 3 }, 3);
    expect(buffer.record(1, seq1).accepted).toBe(true);
    expect(buffer.record(2, seq2).accepted).toBe(true);
    expect(buffer.record(3, seq3).accepted).toBe(true);
    expect(buffer.ackedSeq).toBe(0);
    expect(buffer.lastSentSeq).toBe(3);

    const replay = buffer.acknowledge(1);
    expect(replay).toEqual([...seq2, ...seq3]);
    expect(buffer.ackedSeq).toBe(1);
    expect(buffer.pendingMessageCount).toBe(2);
  });

  it("重传帧幂等：已装配过的 seq 再次到达不重复交付", () => {
    const assembler = new WebRemoteControlRpcAssembler();
    const buffer = new WebRemoteControlRpcReplayBuffer();
    const frames = encode({ again: true }, 1);
    buffer.record(1, frames);
    expect(assembler.push(frames[0]).some((event) => event.kind === "message")).toBe(true);

    const events = assembleAll(assembler, buffer.replayUnacknowledged());
    expect(events.some((event) => event.kind === "message")).toBe(false);
    expect(events.some((event) => event.kind === "ignored" && event.reason === "stale")).toBe(true);
  });

  it("丢片 nudge：ack 停留在已装配值后重传可补齐，且不重复交付", () => {
    const assembler = new WebRemoteControlRpcAssembler();
    const buffer = new WebRemoteControlRpcReplayBuffer();
    const seq1 = encode({ n: 1 }, 1);
    const seq2 = encode({ n: 2 }, 2);
    const seq3 = encode({ n: 3 }, 3);
    buffer.record(1, seq1);
    buffer.record(2, seq2);
    buffer.record(3, seq3);

    // 对端只收到 seq1；nudge ack=1，要求从 2 起重传。
    assembleAll(assembler, seq1);
    const replay = buffer.acknowledge(1);
    expect(replay).toEqual([...seq2, ...seq3]);
    expect(assembleAll(assembler, replay).filter((event) => event.kind === "message")).toHaveLength(
      2,
    );
    expect(assembler.acknowledgedSeq).toBe(3);
    // 同一批重传再来一次仍然幂等。
    expect(assembleAll(assembler, replay).filter((event) => event.kind === "message")).toHaveLength(
      0,
    );
  });

  it("按条数与字节双封顶：超限返回 replayBufferOverflow 且不变更缓冲", () => {
    const buffer = new WebRemoteControlRpcReplayBuffer({ maxMessages: 1 });
    expect(buffer.record(1, encode({ n: 1 }, 1)).accepted).toBe(true);
    expect(buffer.record(2, encode({ n: 2 }, 2))).toEqual({
      accepted: false,
      reasonCode: WEB_REMOTE_CONTROL_RPC_FAULT_REASONS.replayBufferOverflow,
    });
    expect(buffer.pendingMessageCount).toBe(1);
    expect(buffer.lastSentSeq).toBe(1);

    const byteLimited = new WebRemoteControlRpcReplayBuffer({ maxBytes: 1 });
    expect(byteLimited.record(1, encode({ n: 1 }, 1)).accepted).toBe(false);
    expect(byteLimited.pendingMessageCount).toBe(0);
  });

  it("ack 确认后释放缓冲，容量恢复", () => {
    const buffer = new WebRemoteControlRpcReplayBuffer({ maxMessages: 2 });
    buffer.record(1, encode({ n: 1 }, 1));
    buffer.record(2, encode({ n: 2 }, 2));
    expect(buffer.record(3, encode({ n: 3 }, 3)).accepted).toBe(false);
    buffer.acknowledge(1);
    expect(buffer.record(3, encode({ n: 3 }, 3)).accepted).toBe(true);
    expect(buffer.pendingMessageCount).toBe(2);
  });

  it("gap 故障全窗口重放；ack 超过 lastSentSeq 不推进", () => {
    const buffer = new WebRemoteControlRpcReplayBuffer();
    const seq1 = encode({ n: 1 }, 1);
    const seq2 = encode({ n: 2 }, 2);
    buffer.record(1, seq1);
    buffer.record(2, seq2);
    expect(buffer.replayUnacknowledged()).toEqual([...seq1, ...seq2]);
    expect(buffer.acknowledge(5)).toEqual([]);
    expect(buffer.ackedSeq).toBe(0);
    expect(buffer.pendingMessageCount).toBe(2);
  });

  it("重复 record 同 seq 幂等，不重复入队", () => {
    const buffer = new WebRemoteControlRpcReplayBuffer();
    const frames = encode({ n: 1 }, 1);
    buffer.record(1, frames);
    buffer.record(1, frames);
    expect(buffer.pendingMessageCount).toBe(1);
  });
});

describe("web remote control rpc transport · ack 批量调度", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("合并窗口内多次装配只产生一个 ack，取最高 seq", () => {
    const flushes: number[] = [];
    const scheduler = new WebRemoteControlRpcAckScheduler({
      coalesceWindowMs: 50,
      deadlineMs: 1_000,
      maxPendingCount: 10,
      onFlush: (ackSeq) => flushes.push(ackSeq),
    });
    scheduler.record(1);
    scheduler.record(2);
    scheduler.record(3);
    expect(flushes).toEqual([]);
    vi.advanceTimersByTime(50);
    expect(flushes).toEqual([3]);
    scheduler.dispose();
  });

  it("待发条数达到阈值立即刷", () => {
    const flushes: number[] = [];
    const scheduler = new WebRemoteControlRpcAckScheduler({
      coalesceWindowMs: 1_000,
      deadlineMs: 5_000,
      maxPendingCount: 2,
      onFlush: (ackSeq) => flushes.push(ackSeq),
    });
    scheduler.record(1);
    expect(flushes).toEqual([]);
    scheduler.record(2);
    expect(flushes).toEqual([2]);
    scheduler.dispose();
  });

  it("deadline 兜底：合并窗口被不断推后也必刷最后一个 ack", () => {
    const flushes: number[] = [];
    const scheduler = new WebRemoteControlRpcAckScheduler({
      coalesceWindowMs: 100,
      deadlineMs: 250,
      maxPendingCount: 100,
      onFlush: (ackSeq) => flushes.push(ackSeq),
    });
    scheduler.record(1);
    vi.advanceTimersByTime(90);
    scheduler.record(2);
    vi.advanceTimersByTime(90);
    scheduler.record(3);
    // 距首个待发 ack 才 180ms，尚未到 deadline，不应刷。
    expect(flushes).toEqual([]);
    vi.advanceTimersByTime(70);
    expect(flushes).toEqual([3]);
    scheduler.dispose();
  });

  it("无变更不刷：没有待发 ack 时空转，flush 后清定时器", () => {
    const flushes: number[] = [];
    const scheduler = new WebRemoteControlRpcAckScheduler({
      coalesceWindowMs: 50,
      deadlineMs: 500,
      onFlush: (ackSeq) => flushes.push(ackSeq),
    });
    vi.advanceTimersByTime(5_000);
    expect(flushes).toEqual([]);
    scheduler.record(1);
    vi.advanceTimersByTime(50);
    expect(flushes).toEqual([1]);
    vi.advanceTimersByTime(5_000);
    expect(flushes).toEqual([1]);
    scheduler.dispose();
  });

  it("clear 取消待发；dispose 后不再刷", () => {
    const flushes: number[] = [];
    const scheduler = new WebRemoteControlRpcAckScheduler({
      coalesceWindowMs: 50,
      deadlineMs: 500,
      onFlush: (ackSeq) => flushes.push(ackSeq),
    });
    scheduler.record(1);
    scheduler.clear();
    vi.advanceTimersByTime(500);
    expect(flushes).toEqual([]);
    scheduler.record(2);
    scheduler.dispose();
    vi.advanceTimersByTime(500);
    expect(flushes).toEqual([]);
  });
});
