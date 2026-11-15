// canonical 用户输入事实：live SessionEvent 与 cold hydration 合成事件共用的唯一解释入口。
//
// 从 event-normalizer 按语义拆出：用户意图（kind/text/来源/附件/选区引用）是一类事实，
// assistant 流与 passthrough 是另外两类。`event-normalizer.ts` 仍是公开入口，
// 这里只承载用户意图一侧的组装，避免单文件超出 400 行后被迫跳过字段。
import type {
  SessionEvent,
  SyntheticUserMessageSource,
  TurnAttachmentMeta,
  TurnInputIntentMetadata,
  TurnStartedPayload,
} from "@zcode/contracts";

type CanonicalConversationVisibility = "visible" | "modelOnly" | "stateOnly";
type CanonicalConversationOrigin =
  | "realUser"
  | "backgroundResult"
  | "goalContinuation"
  | "mailbox"
  | "synthetic"
  | "workflowLaunch"
  | "assistant"
  | "system";

export interface CanonicalConversationPlacement {
  lane: "trigger" | "assistantWork" | "stateOnly";
  relation: "withinProductTurn" | "none";
}

export interface ConversationNormalizationDiagnostic {
  code:
    | "normalizer.user.missingTranscriptMessageId"
    | "normalizer.assistant.missingTranscriptMessageId";
  eventId: string;
}

export interface CanonicalConversationFactBase {
  event: SessionEvent;
  entityId: string;
  productTurnId: string;
  runtimeTurnId: string;
  transcriptMessageId: string | null;
  visibility: CanonicalConversationVisibility;
  origin: CanonicalConversationOrigin;
  placement: CanonicalConversationPlacement;
  diagnostics: readonly ConversationNormalizationDiagnostic[];
}

export interface CanonicalTurnAttachment {
  ref?: string;
  fileName: string;
  mime: string;
  bytes: number;
  previewRef?: string;
}

export interface CanonicalUserIntentFact extends CanonicalConversationFactBase {
  semanticKind: "userIntent";
  visibility: "visible" | "modelOnly";
  origin:
    | "realUser"
    | "backgroundResult"
    | "goalContinuation"
    | "mailbox"
    | "synthetic"
    | "workflowLaunch";
  input: string;
  intentText: string;
  intentKind: "sendText" | "sendGoalCommand";
  turnNumber: number;
  executionKind: "agent" | "controlOnly";
  turnHeaderOrigin:
    | "userInput"
    | "backgroundResult"
    | "goalContinuation"
    | "editRerun"
    | "workflowLaunch";
  originMeta?: TurnStartedPayload["originMeta"];
  /**
   * 中枢直接启动已保存工作流的启动轮元数据（`inputSource === "workflow_launch"` 时在场）。
   * 活投影据它在 turnHeader / userInput 两行上画启动卡；与消息 metadata 里的同一份对齐（冷热同形）。
   */
  workflowLaunch?: TurnStartedPayload["workflowLaunch"];
  /** `input` 从此下标起是引擎附加文本。 */
  epilogueStart?: number;
  sourceCommandId?: string;
  foregroundExecutionId?: string;
  clientId?: string;
  attachments?: readonly CanonicalTurnAttachment[];
  /**
   * 会话选区引用：canonical 事实的一部分，编辑/重试重放与投影行都读这一份。
   * 正文（input/intentText）不含引用材料，模型边界才渲染。
   */
  conversationQuotes?: TurnInputIntentMetadata["conversationQuotes"];
  queueItemId?: string;
  admissionSeq?: number;
  admittedAt?: number;
  requestedDelivery?: "auto" | "startNow" | "queue" | "guide";
  admittedDelivery?: "startNow" | "queue" | "guide";
  sharedContextRefs?: readonly { kind: "shared_context_import"; context_id: string }[];
  fallbackReasonCode?: string;
  modelSelection?: TurnInputIntentMetadata["modelSelection"];
  mode?: TurnInputIntentMetadata["mode"];
  planEnabled?: boolean;
  provenance?: {
    sourceCommandId: string;
    queueItemId?: string;
    clientId?: string;
  };
  source?: TurnInputIntentMetadata["source"];
}

