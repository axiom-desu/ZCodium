import type { VirtualProject } from "#src/project/contract.js";
import type { RemoteProjectEntry } from "#src/project-storage/contract.js";
import type { ProjectCatalog } from "#src/remote-projects/contract.js";

/**
 * 只读组合，不引入第二份状态：本机项目原样返回，远端入口只做离线隐藏投影。
 * connection facts 不在这里合并；调用方仍从 registry 读取在线/身份。
 */
export function composeProjectCatalog(input: {
  localProjects: readonly VirtualProject[];
  remoteEntries: readonly RemoteProjectEntry[];
}): ProjectCatalog {
  return {
    localProjects: [...input.localProjects],
    remoteProjects: input.remoteEntries.filter((entry) => !entry.cachedDeleted),
  };
}
