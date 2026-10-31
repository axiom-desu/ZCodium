import {
  IProjectService,
  IZCodeAgentService,
  IZCodeTaskService,
  type ServiceCollection,
} from "@zcode/services";
import type { MobileProjectDirectoryOwner } from "@zcode/services/node";
import {
  buildServerRemoteWorkspaceIdentity,
  isRemoteWorkspaceIdentity,
  remoteHostIdFromWorkspaceIdentity,
  type WindowHostAttachmentScope,
} from "@zcode/shared";
import { guardReplayableTaskCreation } from "./mobileProjectDirectoryAttachment.js";
import type { createWindowRemoteConnectionRegistry } from "./windowRemoteConnectionRegistry.js";

export interface MobileProjectDirectoryCapabilities {
  existingRuntimeAdmission?: boolean;
}

type AttachmentRegistry = ReturnType<
  typeof createWindowRemoteConnectionRegistry<ServiceCollection, MobileProjectDirectoryCapabilities>
>;
type SessionSnapshot = ReturnType<AttachmentRegistry["listSessions"]>[number];

/**
 * 只允许当前 MessagePort 的精确 attachment scope 通过。remote 必须同时满足：
 * 该 logical session 仍在线、generation/identity/path/source 未变，且 registry 为这个
 * scope 解析出的仍是本次 expose 的同一份 scoped services。legacy/canonical 不互相推断。
 */
export function createMobileProjectDirectoryAttachmentAssertion(params: {
  registry: AttachmentRegistry;
  getActiveServices(): ServiceCollection | null;
  services: ServiceCollection;
  attachmentScope: WindowHostAttachmentScope;
  attachmentGeneration: number;
  isDisposed(): boolean;
}): () => void {
  return () => {
    if (params.isDisposed()) throw new Error("project.stale-attachment");
    const scope = params.attachmentScope;
    if (scope.kind === "source-settings") throw new Error("project.invalid-attachment");
    if (scope.kind === "local") {
      if (params.getActiveServices() !== params.services)
        throw new Error("project.stale-attachment");
      return;
    }
    const current = params.registry.getSession(scope.remoteSessionId);
    if (
      !current ||
      current.generation !== params.attachmentGeneration ||
      current.state !== "online" ||
      current.sourceAvailability !== "online" ||
      current.workspacePath !== scope.workspacePath ||
      current.workspaceIdentity !== scope.workspaceIdentity ||
      (scope.sourceServerId !== undefined && current.sourceServerId !== scope.sourceServerId) ||
      params.registry.resolveScopedServices(scope) !== params.services
    )
      throw new Error("project.stale-attachment");
  };
}

/**
 * 目录 capability 只能由本次 attachment 的 scoped services + 握手 capabilities 决定。
 * 远端 TaskService 是 RPC proxy，任何属性都表现为 function；不能据此推断 existing entry，
 * 也不能读取窗口本地 activeServices 来宣告远端附件。
 */
export function resolveMobileProjectDirectoryAvailability(params: {
  clientMode: "desktop-continuous" | "web-remote-replayable";
  attachmentScope: WindowHostAttachmentScope;
  services: ServiceCollection;
  capabilities?: MobileProjectDirectoryCapabilities;
}): boolean {
  if (params.clientMode !== "web-remote-replayable") return false;
  if (params.attachmentScope.kind === "source-settings") return false;
  if (!params.services.getOptional(IProjectService)) return false;
  const tasks = params.services.getOptional(IZCodeTaskService);
  if (!tasks) return false;
  if (params.attachmentScope.kind === "local")
    return typeof tasks.createTaskExistingRuntime === "function";
  return params.capabilities?.existingRuntimeAdmission === true;
}

interface OwnerSeed {
  hostId: string;
  services: ServiceCollection;
  capabilities?: MobileProjectDirectoryCapabilities;
  lease:
    | { kind: "source"; sourceServerId: string }
    | { kind: "session"; session: SessionSnapshot }
    | { kind: "attachment" };
}

/**
 * 目录投影仍列出窗口可见的本地/已连接 Source，但 create 只对与当前 attachment
 * 精确匹配的 root 返回 target。不再按 path/identity `find` 第一个 logical session，
 * 不把 legacy identity canonicalize 到另一个 host owner。
 */
