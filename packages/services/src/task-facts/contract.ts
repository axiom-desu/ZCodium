/** 公开契约再导出；实现位于 domain/app 分层，UI/装配只依赖此入口。 */
export type { CliSessionFacts, CliTaskFacts } from "#src/task-facts/domain/facts.js";
export type { TaskFactsContract, TaskFactChange } from "#src/task-facts/domain/contract.js";
export type {
  TaskFactMutation,
  TaskFactSource,
  TaskFactStore,
  TaskFactTarget,
  TaskWorkspace,
} from "#src/task-facts/domain/ports.js";
export type { SubagentIndexRepair } from "#src/task-facts/domain/subagentRepair.js";
