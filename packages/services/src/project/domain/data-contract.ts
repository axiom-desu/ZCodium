// 项目数据彻底删除的端口与结果类型；IProjectService 的两条数据命令使用这些类型。
// 规格：docs/superpowers/specs/2026-10-24-project-management.md「彻底删除数据」（本仓
// .agents/specs/upstream-3.18-project-data.md §3）。

/**
 * 彻底删除数据的一个会话：sessionId 即任务 ID；workspacePath 是会话的归属 workspace，
 * 决定由哪个 Agent 进程执行。worktree 任务的 cwd 与它不同。
 */
export interface ProjectDataSession {
  sessionId: string;
  workspacePath: string;
}

/**
 * 项目数据删除的副作用端口（node.ts 装配：CLI 会话数据 + git checkpoint 目录）。
 * 大小只统计真正从磁盘删除的文件；数据库行删除不计入（库文件不收缩）。
 */
export interface ProjectDataPort {
  measure(input: { sessions: ProjectDataSession[]; directories: string[] }): Promise<{
    sessions: Array<{ sessionId: string; bytes: number }>;
    directories: Array<{ path: string; memoryBytes: number; checkpointBytes: number }>;
  }>;
  /** 运行中、或附件仍被别的会话引用的会话保留在 kept；文件删除失败的会话保留行并计入 failed。 */
  purgeSessions(sessions: ProjectDataSession[]): Promise<{
    deleted: Array<{ sessionId: string; bytes: number }>;
    kept: Array<{ sessionId: string; reason: "running" | "referenced" }>;
    failed: string[];
  }>;
  /** 删除这些目录的记忆与文件检查点。 */
  purgeDirectories(directories: string[]): Promise<{ bytes: number; failed: string[] }>;
}

export interface ProjectDataMeasure {
  id: string;
  sessions: number;
  sessionBytes: number;
  checkpointBytes: number;
  memoryBytes: number;
}

export interface ProjectDataDeleteResult {
  freedBytes: number;
  deletedSessions: number;
  /** 仍在运行而保留的会话数；>0 时项目保持软删除，可恢复、可重试。 */
  runningSessions: number;
  /** 附件仍被别的会话（如别的项目里的 fork）引用而保留的会话数；同样保持软删除。 */
  referencedSessions: number;
  /** 删除失败的会话与目录数；>0 时同样保持软删除。 */
  failed: number;
}

export interface ProjectDataMeasureResult {
  projects: ProjectDataMeasure[];
}

/**
 * 项目数据彻底删除的两条命令。与 IProjectService 同一 Host 服务实例实现（同一仓储、同一广播），
 * 单独成接口是为了把「项目组织态」与「本机副作用删除」的边界写在契约上。
 */
export interface IProjectDataService {
  /** 只读测量；不支持时抛 `project.data-unavailable`，不返回 0 字节。 */
  measureProjectData(ids: string[], hostId?: string): Promise<ProjectDataMeasureResult>;
  /** 只删已软删除的项目数据；远程报 `project.data-local-only`。 */
  deleteProjectData(id: string, hostId?: string): Promise<ProjectDataDeleteResult>;
}
