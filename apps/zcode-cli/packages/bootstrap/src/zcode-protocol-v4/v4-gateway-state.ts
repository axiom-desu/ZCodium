import { LocalTtftRecorder } from "./local-ttft.js";
import { localTtftNow, localTtftFactsSchema } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationTopicPublisher } from "./conversation-topic-publisher.js";
import { AttachmentUploadRegistry } from "./attachment-upload-registry.js";
import { BinaryReadCache } from "./binary-read-cache.js";
import { ColdSessionResumeCoordinator } from "./cold-session-resume.js";
import { CommandInbox } from "./command-inbox.js";
import { ConversationTelemetryFactNormalizer } from "./conversation-telemetry-facts.js";
import { CuaPermissionObservationNormalizer } from "./cua-permission-observation.js";
import { SessionsIndexFanoutThrottle } from "./sessions-index-fanout-throttle.js";
import { SessionsIndexPublisherRegistry } from "./sessions-index-publisher-registry.js";
import { WorkspaceConfigPublisher } from "./workspace-config-publisher.js";
import { PROTOCOL_V4_LIMITS } from "@zcode/shared/zcode-protocol-v4";
import {
  defaultLogEpoch,
  rowTargetActionForCommand,
  type ConversationV4GatewayOptions,
  type FlushState,
  type HydrationBuffer,
  type ProjectionEventCommitWaiter,
  type RawSequenceState,
  type V4GatewayHost,
} from "./v4-gateway-contract.js";
import { createFileQueries } from "./v4-gateway-file-queries.js";
import { createWorkflowQueries } from "./v4-gateway-workflow-queries.js";
import { publishCurrentSummaryToIndex } from "./v4-gateway-index-config.js";
import {
  ensureHostRecordForJournalRead,
  hasLiveConversation,
  resolveQueryPublisher,
} from "./v4-gateway-hydration.js";

/** Root-owned runtime context. Every map/cache/host reference exists exactly once here. */
export interface GatewayState {
  host: V4GatewayHost;
  now: () => number;
  createLogEpoch: (sessionId: string) => string;
  publishers: Map<string, ConversationTopicPublisher>;
  indexPublishers: SessionsIndexPublisherRegistry;
  configPublishers: Map<string, WorkspaceConfigPublisher>;
  hydratedSessions: Set<string>;
  hydrationInFlight: Map<string, Promise<ConversationTopicPublisher>>;
  readyFlights: Map<string, Promise<ConversationTopicPublisher>>;
  hydrationBuffers: Map<string, HydrationBuffer>;
  rawSequenceStates: Map<string, RawSequenceState>;
  projectionEventCommitWaiters: Map<string, Map<string, Set<ProjectionEventCommitWaiter>>>;
  detachedLiveSessions: Set<string>;
  detachedChildParent: Map<string, string>;
  detachedChildrenByParent: Map<string, Set<string>>;
  detachedTerminalAt: Map<string, number>;
  coldResume: ColdSessionResumeCoordinator;
  flushStates: Map<string, FlushState>;
  controlReservations: WeakSet<object>;
  pausedConnections: Set<string>;
  projectionFaultedSessions: Set<string>;
  inbox: CommandInbox;
  attachmentUploads: AttachmentUploadRegistry;
  binaryReadCache: BinaryReadCache;
  workflowQueries: ReturnType<typeof createWorkflowQueries>;
  fileQueries: ReturnType<typeof createFileQueries>;
  localTtft: LocalTtftRecorder;
  indexFanoutThrottle: SessionsIndexFanoutThrottle;
  attachmentPruneTimer: ReturnType<typeof setInterval>;
  telemetryNormalizer: ConversationTelemetryFactNormalizer;
  telemetryEventIds: Set<string>;
  cuaPermissionNormalizer: CuaPermissionObservationNormalizer;
  disposed: boolean;
}

/**
 * 组装唯一运行态。构造顺序与旧网关构造函数/字段初始化保持一致：cache、inbox、
 * uploads、定时器都只在这里创建一次，领域模块只接收这些引用，不复制 owner。
 */
