// v4/conversation/inputPrediction 的 CLI 侧处理器（手机远控 ghost hint）。
// 规格：.agents/specs/upstream-3.18-input-prediction.md。
//
// 职责：
// - 同一会话只保留一个进行中的预测：新请求到达即中止旧请求，旧请求回 cancelled；
// - 按 (sessionId, revision, draft) 小 LRU 缓存终态结果，重连/重发不重复打模型；
// - 会话不在内存 / 轮数不够 → suppress_no_context；无模型、超时、模型失败 → unavailable。
// 只读、不做 CAS：预测是建议，不是状态；不进入 CommandInbox，也不续期 resident。
import type { Logger, MessageWithParts, SessionId, SessionStorePort } from "@zcode/contracts";
import {
  decideInputPrediction,
  generateInputPredictionCandidates,
  inputPredictionMinTurns,
  normalizeInputPredictionDraft,
  type InputPredictionModelCall,
  type InputPredictionTurnContext,
} from "@zcode/core";
import { isConversationRealUserTurnStarter } from "@zcode/shared";
import {
  emptyInputPredictionResult,
  v4ConversationInputPredictionParamsSchema,
  v4ConversationInputPredictionCancelParamsSchema,
  type V4ConversationInputPredictionResult,
} from "@zcode/shared/zcode-protocol-v4";
import type { ZCodeProtocolSessionRecord } from "./server-types.js";

/** 终态结果缓存条数（跨会话共享）。 */
const INPUT_PREDICTION_CACHE_MAX_ENTRIES = 16;

/** 预测需要的会话素材；会话不在内存时为 null。 */
export interface InputPredictionSessionMaterial {
  turns: InputPredictionTurnContext[];
  /** 会话没有可用模型选择时为 null。 */
  callModel: InputPredictionModelCall | null;
  /** 会话 record 身份令牌；返回前用它确认记录没有被换代/移除。 */
  generationToken?: unknown;
}

interface ConversationInputPredictionHandlerDeps {
  loadSession(sessionId: string): Promise<InputPredictionSessionMaterial | null>;
  /** 会话 record 仍是同一代际；缺席时退化为只读快照语义。 */
  isCurrentSession?(sessionId: string, token: unknown): boolean;
  logger?: Logger;
  timeoutMs?: number;
}

type PredictionResult = Omit<V4ConversationInputPredictionResult, "requestId">;

interface CachedResult {
  result: PredictionResult;
  generationToken?: unknown;
}

export class ConversationInputPredictionHandler {
  private readonly inFlight = new Map<string, { controller: AbortController; requestId: string }>();
  private readonly cache = new Map<string, CachedResult>();

  constructor(private readonly deps: ConversationInputPredictionHandlerDeps) {}

  async handle(rawParams: unknown): Promise<V4ConversationInputPredictionResult> {
    const params = v4ConversationInputPredictionParamsSchema.parse(rawParams);
    const { sessionId, requestId } = params;
    const draft = normalizeInputPredictionDraft(params.draft);
    const cacheKey = JSON.stringify([sessionId, params.revision, draft]);
    const withRequestId = (result: PredictionResult): V4ConversationInputPredictionResult =>
      requestId === undefined ? result : { ...result, requestId };

    let material: InputPredictionSessionMaterial | null;
    try {
      material = await this.deps.loadSession(sessionId);
    } catch (error) {
      this.warn("transcript_failed", sessionId, error);
      return emptyInputPredictionResult("unavailable", requestId);
    }
    if (!material) return emptyInputPredictionResult("suppress_no_context", requestId);

    const cached = this.cache.get(cacheKey);
    if (cached && cached.generationToken === material.generationToken) {
      // 修复原因：旧缓存原先只按 session/revision/draft 命中，sessionId 重用后会跨 runtime 复播。
      if (material.generationToken === undefined || !this.deps.isCurrentSession ||
          this.deps.isCurrentSession(sessionId, material.generationToken)) {
        this.cache.delete(cacheKey);
        this.cache.set(cacheKey, cached);
        return withRequestId(cached.result);
      }
      this.cache.delete(cacheKey);
    }

    // 新请求替代同会话的旧请求：手机只关心最新草稿。
    this.inFlight.get(sessionId)?.controller.abort();
    const controller = new AbortController();
    const flight = { controller, requestId: requestId ?? "" };
    this.inFlight.set(sessionId, flight);
    try {
      const result = await this.predict(sessionId, draft, controller.signal, material);
      if (controller.signal.aborted) return emptyInputPredictionResult("cancelled", requestId);
      if (result.decision !== "unavailable") {
        this.remember(cacheKey, { result, generationToken: material.generationToken });
      }
      return withRequestId(result);
    } finally {
      if (this.inFlight.get(sessionId) === flight) this.inFlight.delete(sessionId);
    }
  }

  /** 精确按会话与 requestId 取消；旧请求不能误杀同会话的新 generation。 */
  cancel(rawParams: unknown): void {
    const { sessionId, requestId } = v4ConversationInputPredictionCancelParamsSchema.parse(rawParams);
    const flight = this.inFlight.get(sessionId);
    if (flight?.requestId === requestId) flight.controller.abort();
  }

