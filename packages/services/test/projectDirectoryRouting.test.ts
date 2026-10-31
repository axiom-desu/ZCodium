import { describe, expect, it, vi } from "vitest";
import type { FileEntry } from "@zcode/shared";
import type { ProjectRepositoryContract } from "#src/project-storage/contract.js";
import { createProjectService } from "#src/project/app/index.js";

const remoteEntries: FileEntry[] = [{ name: "repo", path: "/srv/repo", type: "directory" }];

describe("Source 项目目录路由", () => {
  it("readDirectory 按 hostId 走已在线远端 Host，不读本地目录也不启动 Agent", async () => {
    const remoteReadDirectory = vi.fn(async () => ({ path: "/srv", entries: remoteEntries }));
    const localRead = vi.fn(async () => remoteEntries);
    const repository = vi.fn(async () => {
      throw new Error("directory read must not touch the local project repository");
    });

    const service = createProjectService({
      repository: repository as unknown as () => Promise<ProjectRepositoryContract>,
      workspaceDirectory: "/local",
      ownerHostId: "local",
      directories: { home: async () => "/local", read: localRead },
      resolveHost: async (hostId) => {
        if (hostId !== "remote:server:source-1") throw new Error("project.host-offline");
        return { readDirectory: remoteReadDirectory } as never;
      },
    });

    await expect(
      service.readDirectory({ hostId: "remote:server:source-1", path: "/srv" }),
    ).resolves.toEqual({ path: "/srv", entries: remoteEntries });
    expect(remoteReadDirectory).toHaveBeenCalledWith({
      hostId: "remote:server:source-1",
      path: "/srv",
    });
    expect(localRead).not.toHaveBeenCalled();
    expect(repository).not.toHaveBeenCalled();
  });

  it("在线 Host 缺失时 typed 拒绝，不创建替代 Host 或读取本地目录", async () => {
    const localRead = vi.fn(async () => remoteEntries);
    const service = createProjectService({
      repository: async () => ({}) as ProjectRepositoryContract,
      workspaceDirectory: "/local",
      ownerHostId: "local",
      directories: { home: async () => "/local", read: localRead },
      resolveHost: async () => {
        throw new Error("project.host-offline");
      },
    });

    await expect(service.readDirectory({ hostId: "remote:server:offline" })).rejects.toThrow(
      /project\.host-offline/u,
    );
    expect(localRead).not.toHaveBeenCalled();
  });
});
