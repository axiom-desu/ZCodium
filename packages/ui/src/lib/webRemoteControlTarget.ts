import type { WebRemoteControlStatusSnapshot } from "@zcode/shared";
import { getWorkspaceKey } from "./workspaceKey.js";

/**
 * 判断远控快照是否就是「当前 workspace + 当前 remoteSessionId」这一目标。
 *
 * Bugfix: 之前打开弹层时仅凭 status 非 idle/error 就复用会话，会把其他 workspace 的旧会话
 * 误当成当前目标，导致当前 workspace 不触发 start、状态长期卡在 starting。
 * 这里改为严格比较 workspaceKey（workspaceIdentity 优先，缺省回退 workspacePath）与
 * remoteSessionId，确保会话和目标一一对应。
 */
export function isSameWebRemoteControlTarget(
  status: WebRemoteControlStatusSnapshot,
  workspacePath: string,
  workspaceIdentity?: string,
  remoteSessionId?: string,
): boolean {
  if (status.status === "idle" || status.status === "error") {
    return false;
  }

  const statusWorkspacePath = status.workspacePath?.trim();
  if (!statusWorkspacePath) {
    return false;
  }

  const expectedWorkspaceKey = getWorkspaceKey(workspacePath, workspaceIdentity);
  const statusWorkspaceKey = getWorkspaceKey(statusWorkspacePath, status.workspaceIdentity);
  if (statusWorkspaceKey !== expectedWorkspaceKey) {
    return false;
  }

  const expectedRemoteSessionId = remoteSessionId?.trim() || undefined;
  const statusRemoteSessionId = status.remoteSessionId?.trim() || undefined;
  if (statusRemoteSessionId !== expectedRemoteSessionId) {
    return false;
  }

  return Boolean(status.windowControlSessionId ?? status.sessionId);
}

/**
 * 已连上手机的会话跨 workspace 也要复用：打开弹层只是管理当前窗口的远控入口，
 * 不能因为当前 workspace 与手机桥接的 workspace 不一致就重启 relay 会话，
 * 否则会主动给手机发 desktop-disconnected。
 */
export function isReusableWebRemoteControlSession(status: WebRemoteControlStatusSnapshot): boolean {
  if (status.status === "idle" || status.status === "error") {
    return false;
  }

  return Boolean(status.mobileConnected && (status.windowControlSessionId ?? status.sessionId));
}
