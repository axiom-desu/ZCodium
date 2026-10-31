import { buildExecutionStateEntry, readRuntimeExecutionState } from "../execution-state.js";
import type { WorkspaceId } from "@zcode/contracts";
import { SessionEventType, createSessionEvent, traceContextToLogContext } from "../deps.js";

// 生产环境只记录会改变 Turn/Session 生命周期的低频事件；stream/progress 仍由
// 现有 debug 聚合日志覆盖，避免诊断日志和消息流同频刷盘。
const LIFECYCLE_SESSION_EVENT_TYPES = new Set<SessionEventType>([
  SessionEventType.SessionTitleUpdated,
  SessionEventType.TurnStarted,
  SessionEventType.ModelRequest,
  SessionEventType.ModelComplete,
  SessionEventType.TurnComplete,
  SessionEventType.TurnError,
]);
import type { SessionEvent, TraceContext } from "../deps.js";
import { titleFromInput, slugify, projectIdFromDirectory } from "../helpers/index.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { recordToolUsageFromEvent } from "./usage-observability.js";
import { persistSessionShellEnvironmentSnapshot } from "./session-shell-environment.js";
import { persistRuntimeModelSelection } from "./turn-model.js";
import { persistDurableSessionEvent } from "./events-durable-persistence.js";
import { writeDynamicWorkflowActivationEntryIfActivated } from "./dynamic-workflow-activation.js";
import {
  flushSessionEventAppendAggregates,
  recordSessionEventAppendAggregate,
} from "./events-append-aggregate.js";

export function createEvent(
  this: AgentRuntimeInternal,
  type: SessionEventType,
  payload: unknown,
  traceContext: TraceContext,
): SessionEvent {
  return createSessionEvent(type, this.sessionId, payload, {
    turnId: traceContext.turnId,
    traceId: traceContext.traceId,
  });
}

export async function appendEvent(
  this: AgentRuntimeInternal,
  event: SessionEvent,
  traceContext: TraceContext,
): Promise<void> {
  // live sink 以前拿到的是 createSessionEvent 默认的 sequenceNumber=0，
  // 而 replay/read 路径拿到的是 eventStore 补号后的事件，导致同一 session 有两套顺序事实。
  // 这里只发布已落库事件，让 live、replay、snapshot 的 eventSeq 全部来自同一个 event store。
  const shouldLogLifecycle = LIFECYCLE_SESSION_EVENT_TYPES.has(event.type);
  const startedAt = Date.now();
  if (shouldLogLifecycle) {
    this.logger?.info("Session event persistence started", {
      ...traceContextToLogContext(traceContext),
      event: "session.event.persistence.started",
      module: "core.runtime",
      sessionEventType: event.type,
      status: "started",
    });
  }

  let phase = "event_store.append";
  try {
    const storedEvent = await this.eventStore.append(event);
    phase = "session_event.persist_durable";
    await persistDurableSessionEvent.call(this, storedEvent, traceContext);
    phase = "session_event.record_usage";
    await recordToolUsageFromEvent(this, storedEvent, traceContext);
    phase = "session_event.notify_sinks";
    await this.notifyEventSinks(storedEvent, traceContext);
    if (shouldLogLifecycle) {
      this.logger?.info("Session event persistence completed", {
        ...traceContextToLogContext(traceContext),
        durationMs: Date.now() - startedAt,
        event: "session.event.persistence.completed",
        module: "core.runtime",
        sessionEventSequenceNumber: storedEvent.sequenceNumber,
        sessionEventType: storedEvent.type,
        status: "completed",
      });
    }
    if (recordSessionEventAppendAggregate.call(this, storedEvent, traceContext)) {
      return;
    }
    flushSessionEventAppendAggregates.call(this, traceContext, "low_frequency_event");
    this.logger?.debug("Session event appended", {
      ...traceContextToLogContext(traceContext),
      event: "event_store.appended",
      module: "core.runtime",
      sessionEventSequenceNumber: storedEvent.sequenceNumber,
      sessionEventType: storedEvent.type,
    });
  } catch (error) {
    if (shouldLogLifecycle) {
      this.logger?.warn("Session event persistence failed", {
        ...traceContextToLogContext(traceContext),
        durationMs: Date.now() - startedAt,
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "session.event.persistence.failed",
        module: "core.runtime",
        phase,
        sessionEventType: event.type,
        status: "failed",
      });
    }
    throw error;
  }
}

export async function notifyEventSinks(
  this: AgentRuntimeInternal,
  event: SessionEvent,
  traceContext: TraceContext,
): Promise<void> {
  for (const sink of this.eventSinks) {
    try {
      await sink.onSessionEvent(event);
    } catch (error) {
      this.logger?.warn("Session event sink failed", {
        ...traceContextToLogContext(traceContext),
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "session_event_sink.failed",
        module: "core.runtime",
        sessionEventType: event.type,
        status: "failed",
      });
    }
  }
}

/**
 * 会话是否已进入持久化 store（首条输入 / 外部活动 / 直接启动的启动轮 / 冷恢复任一路径落过行）。
 * 协议层的 session record 以它为 draft 判定的事实源（bootstrap `onSessionEvent` 每条事件对齐一次），
 * 不再靠各命令 handler 各自翻 `record.persistence`。
 */
