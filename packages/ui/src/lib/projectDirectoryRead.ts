import type { FileEntry } from "@zcode/shared";
import type { IFileService, IProjectService } from "@zcode/services";

/**
 * Source/远端目录浏览的唯一读取选择：
 * 有 Project 服务时走所属 Host 的 IProjectService.readDirectory（真实项目服务、不启动 Agent），
 * 只有旧 Host 尚未注册 Project 通道时才回退既有 file.readdir。UI 不直接拼 hostId。
 */
interface ProjectDirectoryReadServices {
  projectService?: Pick<IProjectService, "readDirectory">;
  fileService: Pick<IFileService, "readdir">;
}

export async function readProjectDirectoryEntries(
  services: ProjectDirectoryReadServices,
  params: { path: string; includeHidden?: boolean },
): Promise<FileEntry[]> {
  if (services.projectService) {
    const result = await services.projectService.readDirectory({
      path: params.path,
      ...(params.includeHidden !== undefined ? { includeHidden: params.includeHidden } : {}),
    });
    return result.entries;
  }
  return services.fileService.readdir({
    path: params.path,
    ...(params.includeHidden !== undefined ? { includeHidden: params.includeHidden } : {}),
  });
}
