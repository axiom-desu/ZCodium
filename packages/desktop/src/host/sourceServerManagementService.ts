/* eslint-disable max-lines -- 管理服务把目录、运行态、状态/日志事件与删除事务集中在一个 owner，拆分会切裂 generation 边界。 */
import { Emitter } from "@zcode/rpc";
import {
  SOURCE_SERVER_REMOVE_CALLBACK_FAILED_ERROR_CODE,
  SOURCE_SERVER_REMOVE_CALLBACK_MISSING_ERROR_CODE,
  SOURCE_SERVER_REMOVE_PERSIST_FAILED_ERROR_CODE,
  isSameSourceServerUpdateTarget,
  sourceServerManagementDirectoryDeltaSchema,
  sourceServerManagementSnapshotRequestSchema,
  sourceServerManagementSnapshotSchema,
  sourceServerManagementStateDeltaSchema,
  sourceServerOperationLogSchema,
  remoteTargetSchema,
  sourceServerUpdateRequestSchema,
  type ConnectionProfile,
  type RemoteTarget,
  type SourceServerConnectionStateSnapshot,
  type SourceServerManagementDirectoryDelta,
  type SourceServerManagementSnapshot,
  type SourceServerManagementSnapshotRequest,
  type SourceServerManagementStateDelta,
  type SourceServerOperationLog,
  type SourceServerUpdateRequest,
  type SourceServerUpdateTarget,
} from "@zcode/shared";
import type {
  CreateConnectionProfileInput,
  ISourceServerManagementService,
  UpdateConnectionProfileInput,
} from "@zcode/services";
import type { SourceServerDirectory } from "./sourceServerDirectory.js";

interface SourceServerManagementRuntimeConnectResult {
  sourceServerId?: string;
  version?: string;
  hostname?: string;
  osUser?: string;
}

/** Host 侧真实连接/更新边界；管理服务只编排目录、状态与错误分类。 */
export interface SourceServerManagementRuntime {
  connect(input: {
    profile: ConnectionProfile;
    target: Exclude<RemoteTarget, { kind: "server" }>;
    confirmIdentityChange?: boolean;
    confirmSourceServerInstall?: boolean;
    context: {
      onLog: (event: {
        phase: string;
        message: string;
        progress?: number;
        level?: "info" | "warn" | "error";
      }) => void;
    };
  }): Promise<SourceServerManagementRuntimeConnectResult>;
  update(input: {
    profile: ConnectionProfile;
    target: Exclude<RemoteTarget, { kind: "server" }>;
    force?: boolean;
    context: {
      onLog: (event: {
        phase: string;
        message: string;
        progress?: number;
        level?: "info" | "warn" | "error";
      }) => void;
    };
  }): Promise<SourceServerManagementRuntimeConnectResult>;
  disconnect(sourceServerId: string): Promise<void>;
  isOnline(sourceServerId: string): boolean;
  currentVersion?(sourceServerId: string): string | undefined;
  removeProfile?(profileId: string): Promise<void> | void;
}

interface SourceServerManagementServiceOptions {
  directory: SourceServerDirectory;
  runtime: SourceServerManagementRuntime;
  onBeforeSourceRemoved?: (sourceServerId: string) => Promise<void>;
  now?: () => number;
}

class SourceServerRemovalError extends Error {
  public readonly retryable = true;
  public constructor(
    public readonly code:
      | typeof SOURCE_SERVER_REMOVE_CALLBACK_MISSING_ERROR_CODE
      | typeof SOURCE_SERVER_REMOVE_CALLBACK_FAILED_ERROR_CODE
      | typeof SOURCE_SERVER_REMOVE_PERSIST_FAILED_ERROR_CODE,
    message: string,
  ) {
    super(message);
    this.name = "SourceServerRemovalError";
  }
}

