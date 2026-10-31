import { parseRemoteWorkspaceIdentity } from "@zcode/shared";
import { V4_NOTIFICATIONS } from "@zcode/shared/zcode-protocol-v4";
import { isTaskListSessionType } from "../zcode-protocol-v4/task-list-session-membership.js";
import { buildLiveWorkspaceConfigStateV4 } from "./v4-workspace-config.js";
import { resolveSessionModelContextWindow } from "./workspace-model-runtime.js";
import { readSessionContextUsage } from "./server-operations.js";
import type { V4BridgeRuntimePorts, V4GatewayOptions } from "./v4-bridge-shared.js";
import { cloneModelSelection } from "./v4-bridge-shared.js";
import { sessionUsageSeedFromRuntimeContextUsage } from "./v4-bridge-cold-hydration.js";

export function createGatewayEventForwarding(
  ports: V4BridgeRuntimePorts,
): Pick<
  V4GatewayOptions,
  | "emitWireFrame"
  | "emitConversationTelemetryFact"
  | "emitSessionActivity"
  | "emitLocalTtftFacts"
  | "emitCuaPermissionObservation"
  | "emitPluginUiToolResult"
  | "getSessionMemoryEnabled"
  | "getSessionConfigSeed"
  | "getSessionUsageSeed"
  | "getSessionWorkspaceId"
  | "getSessionIndexMeta"
  | "listWorkspaceSessionIds"
  | "isDraftSession"
  | "getWorkspaceConfig"
  | "getStoredSessionSummaries"
  | "refreshLegacySessionSummaries"
> {
  const context = ports.context;
  const loadStoredSessionSummaries = ports.summaries.loadStoredSessionSummaries;
  return {
    emitWireFrame: (wire) =>
      context.notify({
        method: V4_NOTIFICATIONS.conversationFrame,
        params: wire,
      }),
    emitConversationTelemetryFact: (fact) =>
      context.notify({ method: V4_NOTIFICATIONS.conversationTelemetryFact, params: fact }),
    emitSessionActivity: (activity) =>
      context.notify({ method: V4_NOTIFICATIONS.sessionActivity, params: activity }),
    emitLocalTtftFacts: (facts) =>
      context.notify({ method: V4_NOTIFICATIONS.localTtftFacts, params: facts }),
    emitCuaPermissionObservation: (observation) =>
      context.notify({
        method: V4_NOTIFICATIONS.cuaPermissionObservation,
        params: observation,
      }),
    emitPluginUiToolResult: (result) =>
      context.notify({ method: V4_NOTIFICATIONS.pluginUiToolResult, params: result }),
    // ── config 种子：投影初值 = runtime 真值 ─────────────
    // 覆盖三个种子来源：启动缺省（Workspace 模型偏好 + 项目持久化 mode）、
    // createSession.config（handler 先应用到 runtime 再种）、历史会话 resume
    // （App 恢复结果可以只有模型身份，不能为了投影而绑定半成品执行模型）。
    getSessionMemoryEnabled: (sessionId) => context.sessions.get(sessionId)?.memoryEnabled,
    getSessionConfigSeed: (sessionId) => {
      const record = context.sessions.get(sessionId);
      if (!record) return null;
      const selection =
        record.app.runtime.getSessionModelSelection() ?? record.restoredModelSelection;
      return {
        modelSelection: cloneModelSelection(selection),
        provider: selection?.providerId ?? "",
        model: selection?.modelId ?? "",
        thought: selection?.options?.reasoningLevel ?? "",
        thoughtLevels: selection
          ? (record.app
              .listModels()
              .find(
                (model) =>
                  model.ref.providerId === selection.providerId &&
                  model.ref.modelId === selection.modelId,
              )
              ?.reasoning?.levels.map((level) => level.value) ?? [])
          : [],
        mode: record.app.getMode(),
        planEnabled: record.app.runtime.getPlanEnabled(),
        ...(record.app.runtime.lastPermissionGrantId
          ? { permissionGrant: { interactionId: record.app.runtime.lastPermissionGrantId } }
          : {}),
      };
    },
    getSessionUsageSeed: async (sessionId, persistedMessages) => {
      const record = context.sessions.get(sessionId);
      if (!record) return null;
      const contextUsage = await readSessionContextUsage(context, sessionId, persistedMessages);
      // usage seed 会在 hydration 后再次覆盖首帧分母；必须与合成事件
      // 使用同一份当前模型 registry 真值，不能把旧 runtime projection 的窗口写回来。
      return sessionUsageSeedFromRuntimeContextUsage(
        contextUsage,
        resolveSessionModelContextWindow(context, record),
      );
    },
    // ── sessions-index hooks（workspace 分桶 + 冷启动 store 种子）──────────
    getSessionWorkspaceId: (sessionId) => {
      const record = context.sessions.get(sessionId);
      return !record || !isTaskListSessionType(record.taskType)
        ? null
        : record.workspace.workspaceKey;
    },
    getSessionIndexMeta: (sessionId) => {
      const record = context.sessions.get(sessionId);
      if (!record) return null;
      return {
        createdAt: record.createdAt,
        lastActivityAt: record.updatedAt,
        ...(record.parentSessionId ? { parentSessionId: String(record.parentSessionId) } : {}),
      };
    },
    listWorkspaceSessionIds: (workspaceId) =>
      [...context.sessions.values()]
        .filter(
          (record) =>
            isTaskListSessionType(record.taskType) && record.workspace.workspaceKey === workspaceId,
        )
        .map((record) => record.app.sessionId),
    // draft 判定：deferred = 未发首条输入（prompt-turn 首发提升为 immediate）。
    // 旧 workspace prepare 预建的 deferred 会话不得以「新任务」漏进侧栏列表。
    isDraftSession: (sessionId) => context.sessions.get(sessionId)?.persistence === "deferred",
    // ── workspace-config hook（配置目录订阅种子；live session 快路径，避免临时 app）──
    getWorkspaceConfig: (workspaceId) => buildLiveWorkspaceConfigStateV4(context, workspaceId),
    getStoredSessionSummaries: loadStoredSessionSummaries,
    refreshLegacySessionSummaries: (workspaceId, legacyTaskIds) =>
      parseRemoteWorkspaceIdentity(workspaceId)
        ? loadStoredSessionSummaries(workspaceId, legacyTaskIds)
        : null,
    // 回落面已清零（20 命令全部原生）：supports 未命中（未知命令类型）→
    // notImplemented → ACK failed fault.command.notImplemented。
  };
}
