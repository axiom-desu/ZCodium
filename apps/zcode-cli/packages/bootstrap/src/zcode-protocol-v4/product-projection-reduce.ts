import type {
  PluginUiAppToolCallRequestedPayload,
  PluginUiResourceListChangedPayload,
  PluginUiResourceUpdatedPayload,
} from "@zcode/contracts";
import { SessionEventType } from "@zcode/contracts";
import { isZCodeModelRetryRecoveryProgressPayload } from "@zcode/shared";
import type { ProjectionState } from "./product-projection-state.js";
import type { ConversationDelta } from "@zcode/shared/zcode-protocol-v4";
import type { CanonicalConversationFact } from "./event-normalizer.js";
import {
  onRewindTriggered,
  onSessionCreated,
  onSessionForked,
  onSessionModeChanged,
  onSessionResumed,
  onSessionTitleUpdated,
} from "./product-projection-sessions.js";
import { onTurnError, onTurnStarted } from "./product-projection-turns.js";
import { onTurnComplete } from "./product-projection-turn-segments.js";
import {
  flushPendingSessionHookInvocations,
  onHookRunLifecycle,
} from "./product-projection-hook-lifecycle.js";
import {
  onPermissionDenied,
  onPermissionRequested,
  onPermissionResolved,
  onUserInputAutoResolutionUpdated,
  onWorkspaceHookAdmissionUpdated,
  onWorkspaceHookReviewRequested,
  onWorkspaceHookReviewSettled,
  onWorkspaceHookReviewSuperseded,
} from "./product-projection-permissions.js";
import {
  onFollowupModeChanged,
  onQueueAutoDrainChanged,
  onTurnSteerDeliveryChanged,
  onTurnSteerDispatchChanged,
  onTurnSteerQueued,
  onTurnSteerReordered,
} from "./product-projection-queue.js";
import {
  onSessionInputPromoted,
  onTurnSteerDiscarded,
  onTurnSteerDrained,
} from "./product-projection-steer.js";
import {
  onToolCallActivity,
  onToolCallError,
  onToolCallProgress,
  onToolCallResult,
  onToolCallScheduled,
} from "./product-projection-tools.js";
import { onModelComplete, onModelSelected, onModelStreaming } from "./product-projection-model.js";
import {
  acceptsActiveModelEvent,
  onModelNetworkStatus,
  onStreamRecoveryRetryStarted,
  onStreamRecoveryStarted,
  onStreamRecoveryTailDiscarded,
  setApiRetry,
} from "./product-projection-stream-recovery.js";
import { onCompactLifecycle } from "./product-projection-compact.js";
import { onTargetChanged, onTargetVerification } from "./product-projection-targets.js";
import {
  onSubagentMessage,
  onSubagentSpawned,
  onSubagentStopped,
} from "./product-projection-subagents.js";
import {
  onBackgroundTaskLifecycle,
  onDynamicWorkflowRunProgress,
} from "./product-projection-subagent-tasks.js";

