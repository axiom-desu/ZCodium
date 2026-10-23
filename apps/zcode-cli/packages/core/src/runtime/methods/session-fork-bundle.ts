import type { ExecutionState } from "@zcode/shared";
import {
  createModelId,
  createModelProviderId,
  type CreateSessionInput,
  type ModelSelection,
} from "@zcode/contracts";
import { readRuntimeExecutionState } from "../execution-state.js";
import { systemReminderRuntimeMetadata } from "../../agent/message-history.js";
import {
  SESSION_ENTRY_MODEL_SELECTION,
  createMessageId,
  createPartId,
  createTurnId,
} from "../deps.js";
import type {
  MessageId,
  MessageWithParts,
  SessionEntryInfo,
  SessionId,
  SessionInfo,
} from "../deps.js";
import {
  emptyTokenUsageInfo,
  formatConversationForkNoticeBody,
  slugify,
} from "../helpers/index.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { cloneModelSelection } from "../model-selection.js";
import { buildSyntheticUserNoticePartMetadata } from "./synthetic-notice-metadata.js";
import type { ForkIdentityMap } from "./session-fork-identity.js";

const MODEL_SELECTION_ENTRY_SUFFIX = ":runtime-model-selection";

function modelSelectionFromMessage(message: MessageWithParts): ModelSelection | undefined {
  if (message.info.role === "user") {
    return message.info.modelSelection && cloneModelSelection(message.info.modelSelection);
  }
  if (!message.info.modelId || !message.info.providerId) return undefined;
  return {
    modelId: message.info.modelId,
    providerId: message.info.providerId,
    ...(message.info.reasoningLevel
      ? { options: { reasoningLevel: message.info.reasoningLevel } }
      : {}),
  };
}

export function resolveForkModelSelection(
  runtime: AgentRuntimeInternal,
  messages: readonly MessageWithParts[],
  explicit?: ModelSelection,
): ModelSelection | undefined {
  if (explicit) return cloneModelSelection(explicit);
  const historical = [...messages].reverse().map(modelSelectionFromMessage).find(Boolean);
  const runtimeSelection = runtime.getSessionModelSelection();
  const identity = historical ?? runtimeSelection;
  if (!identity) return undefined;
  const historicalOptions = historical?.options;
  const reasoningLevel =
    historicalOptions?.reasoningLevel ?? runtimeSelection?.options?.reasoningLevel;
  return {
    modelId: identity.modelId,
    providerId: identity.providerId,
    ...(reasoningLevel !== undefined
      ? {
          options: {
            reasoningLevel,
          },
        }
      : {}),
  };
}

export function buildModelSelectionEntry(
  childSessionId: SessionId,
  modelSelection: ModelSelection | undefined,
): SessionEntryInfo {
  const timestamp = Date.now();
  return {
    id: `${childSessionId}${MODEL_SELECTION_ENTRY_SUFFIX}`,
    sessionID: childSessionId,
    type: SESSION_ENTRY_MODEL_SELECTION,
    touchSession: false,
    time: { created: timestamp, updated: timestamp },
    data: modelSelection ? cloneModelSelection(modelSelection) : null,
  };
}

export function buildForkedSessionInput(
  runtime: AgentRuntimeInternal,
  parentSession: SessionInfo,
  forkedSessionId: SessionId,
  kind: "fork" | "selection_side_chat" = "fork",
): CreateSessionInput {
  const now = Date.now();
  return {
    id: forkedSessionId,
    projectID: parentSession.projectID,
    workspaceID: parentSession.workspaceID,
    parentID: runtime.sessionId,
    traceID: runtime.rootTraceContext.traceId,
    taskType: kind,
    slug: `${slugify(parentSession.slug)}-${kind}-${now.toString(36)}`.slice(0, 120),
    directory: parentSession.directory,
    path: parentSession.path,
    title:
      kind === "selection_side_chat" ? "Selection side chat" : `Fork of ${parentSession.title}`,
    titleSource: "generated",
    version: parentSession.version,
    permission: parentSession.permission,
    time: {
      created: now,
      updated: now,
    },
  };
}

