import {
  CoreErrorType,
  RewindStrategy,
  SessionEventType,
  createCoreError,
  createMessageId,
  createPartId,
  createSessionId,
  traceContextToLogContext,
} from "../deps.js";
import type { MessageId, SessionId, SessionInfo, TraceContext } from "../deps.js";
import { buildExecutionStateEntry, readRuntimeExecutionState } from "../execution-state.js";
import { formatConversationForkNoticeBody } from "../helpers/index.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type {
  StableConversationForkChildMetadata,
  StableConversationForkOptions,
  ConversationBeforeInputForkOptions,
  SelectionSideChatCreateOptions,
  WorkspaceForkResult,
} from "../types.js";
import { commitAtomicConversationFork } from "./session-fork-commit.js";
import { buildForkedSessionInput } from "./session-fork-bundle.js";
import { stableForkError } from "./session-fork-errors.js";
import { copyGoalStateForFork } from "./session-fork-goal.js";
import {
  buildForkHistoryMessages,
  conversationHistoryBeforeInput,
  forkSourceMessagesForSession,
  resolveForkHistoryEndIndex,
  selectionSideChatHistoryMessages,
  stableForkHistoryMessages,
} from "./session-fork-history.js";

export { copyGoalStateForFork } from "./session-fork-goal.js";
export {
  buildForkHistoryMessages,
  forkSourceMessagesForSession,
  resolveForkHistoryEndIndex,
} from "./session-fork-history.js";

/**
 * 副屏创建使用父 active transcript 的稳定落盘边界。正在生成时只保留已提交的本轮
 * real-user input，排除其后的 assistant/tool 增量；goal、queue 与阻塞运行态不复制。
 */
export async function createSelectionSideConversation(
  this: AgentRuntimeInternal,
  options: SelectionSideChatCreateOptions,
): Promise<WorkspaceForkResult> {
  if (!options.sourceCommandId.trim()) {
    throw stableForkError("Selection side chat sourceCommandId must not be empty");
  }
  if (!this.sessionStore?.commitForkBundle) {
    throw stableForkError("Selection side chat requires commitForkBundle");
  }
  const parentSession = await this.sessionStore.getSession(this.sessionId);
  if (!parentSession) throw stableForkError(`Session not found: ${this.sessionId}`);
  const parentMessages = await this.sessionStore.messages({ sessionID: this.sessionId });
  const activeMessages = forkSourceMessagesForSession(parentMessages, parentSession);
  const history = selectionSideChatHistoryMessages(activeMessages, this.activeTurn?.turnId);
  const targetMessageId = history.at(-1)?.info.id ?? createMessageId();
  return await commitAtomicConversationFork(this, {
    modelSelection: options.modelSelection,
    goalBoundary: { kind: "none" },
    kind: "selection_side_chat",
    messages: history,
    parentSession,
    revisionAtDecision: options.revisionAtDecision,
    sourceCommandId: options.sourceCommandId,
    targetMessageId,
    traceContext: options.traceContext ?? this.rootTraceContext,
  });
}

export async function createForkedSession(
  runtime: AgentRuntimeInternal,
  options: {
    parentSession: SessionInfo;
    forkedSessionId?: SessionId;
    stableForkMetadata?: StableConversationForkChildMetadata;
  },
): Promise<SessionId> {
  if (!runtime.sessionStore) {
    throw createCoreError(CoreErrorType.ConfigurationError, "Fork requires a session adapter.", {
      context: {
        hasSessionStore: false,
      },
      recoverable: true,
    });
  }

  const forkedSessionId = options.forkedSessionId ?? createSessionId();
  const input = buildForkedSessionInput(runtime, options.parentSession, forkedSessionId);
  // legacy workspace fork 兼容分支。V4 stable/compact-edit 入口直接构建完整 bundle，
  // 不得经过这里的 child-only metadata 原语，否则会重新引入逐条补写窗口。
  if (options.stableForkMetadata) {
    if (!runtime.sessionStore.createForkedSessionWithMetadata) {
      throw stableForkError("Stable fork requires atomic child metadata persistence", {
        forkedSessionId,
        sourceCommandId: options.stableForkMetadata.sourceCommandId,
      });
    }
    const persisted = await runtime.sessionStore.createForkedSessionWithMetadata(
      input,
      options.stableForkMetadata,
    );
    return persisted.id;
  } else {
    await runtime.sessionStore.createSession(input);
  }

  await runtime.sessionStore.saveSessionEntry?.(
    buildExecutionStateEntry(forkedSessionId, readRuntimeExecutionState(runtime)),
  );
  return forkedSessionId;
}

