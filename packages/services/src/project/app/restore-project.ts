import { z } from "zod";
import type { ProjectRepositoryContract } from "#src/project-storage/contract.js";
import type { VirtualProject } from "#src/project/domain/contract.js";

/**
 * 撤销软删除（上游 `docs/superpowers/specs/2026-10-24-project-management.md`「恢复命令」）。
 *
 * 幂等；不存在报 `project.not-found`；跨 Host 拒绝。写路径复用仓储既有
 * `saveProject({ restoreProjectId, roots })`：清 deleted、名称按保存规则重新派生、重名加序号，
 * roots/置顶/顺序不变。**刻意不校验目录存在**——否则「文件夹不存在」的项目永远无法撤销；
 * 主目录失效继续由 `primaryRootStatus` 与 `prepareSession` 表达。
 */
export async function restoreProjectWith(
  repository: ProjectRepositoryContract,
  ownerHostId: string,
  id: string,
): Promise<VirtualProject> {
  z.string().min(1).parse(id);
  const project = repository
    .readTree({ includeDeleted: true, includeTasks: false })
    .projects.find((entry) => entry.id === id);
  if (!project) throw new Error("project.not-found");
  if (project.hostId !== ownerHostId) throw new Error("project.cross-host-move");
  // 未删除的项目直接返回当前事实，不改名称/roots/置顶/顺序。
  if (!project.deleted) return project;
  return repository.saveProject({
    restoreProjectId: id,
    roots: project.roots.map((root) => root.rootPath),
  });
}
