export const extensionHostProtocolModule = {
  id: "extension-host-protocol",
  requires: [],
  provides: ["extension-host-protocol"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