  /** 连接断开 / 进程关闭：中止全部进行中的预测。 */
  dispose(reason?: unknown): void {
    for (const { controller } of this.inFlight.values()) controller.abort(reason);
    this.inFlight.clear();
    this.cache.clear();
  }

  private async predict(
    sessionId: string,
    draft: string,
    abortSignal: AbortSignal,
    material: InputPredictionSessionMaterial,
  ): Promise<PredictionResult> {
    if (material.turns.length < inputPredictionMinTurns(draft)) {
      return emptyInputPredictionResult("suppress_no_context");
    }
    if (!material.callModel) return emptyInputPredictionResult("unavailable");

    const generationToken = material.generationToken;
    const isCurrent = () =>
      generationToken === undefined ||
      !this.deps.isCurrentSession ||
      this.deps.isCurrentSession(sessionId, generationToken);

    let rawCandidates;
    try {
      rawCandidates = await generateInputPredictionCandidates({
        turns: material.turns,
        draft,
        callModel: material.callModel,
        abortSignal,
        ...(this.deps.timeoutMs !== undefined ? { timeoutMs: this.deps.timeoutMs } : {}),
      });
    } catch (error) {
      // 超时 / 网络 / 模型不可用：静默降级，不影响手机主链路。被替代的请求不记日志。
      if (!abortSignal.aborted) this.warn("model_failed", sessionId, error);
      return emptyInputPredictionResult("unavailable");
    }
    // 会话在模型返回前被关闭/换代：旧代际结果不得写给新会话。
    if (!isCurrent() || abortSignal.aborted) return emptyInputPredictionResult("cancelled");
    if (!rawCandidates) return emptyInputPredictionResult("suppress_below_threshold");
    return decideInputPrediction({
      rawCandidates,
      draft,
      recentUserInputs: material.turns.map((turn) => turn.userText),
      turnCount: material.turns.length,
    });
  }

  private remember(cacheKey: string, result: CachedResult): void {
    this.cache.set(cacheKey, result);
    while (this.cache.size > INPUT_PREDICTION_CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private warn(reason: string, sessionId: string, error: unknown): void {
    // 只记错误类型与消息，绝不记草稿和会话内容。
    this.deps.logger?.warn("v4 input prediction degraded", {
      event: `zcode_protocol.v4.input_prediction_${reason}`,
      module: "bootstrap.zcode_protocol",
      sessionId,
      errorClass: error instanceof Error ? error.name : typeof error,
    });
  }
}

/**
 * 轮次配对：真实用户输入 → 到下一条真实用户输入之前的最后一条非空助手文本。
 * 合成消息、provider-only 上下文不算轮次，也不截断轮次。
 */
function collectInputPredictionTurns(
  messages: readonly MessageWithParts[],
): InputPredictionTurnContext[] {
  const turns: InputPredictionTurnContext[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (!isConversationRealUserTurnStarter(message)) continue;
    const userText = visibleText(message);
    if (userText.trim().length === 0) continue;
    let assistantText: string | null = null;
    for (let next = index + 1; next < messages.length; next += 1) {
      const candidate = messages[next]!;
      // 修复原因：以前遇到任何 user 行就停止；UserPromptSubmit、Stop 上下文和公告都是写在
      // prompt 与回答之间的隐藏 user 行，这一轮会取不到回答，或只取到中间的回答。
      if (isConversationRealUserTurnStarter(candidate)) break;
      if (candidate.info.role !== "assistant") continue;
      const text = visibleText(candidate);
      if (text.trim().length > 0) assistantText = text;
    }
    turns.push({ userText, assistantText });
  }
  return turns;
}

function visibleText(message: MessageWithParts): string {
  return message.parts
    .filter(
      (part): part is Extract<MessageWithParts["parts"][number], { type: "text" }> =>
        part.type === "text" && part.ignored !== true,
    )
    .map((part) => part.text)
    .join("");
}

/** 生产 loader：会话必须驻留在本进程（手机正在看的会话一定驻留）。 */
export function createInputPredictionSessionLoader(input: {
  sessions: ReadonlyMap<string, ZCodeProtocolSessionRecord>;
  sessionStore?: SessionStorePort;
}): ConversationInputPredictionHandlerDeps["loadSession"] {
  return async (sessionId) => {
    const record = input.sessions.get(sessionId);
    if (!record || !input.sessionStore) return null;
    const messages = await input.sessionStore.messages({ sessionID: sessionId as SessionId });
    const selection =
      record.app.runtime.getSessionModelSelection() ?? record.restoredModelSelection;
    const callModel: InputPredictionModelCall | null = selection
      ? async (modelMessages, options) => {
          const result = await record.app.generateWorkspaceText(
            { selection, messages: modelMessages, querySource: options.querySource },
            { abortSignal: options.abortSignal },
          );
          return { text: result.text };
        }
      : null;
    return {
      turns: collectInputPredictionTurns(messages),
      callModel,
      generationToken: record,
    };
  };
}
