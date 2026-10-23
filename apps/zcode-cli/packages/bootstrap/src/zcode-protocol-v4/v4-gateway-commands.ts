import { localTtftNow } from "@zcode/shared/zcode-protocol-v4";
import type {
  CommandAck,
  CommandsQueryResult,
  ConversationInputIntent,
} from "@zcode/shared/zcode-protocol-v4";
import {
  PROTOCOL_V4_LIMITS,
  commandsQueryParamsSchema,
  commandsQueryResultSchema,
  parseCommandEnvelope,
} from "@zcode/shared/zcode-protocol-v4";
import { ConversationTopicPublisher } from "./conversation-topic-publisher.js";
import type { GatewayState } from "./v4-gateway-state.js";

/** 本域实际使用的根状态窄面。 */
type CommandsDomainState = Pick<
  GatewayState,
  | "coldResume"
  | "configPublishers"
  | "controlReservations"
  | "createLogEpoch"
  | "detachedLiveSessions"
  | "disposed"
  | "flushStates"
  | "host"
  | "hydratedSessions"
  | "hydrationBuffers"
  | "hydrationInFlight"
  | "inbox"
  | "indexFanoutThrottle"
  | "indexPublishers"
  | "localTtft"
  | "now"
  | "pausedConnections"
  | "projectionEventCommitWaiters"
  | "publishers"
  | "rawSequenceStates"
  | "readyFlights"
>;
import * as hydration from "./v4-gateway-hydration.js";

/**
 * v4/command：inbox 六态裁决；accepted 时执行副作用并把终态随响应返回。
 *
 * 这里曾经"立即回初始 ACK、后台 settle"，
 * 导致 createSession/forkAssistant 的调用方拿不到 result.sessionId（settle 只回填
 * 幂等表，只有同 commandId 重试才能读到）——违反
 * 「accepted 即时带 result」。命令副作用本身是快返回的（sendPrompt 后台起 turn），
 * await 不会把 RPC 挂到整个 turn 结束，所以同步等待终态。
 * settle 仍然固化结果供 duplicate 重放。
 */
