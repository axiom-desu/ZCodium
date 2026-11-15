import type { IProjectService } from "./contract.js";

export async function readProjectTree(service: IProjectService) {
  return service.readTree();
}

/** 撤销软删除是幂等命令：目录缺失也要能恢复（不校验目录存在）。 */
export async function restoreRemovedProject(service: IProjectService, id: string) {
  return service.restoreProject(id);
}

/** 只删已软删除项目的本机数据：运行中/被引用的会话保留，返回真实释放量供进度显示。 */
export async function deleteRemovedProjectData(service: IProjectService, id: string) {
  return service.deleteProjectData(id, "local");
}