/** legacy workspace/checkpoint fork；V4 stable 与 compact-edit 禁止调用。 */
export async function forkConversationFromMessage(
  this: AgentRuntimeInternal,
  options: {
    forkedSessionId?: SessionId;
    targetMessageId: MessageId;
    traceContext: TraceContext;
    beforeTarget?: true;
  },
): Promise<WorkspaceForkResult> {
  if (!this.sessionStore) {
    throw createCoreError(CoreErrorType.ConfigurationError, "Fork requires a session adapter.", {
      context: {
        hasSessionStore: false,
      },
      recoverable: true,
    });
  }

  const parentSession = await this.sessionStore.getSession(this.sessionId);
  if (!parentSession) {
    throw createCoreError(CoreErrorType.SessionNotFound, `Session not found: ${this.sessionId}`, {
      context: {
        sessionId: this.sessionId,
      },
      recoverable: true,
    });
  }

  const parentMessages = await this.sessionStore.messages({
    sessionID: this.sessionId,
  });
  // fork 会在编辑重发和压缩后发生，复制源必须是 UI transcript 语义。
  // activeSessionMessages 是模型恢复语义，会按 compact boundary 截掉旧 worklog；
  // fork child 需要保留 fork 点前可见历史，但仍要排除 rewind/edit 后的旧分支。
  const forkSourceMessages = forkSourceMessagesForSession(parentMessages, parentSession);
  const targetIndex = forkSourceMessages.findIndex(
    (message) => message.info.id === options.targetMessageId,
  );
  if (targetIndex < 0) {
    throw stableForkError(
      `Fork target message not found in session store: ${options.targetMessageId}`,
      { messageId: options.targetMessageId },
    );
  }

  const legacyForkHistoryEndIndex = resolveForkHistoryEndIndex(
    forkSourceMessages,
    targetIndex,
    true,
  );
  const forkHistoryMessages = options.beforeTarget
    ? conversationHistoryBeforeInput(forkSourceMessages, options.targetMessageId)
    : buildForkHistoryMessages(
        parentMessages,
        forkSourceMessages,
        targetIndex,
        legacyForkHistoryEndIndex,
      );

  const forkedSessionId = await createForkedSession(this, {
    forkedSessionId: options.forkedSessionId,
    parentSession,
  });
  const { copiedMessageCount, messageIdMap } = await this.copySessionMessagesForFork({
    forkedSessionId,
    messages: forkHistoryMessages,
    traceContext: options.traceContext,
  });
  await copyGoalStateForFork.call(this, {
    forkedSessionId,
    messageIdMap,
    traceContext: options.traceContext,
  });
  // 纯对话 fork 没有 workspace checkpoint，但 UI 仍需要一条结构化 fork notice 渲染分割线。
  // 之前只复制历史消息，导致 forked session 首屏看不到来源边界。
  const copiedTargetMessageId = messageIdMap.get(options.targetMessageId);
  const forkTimelineCreated = Date.now();
  await this.persistAssistantTimelinePartForSession({
    sessionId: forkedSessionId,
    messageID: createMessageId(),
    partID: createPartId(
      `fork_${String(this.sessionId)}_${String(options.targetMessageId)}_timeline`,
    ),
    parentID: copiedTargetMessageId,
    created: forkTimelineCreated,
    completed: forkTimelineCreated,
    finish: "completed",
    timeline: {
      timelineType: "session_fork",
      display: "separator",
      status: "completed",
      anchorMessageId: copiedTargetMessageId,
      parentSessionId: this.sessionId,
      targetMessageId: options.targetMessageId,
      restoredFileCount: 0,
      time: {
        start: forkTimelineCreated,
        end: forkTimelineCreated,
      },
    },
    traceContext: options.traceContext,
  });
  await this.persistSyntheticUserNoticeForSession({
    messageID: createMessageId(),
    sessionId: forkedSessionId,
    source: "fork",
    text: formatConversationForkNoticeBody({
      parentSessionId: this.sessionId,
      targetMessageId: options.targetMessageId,
    }),
    metadata: {
      forkContext: {
        kind: "session_fork",
        parentSessionId: this.sessionId,
        targetMessageId: options.targetMessageId,
        restoredFileCount: 0,
      },
    },
    traceContext: options.traceContext,
  });
  this.logger?.debug("Conversation fork notice persisted", {
    ...traceContextToLogContext(options.traceContext),
    event: "session.fork.notice.persisted",
    forkedSessionId,
    module: "core.runtime",
    parentSessionId: this.sessionId,
    status: "completed",
    targetMessageId: options.targetMessageId,
  });

  const forkedEvent = this.createEvent(
    SessionEventType.SessionForked,
    {
      originalSessionId: this.sessionId,
      forkedSessionId,
      forkPoint: legacyForkHistoryEndIndex,
      targetMessageId: options.targetMessageId,
      restoredFileCount: 0,
      strategy: RewindStrategy.ForkRequired,
    },
    options.traceContext,
  );
  await this.appendEvent(forkedEvent, options.traceContext);

  return {
    copiedMessageCount,
    forkedSessionId,
    parentSessionId: this.sessionId,
    targetMessageId: options.targetMessageId,
    restoredFiles: [],
    response: `Forked session ${forkedSessionId} from message ${options.targetMessageId}: copied ${copiedMessageCount} messages.`,
  };
}

