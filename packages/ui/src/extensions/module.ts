export const extensionSlotsModule = {
  id: "extension-slots",
  requires: ["ui", "shared", "services", "extension-host-protocol", "extension-host-service"],
  provides: ["extension-slots"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
