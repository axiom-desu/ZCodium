/**
 * data-sync 模块清单（architecture-governance managed 模块；policy 登记由整合方 G1 完成）。
 * 层：contract < domain（比较/投影纯函数）< app（分类适配器、加载与推送、弹窗状态）< ui（设置页与弹窗、index）。
 * 修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const dataSyncModule = {
  id: "data-sync",
  requires: ["services", "shared", "ui"],
  provides: ["data-sync"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
