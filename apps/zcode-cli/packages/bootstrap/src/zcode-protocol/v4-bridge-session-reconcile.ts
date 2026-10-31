import { parseRemoteWorkspaceIdentity } from "@zcode/shared";
import type { SessionId } from "@zcode/contracts";
import type { V4BridgeBasePorts, V4GatewayOptions } from "./v4-bridge-shared.js";
import { normalizeStoredTitleSource } from "./v4-bridge-cold-hydration.js";

/**
 * sessions-index 事实只读查询：CLI 持久 store 是唯一 owner。
 * 不激活 runtime、不恢复会话、不创建项目；workspace 身份必须与订阅时一致，
 * 否则同路径不同远端会被误认成同一批任务。
 */
export function createGatewaySessionReconcile(
  ports: V4BridgeBasePorts,
): Pick<V4GatewayOptions, "reconcileSessions"> {
  const context = ports.context;
  return {
    reconcileSessions: async ({ workspaceId, sessionIds }) => {
      const store = context.deps.sessionStore;
      if (!store) throw new Error("Session store is unavailable");
      const remote = parseRemoteWorkspaceIdentity(workspaceId);
      const directory = remote?.workspacePath ?? workspaceId;
      const sessions = await Promise.all(
        [...new Set(sessionIds)].map(async (sessionId) => {
          const session = await store.getSession(sessionId as SessionId);
          const sameWorkspace =
            session &&
            session.directory === directory &&
            (remote
              ? session.workspaceID === workspaceId
              : !session.workspaceID || session.workspaceID === workspaceId);
          if (!sameWorkspace) return { sessionId, exists: false as const, deleted: false as const };
          return {
            sessionId,
            exists: true as const,
            deleted: session.time.deleted !== undefined,
            title: session.title,
            titleSource: normalizeStoredTitleSource(session.titleSource),
            createdAt: session.time.created,
            updatedAt: session.time.updated,
            ...(session.lastOutcome ? { lastOutcome: session.lastOutcome } : {}),
          };
        }),
      );
      return { sessions };
    },
  };
}
