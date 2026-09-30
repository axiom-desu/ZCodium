import type { TurnInputIntentMetadata } from "../deps.js";

/**
 * 把 runtime 的协议无关参数组装成 transcript/ledger 共用的完整输入事实。
 *
 * 只分别保存 text 与一组 metadata 的话，恢复端必须再次推断 delivery、
 * steer 和 dispatch，容易让 live projection 与 cold snapshot 出现不同状态。这里在
 * admission/drain 边界一次性固化，后续消费者只能读取，不能重新猜测。
 */
export function buildPersistedConversationInputIntent(
  text: string,
  intent: TurnInputIntentMetadata | undefined,
  dispatchState: "queued" | "drained",
): Record<string, unknown> | undefined {
  if (!intent) return undefined;

  const steer = intent.fallbackReasonCode
    ? { state: "fellBack", reasonCode: intent.fallbackReasonCode }
    : intent.admittedDelivery === "guide"
      ? { state: dispatchState === "drained" ? "guided" : "steering" }
      : { state: "notRequested" };

  return {
    sourceCommandId: intent.sourceCommandId,
    queueItemId: intent.queueItemId,
    clientId: intent.clientId,
    kind: intent.kind,
    // goal 的 message text 可以是 `/goal ...` 展示文案；admission 已持有 runtime
    // 解析后的 canonical objective，持久化必须优先使用它以保证 live/cold 等价。
    text: intent.text ?? text,
    attachments: intent.attachmentRefs ?? [],
    ...(intent.modelSelection ? { modelSelection: intent.modelSelection } : {}),
    ...(intent.mode ? { mode: intent.mode } : {}),
    ...(intent.planEnabled !== undefined ? { planEnabled: intent.planEnabled } : {}),
    ...(intent.sharedContextRefs ? { sharedContextRefs: intent.sharedContextRefs } : {}),
    delivery: {
      requested: intent.requestedDelivery,
      admitted: intent.admittedDelivery,
      ...(intent.fallbackReasonCode ? { fallbackReasonCode: intent.fallbackReasonCode } : {}),
    },
    order: {
      admissionSeq: intent.admissionSeq,
      ...(intent.queuePosition !== undefined ? { queuePosition: intent.queuePosition } : {}),
    },
    steer,
    dispatch: { state: dispatchState },
    admittedAt: intent.admittedAt,
    ...(intent.provenance ? { provenance: intent.provenance } : {}),
    ...(intent.source ? { source: intent.source } : {}),
  };
}
