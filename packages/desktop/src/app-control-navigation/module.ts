export const appControlNavigationModule = {
  id: "app-control-navigation",
  requires: ["shared", "services", "desktop"],
  provides: ["app-control-navigation"],
  publicEntrypoints: ["contract.ts", "index.ts", "host.ts", "main.ts", "renderer.ts"],
} as const;
