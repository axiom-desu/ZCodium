export { createTaskFacts } from "#src/task-facts/app/index.js";
export { repairSubagentTaskIndex } from "#src/task-facts/app/repairSubagentTaskIndex.js";
export type { CliSessionFacts, CliTaskFacts } from "#src/task-facts/domain/facts.js";
export type { TaskFactsContract, TaskFactChange } from "#src/task-facts/domain/contract.js";
export type {
  TaskFactMutation,
  TaskFactSource,
  TaskFactStore,
  TaskFactTarget,
  TaskWorkspace,
} from "#src/task-facts/domain/ports.js";
