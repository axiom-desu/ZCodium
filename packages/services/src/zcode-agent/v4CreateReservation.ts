import { createHash } from "node:crypto";
import { resolveWorkspaceKey } from "@zcode/shared";
import type { CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import type { ZCodeAgentCreateSessionParams } from "./zcodeAgent.js";
import type { ProjectSessionCreationPort } from "#src/project/app/sessionCreation.js";

/**
 * v4 createSession 的项目预占（Host 侧唯一入口）。
 *
 * - projectId 只存在于 Host RPC 参数里，不写进 CLI wire payload：CLI 没有项目概念。
 * - 复用既有 prepareSessionCreation port（与 legacy create/resume 同一 owner），
 *   因此冻结目录、归属与 task 行都只在一个写事务里产生。
 * - sessionId 由 workspace + clientId + commandId 派生：同一命令重试命中同一预占行，
 *   不与 CLI 自建会话抢身份；调用方显式预占的 sessionId 优先。
 */
export function deriveV4ReservedSessionId(params: {
  workspace: { workspacePath: string; workspaceIdentity?: string };
  envelope: Pick<CommandEnvelope, "clientId" | "commandId">;
}): string {
  return `session_${createHash("sha256")
    .update(
      JSON.stringify([
        resolveWorkspaceKey(params.workspace),
        params.envelope.clientId,
        params.envelope.commandId,
      ]),
    )
    .digest("hex")
    .slice(0, 32)}`;
}

interface V4CreateReservationInput {
  workspace: { workspacePath: string; workspaceIdentity?: string };
  envelope: Pick<CommandEnvelope, "clientId" | "commandId">;
  payload: { sessionId?: string; additionalDirectories?: string[] };
  /** 显式 null = 全局任务；undefined = 调用方未表态（仍按 Host 通道预占）。 */
  projectId?: string | null;
  prepareSessionCreation?: ProjectSessionCreationPort["prepareSessionCreation"];
}

/** 返回要注入 createSession payload 的字段；缺失 port 时显式拒绝，不静默跳过归属。 */
export async function reserveV4CreateSession(
  input: V4CreateReservationInput,
): Promise<{ sessionId: string; additionalDirectories: string[] }> {
  if (!input.prepareSessionCreation) throw new Error("project.creation-unavailable");
  const sessionId =
    input.payload.sessionId ??
    deriveV4ReservedSessionId({
      workspace: input.workspace,
      envelope: input.envelope,
    });
  const additionalDirectories = await input.prepareSessionCreation({
    workspacePath: input.workspace.workspacePath,
    ...(input.workspace.workspaceIdentity
      ? { workspaceIdentity: input.workspace.workspaceIdentity }
      : {}),
    sessionId,
    projectId: input.projectId ?? null,
    ...(input.payload.additionalDirectories !== undefined
      ? { additionalDirectories: input.payload.additionalDirectories }
      : {}),
  } as ZCodeAgentCreateSessionParams & { sessionId: string; projectId: string | null });
  return { sessionId, additionalDirectories };
}
