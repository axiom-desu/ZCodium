import type {
  CompactPhase,
  CompactReason,
  MessageId,
  ModelStreamRecoveryStatus,
  Model,
  ModelToolContract,
  OutputStylePromptConfig,
  SessionEvent,
  TraceContext,
  TraceId,
  TurnId,
} from "../deps.js";
import type { ActiveTurnSteeringState } from "../types.js";
import type { SubagentRunOptions } from "@zcode/contracts";
import type { DrainedPendingInputDiagnostics } from "../types.js";
import type { TurnMachineImpl } from "../deps.js";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";

export type PendingStreamRecoveryRequest = ModelStreamRecoveryStatus;

export const RAPID_REFILL_TOOL_TURN_THRESHOLD = 3;
export const MAX_CONSECUTIVE_RAPID_REFILLS = 3;
export const AUTOMATION_MUTATION_TOOL_NAMES = ["CronCreate", "CronUpdate", "CronDelete"] as const;
const AUTOMATION_QUERY_ID_PREFIX = "automation-";

export interface CompactLoopTracking {
  consecutiveRapidRefills: number;
  toolTurnsSinceCompact: number;
}

export interface RapidRefillDecision {
  consecutiveRapidRefills: number;
  shouldBlock: boolean;
  toolTurnsSinceCompact: number;
}

export type CompactAttemptOutcome = "skipped" | "compacted" | "failed";

export type AutoCompactOutcome = CompactAttemptOutcome | "rapid_refill_blocked";

export interface AutoCompactLoopContext {
  compactReason: CompactReason;
  /** compact 成功后公告/续写读取同一份当前 turn 工具目录。 */
  getContinuationTools?: () => readonly ModelToolContract[];
  modelStepIndex: number;
  phase: CompactPhase;
  rapidRefill: RapidRefillDecision;
  model: Model;
  turnRequestState: TurnRequestState;
}

export interface ReactiveCompactLoopContext {
  activeEntries?: readonly RuntimeMessageEntry[];
  getContinuationTools?: () => readonly ModelToolContract[];
  modelStepIndex: number;
  model: Model;
  rapidRefillCount: number;
  turnRequestState: TurnRequestState;
}

export interface TurnRequestState {
  entries: readonly RuntimeMessageEntry[];
  outputTokenContinuationCount: number;
}

export interface RegularTurnLoopState {
  activeTurn?: ActiveTurnSteeringState;
  /** Host admission 显式传入的本轮 automation 身份；不能从持久 task metadata 推断。 */
  automationId?: string;
  /** CronCreate 命中全局上限后，本用户 turn 永久切为纯文本回复，禁止模型自行恢复。 */
  automationCreateLimitReached?: boolean;
  anomalyWarningsInjected: number;
  /** 本轮是否已消费来源为 subagent 的后台结果通知。 */
  backgroundSubagentResultConsumed: boolean;
  /** 本轮是否已消费来源为 workflow（dynamic-workflow run）的后台通知。 */
  workflowResultConsumed: boolean;
  compactTracking?: CompactLoopTracking;
  currentUserMessageId: MessageId;
  drainedSteerForNextRequest?: DrainedPendingInputDiagnostics;
  events: SessionEvent[];
  input: string;
  modelResponse: string;
  /** 本轮固定使用的可调用模型；配置变化只影响以后创建的 Loop。 */
  model: Model;
  /** execution 表示当前 Active Model 不能被同 loop 的 guide 改写。 */
  modelSelectionScope?: "execution";
  /** Core Server 的前台 child Selection override；优先于 profile 与父模型继承。 */
  subagentModelOverride?: SubagentRunOptions["modelOverride"];
  modelStepCount: number;
  /** 当前 query 已成功写入 provider 可见持久历史的 assistant/compact 产物数量。 */
  historyRoundCount: number;
  reactiveCompactAttemptedInCurrentModelStep: boolean;
  repeatedToolCallSignature?: string;
  repeatedToolCallStreakCount: number;
  pendingStreamRecoveryRequest?: PendingStreamRecoveryRequest;
  stopHookContinuationCount: number;
  /** 最终成功 product turn 的 raw transcript 起点；只有确认不再 continue 时才赋值。 */
  stableProductStartMessageId?: MessageId;
  /** 最终成功 assistant boundary；与 stableProductStartMessageId 成对出现。 */
  stableBoundaryAssistantMessageId?: MessageId;
  streamRecoveryRetryCount: number;
  tokenCount: number;
  toolCallCount: number;
  /** 当前 Turn 的 provider-local history；Turn 结束后直接释放。 */
  turnRequestState: TurnRequestState;
  /** 当前 turn 不向 provider 暴露的工具名；registry 仍保留，供执行边界做纵深校验。 */
  toolDisallowlist?: readonly string[];
  traceId: TraceId;
  turnAbortSignal: AbortSignal;
  turnId: TurnId;
  turnMachine: TurnMachineImpl;
  /** 当前 Turn 捕获的 provider-visible output style；不表示显式 subagent model override。 */
  turnOutputStyle?: OutputStylePromptConfig;
  turnTraceContext: TraceContext;
  userMessageId: MessageId;
}

export function isAutomationMutationRestrictedTurn(state: RegularTurnLoopState): boolean {
  if (state.automationId?.trim()) return true;
  if (state.turnTraceContext.queryId?.trim().startsWith(AUTOMATION_QUERY_ID_PREFIX)) return true;

  const disallowedTools = new Set(state.toolDisallowlist ?? []);
  // active/busy automation 输入会把 turn-scoped denylist 合并进当前 loop；即使原始
  // automationId 不再是 loop 首输入，也必须把同一事实继续传到 handler 执行边界。
  return AUTOMATION_MUTATION_TOOL_NAMES.every((toolName) => disallowedTools.has(toolName));
}

export function evaluateRapidRefill(
  tracking: CompactLoopTracking | undefined,
): RapidRefillDecision {
  const toolTurnsSinceCompact = tracking?.toolTurnsSinceCompact ?? 0;
  const consecutiveRapidRefills =
    tracking && toolTurnsSinceCompact < RAPID_REFILL_TOOL_TURN_THRESHOLD
      ? tracking.consecutiveRapidRefills + 1
      : 0;

  return {
    consecutiveRapidRefills,
    shouldBlock: consecutiveRapidRefills >= MAX_CONSECUTIVE_RAPID_REFILLS,
    toolTurnsSinceCompact,
  };
}

export function recordCompactSuccess(
  state: RegularTurnLoopState,
  decision: RapidRefillDecision,
): void {
  state.compactTracking = {
    consecutiveRapidRefills: decision.consecutiveRapidRefills,
    toolTurnsSinceCompact: 0,
  };
}

export function recordCompletedToolBatch(state: RegularTurnLoopState): void {
  // 旧 guard 活在整个用户 turn，完整工具批次结束后仍保持 used，导致后续真实 overflow 无法再次 reactive compact。
  state.reactiveCompactAttemptedInCurrentModelStep = false;
  if (state.compactTracking) {
    state.compactTracking.toolTurnsSinceCompact += 1;
  }
}

export function recordModelHistoryRound(state: RegularTurnLoopState): void {
  // toolCallCount 会把并行工具按数量展开，无法表达模型真正写入历史的轮次。
  // 调用点沿用既有 modelStepCount 的提交边界，额外累计历史轮次而不改变 loop 控制语义。
  state.historyRoundCount += 1;
}

export function recordCompactHistoryRound(state: RegularTurnLoopState): void {
  // compact summary 是独立的 provider 可见持久历史，但不是普通模型步骤，单独累计一次。
  state.historyRoundCount += 1;
}
