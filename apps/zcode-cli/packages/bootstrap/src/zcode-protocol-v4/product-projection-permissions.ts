import { PERMISSION_FULL_ACCESS_OPTION_ID } from "@zcode/shared/zcode-protocol-v4";
import type {
  PermissionDeniedPayload,
  PermissionRequestedPayload,
  PermissionResolvedPayload,
  SessionEvent,
  UserInputAutoResolutionUpdatedPayload,
  WorkspaceHookAdmissionUpdatedPayload,
  WorkspaceHookReviewRequestedPayload,
  WorkspaceHookReviewSettledPayload,
  WorkspaceHookReviewSupersededPayload,
} from "@zcode/contracts";
import { AMEND_WORKFLOW_TOOL_NAME, CREATE_WORKFLOW_TOOL_NAME } from "@zcode/contracts";
import { WORKFLOW_REFINE_PERMISSION_OPTION_ID } from "@zcode/shared";
import {
  createExitPlanModeApprovalQuestion,
  isAskUserQuestionToolName,
  isExitPlanModeToolName,
  isPlainRecord,
  readAskUserQuestionPayloadQuestions,
  toProtocolToolCallDisplay,
} from "./product-projection-ask-user.js";
import type { ProjectionState } from "./product-projection-state.js";
import { findToolRow } from "./product-projection-tool-rows.js";
// review 单调性裁决单一来源；projection 只实现“应用策略”（advance/no_current 接受，
// 其余忽略；跨 flow 等 onSessionResumed 清空）。
// （改直连 monotonicity subpath；discovery barrel 的该 re-export
// 会在 packages/ui 的 Desktop 构建链解析失败，App 重启后打不开。）
import { verdictWorkspaceHookReviewRequest } from "@zcode/shared/workspace-hook-review-monotonicity";
import type {
  ConversationDelta,
  PendingInteraction,
  ToolCallRow,
} from "@zcode/shared/zcode-protocol-v4";
import { workspaceHookReviewRequestPayloadSchema } from "@zcode/shared/zcode-protocol-v4";
import {
  SESSION_ALLOW_PERMISSION_OPTION_KIND,
  buildProtocolPermissionOptions,
} from "../permission-options.js";
import {
  MCP_ELICITATION_INTERACTION,
  MCP_ELICITATION_TOOL_NAME,
  mcpElicitationQuestions,
} from "./mcp-elicitation.js";
import { ms } from "./product-projection-primitives.js";

// ── 权限交互（阻塞交互 → 状态）──

export function onPermissionRequested(
  state: ProjectionState,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as PermissionRequestedPayload;
  const toolCallId = String(payload.toolCallId);
  const interactionId = payload.requestId ?? `perm-${toolCallId}`;
  const interaction = createPendingInteractionFromPermissionEvent(
    state,
    event,
    payload,
    toolCallId,
    interactionId,
  );
  const deltas: ConversationDelta[] = [];
  const row = findToolRow(state, toolCallId);
  if (row) {
    deltas.push({
      op: "row.upserted",
      row: {
        ...row,
        status: "pendingApproval",
        approvalInteractionId: interactionId,
      },
    });
  }
  deltas.push({
    op: "state.updated",
    patch: {
      pendingInteractions: [...state.snapshot.pendingInteractions, interaction],
    },
  });
  return deltas;
}

