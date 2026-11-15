import { resolve } from "node:path";
import type { SessionId } from "@zcode/contracts";
import { zcodeProtocolMethods, type ZCodeWorkspaceRef } from "@zcode/shared";
import type { ZCodeProtocolAgentServerContext } from "../zcode-protocol/server-types.js";
import { activateSessionRuntime } from "../zcode-protocol/server-operations.js";
import { releaseSessionRecord } from "../zcode-protocol/session-residency.js";
import { SessionLifecycleController } from "./controller.js";

/**
 * 生命周期 owner 的宿主适配：存在性/激活/释放全部复用既有 residency 与 server-operations
 * 路径，不在这里创建第二份 runtime 或 session registry。
 */
export function getSessionLifecycle(
  context: ZCodeProtocolAgentServerContext,
): SessionLifecycleController {
  return (context.sessionLifecycle ??= new SessionLifecycleController({
    exists: async (sessionId) => {
      if (context.sessions.has(sessionId)) return true;
      const persisted = await context.deps.sessionStore?.getSession(sessionId as SessionId);
      return Boolean(persisted && persisted.time.deleted === undefined);
    },
    hasRuntime: (sessionId) => context.sessions.has(sessionId),
    validateActivation: (sessionId, workspace) =>
      validateSessionActivationWorkspace(context, sessionId, workspace),
    activate: async (sessionId, workspace) => {
      // 直接调用执行面：controller 已持有 flight，不能再进入 public resume 的同一 owner。
      await activateSessionRuntime(context, { sessionId, workspace });
    },
    assertCanStop: () => {
      // 主动停止不继承 TTL/LRU 的 busy 保护；回收仍由 resident pool 单独预检。
    },
    release: (sessionId) => releaseSessionRecord(context, sessionId),
    onOperationSettled: () => {
      // 操作结算后的重载/预热属于各产品入口；生命周期 owner 不额外触发连接副作用。
    },
    onChange: (snapshot) => {
      context.logger?.info("Session runtime lifecycle changed", {
        event: "zcode_protocol.session.lifecycle_changed",
        ...snapshot,
      });
      try {
        context.notify({ method: zcodeProtocolMethods.sessionLifecycleChanged, params: snapshot });
      } catch (error) {
        // 通知连接失败不改变已完成的生命周期事实，客户端重连后通过查询对账。
        context.logger?.warn("Session lifecycle notification failed", {
          error: error instanceof Error ? error.message : String(error),
          event: "zcode_protocol.session.lifecycle_changed.failed",
          sessionId: snapshot.sessionId,
        });
      }
    },
  }));
}

/** 只读预检：已激活实例逐字段比较；冷实例只比较持久身份，不物化 runtime。 */
async function validateSessionActivationWorkspace(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
  workspace?: ZCodeWorkspaceRef,
): Promise<void> {
  if (!workspace) return; // 旧协议调用仍由持久记录提供上下文。
  const active = context.sessions.get(sessionId);
  if (active) {
    if (
      active.workspace.workspaceKey !== workspace.workspaceKey ||
      resolve(active.workspace.workspacePath) !== resolve(workspace.workspacePath) ||
      active.workspace.workspaceIdentity !== workspace.workspaceIdentity ||
      active.workspace.remoteSessionId !== workspace.remoteSessionId
    )
      throw new Error("project.session-lineage-invalid");
    return;
  }
  const persisted = await context.deps.sessionStore?.getSession(sessionId as SessionId);
  if (!persisted || persisted.time.deleted !== undefined) {
    throw new Error("project.session-lineage-invalid");
  }
  const persistedPath = resolve(persisted.path ?? persisted.directory);
  const identityMismatch =
    Boolean(workspace.workspaceIdentity) &&
    Boolean(persisted.workspaceID) &&
    workspace.workspaceIdentity !== String(persisted.workspaceID);
  if (persistedPath !== resolve(workspace.workspacePath) || identityMismatch) {
    throw new Error("project.session-lineage-invalid");
  }
}
