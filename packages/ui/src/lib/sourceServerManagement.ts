import {
  SOURCE_SERVER_IDENTITY_CHANGE_PENDING_ERROR_CODE,
  SOURCE_SERVER_INSTALL_REQUIRED_ERROR_CODE,
  SOURCE_SERVER_UPDATE_RUNNING_TASKS_ERROR_CODE,
  SOURCE_SERVER_UPGRADE_REQUIRED_ERROR_CODE,
  getSourceServerUpdateTarget,
  isSameSourceServerUpdateTarget,
  type ConnectionProfile,
  type RemoteTarget,
  type SourceServerConnectionStateSnapshot,
  type SourceServerInstallPreview,
  type SourceServerManagementSnapshot,
  type SourceServerRunningTask,
  type SourceServerUpdateTarget,
} from "@zcode/shared";

/**
 * 向导入口的 await 归属。所有跨 await 的结果都必须先验证同一 epoch：
 * 关闭/收起后重开、取消、切连接类型、改目标都会推进 epoch，旧结果只能被动清理。
 */
interface RemoteEntryEpochRef {
  current: number;
}

export function beginRemoteEntryEpoch(ref: RemoteEntryEpochRef): number {
  ref.current += 1;
  return ref.current;
}

export function isRemoteEntryEpochCurrent(ref: RemoteEntryEpochRef, epoch: number): boolean {
  return ref.current === epoch;
}

/** snapshot.generation 只允许前进；事件乱序时丢弃旧快照，避免旧状态覆盖新状态。 */
export function shouldApplySourceManagementSnapshot(
  observedGeneration: number,
  nextGeneration: number,
): boolean {
  return nextGeneration >= observedGeneration;
}

/**
 * 收起后的后台成功不自动推进导航：保留结果等用户显式继续。
 * 前台成功也要求仍属于当前入口，跨 profile/迟到结果一律不导航。
 */
export function shouldAutoAdvanceRemoteCompletion(options: {
  minimized: boolean;
  stillSameEntry: boolean;
}): boolean {
  return !options.minimized && options.stillSameEntry;
}

export type SourceServerFailureKind =
  | "install-required"
  | "upgrade-required"
  | "running-tasks"
  | "identity-change-pending"
  | "target-changed"
  | "credentials-required"
  | "other";

export interface SourceServerFailureClassification {
  kind: SourceServerFailureKind;
  code: string | undefined;
  retryable: boolean;
}

function readErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.length > 0 ? code : undefined;
}

function readRetryable(error: unknown): boolean | undefined {
  if (typeof error !== "object" || error === null || !("retryable" in error)) return undefined;
  const retryable = (error as { retryable?: unknown }).retryable;
  return typeof retryable === "boolean" ? retryable : undefined;
}

/** typed 错误只做分类和重试提示，不用超时/字符串匹配兜底。 */
export function classifySourceServerFailure(error: unknown): SourceServerFailureClassification {
  const code = readErrorCode(error);
  switch (code) {
    case SOURCE_SERVER_INSTALL_REQUIRED_ERROR_CODE:
      return { kind: "install-required", code, retryable: true };
    case SOURCE_SERVER_UPGRADE_REQUIRED_ERROR_CODE:
      return { kind: "upgrade-required", code, retryable: true };
    case SOURCE_SERVER_UPDATE_RUNNING_TASKS_ERROR_CODE:
      return { kind: "running-tasks", code, retryable: true };
    case SOURCE_SERVER_IDENTITY_CHANGE_PENDING_ERROR_CODE:
      return { kind: "identity-change-pending", code, retryable: true };
    case "remote-target-changed":
      return { kind: "target-changed", code, retryable: true };
    case "credentials-required":
      return { kind: "credentials-required", code, retryable: true };
    default:
      return { kind: "other", code, retryable: readRetryable(error) ?? false };
  }
}

export interface SourceProfileRow {
  profileId: string;
  sourceServerId?: string;
  displayName: string;
  sourceDisplayName?: string;
  transport: ConnectionProfile["transport"];
  targetLabel: string;
  state: SourceServerConnectionStateSnapshot["state"];
  error?: string;
  errorCode?: SourceServerConnectionStateSnapshot["errorCode"];
  retryable?: boolean;
  installPreview?: SourceServerInstallPreview;
  upgradeTarget?: SourceServerConnectionStateSnapshot["upgradeTarget"];
  currentVersion?: string;
  availableVersion?: string;
  runningTasks?: SourceServerRunningTask[];
  pendingIdentityChange: boolean;
}

function formatSourceProfileTargetLabel(target: ConnectionProfile["target"]): string {
  switch (target.kind) {
    case "ssh":
      return `${target.username}@${target.host}:${target.port ?? 22}`;
    case "wsl":
      return ["WSL", target.distro, target.user].filter(Boolean).join(" · ") || "WSL";
    case "docker":
      return `Docker · ${target.container}`;
  }
}

/**
 * 管理列表只做快照投影：active profile + 服务器显示名 + 当前状态。
 * online 排前，其余按展示名稳定排序，避免每次事件重排闪烁。
 */
