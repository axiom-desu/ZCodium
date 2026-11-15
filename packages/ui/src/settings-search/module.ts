/**
 * settings-search 模块清单（architecture-governance managed 模块候选）。
 * 层：ui。修改 requires 时同步更新 architecture-policy.yaml（由主代理统一登记）。
 */
export const settingsSearchModule = {
  id: "settings-search",
  requires: ["ui"],
  provides: ["settings-search"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
