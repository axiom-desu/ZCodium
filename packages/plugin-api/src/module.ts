/**
 * plugin-api 模块清单（architecture-governance managed 模块）。
 * 只重导出 extension-host 的公开类型/SDK；修改 requires 时同步更新 architecture-policy.yaml。
 */
export const pluginApiModule = {
  id: "plugin-api",
  requires: ["shared", "extension-host-protocol"],
  provides: ["plugin-api"],
  publicEntrypoints: ["index.ts", "manifest.ts", "contract.ts"],
} as const;