export function createSourceServerManagementService(
  options: SourceServerManagementServiceOptions,
): ISourceServerManagementService & { dispose(): void } {
  const now = options.now ?? Date.now;
  let generation = 0;
  let disposed = false;
  const stateEmitter = new Emitter<SourceServerManagementStateDelta>();
  const directoryEmitter = new Emitter<SourceServerManagementDirectoryDelta>();
  const operationLogEmitter = new Emitter<SourceServerOperationLog>();
  const recentLogs = new Map<string, SourceServerOperationLog[]>();
  const lastStates = new Map<string, SourceServerConnectionStateSnapshot>();
  const directorySubscription = options.directory.onDidChange(() => {
    publishDirectoryChange();
  });

  function publishDirectoryChange(): void {
    if (disposed) return;
    generation += 1;
    directoryEmitter.fire(sourceServerManagementDirectoryDeltaSchema.parse({ generation }));
  }

  function publishState(state: SourceServerConnectionStateSnapshot): void {
    if (disposed) return;
    lastStates.set(state.profileId, state);
    generation += 1;
    stateEmitter.fire(sourceServerManagementStateDeltaSchema.parse({ generation, state }));
  }

  function appendLog(input: {
    profileId: string;
    operation: "connect" | "update";
    phase: string;
    level: "info" | "warn" | "error";
    message: string;
    progress?: number;
  }): void {
    const entry = sourceServerOperationLogSchema.parse({
      profileId: input.profileId,
      operation: input.operation,
      phase: input.phase,
      level: input.level,
      message: input.message,
      ...(input.progress !== undefined ? { progress: input.progress } : {}),
      timestamp: now(),
    });
    const logs = recentLogs.get(input.profileId) ?? [];
    logs.push(entry);
    // 日志只是内存诊断投影，保留最近 200 条，不进入持久化。
    if (logs.length > 200) logs.splice(0, logs.length - 200);
    recentLogs.set(input.profileId, logs);
    operationLogEmitter.fire(entry);
  }

  function stateForProfile(profile: ConnectionProfile): SourceServerConnectionStateSnapshot {
    const online = profile.sourceServerId
      ? options.runtime.isOnline(profile.sourceServerId)
      : false;
    const previous = lastStates.get(profile.profileId);
    if (online) {
      const version = profile.sourceServerId
        ? options.runtime.currentVersion?.(profile.sourceServerId)
        : undefined;
      return {
        profileId: profile.profileId,
        ...(profile.sourceServerId ? { sourceServerId: profile.sourceServerId } : {}),
        state: "online",
        ...(version ? { currentVersion: version } : {}),
        updatedAt: now(),
      };
    }
    if (previous && previous.state !== "online") {
      return {
        ...previous,
        ...(profile.sourceServerId ? { sourceServerId: profile.sourceServerId } : {}),
        updatedAt: now(),
      };
    }
    return {
      profileId: profile.profileId,
      ...(profile.sourceServerId ? { sourceServerId: profile.sourceServerId } : {}),
      state: profile.lastConnectError ? "failed" : "offline",
      ...(profile.lastConnectError ? { error: profile.lastConnectError } : {}),
      updatedAt: now(),
    };
  }

  async function readProfile(profileId: string): Promise<ConnectionProfile> {
    const profile = await options.directory.findProfile(profileId);
    if (!profile) throw new Error(`Unknown Connection Profile: ${profileId}`);
    return profile;
  }

  async function getSnapshot(
    input?: SourceServerManagementSnapshotRequest,
  ): Promise<SourceServerManagementSnapshot> {
    sourceServerManagementSnapshotRequestSchema.parse(input === undefined ? {} : input);
    const directory = await options.directory.snapshot();
    const states = directory.profiles.map(stateForProfile);
    return sourceServerManagementSnapshotSchema.parse({
      generation,
      ...directory,
      states,
      failedPathCount: 0,
      abandonedPathCount: 0,
      migrationCounts: directory.servers.map((server) => ({
        sourceServerId: server.sourceServerId,
        ...(options.runtime.isOnline(server.sourceServerId)
          ? {
              status: "available" as const,
              failedPathCount: 0,
              abandonedPathCount: 0,
            }
          : { status: "requires-connection" as const }),
      })),
    });
  }

  function logContext(
    profileId: string,
    operation: "connect" | "update",
  ): {
    onLog: (event: {
      phase: string;
      message: string;
      progress?: number;
      level?: "info" | "warn" | "error";
    }) => void;
  } {
    return {
      onLog: (event) =>
        appendLog({
          profileId,
          operation,
          phase: event.phase,
          message: event.message,
          level: event.level ?? "info",
          ...(event.progress !== undefined ? { progress: event.progress } : {}),
        }),
    };
  }

  async function connectWithProfile(
    profile: ConnectionProfile,
    confirmIdentityChange: boolean,
    confirmSourceServerInstall = false,
    expectedTarget?: SourceServerUpdateTarget,
  ): Promise<void> {
    const assertTarget = (target: Exclude<RemoteTarget, { kind: "server" }>) => {
      if (expectedTarget && !isSameSourceServerUpdateTarget(target, expectedTarget)) {
        throw Object.assign(new Error("Connection target changed; retry the connection"), {
          code: "remote-target-changed",
        });
      }
    };
    assertTarget(profile.target);
    const target = await options.directory.resolveProfileTarget(profile);
    // 凭据读取/交互期间 profile 可能被改址；确认后的安装必须绑定 preview 时的目标。
    assertTarget(target);
    try {
      const result = await options.runtime.connect({
        profile,
        target,
        ...(confirmIdentityChange ? { confirmIdentityChange: true } : {}),
        ...(confirmSourceServerInstall ? { confirmSourceServerInstall: true } : {}),
        context: logContext(profile.profileId, "connect"),
      });
      if (result.sourceServerId) {
        const handshake = await options.directory.recordHandshake(profile.profileId, {
          sourceServerId: result.sourceServerId,
          version: result.version ?? "unknown",
          ...(result.hostname ? { hostname: result.hostname } : {}),
          ...(result.osUser ? { osUser: result.osUser } : {}),
        });
        publishState({
          profileId: profile.profileId,
          sourceServerId: result.sourceServerId,
          state: "online",
          ...(result.version ? { currentVersion: result.version } : {}),
          ...(handshake.identityChanged
            ? {
                pendingSourceServerId: handshake.identityChanged
                  ? result.sourceServerId
                  : undefined,
              }
            : {}),
          updatedAt: now(),
        });
      }
    } catch (error) {
      const code =
        typeof error === "object" && error && "code" in error
          ? String((error as { code?: unknown }).code)
          : undefined;
      publishState({
        profileId: profile.profileId,
        ...(profile.sourceServerId ? { sourceServerId: profile.sourceServerId } : {}),
        state:
          code === "source-server-install-required"
            ? "needs-install"
            : code === "source-server-upgrade-required"
              ? "needs-upgrade"
              : code === "source-server-identity-change-pending"
                ? "identity-change-pending"
                : "failed",
        error: error instanceof Error ? error.message : String(error),
        ...(code ? { errorCode: code as never } : {}),
        updatedAt: now(),
      });
      if (code === "source-server-identity-change-pending") return;
      throw error;
    }
  }

  return {
    onDidChangeState: stateEmitter.event,
    onDidChangeDirectory: directoryEmitter.event,
    onDidAppendOperationLog: operationLogEmitter.event,
    getSnapshot,
    async getRecentOperationLogs(profileId: string) {
      await readProfile(profileId);
      return [...(recentLogs.get(profileId) ?? [])];
    },
    async connectProfile(profileId, connectOptions) {
      void connectOptions?.retainedOnly;
      const profile = await readProfile(profileId);
      await connectWithProfile(
        profile,
        false,
        connectOptions?.confirmSourceServerInstall === true,
        connectOptions?.expectedTarget,
      );
      return await getSnapshot();
    },
    async connectSource(sourceServerId, connectOptions) {
      const profile = await options.directory.preferredProfile(sourceServerId);
      if (!profile) {
        throw new Error(`Source Server has no active Connection Profile: ${sourceServerId}`);
      }
      await connectWithProfile(
        profile,
        false,
        connectOptions?.confirmSourceServerInstall === true,
        connectOptions?.expectedTarget,
      );
      return await getSnapshot();
    },
    async disconnect(sourceServerId) {
      await options.runtime.disconnect(sourceServerId);
      for (const [profileId, state] of lastStates) {
        if (state.sourceServerId === sourceServerId) {
          publishState({
            ...state,
            state: "offline",
            updatedAt: now(),
          });
          lastStates.set(profileId, { ...state, state: "offline", updatedAt: now() });
        }
      }
      return await getSnapshot();
    },
    async confirmIdentityChange(profileId) {
      const profile = await readProfile(profileId);
      await connectWithProfile(profile, true);
      return await getSnapshot();
    },
    async updateSource(input: SourceServerUpdateRequest) {
      const { profileId, expectedTarget, force } = sourceServerUpdateRequestSchema.parse(input);
      const profile = await readProfile(profileId);
      // profile ID 可原位改址；读取凭据前后都核验 expectedTarget，旧授权不能用于新设备/账户。
      const assertTarget = (target: Exclude<RemoteTarget, { kind: "server" }>) => {
        if (expectedTarget && !isSameSourceServerUpdateTarget(target, expectedTarget)) {
          throw Object.assign(new Error("Connection target changed; retry the connection"), {
            code: "remote-target-changed",
          });
        }
      };
      assertTarget(profile.target);
      const target = await options.directory.resolveProfileTarget(profile);
      assertTarget(target);
      try {
        const result = await options.runtime.update({
          profile,
          target,
          ...(force ? { force: true } : {}),
          context: logContext(profile.profileId, "update"),
        });
        if (result.sourceServerId) {
          await options.directory.recordHandshake(profile.profileId, {
            sourceServerId: result.sourceServerId,
            version: result.version ?? "unknown",
          });
        }
        publishState({
          profileId,
          ...((result.sourceServerId ?? profile.sourceServerId)
            ? { sourceServerId: result.sourceServerId ?? profile.sourceServerId }
            : {}),
          state: "online",
          ...(result.version ? { currentVersion: result.version } : {}),
          updatedAt: now(),
        });
      } catch (error) {
        const code =
          typeof error === "object" && error && "code" in error
            ? String((error as { code?: unknown }).code)
            : undefined;
        publishState({
          profileId,
          ...(profile.sourceServerId ? { sourceServerId: profile.sourceServerId } : {}),
          state: code === "source-server-update-running-tasks" ? "updating" : "failed",
          error: error instanceof Error ? error.message : String(error),
          ...(code ? { errorCode: code as never } : {}),
          updatedAt: now(),
        });
        throw error;
      }
      return await getSnapshot();
    },
    async renameSource(sourceServerId, displayName) {
      await options.directory.renameSource(sourceServerId, displayName);
      return await getSnapshot();
    },
    async renameProfile(profileId, displayName) {
      await options.directory.renameProfile(profileId, displayName);
      return await getSnapshot();
    },
    async createProfile(input: CreateConnectionProfileInput) {
      // target 由 shared schema 校验；server 直连没有 profile 概念，typed 拒绝而不是伪造记录。
      const target = remoteTargetSchema.parse(input.target);
      if (target.kind === "server") {
        throw Object.assign(new Error("Direct server connections do not use Connection Profiles"), {
          code: "source-server-profile-unsupported-transport",
        });
      }
      // 凭据读写与串行提交都留在 directory（唯一 owner）；这里只编排显示名并回传快照。
      const profile = await options.directory.ensureProfile(target);
      const profileDisplayName = input.profileDisplayName?.trim();
      const sourceDisplayName = input.sourceDisplayName?.trim();
      if (profileDisplayName || sourceDisplayName) {
        await options.directory.updateProfile({
          profileId: profile.profileId,
          profileDisplayName:
            profileDisplayName || profile.displayName?.trim() || `${profile.transport} profile`,
          ...(sourceDisplayName ? { sourceDisplayName } : {}),
          target,
        });
      }
      return await getSnapshot();
    },
    async updateProfile(input: UpdateConnectionProfileInput) {
      await options.directory.updateProfile(input);
      options.runtime.removeProfile?.(input.profileId);
      return await getSnapshot();
    },
    async setPreferredProfile(sourceServerId, profileId) {
      await options.directory.setPreferredProfile(sourceServerId, profileId);
      return await getSnapshot();
    },
    async removeProfile(profileId) {
      await options.runtime.removeProfile?.(profileId);
      await options.directory.removeProfile(profileId);
      lastStates.delete(profileId);
      recentLogs.delete(profileId);
      return await getSnapshot();
    },
    async removeSource(sourceServerId) {
      const before = await options.directory.snapshot();
      const exists =
        before.servers.some((server) => server.sourceServerId === sourceServerId) ||
        before.profiles.some((profile) => profile.sourceServerId === sourceServerId) ||
        before.workspaceHistory.some((entry) => entry.sourceServerId === sourceServerId);
      if (!exists) return await getSnapshot();
      if (!options.onBeforeSourceRemoved) {
        throw new SourceServerRemovalError(
          SOURCE_SERVER_REMOVE_CALLBACK_MISSING_ERROR_CODE,
          "Source Server removal requires the Host attachment cleanup callback",
        );
      }
      // 删除顺序：释放运行态 → Host 清理 attachment → 提交本地持久化。任一步失败都保留 profile。
      await options.runtime.disconnect(sourceServerId);
      try {
        await options.onBeforeSourceRemoved(sourceServerId);
      } catch (error) {
        throw new SourceServerRemovalError(
          SOURCE_SERVER_REMOVE_CALLBACK_FAILED_ERROR_CODE,
          error instanceof Error ? error.message : String(error),
        );
      }
      try {
        await options.directory.removeSource(sourceServerId);
      } catch (error) {
        throw new SourceServerRemovalError(
          SOURCE_SERVER_REMOVE_PERSIST_FAILED_ERROR_CODE,
          error instanceof Error ? error.message : String(error),
        );
      }
      for (const profile of before.profiles) {
        if (profile.sourceServerId === sourceServerId) {
          await options.runtime.removeProfile?.(profile.profileId);
          lastStates.delete(profile.profileId);
          recentLogs.delete(profile.profileId);
        }
      }
      return await getSnapshot();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      directorySubscription();
      stateEmitter.dispose();
      directoryEmitter.dispose();
      operationLogEmitter.dispose();
    },
  };
}
