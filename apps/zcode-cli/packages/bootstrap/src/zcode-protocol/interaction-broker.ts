import { randomUUID } from "node:crypto";
import { raceClientRequestWithV4Interaction } from "./interaction-response-race.js";
import {
  ASK_USER_QUESTION_TOOL_NAME,
  AskUserQuestionInputSchema,
  EXIT_PLAN_MODE_TOOL_NAME,
  SessionEventType,
  createEventId,
  type McpElicitationRequest,
  type McpElicitationResult,
  type PermissionBrokerPort,
  type PermissionBrokerRequest,
  type PermissionBrokerRequestOptions,
  type PermissionBrokerResult,
  type SessionEvent,
} from "@zcode/contracts";
import {
  MCP_ELICITATION_INTERACTION,
  MCP_ELICITATION_TOOL_NAME,
  mcpElicitationContentFromAnswers,
  mcpElicitationQuestions,
} from "../zcode-protocol-v4/mcp-elicitation.js";
import {
  zcodePermissionResponseSchema,
  zcodeProtocolMethods,
  zcodeUserInputResponseSchema,
  type ZCodeUserInputResponse,
} from "@zcode/shared";
import type { ZCodeProtocolAgentServerContext } from "./server-types.js";
import {
  buildProtocolPermissionOptions,
  toLegacyPermissionOptionsPolicy,
  PERMISSION_DENIED_BY_USER_CONTENT,
} from "./permission-options.js";
import {
  createExitPlanModeApprovalQuestion,
  mapAskUserQuestion,
  planApprovalResponseToBrokerResult,
  userInputResponseToBrokerResult,
  v4AnswerToPermissionResponse,
  v4AnswerToPlanApprovalResponse,
  v4AnswerToUserInputResponse,
} from "./interaction-answer-mapping.js";
import {
  createInteractionRegistrationOptions,
  readPersistedAutoResolution,
  withInteractionRequestRecovery,
} from "./interaction-registration.js";

export function createProtocolInteractionBroker(
  context: ZCodeProtocolAgentServerContext,
): PermissionBrokerPort {
  return {
    requestPermission(request, options) {
      if (request.toolName === ASK_USER_QUESTION_TOOL_NAME) {
        return requestUserInput(context, request, options);
      }
      if (request.toolName === EXIT_PLAN_MODE_TOOL_NAME) {
        return requestExitPlanModeApproval(context, request, options);
      }
      return requestPermission(context, request, options);
    },
  };
}

async function requestPermission(
  context: ZCodeProtocolAgentServerContext,
  request: PermissionBrokerRequest,
  options?: PermissionBrokerRequestOptions,
): Promise<PermissionBrokerResult> {
  const permissionOptions = buildProtocolPermissionOptions(request);
  // v3 反向 RPC 的选项列表：会话免确认只在 v4 投放（旧桌面回传 response 原文，认不出会话语义）。
  const legacyPermissionOptions = buildProtocolPermissionOptions({
    ...request,
    optionsPolicy: toLegacyPermissionOptionsPolicy(request.optionsPolicy),
  });
  const response = await raceClientRequestWithV4Interaction(
    context,
    request.requestId,
    options?.signal,
    (signal) =>
      context.requestClient(
        zcodeProtocolMethods.interactionRequestPermission,
        {
          input: request.input,
          reason: request.reason,
          requestId: request.requestId,
          riskLevel: request.riskLevel,
          sessionId: request.sessionId,
          ...(request.origin ? { origin: request.origin } : {}),
          options: legacyPermissionOptions,
          toolCallId: request.toolCallId,
          toolName: request.toolName,
          turnId: request.turnId,
        },
        zcodePermissionResponseSchema,
        withInteractionRequestRecovery(options, signal),
      ),
    // v4 answer → ZCodePermissionResponse：optionId 语义来自 v4 reducer 合成的
    // allowOnce/allowAlways/deny（见 product-projection onPermissionRequested）。
    (answer) => {
      const response = v4AnswerToPermissionResponse(answer, permissionOptions, request.toolName);
      return response.decision === "deny" && answer.freeText?.trim()
        ? { ...response, preserveReasonFormatting: true }
        : response;
    },
    {
      ...createInteractionRegistrationOptions(request, "other"),
      ...(!request.origin &&
      !request.optionsPolicy &&
      options?.claimResponse &&
      context.deps?.sessionStore?.commitPermissionFullAccess
        ? {
            fullAccess: async () => {
              if (!options.claimResponse!()) throw new Error("Permission response already settled");
              options.signal?.throwIfAborted();
              const record = context.sessions.get(String(request.sessionId));
              if (!record) throw new Error("Permission session unavailable");
              const eventId = await record.app.runtime.grantPermissionFullAccess(
                request.requestId,
                options.signal,
              );
              await context.v4Gateway?.waitForPermissionGrantCommit(
                String(request.sessionId),
                eventId,
              );
            },
          }
        : {}),
    },
  );
  return {
    ...response,
    // 兼容原因：legacy 客户端允许省略 reason；普通用户拒绝仍需向模型明确工具未执行，
    // 否则 core 会回退为通用的 `Permission denied for <tool>`，无法阻止绕过式尝试。
    ...(response.decision === "deny" && !response.reason?.trim()
      ? { reason: PERMISSION_DENIED_BY_USER_CONTENT }
      : {}),
    resolvedAt: new Date(),
  };
}