function createPendingInteractionFromPermissionEvent(
  state: Pick<ProjectionState, "toolRowIdByCallId">,
  event: SessionEvent,
  payload: PermissionRequestedPayload,
  toolCallId: string,
  interactionId: string,
): PendingInteraction {
  if (isAskUserQuestionToolName(payload.toolName)) {
    // AskUserQuestion 的 permission_requested 只是 runtime 等待态；
    // v4 UI 需要结构化 questions 才能回填 answers，而不是 Allow/Deny 权限弹窗。
    return {
      interactionId,
      kind: "userInput",
      anchorRowId: state.toolRowIdByCallId.get(toolCallId) ?? null,
      createdAt: ms(event),
      payload: {
        kind: "userInput",
        prompt: payload.reason,
        freeText: true,
        toolCallId,
        toolName: payload.toolName,
        traceId: event.traceId,
        input: payload.input,
        schema: { toolName: payload.toolName },
        questions: readAskUserQuestionPayloadQuestions(payload.input),
        ...(payload.origin ? { origin: payload.origin } : {}),
      },
    };
  }
  if (payload.toolName === MCP_ELICITATION_TOOL_NAME) {
    // MCP elicitation：requestedSchema → 结构化问题，
    // 与 broker 用同一映射，v4 UI 复用 ElicitationDialog。
    const elicitation = isPlainRecord(payload.input) ? payload.input : {};
    return {
      interactionId,
      kind: "userInput",
      anchorRowId: state.toolRowIdByCallId.get(toolCallId) ?? null,
      createdAt: ms(event),
      payload: {
        kind: "userInput",
        prompt: payload.reason,
        freeText: true,
        toolCallId,
        toolName: payload.toolName,
        traceId: event.traceId,
        input: payload.input,
        schema: {
          interaction: MCP_ELICITATION_INTERACTION,
          serverName: elicitation.serverName,
          requestedSchema: elicitation.requestedSchema,
        },
        questions: mcpElicitationQuestions(payload.reason, elicitation.requestedSchema),
        ...(payload.origin ? { origin: payload.origin } : {}),
      },
    };
  }
  if (isExitPlanModeToolName(payload.toolName)) {
    // ExitPlanMode 复用 userInput/elicitation 通道承载计划审批反馈；
    // 普通 permission payload 无法表达 approve/custom feedback 的业务语义。
    return {
      interactionId,
      kind: "userInput",
      anchorRowId: state.toolRowIdByCallId.get(toolCallId) ?? null,
      createdAt: ms(event),
      payload: {
        kind: "userInput",
        prompt: payload.reason,
        freeText: true,
        toolCallId,
        toolName: payload.toolName,
        traceId: event.traceId,
        input: payload.input,
        schema: { interaction: "plan_approval", toolName: payload.toolName },
        questions: [createExitPlanModeApprovalQuestion(payload.reason)],
        ...(payload.origin ? { origin: payload.origin } : {}),
      },
    };
  }
  const askDisplay = toProtocolToolCallDisplay(payload.display);
  return {
    interactionId,
    kind: "permission",
    anchorRowId: state.toolRowIdByCallId.get(toolCallId) ?? null,
    createdAt: ms(event),
    payload: {
      kind: "permission",
      toolCallId,
      toolName: payload.toolName,
      summary: payload.reason,
      detail: payload.input,
      freeText: true,
      ...(payload.fullAccessSupported === true && !payload.origin && !payload.optionsPolicy
        ? {
            fullAccessOption: {
              optionId: PERMISSION_FULL_ACCESS_OPTION_ID,
              label: "Full access",
              kind: "custom" as const,
              response: { decision: "deny" as const, reason: "Full access requires V4 approval" },
            },
          }
        : {}),
      ...(payload.origin ? { origin: payload.origin } : {}),
      ...(askDisplay ? { display: askDisplay } : {}),
      options: [
        ...buildProtocolPermissionOptions({
          input: payload.input,
          suggestedPermissionUpdates: payload.suggestedPermissionUpdates,
          ...(payload.optionsPolicy ? { optionsPolicy: payload.optionsPolicy } : {}),
          toolName: payload.toolName,
        }).map((option) => ({
          optionId:
            option.kind === "allow_once"
              ? "allowOnce"
              : option.kind === "allow_always"
                ? "allowAlways"
                : option.optionId,
          label: option.name,
          // 会话免确认的 kind 映到闭集里的 allowAlways（排序槽位 / 样式与 always allow 同），
          // optionId 原样 allowSession——broker 靠它精确命中，GUI 靠 name 本地化。
          kind:
            option.kind === "allow_once"
              ? ("allowOnce" as const)
              : option.kind === "allow_always" ||
                  option.kind === SESSION_ALLOW_PERMISSION_OPTION_KIND
                ? ("allowAlways" as const)
                : ("deny" as const),
          response: option.response,
        })),
        // workflow Refine 只在 v4 投放（legacy 选项列表刻意不含，见 session-mapper 注释）。
        // 静态 response 是普通 deny：任何不认识该
        // optionId 的消费面（无 freeText 的应答）都退化为拒绝，反馈升级只发生在
        // interaction-broker 对 freeText 的特判里。
        ...(payload.toolName === CREATE_WORKFLOW_TOOL_NAME ||
        payload.toolName === AMEND_WORKFLOW_TOOL_NAME
          ? [
              {
                optionId: WORKFLOW_REFINE_PERMISSION_OPTION_ID,
                label: "Refine",
                kind: "custom" as const,
                response: { decision: "deny" as const, reason: "Denied" },
              },
            ]
          : []),
      ],
    },
  };
}

export function onPermissionResolved(
  state: ProjectionState,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as PermissionResolvedPayload;
  return settlePermission(
    state,
    String(payload.toolCallId),
    payload.decision === "deny" ? "cancelled" : "running",
  );
}

export function onPermissionDenied(
  state: ProjectionState,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as PermissionDeniedPayload;
  return settlePermission(state, String(payload.toolCallId), "cancelled");
}

