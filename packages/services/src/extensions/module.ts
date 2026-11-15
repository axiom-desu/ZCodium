export const extensionHostServiceModule = {
  id: "extension-host-service",
  requires: ["services", "shared", "rpc", "extension-host-protocol"],
  provides: ["extension-host-service"],
  publicEntrypoints: ["index.ts", "contract.ts", "node.ts"],
} as const;