export function createGatewayState(
  host: V4GatewayHost,
  options: ConversationV4GatewayOptions,
): GatewayState {
  const ctx = { host } as GatewayState;
  ctx.publishers = new Map();
  ctx.indexPublishers = new SessionsIndexPublisherRegistry();
  ctx.configPublishers = new Map();
  ctx.hydratedSessions = new Set();
  ctx.hydrationInFlight = new Map();
  ctx.readyFlights = new Map();
  ctx.hydrationBuffers = new Map();
  ctx.rawSequenceStates = new Map();
  ctx.projectionEventCommitWaiters = new Map();
  ctx.detachedLiveSessions = new Set();
  ctx.detachedChildParent = new Map();
  ctx.detachedChildrenByParent = new Map();
  ctx.detachedTerminalAt = new Map();
  ctx.flushStates = new Map();
  ctx.controlReservations = new WeakSet();
  ctx.pausedConnections = new Set();
  ctx.projectionFaultedSessions = new Set();
  ctx.localTtft = new LocalTtftRecorder(
    localTtftNow,
    () => {
      ctx.host.onError?.(
        "v4.localTtft.completedCapacity",
        new Error("TTFT completed record capacity exceeded"),
      );
    },
    (facts) => {
      const parsed = localTtftFactsSchema.safeParse(facts);
      if (parsed.success) ctx.host.emitLocalTtftFacts?.(parsed.data);
    },
  );
  ctx.indexFanoutThrottle = new SessionsIndexFanoutThrottle({
    publish: (sessionId) => publishCurrentSummaryToIndex(ctx, sessionId),
  });
  ctx.telemetryNormalizer = new ConversationTelemetryFactNormalizer();
  ctx.telemetryEventIds = new Set();
  ctx.cuaPermissionNormalizer = new CuaPermissionObservationNormalizer();
  ctx.disposed = false;
  ctx.now = options.now ?? Date.now;
  ctx.createLogEpoch = options.createLogEpoch ?? defaultLogEpoch;
  ctx.coldResume = new ColdSessionResumeCoordinator(host);
  ctx.binaryReadCache = new BinaryReadCache({
    now: ctx.now,
    readSessionAttachment: host.readSessionAttachment
      ? (sessionId, input) => host.readSessionAttachment!(sessionId, input)
      : undefined,
    readDynamicWorkflowRunArtifact: host.readDynamicWorkflowRunArtifact
      ? (sessionId, input) => host.readDynamicWorkflowRunArtifact!(sessionId, input)
      : undefined,
  });
  ctx.workflowQueries = createWorkflowQueries({
    host,
    ensureHostRecord: (sessionId) => ensureHostRecordForJournalRead(ctx, sessionId),
    binaryReadCache: ctx.binaryReadCache,
  });
  ctx.fileQueries = createFileQueries({
    host,
    resolveLivePublisher: (sessionId) =>
      resolveQueryPublisher(ctx, sessionId, hasLiveConversation(ctx, sessionId)),
    resolveSessionPublisher: (sessionId) =>
      resolveQueryPublisher(ctx, sessionId, host.sessionExists(sessionId)),
  });
  ctx.inbox = new CommandInbox({
    getRevision: (sessionId) => {
      if (!host.sessionExists(sessionId)) return null;
      // 已知会话但尚无事件 → 投影未建，revision 视为 0（draft 起点）。
      return ctx.publishers.get(sessionId)?.getSnapshot().revision ?? 0;
    },
    getLogEpoch: (sessionId) => ctx.publishers.get(sessionId)?.getSnapshot().logEpoch ?? null,
    validateRowTarget: (envelope) => {
      const action = rowTargetActionForCommand(envelope.type);
      if (!action || envelope.sessionId === null) return { verdict: "allow" };
      const target = (envelope.payload as { target?: { rowId: number; entityId: string } }).target;
      if (!target) return { verdict: "reject", reasonCode: "proto.invalidPayload" };
      const resolution = ctx.publishers
        .get(envelope.sessionId)
        ?.resolveRowActionTarget(target, action);
      if (!resolution) return { verdict: "stale", reasonCode: "proto.staleTarget" };
      if (resolution.ok) return { verdict: "allow" };
      return resolution.status === "stale"
        ? { verdict: "stale", reasonCode: resolution.reasonCode }
        : { verdict: "reject", reasonCode: resolution.reasonCode };
    },
    lookupTranscriptCommand: (key) => host.lookupTranscriptCommand?.(key) ?? null,
    lookupTimelineCommand: (key) => host.lookupTimelineCommand?.(key) ?? null,
    lookupChildCommand: (key) => host.lookupChildCommand?.(key) ?? null,
    lookupDiscardedCommand: (key) => host.lookupDiscardedCommand?.(key) ?? null,
    now: ctx.now,
  });
  ctx.attachmentUploads = new AttachmentUploadRegistry({
    now: ctx.now,
    putSessionAttachment: async (sessionId, input) => {
      if (!host.putSessionAttachment) {
        throw new Error("fault.attachment.putUnsupported");
      }
      return host.putSessionAttachment(sessionId, input);
    },
  });
  ctx.attachmentPruneTimer = setInterval(
    () => ctx.attachmentUploads.pruneExpired(),
    Math.min(30_000, PROTOCOL_V4_LIMITS.attachmentUploadTtlMs),
  );
  (ctx.attachmentPruneTimer as ReturnType<typeof setInterval> & { unref?: () => void }).unref?.();
  return ctx;
}