export function buildAtomicForkNotice(
  runtime: AgentRuntimeInternal,
  options: {
    identities: ForkIdentityMap;
    modelSelection?: ModelSelection;
    executionState?: ExecutionState;
    sourceCommandId: string;
    targetMessageId: MessageId;
  },
): MessageWithParts[] {
  const created = Date.now();
  const {
    hiddenMessageId: hiddenId,
    hiddenPartId,
    messageId: noticeId,
    partId: noticePartId,
    turnId: noticeTurnId,
    productTurnId,
  } = options.identities.notice;
  const anchorMessageId = options.identities.messageIds.get(options.targetMessageId) ?? hiddenId;
  const anchor = {
    turnId: noticeTurnId,
    productTurnId,
    orderedMessageIds: [hiddenId, noticeId],
    boundaryMessageId: noticeId,
  };
  const forkOrigin = {
    parentSessionId: runtime.sessionId,
    targetMessageId: options.targetMessageId,
  };
  const runtimeSelection = runtime.getSessionModelSelection();
  const modelSelection = options.modelSelection ?? runtimeSelection;
  return [
    {
      info: {
        id: hiddenId,
        sessionID: options.identities.childSessionId,
        role: "user",
        time: { created },
        agent: runtime.config.agentName ?? "zcode-agent",
        modelSelection: modelSelection && cloneModelSelection(modelSelection),
        synthetic: true,
        source: "fork",
        visibility: "model-only",
        semantics: {
          origin: "system",
          kind: "fork_notice",
          uiVisibility: "hidden",
          providerVisibility: "visible",
          transcriptVisibility: "hidden",
        },
        anchor,
        metadata: { forkOrigin },
      },
      parts: [
        {
          id: hiddenPartId,
          sessionID: options.identities.childSessionId,
          messageID: hiddenId,
          type: "text",
          text: formatConversationForkNoticeBody(forkOrigin),
          synthetic: true,
          time: { start: created, end: created },
          // hydrate 只读 part metadata；独立 source 保留 fork 边界且不改变 checkpoint 的 MCS 行为。
          metadata: buildSyntheticUserNoticePartMetadata("fork", "model-only", {
            forkOrigin,
            runtimeMessage: systemReminderRuntimeMetadata("conversation_fork"),
          }),
        },
      ],
    },
    {
      info: {
        id: noticeId,
        sessionID: options.identities.childSessionId,
        role: "assistant",
        time: { created, completed: created },
        parentID: hiddenId,
        modelId: modelSelection && createModelId(modelSelection.modelId),
        providerId: modelSelection && createModelProviderId(modelSelection.providerId),
        ...(modelSelection?.options?.reasoningLevel
          ? { reasoningLevel: modelSelection.options.reasoningLevel }
          : {}),
        // 分支提示本身也属于新分支历史，必须与分支的持久化状态保持一致。
        ...(options.executionState ?? readRuntimeExecutionState(runtime)),
        agent: runtime.config.agentName ?? "zcode-agent",
        path: { cwd: runtime.workingDirectory, root: runtime.workspaceRoot },
        cost: 0,
        tokens: emptyTokenUsageInfo(),
        finish: "completed",
        semantics: {
          origin: "system",
          kind: "timeline_event",
          uiVisibility: "visible",
          providerVisibility: "hidden",
          transcriptVisibility: "visible",
        },
        anchor,
        metadata: { forkOrigin },
      },
      parts: [
        {
          id: noticePartId,
          sessionID: options.identities.childSessionId,
          messageID: noticeId,
          type: "timeline",
          timelineType: "session_fork",
          display: "separator",
          status: "completed",
          anchorMessageId,
          anchorTurnId: noticeTurnId,
          sourceCommandId: options.sourceCommandId,
          parentSessionId: runtime.sessionId,
          targetMessageId: options.targetMessageId,
          restoredFileCount: 0,
          time: { start: created, end: created },
        },
      ],
    },
  ];
}

const SELECTION_SIDE_CHAT_BOUNDARY = [
  "The preceding conversation was inherited from the parent task for reference only.",
  "Do not continue the parent's active work automatically; answer only new questions sent in this side chat.",
  "Modify the workspace only when the user explicitly asks you to do so in this side chat.",
].join(" ");

export function buildSelectionSideChatBoundary(
  runtime: AgentRuntimeInternal,
  childSessionId: SessionId,
  modelSelection: ModelSelection | undefined,
): MessageWithParts {
  const created = Date.now();
  const messageId = createMessageId();
  const turnId = createTurnId();
  return {
    info: {
      id: messageId,
      sessionID: childSessionId,
      role: "user",
      time: { created },
      agent: runtime.config.agentName ?? "zcode-agent",
      modelSelection: modelSelection && cloneModelSelection(modelSelection),
      synthetic: true,
      source: "selection_side_chat",
      visibility: "model-only",
      semantics: {
        origin: "system",
        kind: "system_reminder",
        source: "selection_side_chat",
        uiVisibility: "hidden",
        providerVisibility: "visible",
        transcriptVisibility: "hidden",
      },
      anchor: {
        turnId,
        productTurnId: String(messageId),
        orderedMessageIds: [messageId],
        boundaryMessageId: messageId,
        origin: "synthetic",
      },
    },
    parts: [
      {
        id: createPartId(),
        sessionID: childSessionId,
        messageID: messageId,
        type: "text",
        text: SELECTION_SIDE_CHAT_BOUNDARY,
        synthetic: true,
        time: { start: created, end: created },
        // hydrate 读取 part metadata；只写 info.source 会退化为普通 user 文本。
        metadata: buildSyntheticUserNoticePartMetadata(
          "selection_side_chat",
          "model-only",
          undefined,
        ),
      },
    ],
  };
}

export function withoutSelectionSideChatGoalBoundary(message: MessageWithParts): MessageWithParts {
  const anchor = message.info.anchor;
  if (!anchor?.goalBoundary) return message;
  const anchorWithoutGoalBoundary = { ...anchor };
  delete anchorWithoutGoalBoundary.goalBoundary;
  return {
    ...message,
    info: {
      ...message.info,
      anchor: anchorWithoutGoalBoundary,
    },
  };
}
