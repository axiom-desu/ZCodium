import type { RemoteTarget } from "./remoteTarget.js";
import { buildSshRemoteHostKey } from "./remoteSshHostKey.js";

/**
 * Provider Provisioning 等 Environment 级状态的稳定身份；不得混用 workspace/session 身份。
 */
export function buildRemoteEnvironmentKey(target: RemoteTarget): string {
  switch (target.kind) {
    case "ssh":
      return `ssh:${buildSshRemoteHostKey(target)}`;
    case "wsl":
      return `wsl:${target.distro?.trim() || "<default>"}\0${target.user?.trim() || "<default>"}`;
    case "docker":
      return `docker:${target.container.trim()}`;
    case "server":
      // Source 的 Environment 身份优先用握手得到的稳定 serverId；未握手时只用去噪端点，
      // 绝不把 token/query 纳入身份。
      return `server:${target.serverId?.trim() || normalizeServerEndpoint(target.url)}`;
  }
}

function normalizeServerEndpoint(url: string): string {
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol === "ws:") parsed.protocol = "http:";
    if (parsed.protocol === "wss:") parsed.protocol = "https:";
    parsed.hash = "";
    parsed.search = "";
    const path = parsed.pathname.replace(/\/+$/gu, "");
    parsed.pathname = path.endsWith("/ws") ? path.slice(0, -3) || "/" : path || "/";
    return parsed.toString().replace(/\/$/gu, "");
  } catch {
    return url.trim().replace(/\/+$/gu, "");
  }
}