/**
 * MCP elicitation：server 在工具执行中向用户提问。
 * 复用 AskUserQuestion 的两条通道——旧 RPC interaction/requestUserInput 与 v4 pending interaction——
 * 后者靠合成（不持久化）的 PermissionRequested / PermissionResolved 事件推进投影。
 */
export async function requestMcpElicitation(
  context: ZCodeProtocolAgentServerContext,
  request: McpElicitationRequest,
  options?: { signal?: AbortSignal },
): Promise<McpElicitationResult> {
  const sessionId = request.trace?.sessionId;
  const record = sessionId ? context.sessions?.get(sessionId) : undefined;
  if (!sessionId || !record) {
    // 没有正在执行的工具调用可归属（如 server 在空闲时主动提问）：拒绝而不是猜会话。
    return { action: "decline" };
  }
  const interactionId = `mcp-elicit-${randomUUID()}`;
  const toolCallId = request.trace?.toolCallId ?? interactionId;
  const questions = mcpElicitationQuestions(request.message, request.requestedSchema);
  const input = {
    serverName: request.serverName,
    message: request.message,
    requestedSchema: request.requestedSchema,
  };
  const traceId = request.trace?.traceId ?? String(record.traceContext.traceId);
  const ingestSynthetic = async (
    type: typeof SessionEventType.PermissionRequested | typeof SessionEventType.PermissionResolved,
    payload: Record<string, unknown>,
  ) => {
    const gateway = context.v4Gateway;
    if (!gateway) return;
    const event: SessionEvent = {
      id: createEventId(),
      sessionId: sessionId as never,
      ...(request.trace?.turnId ? { turnId: request.trace.turnId as never } : {}),
      type,
      timestamp: new Date(),
      traceId: traceId as never,
      // 只进 live 投影、不落盘：raw seq 置 0，让 v4 gateway 分配 transport 序号。
      // 若沿用持久化高水位 +1，第二条合成事件会因 seq 不高于游标被当作重放丢弃，pending 永远清不掉。
      sequenceNumber: 0,
      payload: payload as never,
    };
    gateway.ingest(sessionId, event);
  };
  await ingestSynthetic(SessionEventType.PermissionRequested, {
    requestId: interactionId,
    toolCallId,
    toolName: MCP_ELICITATION_TOOL_NAME,
    riskLevel: "low",
    reason: request.message,
    input,
  });
  let response: ZCodeUserInputResponse;
  try {
    response = await raceClientRequestWithV4Interaction(
      context,
      interactionId,
      options?.signal,
      (signal) =>
        context.requestClient(
          zcodeProtocolMethods.interactionRequestUserInput,
          {
            input,
            prompt: request.message,
            questions,
            requestId: interactionId,
            schema: {
              interaction: MCP_ELICITATION_INTERACTION,
              serverName: request.serverName,
              requestedSchema: request.requestedSchema,
            },
            sessionId,
            toolCallId,
            toolName: MCP_ELICITATION_TOOL_NAME,
            ...(request.trace?.turnId ? { turnId: request.trace.turnId } : {}),
          },
          zcodeUserInputResponseSchema,
          withInteractionRequestRecovery(options, signal),
        ),
      (answer) => v4AnswerToUserInputResponse(answer),
      { sessionId, kind: "other" },
    );
  } finally {
    await ingestSynthetic(SessionEventType.PermissionResolved, {
      requestId: interactionId,
      toolCallId,
      decision: "allow",
    }).catch(() => undefined);
  }
  if (response.action !== "accept") return { action: response.action };
  return {
    action: "accept",
    content: mcpElicitationContentFromAnswers(request.requestedSchema, questions, response.content),
  };
}

