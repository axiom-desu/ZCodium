import type { ProjectSidebarTreeFacts, ProjectTree } from "./contract.js";
import { selectProjectRows, selectUnassignedTasks, selectVisibleProjects } from "./view.js";

/** 只读用法示例：调用方仍通过模块公开 hook 读取，不自行缓存项目行。 */
export function readProjectSidebarRows(facts: ProjectSidebarTreeFacts, tree: ProjectTree) {
  const unassigned = selectUnassignedTasks(tree, new Set());
  return {
    projects: selectVisibleProjects(tree),
    tasks: selectProjectRows(tree, { kind: "unassigned" }),
    projectRows: facts.projects.map((project) => ({
      project,
      tasks: facts.projectTasks(project),
    })),
    unassigned,
  };
}
