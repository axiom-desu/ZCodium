import type {
  ToolCallScheduledPayload,
  ToolCallStartedPayload,
  ToolCallResultPayload,
  ToolCallErrorPayload,
  ToolBatchCompletePayload,
  BackgroundTaskStartedPayload,
  BackgroundTaskUpdatedPayload,
  BackgroundTaskCompletedPayload,
  PermissionRequestedPayload,
  PermissionResolvedPayload,
  PermissionDeniedPayload,
} from "../session.events.js";
import { SessionEventType as EventTypes } from "../session.events.js";
import type { ActiveToolCall, PendingPermission } from "../../interfaces/session.port.js";
import {
  applyBackgroundTaskCompleted,
  applyBackgroundTaskStarted,
  applyBackgroundTaskUpdated,
} from "../event-reducer-helpers.js";
import type { EventHandlerTable } from "./types.js";

export const tool_permissionsHandlers: EventHandlerTable = {
  [EventTypes.ToolCallScheduled]: (p, e) => {
    const payload = e.payload as ToolCallScheduledPayload;
    const newToolCall: ActiveToolCall = {
      toolCallId: payload.toolCallId,
      toolName: payload.toolName,
      status: "pending",
    };
    return {
      ...p,
      activeToolCalls: [...p.activeToolCalls, newToolCall],
      updatedAt: e.timestamp,
    };
  },

  [EventTypes.ToolCallStarted]: (p, e) => {
    const payload = e.payload as ToolCallStartedPayload;
    return {
      ...p,
      activeToolCalls: p.activeToolCalls.map((tc) =>
        tc.toolCallId === payload.toolCallId
          ? { ...tc, status: "running", startedAt: payload.startedAt }
          : tc,
      ),
      updatedAt: e.timestamp,
    };
  },

  [EventTypes.ToolCallResult]: (p, e) => {
    const payload = e.payload as ToolCallResultPayload;
    return {
      ...p,
      activeToolCalls: p.activeToolCalls.map((tc) =>
        tc.toolCallId === payload.toolCallId
          ? { ...tc, status: payload.result.success ? "completed" : "failed" }
          : tc,
      ),
      updatedAt: e.timestamp,
    };
  },

  [EventTypes.ToolCallError]: (p, e) => {
    const payload = e.payload as ToolCallErrorPayload;
    return {
      ...p,
      activeToolCalls: p.activeToolCalls.map((tc) =>
        tc.toolCallId === payload.toolCallId ? { ...tc, status: "failed" } : tc,
      ),
      updatedAt: e.timestamp,
    };
  },

  [EventTypes.ToolBatchComplete]: (p, e) => {
    const payload = e.payload as ToolBatchCompletePayload;
    const activeToolCalls = p.activeToolCalls.filter(
      (tc) => !payload.toolCallIds.includes(tc.toolCallId as any),
    );
    return {
      ...p,
      activeToolCalls,
      // a tool batch can finish before the turn makes its follow-up model request.
      // Only turn_complete moves the session projection back to idle.
      updatedAt: e.timestamp,
    };
  },

  [EventTypes.BackgroundTaskStarted]: (p, e) => {
    const payload = e.payload as BackgroundTaskStartedPayload;
    return applyBackgroundTaskStarted(p, payload, e.timestamp);
  },

  [EventTypes.BackgroundTaskUpdated]: (p, e) => {
    const payload = e.payload as BackgroundTaskUpdatedPayload;
    return applyBackgroundTaskUpdated(p, payload, e.timestamp);
  },

  [EventTypes.BackgroundTaskCompleted]: (p, e) => {
    const payload = e.payload as BackgroundTaskCompletedPayload;
    return applyBackgroundTaskCompleted(p, payload, e.timestamp);
  },

  [EventTypes.PermissionRequested]: (p, e) => {
    const payload = e.payload as PermissionRequestedPayload;
    const newPending: PendingPermission = {
      input: payload.input,
      reason: payload.reason,
      requestId: payload.requestId,
      toolCallId: payload.toolCallId,
      toolName: payload.toolName,
      ...(payload.suggestedPermissionUpdates
        ? { suggestedPermissionUpdates: payload.suggestedPermissionUpdates }
        : {}),
      ...(payload.origin ? { origin: payload.origin } : {}),
      ...(payload.display ? { display: payload.display } : {}),
      ...(payload.optionsPolicy ? { optionsPolicy: payload.optionsPolicy } : {}),
      riskLevel: payload.riskLevel,
      requestedAt: e.timestamp,
    };
    return {
      ...p,
      pendingPermissions: [...p.pendingPermissions, newPending],
      updatedAt: e.timestamp,
    };
  },

  [EventTypes.PermissionResolved]: (p, e) => {
    const payload = e.payload as PermissionResolvedPayload;
    let toolStatus: ActiveToolCall["status"] = "completed";
    if (payload.decision === "deny") {
      toolStatus = "denied";
    }

    return {
      ...p,
      pendingPermissions: p.pendingPermissions.filter((pp) => pp.toolCallId !== payload.toolCallId),
      activeToolCalls: p.activeToolCalls.map((tc) =>
        tc.toolCallId === payload.toolCallId ? { ...tc, status: toolStatus } : tc,
      ),
      updatedAt: e.timestamp,
    };
  },

  [EventTypes.PermissionDenied]: (p, e) => {
    const payload = e.payload as PermissionDeniedPayload;
    return {
      ...p,
      pendingPermissions: p.pendingPermissions.filter((pp) => pp.toolCallId !== payload.toolCallId),
      activeToolCalls: p.activeToolCalls.map((tc) =>
        tc.toolCallId === payload.toolCallId ? { ...tc, status: "denied" } : tc,
      ),
      updatedAt: e.timestamp,
    };
  },
};
