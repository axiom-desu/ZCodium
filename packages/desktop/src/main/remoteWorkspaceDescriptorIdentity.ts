import {
  buildRemoteWorkspaceIdentity,
  buildServerRemoteWorkspaceIdentity,
  type RemoteTarget,
} from "@zcode/shared";

/**
 * Main 只能转发 Host descriptor 的 Source 身份。
 * - 同路径优先 Host 已验证的 exact key，不把 legacy 主 descriptor 重新 canonicalize。
 * - 切路径沿已验证身份种类派生候选，renderer hint 仍交 Host 验证，不能覆盖握手身份。
 * - 其他传输：沿用既有 renderer identity / target 派生逻辑。
 */
export function resolveBoundRemoteWorkspaceIdentity(params: {
  descriptor: {
    sourceServerId?: string;
    workspacePath?: string;
    workspaceIdentity?: string;
    target: RemoteTarget;
  };
  workspacePath: string;
  rendererWorkspaceIdentity?: string;
}): string {
  const rendererIdentity = params.rendererWorkspaceIdentity?.trim();
  const descriptor = params.descriptor;
  // Bug 原因：强制 canonical 会让两个合法旧绑定共用 history/execution key，手机 exact scope 随之失配。
  // 同路径必须转发 Host 的主 key；切目录仅保留已经由 Host 验证的 transport 身份种类。
  if (descriptor.workspacePath === params.workspacePath && descriptor.workspaceIdentity) {
    return descriptor.workspaceIdentity;
  }
  if (
    descriptor.sourceServerId &&
    descriptor.target.kind !== "server" &&
    descriptor.workspacePath &&
    descriptor.workspaceIdentity ===
      buildRemoteWorkspaceIdentity(descriptor.workspacePath, descriptor.target)
  ) {
    return buildRemoteWorkspaceIdentity(params.workspacePath, descriptor.target);
  }
  if (descriptor.sourceServerId) {
    return buildServerRemoteWorkspaceIdentity({
      serverId: descriptor.sourceServerId,
      workspacePath: params.workspacePath,
    });
  }
  return (
    rendererIdentity || buildRemoteWorkspaceIdentity(params.workspacePath, params.descriptor.target)
  );
}
