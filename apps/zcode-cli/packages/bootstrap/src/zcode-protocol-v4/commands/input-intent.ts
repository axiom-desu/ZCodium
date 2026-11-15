import type { TurnInputIntentMetadata } from "@zcode/contracts";
import type { ModelSelection } from "@zcode/shared";
import type { AttachmentRef, CommandEnvelope, QueueItem } from "@zcode/shared/zcode-protocol-v4";
import type { SubmissionMode } from "@zcode/shared/zcode-protocol-v4";
import { commandAdmissionOf } from "./executor.js";

interface CanonicalCommandIntent {
  kind: "sendText" | "sendGoalCommand";
  text: string;
  modelSelection?: ModelSelection;
  mode?: SubmissionMode;
  planEnabled?: boolean;
  sourceCommandId?: string;
  clientId?: string;
  queueItemId?: string;
  requestedDelivery?: TurnInputIntentMetadata["requestedDelivery"];
  admittedDelivery?: TurnInputIntentMetadata["admittedDelivery"];
  fallbackReasonCode?: string;
  attachmentRefs?: readonly AttachmentRef[];
  sharedContextRefs?: TurnInputIntentMetadata["sharedContextRefs"];
  conversationQuotes?: TurnInputIntentMetadata["conversationQuotes"];
  provenance?: TurnInputIntentMetadata["provenance"];
  source?: TurnInputIntentMetadata["source"];
}

export function inputIntentMetadata(
  envelope: CommandEnvelope,
  options: {
    text: string;
    requestedDelivery: TurnInputIntentMetadata["requestedDelivery"];
    admittedDelivery?: TurnInputIntentMetadata["admittedDelivery"];
    fallbackReasonCode?: string;
    attachmentRefs?: readonly AttachmentRef[];
    modelSelection?: ModelSelection;
    mode?: SubmissionMode;
    planEnabled?: boolean;
    sharedContextRefs?: TurnInputIntentMetadata["sharedContextRefs"];
    conversationQuotes?: TurnInputIntentMetadata["conversationQuotes"];
    source?: TurnInputIntentMetadata["source"];
  },
): TurnInputIntentMetadata {
  const admission = commandAdmissionOf(envelope);
  return {
    sourceCommandId: envelope.commandId,
    queueItemId: admission.queueItemId,
    clientId: envelope.clientId || "cli",
    kind:
      envelope.type === "compact"
        ? "compact"
        : envelope.type === "sendGoalCommand"
          ? "sendGoalCommand"
          : "sendText",
    // live intent 过去只带 kind/来源，projection 只能回退可见 command 文案；
    // goal 的 displayText（如 `/GoAl replace X`）不是 runtime 已解析的 canonical objective。
    text: options.text,
    ...(options.modelSelection ? { modelSelection: options.modelSelection } : {}),
    ...(options.mode ? { mode: options.mode } : {}),
    ...(options.planEnabled !== undefined ? { planEnabled: options.planEnabled } : {}),
    admissionSeq: admission.admissionSeq,
    admittedAt: admission.admittedAt,
    requestedDelivery: options.requestedDelivery,
    admittedDelivery:
      options.admittedDelivery ??
      (options.requestedDelivery === "guide"
        ? "guide"
        : options.requestedDelivery === "queue"
          ? "queue"
          : "startNow"),
    ...(options.fallbackReasonCode ? { fallbackReasonCode: options.fallbackReasonCode } : {}),
    ...(options.attachmentRefs ? { attachmentRefs: [...options.attachmentRefs] } : {}),
    ...(options.sharedContextRefs ? { sharedContextRefs: [...options.sharedContextRefs] } : {}),
    ...(options.conversationQuotes ? { conversationQuotes: [...options.conversationQuotes] } : {}),
    ...(options.source ? { source: options.source } : {}),
  };
}

