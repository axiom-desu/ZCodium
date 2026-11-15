export const appControlModule = {
  id: "app-control",
  requires: ["session-control", "services", "shared", "project"],
  provides: ["app-control"],
  publicEntrypoints: ["index.ts", "contract.ts"],
  layers: { contract: "contract.ts", app: "." },
  layerOrder: ["contract", "app"],
} as const;