export async function handleCommand(
  ctx: CommandsDomainState,
  rawParams: unknown,
): Promise<CommandAck> {
  let ttftCapacityRejected = false;
  const ttftCommand =
    typeof rawParams === "object" && rawParams !== null && "ttft" in rawParams
      ? parseCommandEnvelope(rawParams)
      : undefined;
  if (ttftCommand?.ok && ttftCommand.envelope.ttft) {
    const sessionId = ttftCommand.envelope.sessionId;
    const control = sessionId ? ctx.publishers.get(sessionId)?.getSnapshot().control : undefined;
    ttftCapacityRejected = !ctx.localTtft.receive(ttftCommand.envelope, control?.canStop === true);
  }
  // READY 只存在于冷恢复窗口；正常命令直接进入 inbox，避免重复解析信封。
  if (ctx.readyFlights.size > 0) {
    const parsed = parseCommandEnvelope(rawParams);
    const sessionId = parsed.ok ? parsed.envelope.sessionId : null;
    const ready = sessionId === null ? undefined : ctx.readyFlights.get(sessionId);
    if (ready) await ready;
  }

  const outcome = await ctx.inbox.handle(rawParams);
  if (outcome.kind === "ack")
    return {
      ...outcome.ack,
      ...(ttftCapacityRejected ? { ttftExcluded: "capacity" as const } : {}),
    };
  ctx.localTtft.admitted(outcome.envelope.commandId);
  let durableInputIntent: ConversationInputIntent | null = null;
  let settledAck: CommandAck | null = null;
  type CommandFinal = Parameters<typeof outcome.settle>[0];
  const reportError = (scope: string, error: unknown): void => {
    try {
      ctx.host.onError?.(scope, error);
    } catch {
      // 错误观察器不能反向破坏 command final 与 session FIFO 的收口。
    }
  };
  const settleOnce = (final: CommandFinal): CommandAck => {
    if (settledAck) return settledAck;
    const ack = {
      ...outcome.ack,
      ...final,
      ...(ttftCapacityRejected ? { ttftExcluded: "capacity" as const } : {}),
    };
    outcome.settle(final);
    settledAck = ack;
    return ack;
  };
  const cancelDurableInput = async (reason: string): Promise<void> => {
    if (!durableInputIntent) return;
    try {
      await ctx.host.cancelCommandInput?.(outcome.envelope, outcome.queueItemId, reason);
    } catch (cancelError) {
      // 原命令 ACK 必须保留真实执行结果；ledger cancel 失败单独告警，不能覆盖原错误。
      reportError("v4.command.input.cancel", cancelError);
    }
  };
  const releaseDurableInput = (
    final: Pick<CommandAck, "status" | "reasonCode" | "message" | "result">,
  ) => {
    if (!durableInputIntent || outcome.envelope.sessionId === null) return;
    try {
      ctx.inbox.releaseLiveInput(
        {
          sessionId: outcome.envelope.sessionId,
          commandId: durableInputIntent.sourceCommandId,
        },
        { ...outcome.ack, ...final },
      );
    } catch (releaseError) {
      reportError("v4.command.input.release", releaseError);
    }
  };
  try {
    const admission = {
      admissionSeq: outcome.admissionSeq,
      admittedAt: outcome.admittedAt,
      queueItemId: outcome.queueItemId,
    };
    const admissionPublisher =
      outcome.envelope.type === "createSession"
        ? new ConversationTopicPublisher(`pending-${outcome.envelope.commandId}`, "admission", {
            now: ctx.now,
          })
        : outcome.envelope.sessionId === null
          ? null
          : hydration.ensurePublisher(ctx, outcome.envelope.sessionId);
    const admissionProjectionBytes = admissionPublisher?.measureInputAdmissionProjectionBytes(
      outcome.envelope,
      admission,
    );
    if (
      admissionProjectionBytes !== null &&
      admissionProjectionBytes !== undefined &&
      admissionProjectionBytes > PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes
    ) {
      return settleOnce({
        status: "failed",
        reasonCode: "proto.payloadTooLarge",
        message: `conversation projection would exceed ${PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes} bytes`,
      });
    }
    durableInputIntent = (await ctx.host.admitCommandInput?.(outcome.envelope, admission)) ?? null;
    if (durableInputIntent && outcome.envelope.sessionId !== null) {
      ctx.inbox.pinLiveInput(outcome.envelope.sessionId, durableInputIntent);
    }
    const result = await ctx.host.executeCommand(outcome.envelope, admission);
    // 新建/侧聊命令采用结果会话的开关，避免把父会话或当前 App 设置误记到新会话。
    const contextSessionId =
      result?.type === "createSession" || result?.type === "createSelectionSideSession"
        ? result.sessionId
        : outcome.envelope.sessionId;
    const memoryEnabled = contextSessionId
      ? ctx.host.getSessionMemoryEnabled?.(contextSessionId)
      : undefined;
    const final = {
      status: "accepted" as const,
      ...(result ? { result } : {}),
      ...(memoryEnabled !== undefined ? { memoryEnabled } : {}),
    };
    return settleOnce(final);
  } catch (error) {
    // noop 不是失败（同值切换收口）：不进 onError，noop ACK 返回。
    if (error instanceof V4CommandNoopError) {
      await cancelDurableInput(error.reasonCode);
      const final = {
        status: "noop" as const,
        reasonCode: error.reasonCode,
      };
      releaseDurableInput(final);
      return settleOnce(final);
    }
    reportError("v4.command.execute", error);
    // 携带 reasonCode 的领域错误（V4PromptRejectedError / heldQueueDispositionRequired 等）
    // 原样上行，客户端才能按 guard 错误码分流；否则归一 executionFailed。
    const domainReasonCode =
      typeof (error as { reasonCode?: unknown } | null)?.reasonCode === "string"
        ? String((error as { reasonCode: string }).reasonCode)
        : null;
    const final = {
      status: "failed" as const,
      reasonCode:
        error instanceof V4CommandNotImplementedError
          ? "fault.command.notImplemented"
          : (domainReasonCode ?? "fault.command.executionFailed"),
      message: error instanceof Error ? error.message : String(error),
    };
    await cancelDurableInput(final.reasonCode);
    releaseDurableInput(final);
    return settleOnce(final);
  } finally {
    if (!settledAck) {
      // publisher/measure/admission 任一同步异常过去会跳过 settle，
      // 导致相同 command 永久等待、同 session FIFO 也无法继续 admission。
      const final = {
        status: "failed" as const,
        reasonCode: "fault.command.executionFailed",
        message: "command admission terminated before a durable final was recorded",
      };
      releaseDurableInput(final);
      settleOnce(final);
    }
  }
}

/** v4/commands/query：同 key 与 handleCommand 共用 CommandInbox gate。 */
export async function queryCommands(
  ctx: CommandsDomainState,
  rawParams: unknown,
): Promise<CommandsQueryResult> {
  const receivedAt = localTtftNow();
  const params = commandsQueryParamsSchema.parse(rawParams);
  // 校准是纯时钟探测，不能触发命令账本查询、恢复或 admission gate。
  if (params.clock)
    return {
      results: params.commands.map((key) => ({ key, result: "unknown" as const })),
      clock: { instanceId: ctx.localTtft.instanceId, receivedAt, sentAt: localTtftNow() },
    };
  await Promise.all(
    params.commands.map((key) => {
      const ready = key.sessionId === null ? undefined : ctx.readyFlights.get(key.sessionId);
      return ready;
    }),
  );
  return commandsQueryResultSchema.parse({
    results: await ctx.inbox.query(params.commands),
  });
}

/** 宿主 executor 对未接线命令抛出此错误 → ACK failed fault.notImplemented。 */
export class V4CommandNotImplementedError extends Error {
  constructor(type: string) {
    super(`v4 command not implemented in M3: ${type}`);
    this.name = "V4CommandNotImplementedError";
  }
}

/**
 * 命令 handler 的 noop 收口通道（「同值切换 ACK 必须可判别」）：
 * handler 判定命令无事可做（如 switchModelConfig/switchCollaborationMode 命中
 * runtime 当前值）时抛出，gateway 映射为 ACK status="noop" + reasonCode——
 * 不得以 accepted（无 result）静默吞掉，客户端才能区分「已生效」与「本来就是这个值」。
 */
export class V4CommandNoopError extends Error {
  constructor(
    readonly reasonCode: string,
    message?: string,
  ) {
    super(message ?? `v4 command is a no-op (${reasonCode})`);
    this.name = "V4CommandNoopError";
  }
}
