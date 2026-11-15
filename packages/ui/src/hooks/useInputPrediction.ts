// 输入预测（ghost hint）的 UI 侧唯一请求 owner。
// 规格：.agents/specs/upstream-3.18-input-prediction.md。
//
// composer 仍是草稿唯一所有者：本 hook 只产出「可采纳的临时提示」，从不写草稿、不发送、
// 不持久化、不进入会话投影。草稿/会话/revision 变化、提交、停止、失活或 dispose 都取消
// 在途请求；迟到结果按 requestId + 当前草稿丢弃。
import { useCallback, useEffect, useRef, useState } from "react";
import type { V4ConversationInputPredictionResult } from "@zcode/shared/zcode-protocol-v4";

/** 一次预测请求；port 的实现负责跨 Host/CLI 传输。 */
interface InputPredictionRequest {
  sessionId: string;
  revision: number;
  draft: string;
  requestId: string;
}

/**
 * 服务边界：手机/桌面各自注入（mobile web 走 zcodeAgentService 代理）。
 * 实现必须降级为空结果而不是抛错；这里仍对异常做静默处理。
 */
interface InputPredictionPort {
  predict(request: InputPredictionRequest): Promise<V4ConversationInputPredictionResult>;
  cancel(request: Pick<InputPredictionRequest, "sessionId" | "requestId">): Promise<void>;
}

interface InputPredictionOptions {
  port: InputPredictionPort | null;
  sessionId: string | null;
  /** 会话/草稿的单调修订号：发送、切换会话或重连后递增。 */
  revision: number;
  draft: string;
  /** Host 能力位；false/缺席时不发请求（旧 Host 不得发起）。 */
  enabled: boolean;
  /** 会话处于可预测状态（已配对、当前会话视图、非运行中）。 */
  active: boolean;
  debounceMs?: number;
}

interface InputPredictionHint {
  text: string;
  requestId: string;
  revision: number;
  /** 生成该提示时的草稿；用于拒绝已被编辑改写的迟到结果。 */
  draft: string;
}

interface InputPredictionController {
  hint: InputPredictionHint | null;
  clear: () => void;
}

const DEFAULT_DEBOUNCE_MS = 700;

export function useInputPrediction(options: InputPredictionOptions): InputPredictionController {
  const { port, sessionId, revision, draft, enabled, active, debounceMs } = options;
  const [stored, setStored] = useState<InputPredictionHint | null>(null);
  const requestSeq = useRef(0);
  const current = useRef({ draft, revision, sessionId });
  current.current = { draft, revision, sessionId };

  const clear = useCallback(() => setStored(null), []);

  useEffect(() => {
    // 任何依赖变化（编辑/发送/停止/失活/换代）都立即让旧提示与在途结果失效。
    setStored(null);
    if (!enabled || !active || !port || !sessionId) return;
    const requestId = `input-prediction-${(requestSeq.current += 1)}`;
    let cancelled = false;
    let requested = false;
    const request = { sessionId, revision, draft, requestId };
    const timer = setTimeout(() => {
      requested = true;
      void port
        .predict(request)
        .then((result) => {
          if (cancelled) return;
          const live = current.current;
          if (live.draft !== draft || live.revision !== revision || live.sessionId !== sessionId) {
            return;
          }
          // 只接受本次 requestId 的明确 show；cancelled/unavailable/suppress 一律无 hint。
          if (result.decision !== "show" || result.requestId !== requestId) return;
          const candidate = result.candidates[0];
          if (!candidate) return;
          setStored({ text: candidate.text, requestId, revision, draft });
        })
        // 预测失败不改主链路：静默无 hint，不提示、不重试轰炸。
        .catch(() => undefined);
    }, debounceMs ?? DEFAULT_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (requested) void port.cancel({ sessionId, requestId }).catch(() => undefined);
    };
  }, [port, sessionId, revision, draft, enabled, active, debounceMs]);

  // 即使旧提示还在一个渲染帧里，也只把它交给「当前草稿」。
  const hint = stored && stored.draft === draft && stored.revision === revision ? stored : null;
  return { hint, clear };
}