/** V4 running stable fork 公共入口：纯 transcript copy，不读取/恢复 workspace checkpoint。 */
export async function forkStableConversationAtMessage(
  this: AgentRuntimeInternal,
  options: StableConversationForkOptions,
): Promise<WorkspaceForkResult> {
  if (!options.sourceCommandId.trim()) {
    throw stableForkError("Stable fork sourceCommandId must not be empty");
  }
  if (!this.sessionStore?.commitForkBundle) {
    throw stableForkError("Stable fork requires commitForkBundle");
  }
  const parentSession = await this.sessionStore.getSession(this.sessionId);
  if (!parentSession) throw stableForkError(`Session not found: ${this.sessionId}`);
  const parentMessages = await this.sessionStore.messages({ sessionID: this.sessionId });
  const activeMessages = forkSourceMessagesForSession(parentMessages, parentSession);
  const history = stableForkHistoryMessages(activeMessages, options.target);
  return await commitAtomicConversationFork(this, {
    modelSelection: options.modelSelection,
    forkedSessionId: options.forkedSessionId,
    goalBoundary: options.goalBoundary,
    messages: history,
    parentSession,
    revisionAtDecision: options.revisionAtDecision,
    sourceCommandId: options.sourceCommandId,
    target: options.target,
    targetMessageId: options.target.boundaryMessageId as MessageId,
    traceContext: options.traceContext ?? this.rootTraceContext,
  });
}

/** compact-covered edit：复制目标真实用户输入之前的 active conversation prefix。 */
export async function forkConversationBeforeMessage(
  this: AgentRuntimeInternal,
  options: ConversationBeforeInputForkOptions,
): Promise<WorkspaceForkResult> {
  if (!this.sessionStore?.commitForkBundle) {
    throw stableForkError("Fork requires a session adapter");
  }
  const parentSession = await this.sessionStore.getSession(this.sessionId);
  if (!parentSession) throw stableForkError(`Session not found: ${this.sessionId}`);
  const parentMessages = await this.sessionStore.messages({
    sessionID: this.sessionId,
  });
  const activeMessages = forkSourceMessagesForSession(parentMessages, parentSession);
  const prefix = conversationHistoryBeforeInput(activeMessages, options.targetMessageId);
  return await commitAtomicConversationFork(this, {
    commandFact: options.commandFact,
    modelSelection: options.modelSelection,
    forkedSessionId: options.forkedSessionId,
    goalBoundary: options.goalBoundary,
    initialInput: options.initialInput,
    messages: prefix,
    parentSession,
    sourceCommandId: options.sourceCommandId,
    targetMessageId: options.targetMessageId,
    traceContext: options.traceContext ?? this.rootTraceContext,
  });
}