async function requestUserInput(
  context: ZCodeProtocolAgentServerContext,
  request: PermissionBrokerRequest,
  options?: PermissionBrokerRequestOptions,
): Promise<PermissionBrokerResult> {
  const parsed = AskUserQuestionInputSchema.safeParse(request.input);
  if (!parsed.success) {
    return {
      decision: "deny",
      reason: `Invalid AskUserQuestion input: ${
        parsed.error.issues[0]?.message ?? "schema validation failed"
      }`,
      resolvedAt: new Date(),
    };
  }

  const initialAutoResolution = await readPersistedAutoResolution(context, request);

  const response = await raceClientRequestWithV4Interaction(
    context,
    request.requestId,
    options?.signal,
    (signal) =>
      context.requestClient(
        zcodeProtocolMethods.interactionRequestUserInput,
        {
          input: request.input,
          prompt: request.reason,
          questions: parsed.data.questions.map(mapAskUserQuestion),
          requestId: request.requestId,
          schema: { toolName: request.toolName },
          sessionId: request.sessionId,
          ...(request.origin ? { origin: request.origin } : {}),
          toolCallId: request.toolCallId,
          toolName: request.toolName,
          turnId: request.turnId,
        },
        zcodeUserInputResponseSchema,
        withInteractionRequestRecovery(options, signal),
      ),
    // v4 答 AskUserQuestion：freeText/optionId 落到单题 answer 槽位
    // （normalizeAskUserQuestionResponseContent 的 content.answer 兼容路径）；
    // deny 落 decline。多题场景等 v4 投影建模 userInput kind 后再精确映射。
    (answer) => v4AnswerToUserInputResponse(answer),
    createInteractionRegistrationOptions(
      request,
      "askUserQuestion",
      context,
      initialAutoResolution,
    ),
  );

  return userInputResponseToBrokerResult(request, response);
}

async function requestExitPlanModeApproval(
  context: ZCodeProtocolAgentServerContext,
  request: PermissionBrokerRequest,
  options?: PermissionBrokerRequestOptions,
): Promise<PermissionBrokerResult> {
  const response = await raceClientRequestWithV4Interaction(
    context,
    request.requestId,
    options?.signal,
    (signal) =>
      context.requestClient(
        zcodeProtocolMethods.interactionRequestUserInput,
        {
          input: request.input,
          prompt: request.reason,
          questions: [createExitPlanModeApprovalQuestion()],
          requestId: request.requestId,
          schema: { interaction: "plan_approval", toolName: request.toolName },
          sessionId: request.sessionId,
          ...(request.origin ? { origin: request.origin } : {}),
          toolCallId: request.toolCallId,
          toolName: request.toolName,
          turnId: request.turnId,
        },
        zcodeUserInputResponseSchema,
        withInteractionRequestRecovery(options, signal),
      ),
    // v4 答 plan approval：allow 类 optionId = 批准；freeText = 计划反馈
    // （planApprovalResponseToBrokerResult 走 plan_approval_feedback deny）；否则 decline。
    (answer) => v4AnswerToPlanApprovalResponse(answer),
    createInteractionRegistrationOptions(request, "other"),
  );

  return planApprovalResponseToBrokerResult(response);
}
