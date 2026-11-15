import { randomUUID } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import {
  isPathInside,
  isSamePath,
  mapProjectRootsIntoWorktree,
  resolveManagedWorktreeSourcePath,
  type ManagedWorktreeError,
  type ManagedWorktreeErrorCode,
  type ManagedWorktreeGroup,
} from "@zcode/shared/managed-worktree";
import type { IManagedWorktreeService } from "#src/managed-worktree-tasks/contract.js";
import type { ManagedWorktreeTaskPorts } from "#src/managed-worktree-tasks/ports.js";
import {
  releaseSessionsUnder,
  settleFailedCreation,
} from "#src/managed-worktree-tasks/session-failure.js";

const fsPort = {
  readFile: (path: string) => readFile(path, "utf8"),
  realpath,
  async stat(path: string) {
    try {
      const value = await stat(path);
      return { isFile: value.isFile(), isDirectory: value.isDirectory() };
    } catch {
      return null;
    }
  },
};

function errorOf(code: ManagedWorktreeErrorCode, detail?: string): ManagedWorktreeError {
  return { code, ...(detail ? { detail } : {}) };
}

export function createManagedWorktreeTaskService(
  ports: ManagedWorktreeTaskPorts,
): IManagedWorktreeService {
  async function requireProject(projectId: string) {
    const project = (await ports.repository())
      .readTree()
      .projects.find((item) => item.id === projectId);
    if (!project) throw new Error("worktree.project-not-found");
    return project;
  }

  async function supportsWorktreeCwd(target: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }) {
    try {
      return await ports.agent.supportsWorktreeCwd(target);
    } catch {
      // 能力探测失败（未启动/旧连接）按不支持处理，不创建无法安全删除的任务。
      return false;
    }
  }

  /** 在项目 roots 里找到 path 的受管事实；只认 Git 验证过的布局。 */
  async function resolveManaged(projectId: string, path: string) {
    const project = await requireProject(projectId);
    for (const root of project.roots) {
      const listed = await ports.git.list(root.rootPath);
      const match = listed.find((item) => isSamePath(item.path, path));
      if (match) return { project, info: match };
    }
    return null;
  }

  async function listForProject(projectId: string): Promise<ManagedWorktreeGroup[]> {
    const project = await requireProject(projectId);
    const repository = await ports.repository();
    const groups = new Map<string, ManagedWorktreeGroup>();
    for (const root of project.roots) {
      const listed = await ports.git.list(root.rootPath);
      for (const info of listed) {
        const group = groups.get(info.sourceRoot) ?? {
          sourceRoot: info.sourceRoot,
          worktrees: [],
        };
        group.worktrees.push({
          ...info,
          // creating 由跨进程租约推导，不再读取本进程 Set。
          creating: (await ports.leases.readWorktree(info.path))?.kind === "creating",
          tasks: repository.listTasksByWorktree({ worktreeRoot: info.path }).map((task) => ({
            taskId: task.taskId,
            workspacePath: task.workspacePath,
            projectId: task.projectId,
            title: task.title,
            archived: task.archived,
          })),
        });
        groups.set(info.sourceRoot, group);
      }
    }
    return [...groups.values()];
  }

  async function createTask(
    params: Parameters<IManagedWorktreeService["createTask"]>[0],
  ): ReturnType<IManagedWorktreeService["createTask"]> {
    if (!ports.isLocalHost) return { ok: false, error: errorOf("not-local") };
    const project = await requireProject(params.projectId);
    const primary = project.roots.find((root) => root.isPrimary) ?? project.roots[0];
    if (!primary) return { ok: false, error: errorOf("not-repository") };
    // 新任务删除依赖 session/releaseUnderDirectory；旧 CLI 无此能力时不得开放创建。
    if (!(await supportsWorktreeCwd({ workspacePath: primary.rootPath, taskId: "" })))
      return { ok: false, error: errorOf("unsupported-agent") };
    // create 与 remove 在“建目录 → 取得 per-worktree 租约”窗口内按源仓库互斥，
    // 否则另一个窗口 Host 可能删除刚建好、尚未登记任务的目录。
    const sourceRoot = await realpath(primary.rootPath).catch(() => primary.rootPath);
    const sourceLease = await ports.leases.acquireSource({ sourceRoot, kind: "creating" });
    if (!sourceLease.acquired)
      return {
        ok: false,
        error: errorOf(
          "in-use",
          sourceLease.heldBy ? `source-${sourceLease.heldBy}` : "source-lease",
        ),
      };
    const creationId = randomUUID();
    // 预分配会话 ID：失败时用它与现有 receipt/任务行证明 CLI 是否已经接受该会话。
    const sessionId = `sess_${randomUUID().replaceAll("-", "")}`;
    try {
      const created = await ports.git.create(primary.rootPath, params.ref);
      if (!created.ok)
        return { ok: false, error: errorOf(created.error.code, created.error.detail) };
      const worktreeRoot = created.value.path;
      const worktreeLease = await ports.leases.acquireWorktree({
        worktreeRoot,
        kind: "creating",
      });
      if (!worktreeLease.acquired)
        return { ok: false, error: errorOf("in-use", worktreeLease.heldBy ?? "lease") };
      await sourceLease.release();
      try {
        const additionalDirectories = mapProjectRootsIntoWorktree(
          project.roots.map((root) => root.rootPath),
          { sourceRoot: created.value.sourceRoot, worktreeRoot, cwd: worktreeRoot },
        );
        // 复用既有 Host 会话入口：项目预占记录 projectId/worktreeRoot，随后才进 CLI CommandInbox。
        const session = await ports.agent.createSession({
          workspacePath: worktreeRoot,
          projectId: project.id,
          worktreeRoot,
          additionalDirectories,
          sessionId,
        });
        return {
          ok: true,
          value: {
            creationId,
            taskId: session.sessionId,
            workspacePath: worktreeRoot,
            worktreeRoot,
            projectId: project.id,
          },
        };
      } catch (cause) {
        return {
          ok: false,
          error: await settleFailedCreation(ports, {
            cause,
            sourceRoot: created.value.sourceRoot,
            worktreeRoot,
            sessionId,
            cliWorkspace: { workspacePath: worktreeRoot },
          }),
        };
      } finally {
        await worktreeLease.release();
      }
    } finally {
      // 已显式释放时是幂等 no-op；异常路径在这里兜底。
      await sourceLease.release();
    }
  }

  async function forkTask(
    params: Parameters<IManagedWorktreeService["forkTask"]>[0],
  ): ReturnType<IManagedWorktreeService["forkTask"]> {
    if (!ports.isLocalHost) return { ok: false, error: errorOf("not-local") };
    await requireProject(params.projectId);
    const parent = {
      taskId: params.sourceTaskId,
      workspacePath: params.sourceWorkspacePath,
      ...(params.sourceWorkspaceIdentity
        ? { workspaceIdentity: params.sourceWorkspaceIdentity }
        : {}),
    };
    // 旧 CLI 会静默丢弃 targetCwd，子任务会在父目录运行；先探测能力再建 worktree。
    if (!(await supportsWorktreeCwd(parent)))
      return { ok: false, error: errorOf("unsupported-agent") };
    const sourceRoot = await realpath(params.sourceWorkspacePath).catch(
      () => params.sourceWorkspacePath,
    );
    const sourceLease = await ports.leases.acquireSource({ sourceRoot, kind: "creating" });
    if (!sourceLease.acquired)
      return {
        ok: false,
        error: errorOf(
          "in-use",
          sourceLease.heldBy ? `source-${sourceLease.heldBy}` : "source-lease",
        ),
      };
    const childSessionId = `sess_${randomUUID().replaceAll("-", "")}`;
    try {
      const created = await ports.git.create(params.sourceWorkspacePath, params.ref ?? null);
      if (!created.ok)
        return { ok: false, error: errorOf(created.error.code, created.error.detail) };
      const worktreeRoot = created.value.path;
      const worktreeLease = await ports.leases.acquireWorktree({
        worktreeRoot,
        kind: "creating",
      });
      if (!worktreeLease.acquired)
        return { ok: false, error: errorOf("in-use", worktreeLease.heldBy ?? "lease") };
      await sourceLease.release();
      try {
        const repository = await ports.repository();
        // 预分配子会话与任务归属使用同一 ID；CLI forkAssistant 必须返回这个 ID。
        repository.reserveCreatedTask({
          task: { workspacePath: worktreeRoot, taskId: childSessionId },
          projectId: params.projectId,
          // 空数组表示本次派生目录快照；worktree cwd 不在项目 roots 内，必须显式给出。
          additionalDirectories: [],
          worktreeRoot,
        });
        const session = await ports.agent.forkSession({
          parent,
          target: params.target,
          targetCwd: { cwd: worktreeRoot, childSessionId },
          baseRevision: params.baseRevision,
          baseLogEpoch: params.baseLogEpoch,
        });
        // 子会话 ID 不一致说明 CLI 没有认领本次预留；保留目录与预留，不用删除来“纠正”。
        if (session.sessionId !== childSessionId)
          return { ok: false, error: errorOf("session-failed", "child session id mismatch") };
        return {
          ok: true,
          value: {
            creationId: childSessionId,
            taskId: childSessionId,
            workspacePath: worktreeRoot,
            worktreeRoot,
            projectId: params.projectId,
          },
        };
      } catch (cause) {
        // fork 的 ACK 可能丢失：仅 receipt 未认领不足以证明 CLI 没建子会话，
        // 还要父 workspace 的 CLI 驻留表报告该目录内没有会话。
        return {
          ok: false,
          error: await settleFailedCreation(ports, {
            cause,
            sourceRoot: created.value.sourceRoot,
            worktreeRoot,
            sessionId: childSessionId,
            cliWorkspace: parent,
          }),
        };
      } finally {
        await worktreeLease.release();
      }
    } finally {
      await sourceLease.release();
    }
  }

  async function removeWorktree(
    params: Parameters<IManagedWorktreeService["removeWorktree"]>[0],
  ): ReturnType<IManagedWorktreeService["removeWorktree"]> {
    if (!ports.isLocalHost) return { ok: false, error: errorOf("not-local") };
    const managed = await resolveManaged(params.projectId, params.worktreeRoot);
    if (!managed) return { ok: false, error: errorOf("not-managed") };
    // 先取得源仓库租约，再取得 per-worktree 删除租约；两者都是原子文件锁，
    // 不读取本进程 Set，因此另一个窗口 Host 的 creating/removing 同样可见。
    const sourceLease = await ports.leases.acquireSource({
      sourceRoot: managed.info.sourceRoot,
      kind: "removing",
    });
    if (!sourceLease.acquired)
      return {
        ok: false,
        error: errorOf(
          "in-use",
          sourceLease.heldBy ? `source-${sourceLease.heldBy}` : "source-lease",
        ),
      };
    let worktreeLease: Awaited<ReturnType<typeof ports.leases.acquireWorktree>>;
    try {
      worktreeLease = await ports.leases.acquireWorktree({
        worktreeRoot: managed.info.path,
        kind: "removing",
      });
    } finally {
      await sourceLease.release();
    }
    if (!worktreeLease.acquired)
      return { ok: false, error: errorOf("in-use", worktreeLease.heldBy ?? "lease") };
    try {
      const repository = await ports.repository();
      const tasks = repository.listTasksByWorktree({ worktreeRoot: managed.info.path });
      const running = tasks.filter((task) =>
        ports.agent.isTaskActive({
          workspacePath: task.workspacePath,
          taskId: task.taskId,
          ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
        }),
      );
      if (running.length > 0) return { ok: false, error: errorOf("in-use", "running") };
      // 共享引用：其他任务（或未标记 worktree_root 的同目录任务）的 cwd/附加目录落在本次删除根内。
      const shared = repository
        .listDirectoryReferencingTasks({ directory: managed.info.path })
        .filter((task) => !task.worktreeRoot || !isSamePath(task.worktreeRoot, managed.info.path))
        .filter((task) =>
          task.directories.some((directory) => isPathInside(managed.info.path, directory)),
        );
      if (shared.length > 0) return { ok: false, error: errorOf("shared-reference") };
      // 有任务使用时只允许在任务已释放后删除；force 不能替代释放任务。
      if (params.force && tasks.length > 0) return { ok: false, error: errorOf("in-use", "tasks") };
      // 终端是独立的 cwd 持有者；读真实 PTY 进程/后代 cwd，无法证明时保守拒绝。
      if ((await ports.terminals.listIdsUnder(managed.info.path)).length > 0)
        return { ok: false, error: errorOf("in-use", "terminal") };
      // 有改动的判定先于卸载会话：被拒绝的删除不能留下"会话已被卸载"的副作用。
      const dirty = managed.info.dirty;
      if (dirty === null) return { ok: false, error: errorOf("git-failed", "status unavailable") };
      if (!params.force && dirty) return { ok: false, error: errorOf("dirty") };
      // 会话选择与忙闲由 CLI 驻留表判定（含镜像尚未同步的同目录 fork 子会话），
      // 等待真实 releaseUnderDirectory ACK 后才可删除；请求失败不吞错、不继续删。
      let cli: { released: string[]; busy: string[] };
      try {
        cli = await releaseSessionsUnder(ports, managed.project, tasks, managed.info.path);
      } catch (cause) {
        return { ok: false, error: errorOf("session-close-failed", String(cause)) };
      }
      if (cli.busy.length > 0) return { ok: false, error: errorOf("in-use", "running") };
      // force 只用于没有任务使用的残留；CLI 报告仍驻留会话时说明镜像滞后，不能强删。
      if (params.force && cli.released.length > 0)
        return { ok: false, error: errorOf("in-use", "tasks") };
      // 卸载会话期间可能有新任务/新终端/新 generation 写入；删除前重新核对再验证受管归属。
      const known = new Set(tasks.map((task) => task.taskId));
      const added = repository
        .listTasksByWorktree({ worktreeRoot: managed.info.path })
        .some((task) => !known.has(task.taskId));
      if (added) return { ok: false, error: errorOf("in-use", "tasks") };
      if ((await ports.terminals.listIdsUnder(managed.info.path)).length > 0)
        return { ok: false, error: errorOf("in-use", "terminal") };
      const revalidated = await resolveManaged(params.projectId, managed.info.path);
      if (!revalidated || !isSamePath(revalidated.info.sourceRoot, managed.info.sourceRoot))
        return { ok: false, error: errorOf("not-managed") };
      const removed = await ports.git.remove(managed.info.sourceRoot, managed.info.path, {
        force: params.force === true,
        hasTasks: tasks.length > 0,
        hasSharedReferences: false,
      });
      if (!removed.ok)
        return { ok: false, error: errorOf(removed.error.code, removed.error.detail) };
      return { ok: true, value: undefined };
    } finally {
      await worktreeLease.release();
    }
  }

  return {
    listWorktrees: async (params) => ({ groups: await listForProject(params.projectId) }),
    listStartRefs: async (params) => {
      const project = await requireProject(params.projectId);
      const primary = project.roots.find((root) => root.isPrimary) ?? project.roots[0];
      return primary ? await ports.git.startRefs(primary.rootPath) : null;
    },
    createTask,
    forkTask,
    async supportsWorktreeCwd(params) {
      if (!ports.isLocalHost) return false;
      const project = await requireProject(params.projectId);
      const primary = project.roots.find((root) => root.isPrimary) ?? project.roots[0];
      return primary ? supportsWorktreeCwd({ workspacePath: primary.rootPath, taskId: "" }) : false;
    },
    removeWorktree,
    async isWorktreeAvailable(params) {
      if (!ports.isLocalHost) return true;
      try {
        const sourceRoot = await resolveManagedWorktreeSourcePath(
          params.worktreeRoot,
          ports.dataBaseDir(),
          fsPort,
        );
        if (!sourceRoot) return false;
        return (await ports.git.list(sourceRoot)).some((item) =>
          isSamePath(item.path, params.worktreeRoot),
        );
      } catch {
        return false;
      }
    },
  };
}
