import {
  compareSemverVersions,
  SOURCE_SERVER_LIFECYCLE_CONTROL_MIN_VERSION,
  SOURCE_SERVER_UPDATE_RUNNING_TASKS_ERROR_CODE,
} from "@zcode/shared";
import type {
  SourceServerConnectionState,
  SourceServerConnectionStateSnapshot,
  SourceServerManagementSnapshot,
  SourceServerRunningTask,
  SourceServerRunningTasksResult,
  SourceServerUpdateTarget,
} from "@zcode/shared";
import type { ISourceServerManagementService } from "@zcode/services";
import { logger } from "@/logger.js";

function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

/** Host 无法静默取得连接凭据（例如 SSH 密码未保存且设备离线）时的管理错误码。 */
function isSourceServerCredentialsRequiredError(error: unknown): boolean {
  return getErrorCode(error) === "credentials-required";
}

type SourceServerLifecycleActionAvailability =
  | { visible: false }
  | { visible: true; enabled: boolean; requiresRemoteUpdate: boolean };

/** 需要处理（安装/升级/更新/身份变更）时隐藏生命周期菜单，避免与主操作冲突。 */
const LIFECYCLE_PENDING_STATES: ReadonlySet<SourceServerConnectionState> = new Set([
  "absent",
  "bootstrapping",
  "needs-install",
  "needs-upgrade",
  "updating",
  "identity-change-pending",
]);

/**
 * 设备卡「更多」中远端服务生命周期操作（重启与停止）共用的可用状态（RDLC-01）：
 * 需要处理时隐藏；最近握手的远端版本低于首个支持版本或未知时禁用并提示更新；
 * 连接中、更新中或本设备有其他操作时禁用；已连接、未连接、连接失败时可用。
 */
export function resolveSourceServerLifecycleActionAvailability(input: {
  state: SourceServerConnectionState;
  deviceBusy: boolean;
  lastSeenVersion?: string;
}): SourceServerLifecycleActionAvailability {
  if (LIFECYCLE_PENDING_STATES.has(input.state)) return { visible: false };
  // 不发命令试探能力：旧 CLI 会把未知命令转交 TUI 而卡住，或把 `stop --wait` 当成 ack 型 stop。
  const comparison = input.lastSeenVersion
    ? compareSemverVersions(input.lastSeenVersion, SOURCE_SERVER_LIFECYCLE_CONTROL_MIN_VERSION)
    : null;
  const requiresRemoteUpdate = comparison === null || comparison < 0;
  return {
    visible: true,
    requiresRemoteUpdate,
    enabled: !requiresRemoteUpdate && !input.deviceBusy && input.state !== "retrying",
  };
}

/** 只有本机阶段（快照声明 updateCancelable）才显示取消；远端写入阶段不能取消。 */
export function resolveSourceServerUpdateCancelAvailability(input: {
  state: SourceServerConnectionState;
  updateCancelable?: boolean;
  deviceBusy: boolean;
}): { visible: boolean; enabled: boolean } {
  const visible = input.state === "updating" && input.updateCancelable === true;
  return { visible, enabled: visible && !input.deviceBusy };
}

/** 显式降级只在「远端较新、需要本机 Controller 版本」时出现；版本取 Host 快照。 */
export function resolveSourceServerDowngradeActionAvailability(input: {
  state: SourceServerConnectionState;
  updateAvailability?: "none" | "available" | "required";
  upgradeTarget?: "controller" | "server";
  currentVersion?: string;
  deviceBusy: boolean;
}): { visible: boolean; enabled: boolean } {
  const visible =
    input.state !== "updating" &&
    input.updateAvailability === "required" &&
    input.upgradeTarget === "controller" &&
    Boolean(input.currentVersion);
  return { visible, enabled: visible && !input.deviceBusy };
}

