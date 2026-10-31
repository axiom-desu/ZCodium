import type { ProjectMigrationContext } from "#src/project-storage/domain/contract.js";

type SavedEntry = NonNullable<
  NonNullable<ProjectMigrationContext["settings"]>["lastWorkspaceSession"]
>[number];

export function savedRootName(path: string): string {
  const separator = path.includes("\\") ? "\\" : "/";
  const name = path.slice(path.lastIndexOf(separator) + 1);
  return name || path;
}

/** 认证数据（口令/私钥内容）永远不进组织库；只保留脱敏的连接描述。 */
export function sanitizedTarget(entry: SavedEntry): Record<string, string | number> | null {
  if (entry.kind !== "remote") return null;
  const target = entry.target;
  if (target.kind === "ssh")
    return { kind: "ssh", host: target.host, port: target.port ?? 22, username: target.username };
  if (target.kind === "wsl")
    return { kind: "wsl", ...(target.distro ? { distro: target.distro } : {}) };
  if (target.kind === "server")
    // Source 直连只保留可展示的地址/身份；token 与 workspace 内容都不进组织库。
    return {
      kind: "server",
      url: target.url,
      ...(target.serverId ? { serverId: target.serverId } : {}),
    };
  return { kind: "docker", container: target.container };
}

/** 同一旧 settings 条目的稳定脱敏字面量；首次导入与混排顺序迁移共用同一份。 */
export function legacyWorkspaceJson(entry: SavedEntry): string {
  if (entry.kind !== "remote") return JSON.stringify(entry);
  return JSON.stringify({
    kind: "remote",
    workspacePath: entry.workspacePath,
    ...(entry.workspaceIdentity ? { workspaceIdentity: entry.workspaceIdentity } : {}),
    target: sanitizedTarget(entry),
    lastOpenedAt: entry.lastOpenedAt,
    lastConnectionStatus: entry.lastConnectionStatus,
    ...(entry.lastConnectionError ? { lastConnectionError: entry.lastConnectionError } : {}),
  });
}
