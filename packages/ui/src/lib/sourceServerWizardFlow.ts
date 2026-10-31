import {
  SOURCE_SERVER_UPDATE_RUNNING_TASKS_ERROR_CODE,
  getSourceServerUpdateTarget,
  type ConnectionProfile,
  type RemoteTarget,
  type SourceServerManagementSnapshot,
  type SourceServerUpdateRequest,
  type SourceServerUpdateTarget,
} from "@zcode/shared";
import type { CreateConnectionProfileInput, ISourceServerManagementService } from "@zcode/services";
import {
  buildSourceProfileRows,
  classifySourceServerFailure,
  findProfileForRemoteTarget,
  resolveRunningTasksConfirmation,
  resolveSourceInstallConfirmation,
  type SourceInstallConfirmation,
  type SourceProfileRow,
  type SourceServerFailureClassification,
} from "@/lib/sourceServerManagement.js";

/** 向导只依赖管理端口的这些真实方法；不引入 window.zcode 或第二个 Host。 */
export type SourceConnectionManagementPort = Pick<
  ISourceServerManagementService,
  "getSnapshot" | "createProfile" | "connectProfile" | "updateSource"
>;

interface PrepareSourceConnectionInput {
  management: SourceConnectionManagementPort | undefined;
  target: RemoteTarget;
  snapshot: SourceServerManagementSnapshot | null;
  profileId?: string;
  profileDisplayName?: string;
  confirmSourceServerInstall?: boolean;
  expectedTarget?: SourceServerUpdateTarget;
  force?: boolean;
}

export interface SourceRunningTasksConfirmation {
  profileId: string;
  tasks: NonNullable<SourceProfileRow["runningTasks"]>;
  expectedTarget?: SourceServerUpdateTarget;
}

type PrepareSourceConnectionResult =
  | { kind: "skipped" }
  | {
      kind: "ready";
      snapshot: SourceServerManagementSnapshot;
      profileId: string;
    }
  | {
      kind: "install-required";
      snapshot: SourceServerManagementSnapshot;
      confirmation: SourceInstallConfirmation;
    }
  | {
      kind: "running-tasks";
      snapshot: SourceServerManagementSnapshot;
      confirmation: SourceRunningTasksConfirmation;
    }
  | {
      kind: "controller-upgrade-required";
      snapshot: SourceServerManagementSnapshot;
      confirmation: SourceInstallConfirmation;
    }
  | {
      kind: "failed";
      error: unknown;
      classification: SourceServerFailureClassification;
    };

function normalizeTarget(
  target: Exclude<RemoteTarget, { kind: "server" }>,
): SourceServerUpdateTarget | undefined {
  try {
    return getSourceServerUpdateTarget(target);
  } catch {
    return undefined;
  }
}

function readErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

/**
 * 向导连接编排的唯一实现（可单测）：
 * 1. server 直连/无管理端口跳过 profile 编排；
 * 2. 复用或新建 profile（凭据仍由 directory/credential port 拥有）；
 * 3. force 先经 updateSource 且只影响 busy guard；
 * 4. 安装/升级/忙碌错误转成显式确认结果，其余失败交给调用方展示。
 */
