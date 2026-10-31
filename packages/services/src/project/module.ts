/**
 * project 模块清单（architecture-governance managed 模块）。
 * 层：domain（契约）/ app（项目用例与自动归档策略）/ adapters（旧远端只读适配）。
 */
export const projectModule = {
  id: "project",
  requires: ["project-storage", "services", "shared"],
  provides: ["project"],
  publicEntrypoints: ["index.ts", "contract.ts", "app/autoArchiveScheduler.ts"],
} as const;
