// input-prediction（CLI bootstrap 部分）公开入口。
// 规格：.agents/specs/upstream-3.18-input-prediction.md。
import {
  ConversationInputPredictionHandler,
  createInputPredictionSessionLoader,
} from "../input-prediction-handler.js";
import type { ZCodeProtocolAgentServerContext } from "../server-types.js";

/** 每协议 server 一份 handler；惰性创建，跨会话 record 重建存活。 */
export function getConversationInputPredictionHandler(
  context: Pick<
    ZCodeProtocolAgentServerContext,
    "deps" | "inputPrediction" | "logger" | "sessions"
  >,
): ConversationInputPredictionHandler {
  context.inputPrediction ??= new ConversationInputPredictionHandler({
    loadSession: createInputPredictionSessionLoader({
      sessions: context.sessions,
      sessionStore: context.deps.sessionStore,
    }),
    // 会话 record 是内存驻留的唯一代际令牌；换代后旧结果回 cancelled。
    isCurrentSession: (sessionId, token) => context.sessions.get(sessionId) === token,
    ...(context.logger ? { logger: context.logger } : {}),
  });
  return context.inputPrediction;
}