export function reduce(
  state: ProjectionState,
  fact: CanonicalConversationFact,
): ConversationDelta[] {
  const event = fact.event;
  switch (event.type) {
    case SessionEventType.SessionCreated:
      return onSessionCreated(state, event);
    case SessionEventType.SessionResumed:
      return onSessionResumed(state, event);
    case SessionEventType.SessionTitleUpdated:
      return onSessionTitleUpdated(state, event);
    case SessionEventType.TurnStarted:
      if (fact.semanticKind !== "userIntent") return [];
      return [
        ...onTurnStarted(state, fact),
        // model-only 维护 turn（manual /compact、goal continuation）没有资格
        // 承载 SessionStart 摘要；pending 保持到下一条 user-visible 真实 turn。
        ...(state.currentTurnStartedModelOnly
          ? []
          : flushPendingSessionHookInvocations(state, fact.productTurnId)),
      ];
    case SessionEventType.ModelStreaming: {
      if (fact.semanticKind !== "assistantSegment") return [];
      const shouldClearApiRetry =
        acceptsActiveModelEvent(state, event) &&
        isZCodeModelRetryRecoveryProgressPayload(
          event.payload as unknown as Record<string, unknown>,
        );
      const streamingDeltas = onModelStreaming(state, fact);
      return shouldClearApiRetry
        ? [...streamingDeltas, ...setApiRetry(state, null)]
        : streamingDeltas;
    }
    case SessionEventType.ModelNetworkStatus:
      return onModelNetworkStatus(state, event);
    case SessionEventType.StreamRecoveryStarted:
      return onStreamRecoveryStarted(state, event);
    case SessionEventType.StreamRecoveryTailDiscarded:
      return onStreamRecoveryTailDiscarded(state, event);
    case SessionEventType.StreamRecoveryRetryStarted:
      return onStreamRecoveryRetryStarted(state, event);
    case SessionEventType.ModelSelected:
      return onModelSelected(state, event);
    case SessionEventType.ModelComplete:
      return onModelComplete(state, event);
    case SessionEventType.ToolCallScheduled:
      return onToolCallScheduled(state, event);
    case SessionEventType.ToolCallStarted:
      return onToolCallActivity(state, event);
    case SessionEventType.ToolCallProgress:
      return onToolCallProgress(state, event);
    case SessionEventType.ToolCallResult:
      return onToolCallResult(state, event);
    case SessionEventType.ToolCallError:
      return onToolCallError(state, event);
    case SessionEventType.PermissionRequested:
      return onPermissionRequested(state, event);
    case SessionEventType.PermissionResolved:
      return onPermissionResolved(state, event);
    case SessionEventType.PermissionDenied:
      return onPermissionDenied(state, event);
    case SessionEventType.PluginUiResourceUpdated: {
      // live-only，不改快照；renderer 按 subscribers 派发给沙箱实例。
      const payload = event.payload as PluginUiResourceUpdatedPayload;
      return [
        {
          op: "pluginUi.resourceUpdated",
          pluginId: payload.pluginId,
          serverName: payload.serverName,
          uri: payload.uri,
          subscribers: payload.subscribers,
        },
      ];
    }
    case SessionEventType.PluginUiResourceListChanged: {
      const payload = event.payload as PluginUiResourceListChangedPayload;
      return [
        {
          op: "pluginUi.resourceListChanged",
          pluginId: payload.pluginId,
          serverName: payload.serverName,
          subscribers: payload.subscribers,
        },
      ];
    }
    case SessionEventType.PluginUiInstanceClosed: {
      const payload = event.payload as PluginUiResourceListChangedPayload;
      return [{ op: "pluginUi.instanceClosed", ...payload }];
    }
    case SessionEventType.PluginUiAppToolCallRequested: {
      // App-Provided Tools 信箱：live-only，投递给 subscribers 里唯一的实例。
      const payload = event.payload as PluginUiAppToolCallRequestedPayload;
      return [
        {
          op: "pluginUi.appToolCall",
          activity: payload.activity,
          ...(payload.cancelled ? { cancelled: true } : {}),
          pluginId: payload.pluginId,
          serverName: payload.serverName,
          subscribers: payload.subscribers,
          callId: payload.callId,
          toolName: payload.toolName,
          arguments: payload.arguments,
        },
      ];
    }
    case SessionEventType.UserInputAutoResolutionUpdated:
      return onUserInputAutoResolutionUpdated(state, event);
    case SessionEventType.WorkspaceHookReviewRequested:
      return onWorkspaceHookReviewRequested(state, event);
    case SessionEventType.WorkspaceHookReviewSettled:
      return onWorkspaceHookReviewSettled(state, event);
    case SessionEventType.WorkspaceHookReviewSuperseded:
      return onWorkspaceHookReviewSuperseded(state, event);
    case SessionEventType.WorkspaceHookAdmissionUpdated:
      return onWorkspaceHookAdmissionUpdated(event);
    case SessionEventType.HookRunStarted:
    case SessionEventType.HookRunProgress:
    case SessionEventType.HookRunCompleted:
    case SessionEventType.HookRunFailed:
    case SessionEventType.HookRunBlocked:
      return onHookRunLifecycle(state, event);
    case SessionEventType.TurnSteerQueued:
      return onTurnSteerQueued(state, event);
    case SessionEventType.TurnSteerDeliveryChanged:
      return onTurnSteerDeliveryChanged(state, event);
    case SessionEventType.TurnSteerDispatchChanged:
      return onTurnSteerDispatchChanged(state, event);
    case SessionEventType.TurnSteerDrained:
      return onTurnSteerDrained(state, event);
    case SessionEventType.TurnSteerDiscarded:
      return onTurnSteerDiscarded(state, event);
    case SessionEventType.SessionInputPromoted:
      return onSessionInputPromoted(state, event);
    case SessionEventType.TurnSteerReordered:
      return onTurnSteerReordered(state, event);
    case SessionEventType.QueueAutoDrainChanged:
      return onQueueAutoDrainChanged(state, event);
    case SessionEventType.FollowupModeChanged:
      return onFollowupModeChanged(state, event);
    case SessionEventType.SessionModeChanged:
      return onSessionModeChanged(state, event);
    case SessionEventType.TurnComplete:
      return onTurnComplete(state, event);
    case SessionEventType.TurnError:
      return onTurnError(state, event);
    case SessionEventType.CompactStarted:
    case SessionEventType.CompactCompleted:
    case SessionEventType.CompactFailed:
      return onCompactLifecycle(state, event);
    case SessionEventType.TargetChanged:
      return onTargetChanged(state, event);
    case SessionEventType.TargetCompletionVerification:
      return onTargetVerification(state, event);
    case SessionEventType.SessionForked:
      return onSessionForked(state, event);
    case SessionEventType.RewindTriggered:
      return onRewindTriggered(state, event);
    case SessionEventType.BackgroundTaskStarted:
    case SessionEventType.BackgroundTaskUpdated:
    case SessionEventType.BackgroundTaskCompleted:
      return onBackgroundTaskLifecycle(state, event);
    case SessionEventType.DynamicWorkflowRunProgress:
      return onDynamicWorkflowRunProgress(state, event);
    case SessionEventType.SubagentSpawned:
      return onSubagentSpawned(state, event);
    case SessionEventType.SubagentMessage:
      return onSubagentMessage(state, event);
    case SessionEventType.SubagentStopped:
      return onSubagentStopped(state, event);
    default:
      return [];
  }
}