export async function runSourceServerUpdate(options: {
  management: ISourceServerManagementService;
  profileId: string;
  expectedTarget?: SourceServerUpdateTarget;
  /** 用户已确认把较新的远端切换到本机 Desktop 版本。 */
  allowDowngrade?: boolean;
  confirmForce: () => Promise<boolean>;
}): Promise<SourceServerManagementSnapshot | null> {
  const request = {
    profileId: options.profileId,
    ...(options.expectedTarget ? { expectedTarget: options.expectedTarget } : {}),
  };
  const intent = options.allowDowngrade ? { allowDowngrade: true } : {};
  try {
    return await options.management.updateSource({ ...request, force: false, ...intent });
  } catch (error) {
    if (getErrorCode(error) !== SOURCE_SERVER_UPDATE_RUNNING_TASKS_ERROR_CODE) {
      throw error;
    }
    // 版本 required 过去直接等价为 force update，会绕过运行中 Task guard。
    // 先受 guard 拒绝，再由用户明确确认中断，才能发送 force=true。
    if (!(await options.confirmForce())) return null;
    return await options.management.updateSource({ ...request, force: true, ...intent });
  }
}

/** 向导与设备卡共用的降级二次确认；版本取 Host 快照，Renderer 不自行比较。 */
export function getSourceServerDowngradeConfirmation(
  state: Pick<SourceServerConnectionStateSnapshot, "currentVersion" | "availableVersion">,
  formatMessage: (descriptor: { id: string }, values?: Record<string, string>) => string,
) {
  const values = {
    version: state.currentVersion?.replace(/^v/iu, "") ?? "",
    current: state.availableVersion?.replace(/^v/iu, "") ?? "",
  };
  return {
    title: formatMessage({ id: "source.downgradeConfirmTitle" }, values),
    description: formatMessage({ id: "source.downgradeConfirmDescription" }, values),
    confirmLabel: formatMessage({ id: "source.downgradeConfirm" }),
    cancelLabel: formatMessage({ id: "common.cancel" }),
  };
}

/** guard 拒绝后读取 Host 的活动投影；旧远端不支持时明确告知清单不可用。 */
export async function getSourceServerForceUpdateDescription(
  management: ISourceServerManagementService,
  profileId: string,
  formatMessage: (id: string) => string,
): Promise<string> {
  const snapshot = await management.getSnapshot();
  const tasks = snapshot.states.find((state) => state.profileId === profileId)?.runningTasks;
  return (
    formatMessage("source.lifecycle.forceDescription") +
    " · " +
    (tasks?.length
      ? formatSourceServerRunningTasks(tasks)
      : formatMessage("source.lifecycle.runningTasksUnavailable"))
  );
}

/** 运行中任务清单的展示（强制更新与停止 / 重启远端服务共用）：每行 `sessionId — workspacePath`。 */
export function formatSourceServerRunningTasks(tasks: readonly SourceServerRunningTask[]): string {
  return tasks.map((task) => `${task.sessionId} — ${task.workspacePath}`).join(" · ");
}

/**
 * 停止 / 重启确认前读取设备上的运行中任务（RDLC-01）。凭据不可静默取得时原样抛出，由调用方给出补充
 * 凭据提示且不打开确认；其他读取失败不能当作“没有任务”，按清单不可用继续确认。
 */
export async function readSourceServerRunningTasksForConfirmation(
  management: ISourceServerManagementService,
  sourceServerId: string,
): Promise<SourceServerRunningTasksResult> {
  try {
    return await management.getSourceRunningTasks(sourceServerId);
  } catch (error) {
    if (isSourceServerCredentialsRequiredError(error)) throw error;
    logger.warn(
      "[SourceServerLifecycle] running tasks read failed; showing the list as unavailable",
      {
        sourceServerId,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    return { available: false };
  }
}

/**
 * 停止 / 重启远端服务的危险确认说明（RDLC-01）：中断说明 · 任务清单 · 其他客户端可能重启服务 ·
 * 仅停止且开启「启动时自动重连」时提示下次会重新启动。
 */
export function getRemoteServiceLifecycleDescription(input: {
  action: "restart" | "stop";
  runningTasks: SourceServerRunningTasksResult;
  startupAutoReconnect: boolean;
  formatMessage: (id: string) => string;
}): string {
  const { runningTasks, formatMessage } = input;
  const taskSection = !runningTasks.available
    ? formatMessage("source.lifecycle.runningTasksUnavailable")
    : runningTasks.tasks.length > 0
      ? formatSourceServerRunningTasks(runningTasks.tasks)
      : formatMessage("source.lifecycle.noRunningTasks");
  return [
    formatMessage("source.lifecycle.interruption"),
    taskSection,
    formatMessage("source.lifecycle.otherClients"),
    ...(input.action === "stop" && input.startupAutoReconnect
      ? [formatMessage("source.lifecycle.stopStartupReconnect")]
      : []),
  ].join(" · ");
}
