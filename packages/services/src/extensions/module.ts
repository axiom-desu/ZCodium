export const extensionHostServiceModule = {
  id: "extension-host-service",
  // 会话能力经既有 AppControlService.bindClient 路由；不新建 session/task owner。
  requires: [
    "services",
    "shared",
    "rpc",
    "extension-host-protocol",
    "app-control",
    "session-control",
  ],
  provides: ["extension-host-service"],
  publicEntrypoints: ["index.ts", "contract.ts", "node.ts"],
} as const;
