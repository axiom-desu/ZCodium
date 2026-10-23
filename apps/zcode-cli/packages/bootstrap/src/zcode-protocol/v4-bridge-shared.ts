import type { CollaborationMode, Logger, ModelSelection } from "@zcode/contracts";
import type { SessionSummary } from "@zcode/shared/zcode-protocol-v4";
import type { V4CommandCoreHost } from "../zcode-protocol-v4/commands/types.js";
import type { V4CommandExecutor } from "../zcode-protocol-v4/commands/executor.js";
import type { ConversationV4Gateway } from "../zcode-protocol-v4/v4-gateway.js";
import type { PersistentCommandIndex } from "../zcode-protocol-v4/persistent-command-index.js";
import type {
  ZCodeProtocolAgentServerContext,
  ZCodeProtocolSessionRecord,
} from "./server-types.js";

export interface V4BridgeBasePorts {
  readonly context: ZCodeProtocolAgentServerContext;
  readonly log: Logger | undefined;
  readonly persistentCommands: PersistentCommandIndex;
}

export interface V4AutoDrainPort {
  /** 队首提升到空即收敛外层 FIFO；busy/held 时只重排重试。 */
  autoDrainV4QueueIfReady(record: ZCodeProtocolSessionRecord): Promise<void>;
  scheduleAutoDrainRetry(record: ZCodeProtocolSessionRecord): void;
}

export interface V4StoredSummariesPort {
  loadStoredSessionSummaries(
    workspaceId: string,
    legacyTaskIds?: readonly string[],
  ): Promise<SessionSummary[]>;
}

export interface V4BridgeRuntimePorts extends V4BridgeBasePorts {
  readonly coreHost: V4CommandCoreHost;
  readonly autoDrain: V4AutoDrainPort;
  readonly summaries: V4StoredSummariesPort;
  /** executor 由 coreHost 构造出来，命令入口闭包按调用时取用，避免构造期自引用。 */
  getNativeExecutor(): V4CommandExecutor;
}

/** Gateway 构造参数就是这些 hook 的唯一契约面。 */
export type V4GatewayOptions = ConstructorParameters<typeof ConversationV4Gateway>[0];
const STABLE_FORK_MODES = new Set<CollaborationMode>(["plan", "build", "edit", "yolo", "auto"]);

export function stableForkMode(value: string, fallback: CollaborationMode): CollaborationMode {
  return STABLE_FORK_MODES.has(value as CollaborationMode)
    ? (value as CollaborationMode)
    : fallback;
}

export function modelSelectionWithOptionFallback(
  selection: ModelSelection | undefined,
  fallback: ModelSelection | undefined,
): ModelSelection | undefined {
  if (!selection) return fallback && cloneModelSelection(fallback);
  // 兼容旧 fork 消息可能缺少 reasoning；输出预算属于单次请求，不属于 Selection。
  const reasoningLevel = selection.options?.reasoningLevel ?? fallback?.options?.reasoningLevel;
  return {
    providerId: selection.providerId,
    modelId: selection.modelId,
    ...(reasoningLevel !== undefined ? { options: { reasoningLevel } } : {}),
  };
}

export function cloneModelSelection(
  selection: ReturnType<ZCodeProtocolSessionRecord["app"]["runtime"]["getSessionModelSelection"]>,
): ModelSelection | undefined {
  if (!selection) return undefined;
  return {
    providerId: selection.providerId,
    modelId: selection.modelId,
    ...(selection.options ? { options: { ...selection.options } } : {}),
  };
}
