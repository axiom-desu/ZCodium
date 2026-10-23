import type {
  BackgroundBashOutputResult,
  CommandAck,
  CommandEnvelope,
  CommandKey,
  CommandResult,
  ConversationInputIntent,
  ConversationOpenTiming,
  ConversationSnapshot,
  ConversationTelemetryFact,
  CuaPermissionObservation,
  RoutedTopicFrame,
  RoutedTopicWireFrame,
  SessionSummary,
  SubscribeAck,
  V4AttachmentPreviewSourceResult,
  V4ConversationFileChangesResult,
  V4ConversationFileRewindPreviewResult,
  WorkspaceConfigState,
} from "@zcode/shared/zcode-protocol-v4";
import {
  ZCODE_ATTACHMENT_FAULT_CODES,
  ZCodeAttachmentFaultError,
  encodeTopicWireFrames,
  measureTopicNotificationEnvelopeBytes,
  readZCodeAttachmentFaultCode,
} from "@zcode/shared/zcode-protocol-v4";
import type {
  DynamicWorkflowRunArtifact,
  DynamicWorkflowRunArtifactBytes,
  DynamicWorkflowRunArtifactItem,
  DynamicWorkflowRunEvent,
  DynamicWorkflowRunSessionSummary,
  DynamicWorkflowRunWorkspaceNode,
  DynamicWorkflowRunWorkspaceNodeResult,
  FileSystemErrorCode,
  MessageWithParts,
  SessionEvent,
  TurnId,
} from "@zcode/contracts";
import { isFileSystemPortError } from "@zcode/contracts";
import type { ZCodeWorkspaceRef } from "@zcode/shared";
import type { ColdSessionResumeOutcome } from "./cold-session-resume.js";
import type {
  ConversationRowTargetAction,
  SessionConfigSeed,
  SessionSubagentsSeed,
  SessionUsageSeed,
} from "./product-projection.js";
import type { TopicFrameReservation } from "./topic-frame-reservation.js";

export function toRuntimeTurnId(turnId: string | null): TurnId | null {
  // conversation projection 为了 row 索引用 string 保存 product turnId；
  // 离开 gateway 调 runtime 文件摘要/回退能力时，需要恢复 contracts 的品牌类型。
  return turnId as TurnId | null;
}

export function rowTargetActionForCommand(
  type: CommandEnvelope["type"],
): ConversationRowTargetAction | null {
  switch (type) {
    case "forkAssistant":
    case "editUserQuery":
    case "retryTurn":
    case "applyFileRewind":
    case "setAssistantFeedback":
      return type;
    default:
      return null;
  }
}

export interface PersistedEventsLoadResult {
  events: SessionEvent[];
  synthesized: boolean;
  /** durable transcript 重放后、live buffer 补回前注入的 store-verified child manifest。 */
  subagentsSeed?: SessionSubagentsSeed;
  /** shared_context 不生成可见 row；只把脱敏 handover metadata 下发。 */
  sharedContextImport?: ConversationSnapshot["sharedContextImport"];
  /** memory eventStore 取快照时已包含的 raw sequence 水位。 */
  sourceEventSeq?: number;
  /** 与本次历史事件使用同一容量的种子；null 表示已查询但没有历史水位。 */
  usageSeed?: SessionUsageSeed | null;
}

export type V4GatewayErrorContext = Record<string, unknown>;