export async function prepareSourceConnection(
  input: PrepareSourceConnectionInput,
): Promise<PrepareSourceConnectionResult> {
  const { management, target } = input;
  if (!management || target.kind === "server") {
    return { kind: "skipped" };
  }

  let snapshot = input.snapshot ?? (await management.getSnapshot());
  let profile = input.profileId
    ? snapshot.profiles.find((candidate) => candidate.profileId === input.profileId)
    : findProfileForRemoteTarget(snapshot, target);

  if (!profile) {
    const createInput: CreateConnectionProfileInput = {
      target,
      ...(input.profileDisplayName ? { profileDisplayName: input.profileDisplayName } : {}),
    };
    snapshot = await management.createProfile(createInput);
    profile = findProfileForRemoteTarget(snapshot, target);
    if (!profile) {
      // createProfile 应返回包含新记录的权威快照；找不到时显式失败，不按路径猜 profile。
      return {
        kind: "failed",
        error: new Error("Connection Profile was not created"),
        classification: {
          kind: "other",
          code: "connection-profile-unavailable",
          retryable: true,
        },
      };
    }
  }

  const expectedTarget = input.expectedTarget ?? normalizeTarget(target);
  const profileId = profile.profileId;

  try {
    if (input.force) {
      const updateRequest: SourceServerUpdateRequest = {
        profileId,
        force: true,
        ...(expectedTarget ? { expectedTarget } : {}),
      };
      snapshot = await management.updateSource(updateRequest);
    }
    const next = await management.connectProfile(profileId, {
      confirmSourceServerInstall: input.confirmSourceServerInstall === true,
      ...(expectedTarget ? { expectedTarget } : {}),
    });
    return { kind: "ready", snapshot: next, profileId };
  } catch (error) {
    const classification = classifySourceServerFailure(error);
    const code = readErrorCode(error);
    // 只有未确认的安装/升级才转确认；确认后的同类错误仍按失败处理，避免确认循环。
    const needsConfirmation =
      !input.confirmSourceServerInstall &&
      (classification.kind === "install-required" || classification.kind === "upgrade-required");
    let latest = snapshot;
    if (needsConfirmation || code === SOURCE_SERVER_UPDATE_RUNNING_TASKS_ERROR_CODE) {
      latest = await management.getSnapshot();
    }

    if (needsConfirmation) {
      const confirmation = resolveSourceInstallConfirmation(latest, profileId, target);
      if (!confirmation) {
        return { kind: "failed", error, classification };
      }
      return confirmation.controllerUpgradeRequired
        ? { kind: "controller-upgrade-required", snapshot: latest, confirmation }
        : { kind: "install-required", snapshot: latest, confirmation };
    }

    if (classification.kind === "running-tasks") {
      const running = resolveRunningTasksConfirmation(latest, profileId);
      if (running) {
        return {
          kind: "running-tasks",
          snapshot: latest,
          confirmation: {
            ...running,
            ...(expectedTarget ? { expectedTarget } : {}),
          },
        };
      }
    }

    return { kind: "failed", error, classification };
  }
}

/**
 * 已保存 profile 的凭据只从 credential port 读回；UI 不从快照/日志还原口令。
 * displayName 不进入 target（仅用于列表展示）。
 */
export function createRemoteTargetFromProfile(
  profile: Pick<ConnectionProfile, "profileId" | "target">,
  credentials: { password?: string | null; privateKeyPassphrase?: string | null },
): Exclude<RemoteTarget, { kind: "server" }> {
  const target = profile.target;
  switch (target.kind) {
    case "ssh":
      return {
        kind: "ssh",
        host: target.host,
        port: target.port ?? 22,
        username: target.username,
        ...(target.sshConfigAlias ? { sshConfigAlias: target.sshConfigAlias } : {}),
        ...(target.privateKeyPath ? { privateKeyPath: target.privateKeyPath } : {}),
        ...(credentials.password ? { password: credentials.password } : {}),
        ...(credentials.privateKeyPassphrase
          ? { privateKeyPassphrase: credentials.privateKeyPassphrase }
          : {}),
      };
    case "wsl":
      return {
        kind: "wsl",
        ...(target.distro ? { distro: target.distro } : {}),
        ...(target.user ? { user: target.user } : {}),
      };
    case "docker":
      return { kind: "docker", container: target.container };
  }
}

/** 管理列表投影；对话框与设置面板共用同一份快照投影，避免重复计算。 */
export function listSourceProfiles(
  snapshot: SourceServerManagementSnapshot | null,
): SourceProfileRow[] {
  return snapshot ? buildSourceProfileRows(snapshot) : [];
}