/** edit/retry 以新 commandId 重建，但保留原 canonical kind/delivery/cause。 */
export function inputIntentMetadataFromCanonical(
  envelope: CommandEnvelope,
  canonical: CanonicalCommandIntent,
  text = canonical.text,
): TurnInputIntentMetadata {
  const admission = commandAdmissionOf(envelope);
  const originalSourceCommandId =
    canonical.provenance?.sourceCommandId ?? canonical.sourceCommandId;
  return {
    sourceCommandId: envelope.commandId,
    queueItemId: admission.queueItemId,
    clientId: envelope.clientId || canonical.clientId || "cli",
    kind: canonical.kind,
    text,
    ...(canonical.modelSelection ? { modelSelection: canonical.modelSelection } : {}),
    ...(canonical.mode ? { mode: canonical.mode } : {}),
    ...(canonical.planEnabled !== undefined ? { planEnabled: canonical.planEnabled } : {}),
    admissionSeq: admission.admissionSeq,
    admittedAt: admission.admittedAt,
    requestedDelivery: canonical.requestedDelivery ?? "startNow",
    admittedDelivery: canonical.admittedDelivery ?? "startNow",
    ...(canonical.fallbackReasonCode ? { fallbackReasonCode: canonical.fallbackReasonCode } : {}),
    ...(canonical.attachmentRefs ? { attachmentRefs: [...canonical.attachmentRefs] } : {}),
    ...(canonical.sharedContextRefs ? { sharedContextRefs: [...canonical.sharedContextRefs] } : {}),
    ...(canonical.conversationQuotes
      ? { conversationQuotes: [...canonical.conversationQuotes] }
      : {}),
    ...(canonical.source ? { source: canonical.source } : {}),
    ...(originalSourceCommandId
      ? {
          provenance: canonical.provenance ?? {
            sourceCommandId: originalSourceCommandId,
            ...(canonical.queueItemId ? { queueItemId: canonical.queueItemId } : {}),
            ...(canonical.clientId ? { clientId: canonical.clientId } : {}),
          },
        }
      : {}),
  };
}

/**
 * 编辑/重试重放时的选区引用解析（唯一规则）：
 * - 编辑显式携带（含 `[]`）时以本次提交为准：`[]` 是用户清空引用，不是“没修改”。
 * - 未携带时沿用 canonical intent 的值（retry 总是走这一支）。
 * 不读 Composer，也不从正文尾块反推：引用只能来自本轮 intent 事实。
 */
export function resolveEditedConversationQuotes(
  explicit: TurnInputIntentMetadata["conversationQuotes"] | undefined,
  canonical: TurnInputIntentMetadata["conversationQuotes"] | undefined,
): TurnInputIntentMetadata["conversationQuotes"] | undefined {
  if (explicit !== undefined) return explicit.length > 0 ? [...explicit] : [];
  return canonical ? [...canonical] : undefined;
}

/** 正文/附件/引用三者全空才算空输入：只清空正文但保留引用仍是合法编辑。 */
export function hasEditedPromptInput(
  text: string,
  attachments: readonly unknown[] | undefined,
  quotes: TurnInputIntentMetadata["conversationQuotes"] | undefined,
): boolean {
  return text.trim().length > 0 || Boolean(attachments?.length) || Boolean(quotes?.length);
}

/** sendQueuedNow 只能转换原 QueueItem，禁止用 promotion commandId 重建来源。 */
export function inputIntentMetadataFromQueueItem(
  item: QueueItem,
  canonicalText: string,
): TurnInputIntentMetadata {
  return {
    sourceCommandId: item.sourceCommandId,
    queueItemId: item.queueItemId,
    clientId: item.clientId,
    kind: item.kind,
    text: canonicalText,
    ...(item.modelSelection ? { modelSelection: item.modelSelection } : {}),
    ...(item.mode ? { mode: item.mode } : {}),
    ...(item.planEnabled !== undefined ? { planEnabled: item.planEnabled } : {}),
    admissionSeq: item.order.admissionSeq,
    admittedAt: item.admittedAt,
    requestedDelivery: item.delivery.requested,
    admittedDelivery: item.delivery.admitted,
    ...(item.order.queuePosition !== undefined ? { queuePosition: item.order.queuePosition } : {}),
    ...(item.delivery.fallbackReasonCode
      ? { fallbackReasonCode: item.delivery.fallbackReasonCode }
      : {}),
    attachmentRefs: item.attachments,
    ...(item.sharedContextRefs ? { sharedContextRefs: [...item.sharedContextRefs] } : {}),
    // 队列项提升后仍要用入队时固定的选区引用，不重读 Composer。
    ...(item.conversationQuotes ? { conversationQuotes: [...item.conversationQuotes] } : {}),
    ...(item.source ? { source: item.source } : {}),
    // 提升只改变调度状态；重试／编辑原始输入的来源关联不能在此丢失。
    ...(item.provenance ? { provenance: { ...item.provenance } } : {}),
  };
}