export interface V4GatewayHost {
  cliVersion?: string;
  /** 会话是否在宿主注册表中活跃（inbox 的 sessionNotFound 裁决依据）。 */
  sessionExists(sessionId: string): boolean;
  /**
   * V4 冷恢复钩子。gateway 用同一个 READY promise 包住 runtime activation 与 projection
   * hydration；宿主只负责恢复 record。
   */
  resumePersistedSession?(
    sessionId: string,
    resumeThoughtLevel?: string,
    workspace?: ZCodeWorkspaceRef,
  ): Promise<ColdSessionResumeOutcome>;
  /**
   * 下行物理帧出口（宿主负责投递：stdio notification / MessagePort / ws）。
   *
   * 逻辑帧 fallback 会绕过 1MiB 上限、分片和接收端原子组装边界；因此生产
   * host 与测试 host 都必须显式接收 physical wire，类型层不再允许退回逻辑帧。
   */
  emitWireFrame(frame: RoutedTopicWireFrame): void;
  /** 当前进程 live ingest 的无正文事实；不缓存、不进入 topic replay。 */
  emitConversationTelemetryFact?(fact: ConversationTelemetryFact): void;
  emitSessionActivity?(activity: { sessionId: string; state: "running" | "idle" }): void;
  emitLocalTtftFacts?(facts: import("@zcode/shared").LocalTtftFacts): void;
  /** 当前进程 live request_access 权限事实；不缓存、不进入 topic replay。 */
  emitCuaPermissionObservation?(observation: CuaPermissionObservation): void;
  /**
   * sessions-index：会话 → 所属 workspaceId（列表 topic 的分桶键）。
   * 未实现（旧宿主）→ sessions-index 路径整体不激活（no-op），不影响 conversation。
   */
  getSessionWorkspaceId?(sessionId: string): string | null;
  /** sessions-index：会话的列表用元信息（createdAt/父会话/最后活动时刻）。 */
  getSessionIndexMeta?(sessionId: string): {
    createdAt: number;
    lastActivityAt: number;
    parentSessionId?: string;
  } | null;
  /**
   * config 种子：会话 runtime 的当前真值（模型选型/思考深度/协作模式）。
   * 投影初值不能写死空值——runtime 的启动默认模型、项目持久化 mode 偏好、历史会话
   * resume 恢复的上次选型都只活在 runtime 里（ModelSelected 仅在 switchModelConfig 后
   * 补发，日志里可能根本没有），种子是它们进投影的唯一通道。
   * 会话不在册返回 null（gateway 跳过，保持空初值）；未实现（旧宿主/测试桩）同。
   */
  getSessionConfigSeed?(sessionId: string): SessionConfigSeed | null;
  /** 只读会话创建期 App 开关，不读取实时设置或推断 Memory 工具使用。 */
  getSessionMemoryEnabled?(sessionId: string): boolean | undefined;
  /**
   * 冷恢复 usage 种子：transcript 合成路径可能只能生成 0/默认窗口的占位
   * ModelComplete；宿主可从持久化 assistant tokens / runtime snapshot 提供真实水位。
   * 未实现时保持事件日志归约结果。
   */
  getSessionUsageSeed?(
    sessionId: string,
    persistedMessages?: MessageWithParts[],
  ): Promise<SessionUsageSeed | null> | SessionUsageSeed | null;
  /** sessions-index：某 workspace 下当前在册的会话 id（冷启动 snapshot 用）。 */
  listWorkspaceSessionIds?(workspaceId: string): string[];
  /**
   * sessions-index：draft 判定——deferred 持久化且未发首条输入的会话不进列表。
   * 旧 workspace prepare 路径会预建 deferred 会话（历史上列表读 sqlite、
   * deferred 不落盘故不可见）；sessions-index 从活注册表派生后这些幽灵 draft 会
   * 以「新任务」出现在侧栏。首条 sendText 把 persistence 提升为 immediate 后，
   * 事件流自然触发 fanOutToIndex 使会话入列。未实现（旧宿主/测试桩）→ 不过滤。
   */
  isDraftSession?(sessionId: string): boolean;
  /**
   * sessions-index：从持久化 store 直接构造某 workspace 全部会话的轻量摘要（冷启动种子）。
   * 未加载（无 live publisher）的会话靠它进列表；已加载的会话由 gateway 用 live 投影覆盖。
   * store 读取是异步的，故允许返回 Promise（gateway 订阅时 await；同步 stub 直接返回数组）。
   */
  getStoredSessionSummaries?(workspaceId: string): Promise<SessionSummary[]> | SessionSummary[];
  /**
   * 3.3.6 远端历史兼容：用精确 task allowlist 幂等认领后返回严格 identity 摘要。
   * 非远端 workspace 返回 null；失败可降级为空数组，后续携带 allowlist 的订阅会重试。
   */
  refreshLegacySessionSummaries?(
    workspaceId: string,
    legacyTaskIds: readonly string[],
  ): Promise<SessionSummary[] | null> | SessionSummary[] | null;
  /**
   * workspace-config：某 workspace 的配置目录（config options + slash 命令）。
   * 订阅时的种子与 invalidateWorkspaceConfig 重拉都走这里。
   * 未实现（旧宿主 / 测试桩）→ workspace-config 路径退化为空目录快照。
   */
  getWorkspaceConfig?(
    workspaceId: string,
  ): Promise<WorkspaceConfigState | null> | WorkspaceConfigState | null;
  readBackgroundBashOutput?(sessionId: string, workId: string): Promise<BackgroundBashOutputResult>;
  /** 执行 accepted 命令的副作用；返回值进 ACK.result（fork/createSession 带 sessionId）。 */
  executeCommand(
    envelope: CommandEnvelope,
    admission?: { admissionSeq: number; admittedAt: number; queueItemId: string },
  ): Promise<CommandResult | undefined>;
  /** 输入命令执行前先落 durable admission；返回同一份完整 intent 供 inbox pin。 */
  admitCommandInput?(
    envelope: CommandEnvelope,
    admission: { admissionSeq: number; admittedAt: number; queueItemId: string },
  ): Promise<ConversationInputIntent | null>;
  cancelCommandInput?(
    envelope: CommandEnvelope,
    queueItemId: string,
    reason: string,
  ): Promise<void>;
  /** projection 运行中越过 16MiB 时终止当前 turn；同一 fault 周期由 gateway 保证只调用一次。 */
  terminateTurnForProjectionFault?(
    sessionId: string,
    reasonCode: "proto.payloadTooLarge",
  ): Promise<void> | void;
  /** commands/query 持久化 fallback；四个来源必须按 sourceCommandId 精确命中。 */
  lookupTranscriptCommand?(key: CommandKey): Promise<CommandAck | null> | CommandAck | null;
  lookupTimelineCommand?(key: CommandKey): Promise<CommandAck | null> | CommandAck | null;
  lookupChildCommand?(key: CommandKey): Promise<CommandAck | null> | CommandAck | null;
  lookupDiscardedCommand?(key: CommandKey): Promise<CommandAck | null> | CommandAck | null;
  /** transcript 原子 promotion 后同步失效旧 lazy seed，再解除 CommandInbox live pin。 */
  invalidatePersistentCommandFacts?(sessionId: string): void;
  /** canonical goal complete 已进入 projection；宿主副作用必须 detached，禁止阻塞 ingest。 */
  onTargetCompleted?(sessionId: string, event: SessionEvent): void;
  /** 完整 chunk transaction commit 后一次性写 session artifact。 */
  putSessionAttachment?(
    sessionId: string,
    input: { fileName: string; mime: string; bytes: Uint8Array },
  ): Promise<{ ref: string }>;
  /** 已发送 image/video/PDF 只读查询；gateway 完成 row/ref 授权后才允许进入宿主。 */
  readSessionAttachment?(
    sessionId: string,
    input: {
      ref: string;
      mime: string;
      maxBytes: number;
      messageId?: string;
      attachmentIndex?: number;
    },
  ): Promise<{ bytes: Uint8Array; mediaType: string }>;
  /** Share 选择阶段的 userInput 附件 metadata stat；gateway 先完成 row/index 授权。 */
  statSessionAttachment?(
    sessionId: string,
    input: {
      ref: string;
      mime: string;
      messageId?: string;
      attachmentIndex?: number;
    },
  ): Promise<{ totalBytes: number; mediaType: string; mtimeMs?: number }>;
  /** Desktop local 已发送视频路径；gateway 完成 row/index 授权后才允许进入宿主。 */
  resolveSessionAttachmentPreviewSource?(
    sessionId: string,
    input: {
      ref: string;
      mime: string;
      messageId?: string;
      attachmentIndex?: number;
    },
  ): Promise<V4AttachmentPreviewSourceResult>;
  getConversationFileChanges?(
    sessionId: string,
    targetRowId: number,
    messageIds: string[],
    targetTurnId: TurnId | null,
  ): Promise<V4ConversationFileChangesResult>;
  previewConversationFileRewind?(
    sessionId: string,
    targetRowId: number,
    messageIds: string[],
    targetTurnId: TurnId | null,
  ): Promise<V4ConversationFileRewindPreviewResult>;
  /**
   * workflow run 的事件日志分页（详情页审计面）。缺席 = 该会话 runtime 没有这个能力
   * （dwf journal 不可用 → run service 整个没构造），gateway 据此回结构化能力不支持错误。
   */
  listDynamicWorkflowRunEvents?(
    sessionId: string,
    input: { runId: string; afterSequence?: number; limit?: number },
  ): Promise<DynamicWorkflowRunEvent[]>;
  /**
   * dwf run 的枚举面（重启后的发现查询）。
   * 缺席条件同 {@link listDynamicWorkflowRunEvents}。
   */
  listDynamicWorkflowRuns?(
    sessionId: string,
    input: { limit?: number },
  ): Promise<DynamicWorkflowRunSessionSummary[]>;
  /**
   * workflow run 的**用户面产物**读面。三条一起在场、
   * 一起缺席（app 侧同一个条件注册）。缺席条件同 {@link listDynamicWorkflowRunEvents}。
   *
   * ⚠ 术语：artifact = 脚本经 `artifact.*` 发布给用户看的产出，不是 run 的顶层返回值。
   */
  listDynamicWorkflowRunArtifacts?(
    sessionId: string,
    input: { runId: string },
  ): Promise<readonly DynamicWorkflowRunArtifact[] | undefined>;
  listDynamicWorkflowRunArtifactItems?(
    sessionId: string,
    input: { runId: string; artifactId: string; afterSequence?: number; limit: number },
  ): Promise<readonly DynamicWorkflowRunArtifactItem[]>;
  readDynamicWorkflowRunArtifact?(
    sessionId: string,
    input: { runId: string; artifactId: string; version: number },
  ): Promise<DynamicWorkflowRunArtifactBytes | undefined>;
  /**
   * workflow run 的工作区 transcript：两条一起在场、
   * 一起缺席。授权在宿主侧（run 属于本会话）；拒绝与未知都回 `undefined`。
   */
  listDynamicWorkflowRunWorkspaceNodes?(
    sessionId: string,
    input: { runId: string },
  ): Promise<readonly DynamicWorkflowRunWorkspaceNode[] | undefined>;
  readDynamicWorkflowRunNodeResult?(
    sessionId: string,
    input: { runId: string; siteId: string; ordinal: number; maxBytes: number },
  ): Promise<DynamicWorkflowRunWorkspaceNodeResult | undefined>;
  /**
   * hydration：读取 session 的持久化事件用于冷订阅重建投影（fork child / resume /
   * app-restart）。`synthesized=true` 表示事件日志覆盖不了 transcript，events 是从
   * transcript 反向合成的——此时即便已有 cold publisher（fork resume 的 ingest 抢先
   * 建的）也要**重建**，否则历史不进投影。`synthesized=false`（完整事件日志）则保留
   * 已有 live publisher（流式不能被重建打断）。未实现（旧宿主）冷订阅退化为空投影。
   */
  loadPersistedEvents?(
    sessionId: string,
    persistedMessages?: MessageWithParts[],
  ): Promise<PersistedEventsLoadResult>;
  /** 仅用于低频生命周期和恢复裁决；高频 event/stream trace 禁止走生产日志。 */
  onDebug?(message: string): void;
  onError?(scope: string, error: unknown, context?: V4GatewayErrorContext): void;
}

