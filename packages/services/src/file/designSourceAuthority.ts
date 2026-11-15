import { isAbsolute, resolve } from "node:path";
import type { IProjectService } from "#src/project/contract.js";

/**
 * B7：设计工具读写源码的服务端批准根。
 *
 * 只读、每次调用重新求值；来源只能是本 Host 既有的 project/task 目录事实。
 * 没有 authority 的装配（旧构造、Web/server Host、desktop-attached-remote Host）
 * 让 designSource* 端口 fail closed，而不是退回到「信 renderer 传的 rootPath」。
 */
export interface DesignSourceAuthority {
  resolveApprovedRoots(): Promise<readonly string[]>;
}

/** 批准根与请求 root 用同一套绝对路径规范化；非绝对/空值不进入批准集合。 */
export function normalizeApprovedDesignSourceRoots(roots: readonly string[]): ReadonlySet<string> {
  const normalized = new Set<string>();
  for (const root of roots) {
    if (typeof root !== "string" || !root.trim() || !isAbsolute(root)) continue;
    normalized.add(resolve(root));
  }
  return normalized;
}

/**
 * 从本 Host 的项目树派生批准根：未删除项目的 roots + 任务当前 workspace/cwd。
 *
 * 不缓存、不落库、不新建 store：设计读写每次都重新 readTree，项目移除/改 root 后
 * 下一次调用立即失效（= stale grant 不再被信任）。远端 Host 的行不属于本 Host，
 * 因此也不会把远端绝对路径拿到本机解析。
 */
export async function readApprovedDesignSourceRoots(
  projectService: Pick<IProjectService, "readTree">,
  ownerHostId = "local",
): Promise<readonly string[]> {
  const tree = await projectService.readTree({
    includeDeleted: false,
    includeDeletedTasks: false,
  });
  const roots: string[] = [];
  const add = (path: string) => {
    // 项目/任务事实按契约是绝对路径；坏行只跳过该行，不能把相对路径带成批准根。
    if (typeof path === "string" && isAbsolute(path)) roots.push(path);
  };
  for (const project of tree.projects) {
    if (project.deleted || project.hostId !== ownerHostId) continue;
    for (const root of project.roots) add(root.rootPath);
  }
  for (const task of tree.tasks) {
    if (task.hostId !== ownerHostId) continue;
    add(task.workspacePath);
  }
  return roots;
}
