import { randomBytes } from "node:crypto";

/**
 * 每个插件自己的 loopback 凭据。`authenticate` 是唯一的 token → pluginId 绑定来源：
 * 网关只相信这里返回的身份，body 里的 pluginId 不能覆盖它。
 */
interface ExtensionCredentials {
  issue(pluginId: string): string;
  revoke(pluginId: string): void;
  authenticate(token: string): string | null;
  has(pluginId: string): boolean;
  clear(): void;
}

export function createExtensionCredentials(): ExtensionCredentials {
  const tokens = new Map<string, string>();
  const owners = new Map<string, string>();

  function revoke(pluginId: string): void {
    const token = tokens.get(pluginId);
    if (!token) return;
    tokens.delete(pluginId);
    owners.delete(token);
  }

  return {
    issue(pluginId) {
      revoke(pluginId);
      const token = randomBytes(32).toString("hex");
      tokens.set(pluginId, token);
      owners.set(token, pluginId);
      return token;
    },
    revoke,
    authenticate: (token) => owners.get(token) ?? null,
    has: (pluginId) => tokens.has(pluginId),
    clear() {
      tokens.clear();
      owners.clear();
    },
  };
}
