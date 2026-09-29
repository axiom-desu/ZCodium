// AstrBot 传输 provider（v2.1）。见 .agents/specs/bots-astrbot-bridge.md。
//
// 这是官方 BotsService 的一个 BotProviderAdapter：
// - 入站：bridge command 帧 → BotInboundMessage，交官方命令准入 / 任务驱动。
// - 出站：BotOutboundMessage 文本 → bridge delivery 帧。
// - 交互：官方 selection 走文本回退（ZCodium 侧 channel 固定为 astrbot）。
//
// 轮次模型（与插件对齐，每命令一个 stream）：
//   beginTurn → accepted(新 stream) → delivery… → status
// 若该命令启动了任务流（notifyTaskLifecycle("started")），则命令流被提升为任务流，
// 任务期间出站继续走任务流，终态/等待交互时以 status 收口。
// binding 路由与 seq/ack/replay 只属于传输层；provider 不持 sessionId/pending/任务状态。

import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  BOTS_BRIDGE_PROTOCOL_VERSION,
  botsBridgeCommandFrameSchema,
  type BotActor,
  type BotInboundMessage,
  type BotOutboundMessage,
  type BotsBridgeCommandFrame,
  type BotsBridgeDeliveryFrame,
  type BotsBridgeDeliveryPayload,
  type BotsBridgeResumeCursor,
  type BotsBridgeServerFrame,
  type BotsBridgeStreamState,
} from "@zcode/shared";
import { createServiceLogger, type ServiceLogger } from "#src/logger/serviceLogger.js";
import { buildAstrBotSelectionDeliveryPayload } from "../astrbotSelectionPayload.js";
import type { AstrBotBridgeTransport, IAstrBotBridgeService } from "../astrbotBridgePort.js";
import { BotsDeliveryLog, type BotsDeliveryReplay } from "../botsDeliveryLog.js";
import type { BotProviderAdapter, BotTaskLifecyclePhase } from "./types.js";

/** 官方 inbound 处理入口会注入 botId（wire 上没有该字段）。 */
const inboundFrameSchema = botsBridgeCommandFrameSchema.extend({
  zcodeBotId: z.string().trim().min(1),
});

/** actorKey 用平台稳定用户 id 派生，不落明文 id（原桥接 domain 逻辑，现为 provider 私有）。 */
function computeActorKey(channel: string, externalUserId: string): string {
  return createHash("sha256").update(`${channel}\u0000${externalUserId.trim()}`).digest("hex");
}

function buildBindingId(channel: string, actorKey: string): string {
  return `${channel}:${actorKey.slice(0, 16)}`;
}

function targetKey(actor: Pick<BotActor, "chatId" | "providerUserId">): string {
  return actor.chatId?.trim() || actor.providerUserId;
}

function toBridgeState(phase: BotTaskLifecyclePhase): BotsBridgeStreamState {
  switch (phase) {
    case "awaiting_input":
      return "awaiting_input";
    case "failed":
      return "failed";
    default:
      return "completed";
  }
}

export interface AstrBotProviderOptions {
  logger?: ServiceLogger;
  clock?: () => number;
  idFactory?: () => string;
}

export interface AstrBotProvider extends BotProviderAdapter, IAstrBotBridgeService {
  dispose(): void;
}