export function buildSourceProfileRows(
  snapshot: SourceServerManagementSnapshot,
): SourceProfileRow[] {
  const serversById = new Map(snapshot.servers.map((server) => [server.sourceServerId, server]));
  const statesByProfileId = new Map(snapshot.states.map((entry) => [entry.profileId, entry]));
  return snapshot.profiles
    .filter((profile) => profile.lifecycleState !== "retired")
    .map((profile) => {
      const state = statesByProfileId.get(profile.profileId);
      const source = profile.sourceServerId ? serversById.get(profile.sourceServerId) : undefined;
      return {
        profileId: profile.profileId,
        ...(profile.sourceServerId ? { sourceServerId: profile.sourceServerId } : {}),
        displayName:
          profile.displayName?.trim() ||
          source?.displayName ||
          formatSourceProfileTargetLabel(profile.target),
        ...(source?.displayName ? { sourceDisplayName: source.displayName } : {}),
        transport: profile.transport,
        targetLabel: formatSourceProfileTargetLabel(profile.target),
        state: state?.state ?? "offline",
        ...(state?.error ? { error: state.error } : {}),
        ...(state?.errorCode ? { errorCode: state.errorCode } : {}),
        ...(state?.retryable !== undefined ? { retryable: state.retryable } : {}),
        ...(state?.installPreview ? { installPreview: state.installPreview } : {}),
        ...(state?.upgradeTarget ? { upgradeTarget: state.upgradeTarget } : {}),
        ...(state?.currentVersion ? { currentVersion: state.currentVersion } : {}),
        ...(state?.availableVersion ? { availableVersion: state.availableVersion } : {}),
        ...(state?.runningTasks ? { runningTasks: state.runningTasks } : {}),
        pendingIdentityChange:
          state?.state === "identity-change-pending" || Boolean(state?.pendingSourceServerId),
      } satisfies SourceProfileRow;
    })
    .sort((left, right) => {
      const leftOnline = left.state === "online" ? 0 : 1;
      const rightOnline = right.state === "online" ? 0 : 1;
      return (
        leftOnline - rightOnline ||
        left.displayName.localeCompare(right.displayName) ||
        left.profileId.localeCompare(right.profileId)
      );
    });
}

function normalizeExpectedTarget(
  target: Exclude<RemoteTarget, { kind: "server" }>,
): SourceServerUpdateTarget | undefined {
  try {
    return getSourceServerUpdateTarget(target);
  } catch {
    // WSL 缺少 distro/user 时无法冻结目标；向导必须等解析后再确认，不能伪造 expectedTarget。
    return undefined;
  }
}

/** 原始 target 可复用已有 profile 时直接连接，避免重复建 profile；server 直连不走 profile。 */
export function findProfileForRemoteTarget(
  snapshot: SourceServerManagementSnapshot,
  target: RemoteTarget,
): ConnectionProfile | undefined {
  if (target.kind === "server") return undefined;
  return snapshot.profiles.find((profile) => {
    if (profile.lifecycleState === "retired") return false;
    if (profile.transport !== target.kind) return false;
    try {
      return isSameSourceServerUpdateTarget(
        profile.target as Exclude<RemoteTarget, { kind: "server" }>,
        target,
      );
    } catch {
      return false;
    }
  });
}

export interface SourceInstallConfirmation {
  profileId: string;
  kind: "install" | "upgrade";
  expectedTarget?: SourceServerUpdateTarget;
  preview?: SourceServerInstallPreview;
  currentVersion?: string;
  availableVersion?: string;
  upgradeTarget?: SourceServerConnectionStateSnapshot["upgradeTarget"];
  controllerUpgradeRequired: boolean;
}

/**
 * 安装/升级确认面板的唯一数据来源：preview、版本与冻结 target 都在展示时确定，
 * 确认后只能带同一 expectedTarget 重试，目标变化由 Host 返回 remote-target-changed。
 */
export function resolveSourceInstallConfirmation(
  snapshot: SourceServerManagementSnapshot,
  profileId: string,
  expectedTargetInput?: Exclude<RemoteTarget, { kind: "server" }>,
): SourceInstallConfirmation | null {
  const state = snapshot.states.find((entry) => entry.profileId === profileId);
  if (!state) return null;
  const kind =
    state.state === "needs-install"
      ? "install"
      : state.state === "needs-upgrade"
        ? "upgrade"
        : state.errorCode === SOURCE_SERVER_INSTALL_REQUIRED_ERROR_CODE
          ? "install"
          : state.errorCode === SOURCE_SERVER_UPGRADE_REQUIRED_ERROR_CODE
            ? "upgrade"
            : null;
  if (!kind) return null;
  const profile = snapshot.profiles.find((entry) => entry.profileId === profileId);
  const expectedTarget =
    expectedTargetInput !== undefined
      ? normalizeExpectedTarget(expectedTargetInput)
      : profile && profile.transport !== undefined
        ? normalizeExpectedTarget(profile.target as Exclude<RemoteTarget, { kind: "server" }>)
        : undefined;
  return {
    profileId,
    kind,
    ...(expectedTarget ? { expectedTarget } : {}),
    ...(state.installPreview ? { preview: state.installPreview } : {}),
    ...(state.currentVersion ? { currentVersion: state.currentVersion } : {}),
    ...(state.availableVersion ? { availableVersion: state.availableVersion } : {}),
    ...(state.upgradeTarget ? { upgradeTarget: state.upgradeTarget } : {}),
    controllerUpgradeRequired: state.upgradeTarget === "controller",
  };
}

/**
 * force 面板只展示远端正在跑的任务；它不是绕过身份/制品/权限的开关。
 * 清单读取失败时 UI 仍保持 force 默认拒绝。
 */
export function resolveRunningTasksConfirmation(
  snapshot: SourceServerManagementSnapshot,
  profileId: string,
): { profileId: string; tasks: SourceServerRunningTask[] } | null {
  const tasks = snapshot.states.find((entry) => entry.profileId === profileId)?.runningTasks;
  if (!tasks || tasks.length === 0) return null;
  return { profileId, tasks };
}
