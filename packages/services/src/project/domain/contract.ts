import type { FileEntry } from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "#src/descriptors.js";
import type {
  ProjectDirectories,
  ProjectTaskGroupMoveInput,
  ProjectTaskRef,
  ProjectTree,
  SaveProjectInput,
  VirtualProject,
} from "#src/project-storage/contract.js";

export type {
  ProjectDirectories,
  ProjectRoot,
  ProjectTask,
  ProjectTaskGroup,
  ProjectTaskGroupColor,
  ProjectTaskGroupMember,
  ProjectTaskGroupMoveInput,
  ProjectTaskGroupNode,
  ProjectTaskGroupStructure,
  ProjectTaskGroupTopOrder,
  ProjectTaskRef,
  ProjectTree,
  SaveProjectInput,
  VirtualProject,
} from "#src/project-storage/contract.js";

/** 当前 Host 的权威项目服务；远端通过现有 attachment 的服务代理调用。 */
export interface IProjectService {
  /** 项目选目录只访问所属 Host 的文件服务；不建立 workspace 或启动 Agent。 */
  readDirectory(params?: {
    hostId?: string;
    path?: string;
    includeHidden?: boolean;
  }): Promise<{ path: string; entries: FileEntry[] }>;
  /** 配置目录与项目选择；所属 Host 派生主目录状态，不加载任务。 */
  readProjects(params?: { includeDeleted?: boolean; hostId?: string }): Promise<VirtualProject[]>;
  /** SQLite 快照与所属 Host 主目录状态的只读投影；不为查询启动 Agent，也不触发自动归档。 */
  readTree(params?: {
    includeDeleted?: boolean;
    includeDeletedTasks?: boolean;
    hostId?: string;
  }): Promise<ProjectTree>;
  /** 提交前校验目录存在；root 改动不触碰既有任务 cwd。恢复必须明确给出 ID 与同一组 roots。 */
  saveProject(input: SaveProjectInput): Promise<VirtualProject>;
  /** 幂等软删除容器，保留任务归属与 roots。 */
  deleteProject(id: string, hostId?: string): Promise<void>;
  /** 跨 host 拒绝；缺 root 时必须明确 addMissingRoot 才原子加入并移动。 */
  moveTask(input: {
    task: ProjectTaskRef;
    projectId: string;
    hostId?: string;
    addMissingRoot?: boolean;
  }): Promise<void>;
  reorderProjects(ids: string[], hostId?: string): Promise<void>;
  /** 单节点分组/顶层移动；来源与锚点在同一 Host 事务内复检，失败不改任何行。 */
  moveTaskGroupNode(input: ProjectTaskGroupMoveInput, hostId?: string): Promise<void>;
  /**
   * 固化本次创建 cwd 与附加目录，并复检主目录。
   * 结果冻结为 create/resume 的唯一目录合同（S8-C 直接消费，不另建配置通道）。
   */
  prepareSession(params?: {
    projectId?: string;
    hostId?: string;
    draftId?: string;
    reuseDraft?: boolean;
  }): Promise<ProjectDirectories>;
  /** 缺 task = []，缺 project / DB 错误必须拒绝。软删项目仍可恢复历史任务。 */
  resolveSessionDirectories(task: ProjectTaskRef, hostId?: string): Promise<ProjectDirectories>;
}
export const IProjectService = createServiceDescriptor<IProjectService>(ServiceChannels.Project);
