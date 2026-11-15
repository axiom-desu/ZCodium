import type { ExtensionsSnapshot } from "@zcode/services";
import type { ExtensionSlotViewState } from "./contract.js";

export const exampleReadySnapshot: ExtensionsSnapshot = {
  revision: 2,
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
      capabilities: ["projects.list"],
      protocols: { projects: 1 },
    },
  ],
  slots: [
    {
      pluginId: "example-extensions",
      pluginName: "Example Extensions",
      generation: 1,
      id: "status-projects",
      slot: "status.composer",
      title: "Projects",
      icon: "list",
    },
  ],
};

/** 待授权插件的 UI 视图；声明的档位逐个给出人话说明（sessions.write 包含 read）。 */
export const examplePendingSlotView: ExtensionSlotViewState = {
  available: true,
  loading: false,
  phase: "stopped",
  slots: [],
  pending: [
    {
      pluginId: "example-extensions",
      name: "Example Extensions",
      declared: ["projects.read", "sessions.write"],
    },
  ],
  canStart: true,
};
