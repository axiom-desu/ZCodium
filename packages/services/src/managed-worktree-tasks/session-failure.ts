import type {
  ManagedWorktreeError,
  ManagedWorktreeErrorCode,
} from "@zcode/shared/managed-worktree";
import type { ManagedWorktreeTaskPorts } from "#src/managed-worktree-tasks/ports.js";

/** 失败收口要求 receipt 的明确未认领记录与 CLI 无会话两种证据同时成立。 */
interface ReservationProof {
  proven: boolean;
  detail: string;
}

/**
 * 用现有项目预占 receipt 证明“本次会话入口还没有把输入/命令转发给 CLI”。
 *
 * receipt 只在 CLI 首发前存在：`input-forwarded` 与 CLI 事实到达都会先丢弃它。
 * 因此 released 表示本次预占确实未被认领；`not-reserved` 只说明 receipt 不存在。
 * Bug 原因：转发后 receipt 会消失，产品行也可能尚不可见/已被移除；两者缺席不代表命令未接纳。
 * 修复依据：只有明确 released 才能继续验证 CLI，无 receipt 的未知结果必须保留目录。
 */
async function proveReservationUnstarted(
  ports: ManagedWorktreeTaskPorts,
  input: { worktreeRoot: string; sessionId: string },
): Promise<ReservationProof> {
  try {
    const repository = await ports.repository();
    const settlement = repository.settleCreatedTaskReservation({
      task: { workspacePath: input.worktreeRoot, taskId: input.sessionId },
      outcome: "cli-closed",
    });
    if (settlement.released) return { proven: true, detail: "unclaimed reservation released" };
    return { proven: false, detail: `reservation ${settlement.reason}` };
  } catch (cause) {
    return { proven: false, detail: `reservation settlement failed: ${String(cause)}` };
  }
}

/**
 * CLI 驻留表是“目录内是否还有会话”的唯一权威。
 * `releaseSessionsUnderDirectory` 只对 idle 会话去激活；busy 会原样返回，因此任何 released/busy
 * 都说明目录内仍有会话，不能删除目录。请求失败同样按“无法证明”处理。
 */
async function confirmNoCliSession(
  ports: ManagedWorktreeTaskPorts,
  input: {
    workspace: { workspacePath: string; workspaceIdentity?: string };
    directory: string;
  },
): Promise<{ clear: boolean; detail: string }> {
  try {
    const result = await ports.agent.releaseSessionsUnder({
      ...input.workspace,
      directory: input.directory,
    });
    if (result.busy.length > 0)
      return { clear: false, detail: `CLI busy: ${result.busy.join(",")}` };
    if (result.released.length > 0)
      return { clear: false, detail: `CLI sessions released: ${result.released.join(",")}` };
    return { clear: true, detail: "CLI reports no resident session in directory" };
  } catch (cause) {
    return { clear: false, detail: `CLI release check failed: ${String(cause)}` };
  }
}

/** 结果未知时保留 worktree，并把“下一步能做什么”放进 detail，调用方不能当作未创建。 */
function retainedSessionFailure(
  cause: unknown,
  input: { worktreeRoot: string; reason: string },
): ManagedWorktreeError {
  return {
    code: "session-failed",
    detail: `${cause instanceof Error ? cause.message : String(cause)}; session outcome unknown (${input.reason}); worktree retained at ${input.worktreeRoot}; inspect it and retry removal from managed worktree management`,
  };
}

function createWorktreeError(
  code: ManagedWorktreeErrorCode,
  detail?: string,
): ManagedWorktreeError {
  return { code, ...(detail ? { detail } : {}) };
}

/** 失败收口：只有 reservation + CLI 双证明才清理本次新建目录，否则保留 worktree。 */
export async function settleFailedCreation(
  ports: ManagedWorktreeTaskPorts,
  input: {
    cause: unknown;
    sourceRoot: string;
    worktreeRoot: string;
    sessionId: string;
    cliWorkspace: { workspacePath: string; workspaceIdentity?: string };
  },
): Promise<ManagedWorktreeError> {
  const reservation = await proveReservationUnstarted(ports, {
    worktreeRoot: input.worktreeRoot,
    sessionId: input.sessionId,
  });
  if (!reservation.proven)
    return retainedSessionFailure(input.cause, {
      worktreeRoot: input.worktreeRoot,
      reason: reservation.detail,
    });
  const cli = await confirmNoCliSession(ports, {
    workspace: input.cliWorkspace,
    directory: input.worktreeRoot,
  });
  if (!cli.clear)
    return retainedSessionFailure(input.cause, {
      worktreeRoot: input.worktreeRoot,
      reason: cli.detail,
    });
  const cleanup = await ports.git.remove(input.sourceRoot, input.worktreeRoot, {
    force: true,
    hasTasks: false,
    hasSharedReferences: false,
  });
  if (!cleanup.ok)
    return retainedSessionFailure(input.cause, {
      worktreeRoot: input.worktreeRoot,
      reason: `cleanup failed: ${cleanup.error.code}${cleanup.error.detail ? ` ${cleanup.error.detail}` : ""}`,
    });
  return createWorktreeError(
    "session-failed",
    `${String(input.cause)}; ${reservation.detail}; ${cli.detail}; worktree removed`,
  );
}

/**
 * CLI 是驻留会话与忙闲的唯一判定者；只为该项目已有 workspace 请求卸载。
 * 任务行尚未镜像时，项目 roots 覆盖同一 CLI 进程；卸载范围仍只限 directory 内 cwd。
 */
export async function releaseSessionsUnder(
  ports: ManagedWorktreeTaskPorts,
  project: { roots: readonly { rootPath: string }[] },
  tasks: readonly { workspacePath: string; workspaceIdentity?: string }[],
  directory: string,
): Promise<{ released: string[]; busy: string[] }> {
  const workspaces = new Map<string, { workspacePath: string; workspaceIdentity?: string }>();
  const add = (workspacePath: string, workspaceIdentity?: string) => {
    const key = workspaceIdentity?.trim() || workspacePath;
    if (!workspaces.has(key))
      workspaces.set(key, {
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
      });
  };
  for (const task of tasks) add(task.workspacePath, task.workspaceIdentity);
  for (const root of project.roots) add(root.rootPath);
  const released: string[] = [];
  for (const workspace of workspaces.values()) {
    const result = await ports.agent.releaseSessionsUnder({ ...workspace, directory });
    if (result.busy.length > 0) return { released, busy: result.busy };
    released.push(...result.released);
  }
  return { released, busy: [] };
}