export function createAstrBotBotProvider(options: AstrBotProviderOptions = {}): AstrBotProvider {
  const logger = options.logger ?? createServiceLogger("bots.astrbot");
  const clock = options.clock ?? (() => Date.now());
  const idFactory = options.idFactory ?? (() => randomUUID());

  const deliveryLog = new BotsDeliveryLog({ idFactory, clock });
  /** targetKey → bindingId（出站路由）。 */
  const routing = new Map<string, string>();
  /** bindingId → 当前命令轮次（命令窗口内出站走它）。 */
  const currentTurns = new Map<string, { streamId: string; startedTask: boolean }>();
  /**
   * bindingId → 任务流。`awaiting_input` 时**保留**条目并把状态改成 awaiting：
   * 修复依据：原来一进 awaiting_input 就 delete，用户应答权限/提问后任务恢复的出站
   * 在两个 Map 里都查不到 stream，于是每帧 idFactory() 新建一个无主 stream，
   * 协议的 streamId 分组语义失效，插件按 stream 收口时恢复后的正文变成孤立帧。
   */
  const taskStreams = new Map<string, { streamId: string; state: "running" | "awaiting_input" }>();
  /** bindingId → 最近分配的下行 seq。 */
  const cursors = new Map<string, number>();
  /** bindingId → 最近一条 delivery（snapshot 用）。 */
  const latestFrames = new Map<string, BotsBridgeDeliveryFrame>();
  let transport: AstrBotBridgeTransport | null = null;

  function resolveBindingId(actor: Pick<BotActor, "chatId" | "providerUserId">): string {
    return buildBindingId("astrbot", computeActorKey("astrbot", targetKey(actor)));
  }

  function emit(frame: BotsBridgeServerFrame): void {
    transport?.send(frame);
  }

  function emitStatus(bindingId: string, streamId: string, state: BotsBridgeStreamState): void {
    emit({
      v: BOTS_BRIDGE_PROTOCOL_VERSION,
      kind: "status",
      id: idFactory(),
      bindingId,
      streamId,
      state,
    });
  }

  function emitDeliveryPayload(
    bindingId: string,
    streamId: string,
    payload: BotsBridgeDeliveryPayload,
  ): void {
    const currentCursor = cursors.get(bindingId) ?? 0;
    const frame = deliveryLog.append({
      bindingId,
      streamId,
      currentCursor,
      payload,
    });
    cursors.set(bindingId, frame.seq);
    latestFrames.set(bindingId, frame);
    emit(frame);
  }

  function emitDelivery(bindingId: string, streamId: string, text: string): void {
    emitDeliveryPayload(bindingId, streamId, { type: "text", text });
  }

  function beginTurn(frame: BotsBridgeCommandFrame, botId: string): string {
    const actor: BotActor = {
      provider: "astrbot",
      botId,
      providerUserId: frame.actor.externalUserId.trim(),
      chatType: frame.actor.chatType,
      ...(frame.actor.chatId ? { chatId: frame.actor.chatId } : {}),
      ...(frame.actor.displayName ? { displayName: frame.actor.displayName } : {}),
    };
    const bindingId = resolveBindingId(actor);
    routing.set(targetKey(actor), bindingId);
    const streamId = idFactory();
    currentTurns.set(bindingId, { streamId, startedTask: false });
    emit({
      v: BOTS_BRIDGE_PROTOCOL_VERSION,
      kind: "accepted",
      id: idFactory(),
      inReplyTo: frame.id,
      streamId,
      bindingId,
    });
    return bindingId;
  }

  function settleTurn(bindingId: string): void {
    const turn = currentTurns.get(bindingId);
    if (!turn) {
      return;
    }
    currentTurns.delete(bindingId);
    // 启动任务的轮次由任务终态收口；其余命令（含任务等待期间收到的 /status、
    // 普通消息回 taskRunning）立即收口，否则插件侧的流永远不会结束。
    // startedTask 由 notifyTaskLifecycle("started") 置位：BotsService 在权限/问答
    // 应答成功后重新通知 started，任务随即在同一轮次的 stream 上继续。
    if (!turn.startedTask) {
      emitStatus(bindingId, turn.streamId, "completed");
    }
  }

  function notifyTaskLifecycle(_bot: unknown, actor: BotActor, phase: BotTaskLifecyclePhase): void {
    const bindingId = routing.get(targetKey(actor)) ?? resolveBindingId(actor);
    const existing = taskStreams.get(bindingId);
    if (phase === "started") {
      const turn = currentTurns.get(bindingId);
      if (turn) {
        // 命令轮次启动了任务流（含权限/问答应答后任务恢复）：该轮次的 stream 提升为
        // 任务流，startedTask 阻止 settleTurn 提前收口。
        turn.startedTask = true;
        taskStreams.set(bindingId, { streamId: turn.streamId, state: "running" });
        return;
      }
      taskStreams.set(bindingId, {
        streamId: existing?.streamId ?? idFactory(),
        state: "running",
      });
      return;
    }
    if (phase === "awaiting_input") {
      // 保留任务流并标记暂停，供后续终态事件回落；见 taskStreams 声明处的修复依据。
      const streamId = existing?.streamId ?? currentTurns.get(bindingId)?.streamId ?? idFactory();
      taskStreams.set(bindingId, { streamId, state: "awaiting_input" });
      emitStatus(bindingId, streamId, "awaiting_input");
      return;
    }
    const streamId = existing?.streamId ?? currentTurns.get(bindingId)?.streamId ?? idFactory();
    taskStreams.delete(bindingId);
    emitStatus(bindingId, streamId, toBridgeState(phase));
  }

  return {
    async test() {
      return {
        ok: transport !== null,
        message: transport ? "AstrBot bridge connected." : "AstrBot bridge transport not attached.",
      };
    },

    async send(_bot, message: BotOutboundMessage): Promise<void> {
      const bindingId = routing.get(message.providerUserId);
      if (!bindingId) {
        logger.warn(undefined, `astrbot delivery without binding target=${message.providerUserId}`);
        return;
      }
      // 命令窗口内走当前命令流；任务运行期间走任务流；兜底新建流。
      const streamId =
        currentTurns.get(bindingId)?.streamId ??
        taskStreams.get(bindingId)?.streamId ??
        idFactory();
      // 修复原因：带 selection 的出站（权限 / elicitation / 菜单）以前只把 message.text 下发，
      // 而 BotsService 对非 weixin provider 只把 selection.title 写进 text，选项被整体丢弃，
      // 用户在 AstrBot 里看不到可选项也无法应答。这里改发协议里的 selection payload，
      // canonical 文本由 astrbotSelectionPayload 渲染；此时不再补发标题文本，避免重复。
      if (message.selection) {
        emitDeliveryPayload(
          bindingId,
          streamId,
          buildAstrBotSelectionDeliveryPayload(message.selection, message.locale),
        );
        return;
      }
      emitDelivery(bindingId, streamId, message.text);
    },

    parseCallback(payload: unknown): BotInboundMessage[] {
      const parsed = inboundFrameSchema.safeParse(payload);
      if (!parsed.success) {
        return [];
      }
      const frame = parsed.data;
      const actor: BotActor = {
        provider: "astrbot",
        botId: frame.zcodeBotId,
        providerUserId: frame.actor.externalUserId.trim(),
        chatType: frame.actor.chatType,
        ...(frame.actor.chatId ? { chatId: frame.actor.chatId } : {}),
        ...(frame.actor.displayName ? { displayName: frame.actor.displayName } : {}),
        providerMessageId: frame.id,
      };
      routing.set(targetKey(actor), resolveBindingId(actor));
      const base = { botId: frame.zcodeBotId, actor, receivedAt: clock() };
      switch (frame.command.type) {
        case "prompt":
          return [{ ...base, text: frame.command.text }];
        case "bind":
          return [{ ...base, text: `/bind ${frame.command.code}` }];
        case "new":
          return [{ ...base, text: "/new" }];
        case "stop":
          return [{ ...base, text: "/stop" }];
        case "cancel":
          return [{ ...base, text: "/cancel" }];
        case "status":
          return [{ ...base, text: "/status" }];
        case "help":
          return [{ ...base, text: "/help" }];
        case "unbind":
          return [{ ...base, text: "/unbind" }];
        case "workspace.set":
          return [{ ...base, text: `/workspace ${frame.command.value}` }];
        case "permission.respond":
          return [
            { ...base, text: `/approve ${frame.command.requestId} ${frame.command.optionId}` },
          ];
        case "elicitation.respond":
          return [
            {
              ...base,
              text: "",
              elicitationResponse: {
                requestId: frame.command.requestId,
                action: frame.command.action,
                ...(frame.command.content ? { content: frame.command.content } : {}),
              },
            },
          ];
        default:
          return [];
      }
    },

    notifyTaskLifecycle,

    attachTransport(next: AstrBotBridgeTransport) {
      transport = next;
      return {
        dispose: () => {
          if (transport === next) {
            transport = null;
          }
        },
      };
    },

    beginTurn,

    settleTurn,

    resolveResume(cursorsIn: readonly BotsBridgeResumeCursor[]): Map<string, BotsDeliveryReplay> {
      return deliveryLog.resolveResume(cursorsIn);
    },

    async buildSnapshot(bindingId: string): Promise<BotsBridgeDeliveryFrame | null> {
      return latestFrames.get(bindingId) ?? null;
    },

    ackDeliveryByFrameId(deliveryId: string): void {
      deliveryLog.ackById(deliveryId);
    },

    dispose(): void {
      transport = null;
      routing.clear();
      currentTurns.clear();
      taskStreams.clear();
      cursors.clear();
      latestFrames.clear();
    },
  };
}