export function normalizeTurnStarted(
  event: SessionEvent,
  payload: TurnStartedPayload,
  ids: { runtimeTurnId: string; productTurnId: string },
): CanonicalUserIntentFact {
  const transcriptMessageId = payload.messageId ? String(payload.messageId) : null;
  const origin = userInputOrigin(payload.inputSource);
  // live 使用 runtime turnId、cold 使用 hydrate-turn-N；即使二者指向
  // 同一条持久 user message，过去仍生成不同 productTurnId，导致行分组与命令边界
  // 在恢复前后漂移。真实用户轮以持久 user messageId 作为稳定 product turn 身份；
  // legacy 缺 messageId 时才保留 runtime fallback，并通过 diagnostics 暴露降级。
  // 可见 user、goal continuation、background wake 都是 product-turn trigger；
  // 只要有持久 messageId 就必须共用它，不能只稳定 realUser。
  const productTurnId = transcriptMessageId ?? ids.productTurnId;
  const diagnostics: ConversationNormalizationDiagnostic[] = transcriptMessageId
    ? []
    : [
        {
          code: "normalizer.user.missingTranscriptMessageId",
          eventId: String(event.id),
        },
      ];
  return {
    semanticKind: "userIntent",
    event,
    entityId:
      transcriptMessageId ??
      `legacy:user:${String(event.sessionId)}:${ids.runtimeTurnId}:${String(event.id)}`,
    productTurnId,
    runtimeTurnId: ids.runtimeTurnId,
    transcriptMessageId,
    visibility: payload.inputVisibility === "model-only" ? "modelOnly" : "visible",
    origin,
    placement: { lane: "trigger", relation: "withinProductTurn" },
    diagnostics,
    input: payload.input,
    intentText: payload.intent?.text ?? payload.input,
    intentKind: payload.intent?.kind === "sendGoalCommand" ? "sendGoalCommand" : "sendText",
    turnNumber: payload.turnNumber,
    executionKind: payload.executionKind ?? "agent",
    turnHeaderOrigin: turnHeaderOrigin(payload.inputSource),
    ...(payload.originMeta ? { originMeta: payload.originMeta } : {}),
    ...(payload.workflowLaunch ? { workflowLaunch: payload.workflowLaunch } : {}),
    ...(payload.epilogueStart === undefined ? {} : { epilogueStart: payload.epilogueStart }),
    ...((payload.intent?.sourceCommandId ?? payload.inputId)
      ? { sourceCommandId: payload.intent?.sourceCommandId ?? payload.inputId }
      : {}),
    ...(payload.foregroundExecutionId
      ? { foregroundExecutionId: payload.foregroundExecutionId }
      : {}),
    ...(payload.intent?.clientId ? { clientId: payload.intent.clientId } : {}),
    // 选区引用属于本轮 intent 事实：编辑/重试与投影行都从这里读，不重新解析正文。
    ...(payload.intent?.conversationQuotes
      ? { conversationQuotes: payload.intent.conversationQuotes.map((quote) => ({ ...quote })) }
      : {}),
    ...(payload.intent?.queueItemId ? { queueItemId: payload.intent.queueItemId } : {}),
    ...(payload.intent?.admissionSeq !== undefined
      ? { admissionSeq: payload.intent.admissionSeq }
      : {}),
    ...(payload.intent?.admittedAt !== undefined ? { admittedAt: payload.intent.admittedAt } : {}),
    ...(payload.intent?.requestedDelivery
      ? { requestedDelivery: payload.intent.requestedDelivery }
      : {}),
    ...(payload.intent?.admittedDelivery
      ? { admittedDelivery: payload.intent.admittedDelivery }
      : {}),
    ...(payload.intent?.sharedContextRefs
      ? { sharedContextRefs: payload.intent.sharedContextRefs }
      : {}),
    ...(payload.intent?.fallbackReasonCode
      ? { fallbackReasonCode: payload.intent.fallbackReasonCode }
      : {}),
    ...(payload.intent?.modelSelection ? { modelSelection: payload.intent.modelSelection } : {}),
    ...(payload.intent?.mode ? { mode: payload.intent.mode } : {}),
    ...(payload.intent?.planEnabled !== undefined
      ? { planEnabled: payload.intent.planEnabled }
      : {}),
    ...(payload.intent?.provenance ? { provenance: payload.intent.provenance } : {}),
    ...(payload.intent?.source ? { source: payload.intent.source } : {}),
    ...normalizeAttachments(payload),
  };
}

function normalizeAttachments(payload: TurnStartedPayload): {
  attachments?: readonly CanonicalTurnAttachment[];
} {
  if (payload.intent?.attachmentRefs && payload.intent.attachmentRefs.length > 0) {
    return { attachments: payload.intent.attachmentRefs.map((attachment) => ({ ...attachment })) };
  }
  if (!payload.attachments || payload.attachments.length === 0) return {};
  return { attachments: payload.attachments.map(normalizeAttachment) };
}

function normalizeAttachment(attachment: TurnAttachmentMeta): CanonicalTurnAttachment {
  return {
    ...(attachment.ref ? { ref: attachment.ref } : {}),
    fileName: attachment.fileName,
    mime: attachment.mime,
    bytes: attachment.bytes,
  };
}

function turnHeaderOrigin(
  source: SyntheticUserMessageSource | undefined,
): CanonicalUserIntentFact["turnHeaderOrigin"] {
  switch (source) {
    case "background_task":
      return "backgroundResult";
    case "goal-continuation":
      return "goalContinuation";
    case "rewind":
      return "editRerun";
    // 中枢直接启动：turnHeader 与 userInput 同用 workflowLaunch origin，UI 据此画启动卡而非用户气泡。
    case "workflow_launch":
      return "workflowLaunch";
    default:
      return "userInput";
  }
}

function userInputOrigin(
  source: SyntheticUserMessageSource | undefined,
): CanonicalUserIntentFact["origin"] {
  switch (source) {
    case "background_task":
      return "backgroundResult";
    case "goal-continuation":
      return "goalContinuation";
    case "subagent":
    case "subagent_message":
      // child 回复是 mailbox runtime carrier，不是真实用户输入；
      // live/cold 即使都隐藏它，也必须保留相同 canonical origin。
      return "mailbox";
    case "fork":
    case "plugin_reference":
    case "rewind":
    case "todo_reminder":
      return "synthetic";
    // 中枢直接启动：用户在中枢里的真实动作，可见 user row 但以启动卡呈现（origin 区分它与普通气泡）。
    case "workflow_launch":
      return "workflowLaunch";
    default:
      return "realUser";
  }
}
