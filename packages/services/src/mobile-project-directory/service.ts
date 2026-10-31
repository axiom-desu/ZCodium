import type { IProjectService } from "../project/index.js";
import type { IZCodeAgentService, ZCodeAgentWorkspaceTarget } from "../zcode-agent/zcodeAgent.js";
import type { IZCodeTaskService } from "../session/zcodeTaskService.js";
import type { IMobileProjectDirectoryService, MobileProjectRoot } from "./contract.js";

export interface MobileProjectDirectoryOwner {
  hostId: string;
  projects: IProjectService;
  agent: IZCodeAgentService;
  tasks: IZCodeTaskService;
  target(rootPath: string): (ZCodeAgentWorkspaceTarget & { generation: number }) | undefined;
  assertCurrent(): void;
}

/** Projection only. Projects/actors/attachments remain their respective owners. */
export function createMobileProjectDirectoryService(port: {
  owners(): MobileProjectDirectoryOwner[];
  assertCurrent(): void;
}): IMobileProjectDirectoryService {
  const assert = (owner: MobileProjectDirectoryOwner) => {
    port.assertCurrent();
    owner.assertCurrent();
  };
  return {
    async readProjects() {
      port.assertCurrent();
      const groups = await Promise.all(
        port.owners().map(async (owner) => {
          assert(owner);
          const projects = await owner.projects.readProjects();
          assert(owner);
          const roots = await Promise.all(
            projects
              .filter((p) => !p.deleted)
              .flatMap((project) =>
                project.roots.map(async (root): Promise<MobileProjectRoot> => {
                  const row: MobileProjectRoot = {
                    rootIdentity: {
                      hostId: owner.hostId,
                      projectId: project.id,
                      rootPath: root.rootPath,
                    },
                    projectName: project.name,
                    enabled: false,
                  };
                  const target = owner.target(root.rootPath);
                  if (!target || project.legacySingleRoot) return row;
                  try {
                    const runtimeIdentity = await owner.agent.getWorkspaceRuntimeIdentity(target);
                    assert(owner);
                    return {
                      ...row,
                      enabled: true,
                      workspaceIdentity: target.workspaceIdentity,
                      remoteSessionId: target.remoteSessionId,
                      attachmentGeneration: target.generation,
                      runtimeIdentity,
                    };
                  } catch {
                    assert(owner);
                    return row;
                  }
                }),
              ),
          );
          assert(owner);
          return roots;
        }),
      );
      port.assertCurrent();
      return groups.flat();
    },
    async createTask(root) {
      port.assertCurrent();
      if (!root?.enabled || !root.runtimeIdentity) throw new Error("project.open-on-desktop");
      const owner = port.owners().find((o) => o.hostId === root.rootIdentity.hostId);
      if (!owner) throw new Error("project.host-offline");
      assert(owner);
      const target = owner.target(root.rootIdentity.rootPath);
      if (
        !target ||
        target.workspaceIdentity !== root.workspaceIdentity ||
        target.remoteSessionId !== root.remoteSessionId ||
        target.generation !== root.attachmentGeneration
      )
        throw new Error("project.stale-attachment");
      const projects = await owner.projects.readProjects();
      assert(owner);
      if (
        !projects.some(
          (p) =>
            p.id === root.rootIdentity.projectId &&
            !p.deleted &&
            !p.legacySingleRoot &&
            p.roots.some((r) => r.rootPath === target.workspacePath),
        )
      )
        throw new Error("project.root-unavailable");
      // 不能 check 后调用普通 create：同一 TaskService 在任何 prepare 前捕获真实 existing client。
      const result = await owner.tasks.createTaskExistingRuntime(
        { ...target, projectId: root.rootIdentity.projectId },
        root.runtimeIdentity,
      );
      assert(owner);
      return result;
    },
  };
}
