import { beginLocalTurnPreparation } from "@zcode/contracts";
import { SessionEventType, createChildTraceContext, createPartId } from "../deps.js";
import type {
  MessageId,
  Model,
  ModelNetworkStatusEvent,
  ModelToolContract,
  TraceContext,
} from "../deps.js";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import type {
  DrainedPendingInputDiagnostics,
  RunModelTextRequestOptions,
  RuntimeModelStreamSnapshot,
} from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { captureAssistantPersistenceAnchor } from "./turn-stop.js";
import { createStreamingToolCoordinator } from "./streaming-tool-coordinator.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import { querySourceForTask } from "./turn-model-step-usage.js";

/** 一次 model step 的输入；owner 仍是 turn loop。 */
export interface ModelStepOptions {
  drainedSteerForNextRequest?: DrainedPendingInputDiagnostics;
  latestRealUserMessageIndex?: number;
  messages: RunModelTextRequestOptions["messages"];
  sourceEntries: readonly (RuntimeMessageEntry | undefined)[];
  recordedMessages: RunModelTextRequestOptions["messages"];
  requestEntries: readonly RuntimeMessageEntry[];
  tools: ModelToolContract[];
}

/**
 * 请求准备阶段产出的 narrow context。
 *
 * 它只携带本次 model step 已确定的值与请求局部可变槽（stream 快照 / network request id），
 * 不复制 `RegularTurnLoopState` 或 runtime 字段所有权；状态仍由原 `state` / `this` 持有。
 */
export interface PreparedModelStep {
  assistantCreatedAt: number;
  assistantMessageId: MessageId;
  assistantPersistenceAnchor: ReturnType<typeof captureAssistantPersistenceAnchor>;
  executionContextWindow: number | undefined;
  executionMaxOutputTokens: number;
  executionModelSelection: { providerId: Model["providerId"]; modelId: Model["modelId"] };
  modelStepIndex: number;
  modelStartedAt: number;
  modelTraceContext: TraceContext;
  networkEventStartIndex: number;
  querySource: string;
  recordModelNetworkStatus: (event: ModelNetworkStatusEvent) => void;
  requestIds: { latest?: string; latestFailed?: string };
  streamRecoveryRequest: RegularTurnLoopState["pendingStreamRecoveryRequest"];
  streamState: { latestSnapshot: RuntimeModelStreamSnapshot };
  streamingToolCoordinator: ReturnType<typeof createStreamingToolCoordinator>;
}

/**
 * 准备一个 model 请求：assistant message / step-start part / ModelRequest 事件先落库，
 * 再建立 streaming tool coordinator 与 stream 恢复槽。事件次序与原实现一致；
 * 模型调用本身与其结果处理由 `turn-model-step.ts` 编排。
 */
export async function prepareModelStepRequest(
  this: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  options: ModelStepOptions,
  assistantMessageId: MessageId,
): Promise<PreparedModelStep> {
  const model = state.model;
  const modelStepIndex = state.modelStepCount;
  const modelStartedAt = Date.now();
  const assistantCreatedAt = modelStartedAt;
  const assistantPersistenceAnchor = captureAssistantPersistenceAnchor(this);
  const querySource = querySourceForTask(this.config.taskType);
  const executionModelSelection = { providerId: model.providerId, modelId: model.modelId };
  // 请求预算由 Agent 执行链显式决定。普通 Turn 选择打满模型声明的上限，
  // ModelFactory 不再把该请求参数伪装成长期 ModelSelection/Active Model 状态。
  const executionMaxOutputTokens = model.optionSpecs.maxOutputTokens.max;
  const executionContextWindow = model.properties.contextWindow;
  const modelTraceContext = createChildTraceContext(state.turnTraceContext, {
    attributes: {
      providerId: String(model.providerId),
      modelId: String(model.modelId),
      iteration: state.toolCallCount === 0 ? 0 : Math.ceil(state.toolCallCount / 10),
      querySource,
    },
  });

  this.logModelRequestSteeringContext({
    activeTurn: state.activeTurn,
    drained: options.drainedSteerForNextRequest,
    messages: options.messages,
    modelStepCount: state.modelStepCount,
    traceContext: modelTraceContext,
  });
  const finishPersistence = beginLocalTurnPreparation(modelTraceContext, "persistence");
  await this.persistAssistantMessage(
    assistantMessageId,
    state.currentUserMessageId,
    assistantCreatedAt,
    undefined,
    modelTraceContext,
    model,
  );
  await this.persistPart(
    {
      id: createPartId(),
      sessionID: this.sessionId,
      messageID: assistantMessageId,
      type: "step-start",
    },
    modelTraceContext,
  );

  const modelRequestEvent = this.createEvent(
    SessionEventType.ModelRequest,
    {
      // 自动续写提示只属于本次请求，不应写入持久化的 ModelRequest 轨迹。
      messages: options.recordedMessages,
      providerId: String(model.providerId),
      modelId: String(model.modelId),
      querySource,
      toolCount: options.tools.length,
      iteration: state.toolCallCount === 0 ? 0 : Math.ceil(state.toolCallCount / 10),
    },
    modelTraceContext,
  );
  await this.appendEvent(modelRequestEvent, modelTraceContext);
  state.events.push(modelRequestEvent);
  finishPersistence();
  const streamingToolCoordinator = createStreamingToolCoordinator(this, state, {
    assistantMessageId,
    model,
    traceContext: modelTraceContext,
  });
  const networkEventStartIndex = state.events.length;
  const streamState: { latestSnapshot: RuntimeModelStreamSnapshot } = {
    latestSnapshot: { reasoning: [], text: "" },
  };
  const streamRecoveryRequest = state.pendingStreamRecoveryRequest;
  state.pendingStreamRecoveryRequest = undefined;
  const requestIds: { latest?: string; latestFailed?: string } = {};
  const recordModelNetworkStatus = (event: ModelNetworkStatusEvent): void => {
    if (event.type === "model_request_started") {
      requestIds.latest = event.requestId;
      return;
    }
    if (event.type === "model_stream_stalled" || event.type === "model_request_failed") {
      requestIds.latestFailed = event.requestId;
    }
  };
  return {
    assistantCreatedAt,
    assistantMessageId,
    assistantPersistenceAnchor,
    executionContextWindow,
    executionMaxOutputTokens,
    executionModelSelection,
    modelStepIndex,
    modelStartedAt,
    modelTraceContext,
    networkEventStartIndex,
    querySource,
    recordModelNetworkStatus,
    requestIds,
    streamRecoveryRequest,
    streamState,
    streamingToolCoordinator,
  };
}
