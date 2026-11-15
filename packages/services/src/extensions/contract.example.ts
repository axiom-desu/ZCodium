import type { ExtensionsSnapshot } from "./contract.js";

/** 空快照：Host 尚未启动扩展进程时的稳定投影。 */
export const exampleStoppedExtensionsSnapshot: ExtensionsSnapshot = {
  revision: 0,
  generation: 0,
  workspaceIdentity: null,
  phase: "stopped",
  plugins: [],
  slots: [],
};

/** 已授权的单插件快照；slot 只能是宿主内置槽位与图标。 */
export const exampleReadyExtensionsSnapshot: ExtensionsSnapshot = {
  revision: 3,
  generation: 1,
  workspaceIdentity: "local:/tmp/workspace",
  phase: "ready",
  plugins: [
    {
      pluginId: "example-extensions",
      name: "Example Extensions",
      version: "1.0.0",
      declared: ["projects.read"],
      granted: ["projects.read"],
      recorded: ["projects.read"],
      status: "granted",
      capabilities: ["settings.get", "projects.list", "context.get"],
      protocols: { projects: 1 },
      consentedAt: 1_700_000_000_000,
    },
  ],
  slots: [
    {
      pluginId: "example-extensions",
      pluginName: "Example Extensions",
      generation: 1,
      id: "nav-projects",
      slot: "navigation.primary",
      title: "Projects",
      icon: "list",
    },
  ],
};
