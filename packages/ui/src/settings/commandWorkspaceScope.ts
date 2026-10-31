import type { CommandStorageLevel } from "@zcode/shared";
import { getPluginWorkspaceKey } from "@/settings/PluginScopeMenu.js";
import type { PluginWorkspaceTarget } from "@/lib/configDirectoryCatalog.js";

type CommandScopeRecovery = "keep" | "fallback-user" | "close-editor";

export function resolveCommandScopeRecovery(params: {
  editing: boolean;
  scopeKey: string;
  workspaceTabs: readonly PluginWorkspaceTarget[];
}): CommandScopeRecovery {
  if (
    params.scopeKey === "user" ||
    params.workspaceTabs.some((tab) => getPluginWorkspaceKey(tab) === params.scopeKey)
  ) {
    return "keep";
  }
  return params.editing ? "close-editor" : "fallback-user";
}

export function resolveCommandStorageTarget(
  scopeKey: string,
  workspaceTabs: readonly PluginWorkspaceTarget[],
): {
  storageLevel: CommandStorageLevel;
  workspace: PluginWorkspaceTarget | null;
} {
  if (scopeKey === "user") {
    return { storageLevel: "user", workspace: null };
  }
  return {
    storageLevel: "project",
    workspace: workspaceTabs.find((tab) => getPluginWorkspaceKey(tab) === scopeKey) ?? null,
  };
}

export function shouldRefreshCurrentCommandList(
  scopeKey: string,
  currentWorkspaceKey: string,
): boolean {
  return scopeKey === "user" || scopeKey === currentWorkspaceKey;
}
