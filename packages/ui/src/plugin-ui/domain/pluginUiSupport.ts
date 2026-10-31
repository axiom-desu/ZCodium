import { isRemoteWorkspaceIdentity } from "@zcode/shared";

/** 本地桌面 + 已注入平台/桥时才创建 guest；其余环境回退普通 MCP 记录。 */
export function supportsPluginUiGuest(input: {
  hasPlatformSandbox: boolean;
  hasBridge: boolean;
  remoteSessionId?: string | null;
  workspaceIdentity?: string | null;
  enabled?: boolean;
}): boolean {
  return Boolean(
    input.enabled !== false &&
    input.hasPlatformSandbox &&
    input.hasBridge &&
    !input.remoteSessionId &&
    !isRemoteWorkspaceIdentity(input.workspaceIdentity ?? ""),
  );
}