export interface ConversationV4GatewayOptions {
  now?: () => number;
  /** logEpoch 生成器（默认进程内随机；测试注入固定值保证确定性）。 */
  createLogEpoch?: (sessionId: string) => string;
}

export interface FlushState {
  sessionId: string;
  topic: string;
  subscriptionId: string;
  connectionId: string;
  deliveryProfile: "continuous" | "replayable";
  flushWindowMs: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface HydrationBuffer {
  cancelled: boolean;
  eventIds: Set<string>;
  rawEvents: SessionEvent[];
}

export interface RawSequenceState {
  /** 已经由 cold snapshot 或 live replay 消费的 runtime raw cursor。 */
  sourceEventSeq: number;
  /** transportSeq = rawSeq + offset；遇到 sequence=0 时会向前校正。 */
  offset: number;
  lastTransportSeq: number;
  seenEventIds: Set<string>;
  /** publisher 已成功 apply 的 event；runtime sink 已看见但仍在 gap buffer 的不在此集合。 */
  appliedEventIds: Set<string>;
  /** publisher apply 失败事实；临时 sink 迟到注册 waiter 时也必须立即 reject。 */
  failedEventById: Map<string, Error>;
  /** notify sink 可乱序；只有从 sourceEventSeq+1 连续时才可向投影 drain。 */
  pendingByRawSeq: Map<number, SessionEvent>;
  /** synthesized hydration 重建投影时，补回持久读取边界之后已经到达的 raw 事实。 */
  recentRawEventsById: Map<string, SessionEvent>;
}

export interface ProjectionEventCommitWaiter {
  resolve(): void;
  reject(error: Error): void;
}
export const MAX_TELEMETRY_EVENT_IDS = 2_000;
export const PROJECTION_EVENT_COMMIT_TIMEOUT_MS = 25_000;
/** detached subagent child 终态后无订阅者时，publisher 由低频 tick 释放前的保留时长。 */
export const DETACHED_CHILD_PUBLISHER_GRACE_MS = 120_000;

export class ProjectionEventCommitWaitError extends Error {
  constructor(
    readonly reasonCode:
      | "fault.projectionEventCommit.aborted"
      | "fault.projectionEventCommit.applyFailed"
      | "fault.projectionEventCommit.disposed"
      | "fault.projectionEventCommit.gatewayDisposed"
      | "fault.projectionEventCommit.rehydrated"
      | "fault.projectionEventCommit.timeout",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProjectionEventCommitWaitError";
  }
}

/**
 * server 内部分派结果：initial frame 只供 request-scoped post-response outbox
 * 消费，公共 JSON-RPC result schema 始终严格为 `{ ack }`。
 */
export interface V4SubscribeDispatchResult<TFrame> {
  ack: SubscribeAck & { openTiming?: ConversationOpenTiming };
  initialFrame: TFrame | null;
  initialWires: RoutedTopicWireFrame[];
  commit(): boolean;
}

export function encodeReservedTopicFrame(
  reservation: TopicFrameReservation<RoutedTopicFrame>,
): RoutedTopicWireFrame[] {
  return encodeTopicWireFrames(reservation.frame, {
    deliveryKind: reservation.deliveryKind,
    topic: reservation.frame.topic,
    subscriptionId: reservation.frame.subscriptionId,
    logicalFrameId: reservation.logicalFrameId,
    logicalFrameOrdinal: reservation.logicalFrameOrdinal,
    measurePhysicalFrameBytes: (wire) => measureTopicNotificationEnvelopeBytes(wire).maxBytes,
  }) as RoutedTopicWireFrame[];
}

export function subscriptionRouteKey(
  topic: string,
  subscriptionId: string,
  connectionId: string,
): string {
  return `${topic}\0${subscriptionId}\0${connectionId}`;
}

export function defaultLogEpoch(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function artifactRefBelongsToSession(ref: string, sessionId: string): boolean {
  return ref.startsWith(`zcode-artifact://${encodeURIComponent(sessionId)}/`);
}

/** 附件在文件系统层「确定不存在」的错误码集合。 */
const MISSING_ATTACHMENT_FS_CODES = new Set<FileSystemErrorCode>([
  "not_found",
  "is_directory",
  "not_file",
]);

/**
 * 把 host / FileSystemPort 抛出的错误归一成带稳定码的附件 fault。
 * host 已经给出结构化 fault 码时原样透传，其余按 FileSystemPortError.code 判定；
 * 都不匹配则保持原错误，让上层按「未知」处理，而不是猜成确定分类。
 */
export function toShareStatFault(error: unknown): unknown {
  if (readZCodeAttachmentFaultCode(error)) return error;
  if (isFileSystemPortError(error) && MISSING_ATTACHMENT_FS_CODES.has(error.code)) {
    return new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.shareStatNotFound, {
      cause: error,
    });
  }
  return error;
}