export function isSessionPersisted(this: AgentRuntimeInternal): boolean {
  return this.sessionPersisted;
}

const pendingSessionPersistence = new WeakMap<AgentRuntimeInternal, Promise<void>>();

export async function ensureSessionPersisted(
  this: AgentRuntimeInternal,
  input: string,
  traceContext: TraceContext,
): Promise<void> {
  if (!this.sessionStore || this.sessionPersisted) return;
  const pending = pendingSessionPersistence.get(this);
  if (pending) return pending;
  // App sampling 可与首轮任务并发；同一任务创建必须合并，避免重复插入及模型配置覆盖。
  const created = persistSession
    .call(this, input, traceContext)
    .finally(() => pendingSessionPersistence.delete(this));
  pendingSessionPersistence.set(this, created);
  return created;
}

async function persistSession(
  this: AgentRuntimeInternal,
  input: string,
  traceContext: TraceContext,
): Promise<void> {
  if (!this.sessionStore || this.sessionPersisted) return;

  const startedAt = Date.now();
  let phase = "session_store.create";
  this.logger?.info("Session persistence started", {
    ...traceContextToLogContext(traceContext),
    event: "session.persistence.started",
    module: "core.runtime",
    sessionId: this.sessionId,
    status: "started",
  });

  try {
    const directory = this.workingDirectory;
    // bootstrap 会用 path.resolve 规范化执行 cwd；过去又把同一个值写入
    // session.path/directory，导致本地 workspacePath 的末尾 `/` 丢失。冷恢复随后按精确
    // workspaceKey 查 provider registry 时就会落到另一个身份。持久化必须保留协议入口路径。
    const persistedWorkspacePath = this.config.workspacePath ?? directory;
    const title = titleFromInput(input);
    const workspaceIdentity = this.config.memory?.workspaceIdentity?.trim();
    await this.sessionStore.createSession({
      id: this.sessionId,
      projectID: projectIdFromDirectory(directory),
      // Memory workspaceIdentity 是上游提供的不透明隔离键。这里只做类型品牌化，
      // 不能调用会改写字符串的 ID 生成器，否则恢复后的 Memory root 会发生漂移。
      workspaceID: this.config.workspaceIdentity ?? (workspaceIdentity as WorkspaceId | undefined),
      parentID: this.config.parentSessionId,
      traceID: traceContext.traceId,
      taskType: this.config.taskType,
      slug: slugify(this.sessionId),
      directory: persistedWorkspacePath,
      path: persistedWorkspacePath,
      title,
      titleSource: "first_input",
      version: this.appVersion,
      permission: {
        mode: this.config.mode ?? "build",
      },
    });
    // 初始模型过去只写进首条 user message，没有写稳定的 session selection。
    // 冷恢复从末尾 assistant 反推时只能得到 provider/model，必选 reasoning 会丢失，
    // Subagent 因此在 hydration 前就无法重新创建 Model。会话创建时同步固定完整选型，
    // 后续显式切模仍复用同一个稳定 entry 覆盖。
    phase = "session_model_selection";
    const initialSelection = this.getSessionModelSelection();
    if (initialSelection) await persistRuntimeModelSelection(this, initialSelection);
    phase = "session_shell_snapshot";
    await persistSessionShellEnvironmentSnapshot(this, traceContext);
    phase = "session_execution_state";
    await this.sessionStore.saveSessionEntry?.(
      buildExecutionStateEntry(this.sessionId, readRuntimeExecutionState(this)),
    );
    this.sessionPersisted = true;
    // `/workflow` 作为会话首轮到来时激活先于落盘；此时才第一次有会话可挂 entry。
    await writeDynamicWorkflowActivationEntryIfActivated(this);
    this.logger?.debug("Session persisted", {
      ...traceContextToLogContext(traceContext),
      event: "session.persisted",
      module: "core.runtime",
      status: "completed",
    });
    // 之前只把 first_input title 写进 sessionStore 但不 appendEvent，
    // 导致下游 (z-code services 层的 task index sqlite syncer) 等不到 session.titleUpdated，
    // 侧边栏一直显示 "New session" 直到后台 LLM 生成 title。这里补一条 source="first_input"
    // 事件，让 desktop/web/mobile 三端的 syncer 走同一条收敛路径。
    phase = "session_title_event";
    await this.appendEvent(
      this.createEvent(
        SessionEventType.SessionTitleUpdated,
        {
          previousTitle: "",
          source: "first_input",
          title,
        },
        traceContext,
      ),
      traceContext,
    );
    this.logger?.info("Session persistence completed", {
      ...traceContextToLogContext(traceContext),
      durationMs: Date.now() - startedAt,
      event: "session.persistence.completed",
      module: "core.runtime",
      sessionId: this.sessionId,
      status: "completed",
    });
  } catch (error) {
    this.logger?.warn("Session persistence failed", {
      ...traceContextToLogContext(traceContext),
      durationMs: Date.now() - startedAt,
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "session.persistence.failed",
      module: "core.runtime",
      phase,
      sessionId: this.sessionId,
      status: "failed",
    });
    throw error;
  }
}
