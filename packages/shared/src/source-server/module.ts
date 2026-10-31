/**
 * source-server 模块清单（architecture-governance managed 模块）。
 * 层：domain。纯 schema/版本比较/错误分类，不进行 IO。修改 requires 时同步更新
 * architecture-policy.yaml（检查器会校验两者一致）。
 */
export const sourceServerModule = {
  id: "source-server",
  requires: ["shared"],
  provides: ["source-server"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
