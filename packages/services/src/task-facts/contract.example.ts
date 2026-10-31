import type { TaskFactsContract } from "./contract.js";

export async function refreshTaskExample(taskFacts: TaskFactsContract, taskId: string) {
  return taskFacts.refresh({ workspacePath: "/repo", taskId });
}
