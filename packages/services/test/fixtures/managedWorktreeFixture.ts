import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { projectStorage } from "#src/project-storage/index.js";
import {
  createManagedWorktreeTaskService,
  createWorktreeLeaseGate,
} from "#src/managed-worktree-tasks/index.js";
import { createManagedWorktreeRepo } from "#src/git/managed-worktree/repo.js";
import { createGitCommandProvider } from "#src/git/providers/gitCommandProvider.js";

/** 失败注入点包含转发后 projection 丢失；投影缺席不能证明 CLI 从未接纳。 */
export type SessionFailureMode = "none" | "reserved" | "forwarded" | "forwarded-invisible";

export interface ManagedWorktreeFixtureOptions {
  sessionFails?: SessionFailureMode;
  forkFails?: boolean;
  forkMismatch?: boolean;
  supportsWorktreeCwd?: boolean;
  releaseBusy?: boolean;
  releaseFails?: boolean;
  releaseReleases?: string[];
  releaseWait?: Promise<void>;
  sessionWait?: Promise<void>;
  onRelease?: () => void;
  terminalPaths?: string[];
}

/**
 * 真实 tmp Git + SQLite 的受管 worktree fixture。
 * `openHost()` 为同一 tasks-index 再开一条 SQLite 连接与新服务实例，模拟另一个窗口 Host 进程。
 */
export async function createManagedWorktreeFixture(options: ManagedWorktreeFixtureOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), "zcode-worktree-tasks-"));
  const repoPath = join(directory, "repo");
  await mkdir(repoPath);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repoPath, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  await writeFile(join(repoPath, "file.txt"), "base\n");
  git("add", "file.txt");
  git("commit", "-qm", "base");

  const dbPath = join(directory, "tasks-index.sqlite");
  const dataBaseDir = join(directory, "data");
  const databases: DatabaseSync[] = [];
  const forks: Array<{
    target: { rowId: number; entityId: string };
    targetCwd: { cwd: string; childSessionId: string };
    parentPath: string;
  }> = [];
  const releases: Array<{ workspacePath: string; directory: string }> = [];
  const active = new Set<string>();
  const terminalPaths = options.terminalPaths ?? [];
  let migrated = false;

  const openHost = async () => {
    const db = new DatabaseSync(dbPath);
    databases.push(db);
    if (!migrated) {
      migrated = true;
      // 旧版 tasks-index 基线表；迁移测试与生产迁移共用同一列集合。
      db.exec(`CREATE TABLE tasks (
        workspace_key TEXT NOT NULL, workspace_path TEXT NOT NULL, workspace_identity TEXT,
        task_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', task_status TEXT,
        provider TEXT DEFAULT 'glm', mode TEXT NOT NULL DEFAULT 'build', model TEXT,
        migration_source TEXT, forked_from_task_id TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, unread_at INTEGER,
        last_unread_at INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0,
        title_overridden INTEGER NOT NULL DEFAULT 0, meta_json TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY(workspace_key, task_id));`);
      await projectStorage.migrate(db, {
        backupDirectories: [join(directory, "backup")],
        settings: { lastWorkspaceSession: [], recentProjects: [] },
      });
      // 真实仓储的预留收口会查询用户整理证据；测试库补齐同一迁移表（只读存在性）。
      db.exec("CREATE TABLE IF NOT EXISTS task_group_members (workspace_key TEXT, task_id TEXT);");
    }
    const repository = projectStorage.repository(db);
    const service = createManagedWorktreeTaskService({
      isLocalHost: true,
      repository: () => repository,
      git: createManagedWorktreeRepo({
        commandProvider: createGitCommandProvider(),
        dataBaseDir: () => dataBaseDir,
      }),
      dataBaseDir: () => dataBaseDir,
      agent: {
        async createSession(params) {
          if (options.sessionWait) await options.sessionWait;
          if (options.sessionFails === "none") throw new Error("session bootstrap failed");
          // 真实预占事务：worktree 关系与任务行同一 owner，不新建第二条 admission。
          repository.reserveCreatedTask({
            task: { workspacePath: params.workspacePath, taskId: params.sessionId },
            projectId: params.projectId,
            additionalDirectories: params.additionalDirectories,
            worktreeRoot: params.worktreeRoot,
          });
          if (
            options.sessionFails === "forwarded" ||
            options.sessionFails === "forwarded-invisible"
          ) {
            // 模拟 zcodeAgentService：CLI 首发前先丢弃 receipt，之后 ACK 可能丢失。
            repository.settleCreatedTaskReservation({
              task: { workspacePath: params.workspacePath, taskId: params.sessionId },
              outcome: "input-forwarded",
            });
          }
          if (options.sessionFails === "forwarded-invisible") {
            // 模拟转发后用户/投影 owner 已移除产品行；CLI 的结果仍未知。
            db.prepare("DELETE FROM tasks WHERE task_id=?").run(params.sessionId);
          }
          if (options.sessionFails)
            throw new Error(`session bootstrap failed: ${options.sessionFails}`);
          return { sessionId: params.sessionId };
        },
        async forkSession(params) {
          if (options.forkFails) throw new Error("fork rejected");
          forks.push({
            target: params.target,
            targetCwd: params.targetCwd,
            parentPath: params.parent.workspacePath,
          });
          return {
            sessionId: options.forkMismatch ? "sess_mismatch" : params.targetCwd.childSessionId,
          };
        },
        isTaskActive: (task) => active.has(task.taskId),
        async supportsWorktreeCwd() {
          return options.supportsWorktreeCwd ?? true;
        },
        async releaseSessionsUnder(params) {
          releases.push({ workspacePath: params.workspacePath, directory: params.directory });
          options.onRelease?.();
          if (options.releaseWait) await options.releaseWait;
          if (options.releaseFails) throw new Error("release transport failed");
          if (options.releaseBusy) return { released: [], busy: ["child-busy"] };
          return { released: options.releaseReleases ?? ["released-session"], busy: [] };
        },
      },
      terminals: {
        async listIdsUnder(path) {
          return terminalPaths.filter((value) => value.startsWith(path));
        },
      },
      leases: createWorktreeLeaseGate({ dataBaseDir: () => dataBaseDir }),
    });
    return { db, repository, service };
  };

  const first = await openHost();
  const project = first.repository.saveProject({ name: "Repo", roots: [repoPath] });
  return {
    directory,
    repoPath,
    dbPath,
    dataBaseDir,
    project,
    active,
    releases,
    forks,
    terminalPaths,
    openHost,
    ...first,
    async dispose() {
      for (const db of databases.splice(0)) {
        try {
          db.close();
        } catch {
          // 已关闭的连接无需再处理。
        }
      }
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export type ManagedWorktreeFixture = Awaited<ReturnType<typeof createManagedWorktreeFixture>>;

/** 测试等待：只等待“真实进程/文件事实出现”，不作为生产同步手段。 */
export async function waitForFact(
  check: () => Promise<boolean>,
  label: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}
