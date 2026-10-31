/**
 * task-facts 模块清单（architecture-governance managed 模块）。
 * 层：domain（纯契约）/ app（会话事实摄入与命令交接用例）；IO 通过端口注入。
 */
export const taskFactsModule = {
  id: "task-facts",
  requires: ["shared"],
  provides: ["task-facts"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