export function createMobileProjectDirectoryOwners(params: {
  assertAttachment(): void;
  attachmentScope: WindowHostAttachmentScope;
  attachmentGeneration: number;
  attachmentServices: ServiceCollection;
  attachmentCapabilities?: MobileProjectDirectoryCapabilities;
  localServices: ServiceCollection | null;
  registry: AttachmentRegistry;
}): MobileProjectDirectoryOwner[] {
  const { registry, attachmentScope, attachmentGeneration } = params;
  const owners: MobileProjectDirectoryOwner[] = [];
  const localBound = attachmentScope.kind === "local";
  const local = params.localServices;
  if (local?.getOptional(IProjectService)) {
    const projects = local.get(IProjectService);
    const agent = local.get(IZCodeAgentService);
    const tasks = local.get(IZCodeTaskService);
    const assertLocal = () => {
      params.assertAttachment();
      if (params.localServices !== local) throw new Error("project.stale-attachment");
    };
    owners.push({
      hostId: "local",
      projects,
      agent,
      tasks: guardReplayableTaskCreation({
        tasks,
        agent,
        supported: localBound,
        localAdmission: true,
        inProcess: true,
        assertTarget: (target) => {
          assertLocal();
          if (
            target.remoteSessionId ||
            (target.workspaceIdentity && isRemoteWorkspaceIdentity(target.workspaceIdentity))
          )
            throw new Error("project.invalid-attachment");
        },
      }),
      target: (rootPath) => (localBound ? { workspacePath: rootPath, generation: 1 } : undefined),
      assertCurrent: assertLocal,
    });
  }

  const attachmentHostId =
    attachmentScope.kind === "remote"
      ? remoteHostIdFromWorkspaceIdentity(attachmentScope.workspaceIdentity)
      : null;
  const seeds = new Map<string, OwnerSeed>();
  for (const source of registry.listOnlineSources()) {
    const online = registry.getOnlineSource(source.sourceServerId);
    if (!online?.virtualProjects) continue;
    if (!source.services.getOptional(IProjectService)) continue;
    const hostId = remoteHostIdFromWorkspaceIdentity(
      buildServerRemoteWorkspaceIdentity({ serverId: source.sourceServerId, workspacePath: "/" }),
    );
    if (!hostId) continue;
    seeds.set(hostId, {
      hostId,
      services: source.services,
      capabilities: online.capabilities,
      lease: { kind: "source", sourceServerId: source.sourceServerId },
    });
  }
  for (const session of registry.listSessions()) {
    if (
      session.state !== "online" ||
      session.sourceAvailability !== "online" ||
      !session.workspaceIdentity ||
      !session.workspacePath
    )
      continue;
    const hostId = remoteHostIdFromWorkspaceIdentity(session.workspaceIdentity);
    if (!hostId || seeds.has(hostId)) continue;
    const scope = {
      kind: "remote" as const,
      remoteSessionId: session.remoteSessionId,
      workspacePath: session.workspacePath,
      workspaceIdentity: session.workspaceIdentity,
    };
    let services: ServiceCollection;
    try {
      services = registry.resolveScopedServices(scope);
    } catch {
      continue;
    }
    if (!services.getOptional(IProjectService)) continue;
    seeds.set(hostId, {
      hostId,
      services,
      capabilities: registry.resolveScopedCapabilities(scope),
      lease: { kind: "session", session },
    });
  }
  if (attachmentHostId && attachmentScope.kind === "remote") {
    // 当前 MessagePort 的 attachment 是唯一可启用来源；精确复用该 scope 的 services。
    if (params.attachmentServices.getOptional(IProjectService)) {
      seeds.set(attachmentHostId, {
        hostId: attachmentHostId,
        services: params.attachmentServices,
        capabilities: params.attachmentCapabilities,
        lease: { kind: "attachment" },
      });
    }
  }

  for (const seed of seeds.values()) {
    const bound = seed.hostId === attachmentHostId && attachmentScope.kind === "remote";
    const scope = attachmentScope.kind === "remote" ? attachmentScope : undefined;
    const assertCurrent = () => {
      params.assertAttachment();
      if (seed.lease.kind === "attachment") return;
      if (seed.lease.kind === "source") {
        if (registry.getOnlineSource(seed.lease.sourceServerId)?.services !== seed.services)
          throw new Error("project.host-offline");
        return;
      }
      const snapshot = seed.lease.session;
      const current = registry.getSession(snapshot.remoteSessionId);
      if (
        !current ||
        current.generation !== snapshot.generation ||
        current.state !== "online" ||
        current.sourceAvailability !== "online" ||
        current.workspacePath !== snapshot.workspacePath ||
        current.workspaceIdentity !== snapshot.workspaceIdentity
      )
        throw new Error("project.stale-attachment");
      const leaseScope = {
        kind: "remote" as const,
        remoteSessionId: snapshot.remoteSessionId,
        workspacePath: snapshot.workspacePath!,
        workspaceIdentity: snapshot.workspaceIdentity!,
      };
      if (registry.resolveScopedServices(leaseScope) !== seed.services)
        throw new Error("project.stale-attachment");
    };
    const projects = seed.services.get(IProjectService);
    const agent = seed.services.get(IZCodeAgentService);
    owners.push({
      hostId: seed.hostId,
      projects,
      agent,
      tasks: guardReplayableTaskCreation({
        tasks: seed.services.get(IZCodeTaskService),
        agent,
        supported: bound && seed.capabilities?.existingRuntimeAdmission === true,
        localAdmission: false,
        inProcess: false,
        assertTarget: (target) => {
          assertCurrent();
          if (
            !scope ||
            target.workspacePath !== scope.workspacePath ||
            target.workspaceIdentity !== scope.workspaceIdentity ||
            target.remoteSessionId !== scope.remoteSessionId
          )
            throw new Error("project.stale-attachment");
        },
      }),
      target: (rootPath) => {
        if (!bound || !scope) return undefined;
        // 只有 attachment 自己的 workspacePath 是已附着 root；同项目其它 root 保持 disabled。
        if (rootPath !== scope.workspacePath) return undefined;
        return {
          workspacePath: rootPath,
          workspaceIdentity: scope.workspaceIdentity,
          remoteSessionId: scope.remoteSessionId,
          generation: attachmentGeneration,
        };
      },
      assertCurrent,
    });
  }
  return owners;
}
