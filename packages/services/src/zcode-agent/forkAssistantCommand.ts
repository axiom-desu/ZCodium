import type { CommandAck } from "@zcode/shared/zcode-protocol-v4";
import type { IZCodeAgentService, ZCodeAgentWorkspaceTarget } from "./zcodeAgent.js";
import { createHostCommandEnvelope } from "./zcodeV4HostCommand.js";

/**
 * Host 侧 v4 forkAssistant 的唯一命令构造/结果映射。
 *
 * W6 的受管 worktree fork 与 AppForkSession 都走这里：CLI 的 stable resolver
 * 负责最终边界校验，Host 只负责把真实 target/baseRevision/baseLogEpoch 交给
 * 同一 command owner，并区分「明确拒绝」「结果不明」「旧 Agent 不支持」。
 */
interface HostForkAssistantParams extends ZCodeAgentWorkspaceTarget {
  sessionId: string;
  target: { rowId: number; entityId: string };
  baseRevision: number;
  baseLogEpoch: string;
  /** 受管 worktree：由 Host 预分配 child id 与子会话 cwd；App fork 省略。 */
  targetCwd?: { cwd: string; childSessionId: string };
  /** App 请求的幂等身份（同一 caller+requestId 重试复用）。 */
  commandId?: string;
  clientId?: string;
  clientMode?: "desktop-continuous" | "web-remote-replayable";
}

type HostForkAssistantResult =
  | { status: "created"; sessionId: string }
  | { status: "rejected"; reason?: string }
  | { status: "unknown"; reason?: string }
  | { status: "unsupported"; reason?: string };

/** 旧 Agent 对 v4/command 的明确「不认识」；其它传输错误仍按未知上抛给调用方。 */
function isUnsupportedForkCommand(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  if (code === -32601) return true;
  const message = error instanceof Error ? error.message : String(error);
  return (
    /Method not found[^\n]*v4\/command/i.test(message) ||
    /fault\.command\.unsupported/i.test(message)
  );
}

export async function sendHostForkAssistant(
  sendConversationCommandV4: IZCodeAgentService["sendConversationCommandV4"],
  params: HostForkAssistantParams,
): Promise<HostForkAssistantResult> {
  const envelope = createHostCommandEnvelope({
    type: "forkAssistant",
    sessionId: params.sessionId,
    payload: {
      target: params.target,
      ...(params.targetCwd ? { targetCwd: params.targetCwd } : {}),
    },
    baseRevision: params.baseRevision,
    baseLogEpoch: params.baseLogEpoch,
    ...(params.commandId ? { commandId: params.commandId } : {}),
    ...(params.clientId ? { clientId: params.clientId } : {}),
  });
  let ack: CommandAck;
  try {
    ack = await sendConversationCommandV4({
      workspacePath: params.workspacePath,
      ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
      ...(params.remoteSessionId ? { remoteSessionId: params.remoteSessionId } : {}),
      ...(params.clientMode ? { clientMode: params.clientMode } : {}),
      envelope,
    });
  } catch (error) {
    if (isUnsupportedForkCommand(error))
      return {
        status: "unsupported",
        reason: error instanceof Error ? error.message : "forkAssistant is not supported",
      };
    // 传输中断可能发生在 CLI 已接受命令之后：调用方必须按 unknown 处理，不能猜成功。
    throw error;
  }
  if (ack.result?.type === "forkAssistant")
    return { status: "created", sessionId: ack.result.sessionId };
  if (ack.status === "rejected" || ack.status === "stale" || ack.status === "failed")
    return { status: "rejected", reason: ack.reasonCode ?? ack.status };
  return { status: "unknown", reason: ack.reasonCode ?? `forkAssistant ${ack.status}` };
}