export function onWorkspaceHookReviewRequested(
  state: Pick<ProjectionState, "snapshot">,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as WorkspaceHookReviewRequestedPayload;
  const request = workspaceHookReviewRequestPayloadSchema.parse(payload.request);
  const current = state.snapshot.pendingInteractions.find(
    (item) => item.payload.kind === "workspaceHookReview",
  );
  if (current?.payload.kind === "workspaceHookReview") {
    const verdict = verdictWorkspaceHookReviewRequest(current.payload, request);
    // 跨 flow 只能在 onSessionResumed 已清空旧 review 后接管（epoch 应用策略在
    // onSessionResumed）；其余 stale/replay/conflict 均不得覆盖或延长当前 authority。
    if (verdict !== "same_flow_advance") {
      return [];
    }
  }
  const interaction: PendingInteraction = {
    interactionId: request.interactionId,
    kind: "workspaceHookReview",
    anchorRowId: null,
    createdAt: request.createdAt,
    payload: request,
  };
  // 同 flow 的更高 generation 是唯一合法替换；Runtime 重启的跨 flow 接管必须先经过
  // SessionResumed 清旧 authority。这里仍原子替换，避免历史异常状态残留多个 review。
  const pendingInteractions = state.snapshot.pendingInteractions.filter(
    (item) => item.payload.kind !== "workspaceHookReview",
  );
  pendingInteractions.push(interaction);
  return [{ op: "state.updated", patch: { pendingInteractions } }];
}

export function onWorkspaceHookReviewSettled(
  state: Pick<ProjectionState, "snapshot">,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as WorkspaceHookReviewSettledPayload;
  return removeWorkspaceHookReview(state, payload.interactionId);
}

export function onWorkspaceHookReviewSuperseded(
  state: Pick<ProjectionState, "snapshot">,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as WorkspaceHookReviewSupersededPayload;
  return removeWorkspaceHookReview(state, payload.interactionId);
}

function removeWorkspaceHookReview(
  state: Pick<ProjectionState, "snapshot">,
  interactionId: string,
): ConversationDelta[] {
  const pendingInteractions = state.snapshot.pendingInteractions.filter(
    (item) =>
      !(item.payload.kind === "workspaceHookReview" && item.interactionId === interactionId),
  );
  return pendingInteractions.length === state.snapshot.pendingInteractions.length
    ? []
    : [{ op: "state.updated", patch: { pendingInteractions } }];
}

/**
 * 软门禁:处理 WorkspaceHookAdmissionUpdated 事件。
 *
 * pendingCount > 0 → 写入 snapshot.workspaceHookAdmission(提示条出现);
 * pendingCount === 0 → 置 null(提示条消失)。
 */
export function onWorkspaceHookAdmissionUpdated(event: SessionEvent): ConversationDelta[] {
  const payload = event.payload as WorkspaceHookAdmissionUpdatedPayload;
  const workspaceHookAdmission =
    payload.pendingCount === 0
      ? null
      : {
          pendingCount: payload.pendingCount,
          bundleDigest: payload.bundleDigest,
          ...(payload.workspaceIdentity ? { workspaceIdentity: payload.workspaceIdentity } : {}),
        };
  return [{ op: "state.updated", patch: { workspaceHookAdmission } }];
}

export function onUserInputAutoResolutionUpdated(
  state: Pick<ProjectionState, "snapshot">,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as UserInputAutoResolutionUpdatedPayload;
  let changed = false;
  const pendingInteractions = state.snapshot.pendingInteractions.map((interaction) => {
    if (
      interaction.interactionId !== payload.interactionId ||
      interaction.payload.kind !== "userInput"
    ) {
      return interaction;
    }
    changed = true;
    return {
      ...interaction,
      autoResolution: payload.autoResolution,
    };
  });
  return changed ? [{ op: "state.updated", patch: { pendingInteractions } }] : [];
}

function settlePermission(
  state: ProjectionState,
  toolCallId: string,
  status: ToolCallRow["status"],
): ConversationDelta[] {
  const deltas: ConversationDelta[] = [];
  const row = findToolRow(state, toolCallId);
  if (row) {
    const next: ToolCallRow = { ...row, status };
    delete next.approvalInteractionId;
    deltas.push({ op: "row.upserted", row: next });
  }
  const remaining = state.snapshot.pendingInteractions.filter(
    (item) =>
      !(
        (item.payload.kind === "permission" || item.payload.kind === "userInput") &&
        item.payload.toolCallId === toolCallId
      ),
  );
  if (remaining.length !== state.snapshot.pendingInteractions.length) {
    deltas.push({
      op: "state.updated",
      patch: { pendingInteractions: remaining },
    });
  }
  return deltas;
}
