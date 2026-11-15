import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFileService } from "#src/file/fileService.js";
import { readApprovedDesignSourceRoots } from "#src/file/designSourceAuthority.js";
import { createProjectService } from "#src/project/app/index.js";
import type { ProjectTree } from "#src/project/contract.js";
import { TaskIndexRepo } from "#src/session/taskIndexRepo.js";

// B7：设计源码读写的批准根只能来自本 Host 既有 project/task 目录事实。
// 这里用假 project tree 验证取舍规则，再用真实 SQLite 项目仓储验证「改 root 后立即失效」。
// 不读用户项目/配置：临时目录 + 临时 tasks-index。

const tempRoots: string[] = [];
const repos: TaskIndexRepo[] = [];

afterEach(async () => {
  for (const repo of repos.splice(0)) repo.close();
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function fakeProjectService(tree: ProjectTree): {
  readTree: () => Promise<ProjectTree>;
} {
  return { readTree: async () => tree };
}

function project(
  hostId: string,
  deleted: boolean,
  rootPath: string,
): ProjectTree["projects"][number] {
  return {
    id: `${hostId}:${rootPath}`,
    hostId,
    name: rootPath,
    nameOverridden: false,
    roots: [{ rootPath, position: 0, isPrimary: true }],
    position: 0,
    pinned: false,
    deleted,
    createdAt: 0,
    updatedAt: 0,
  };
}

describe("design source root authority", () => {
  it("approves only this Host's project roots and task cwds", async () => {
    const tree = {
      projects: [
        project("local", false, "/srv/local-project"),
        project("remote-1", false, "/srv/foreign-project"),
        project("local", true, "/srv/deleted-project"),
        project("local", false, "relative-root"),
      ],
      tasks: [
        { taskId: "t-local", hostId: "local", workspacePath: "/srv/worktree-task" },
        { taskId: "t-foreign", hostId: "remote-1", workspacePath: "/srv/foreign-task" },
      ],
    } as unknown as ProjectTree;

    const approved = await readApprovedDesignSourceRoots(fakeProjectService(tree));
    expect(new Set(approved)).toEqual(new Set(["/srv/local-project", "/srv/worktree-task"]));
  });

  it("derives real approval from the Host project tree and revokes a replaced root", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-design-authority-"));
    tempRoots.push(directory);
    const repo = new TaskIndexRepo(join(directory, "tasks-index.sqlite"), 5000, {
      settings: { lastWorkspaceSession: [], recentProjects: [] },
      hostId: "local",
    });
    repos.push(repo);
    await repo.ensureReady();
    const projectService = createProjectService({
      repository: () => repo.getProjectRepository(),
      workspaceDirectory: join(directory, "workspace"),
    });
    const projectRoot = join(directory, "project");
    await mkdir(projectRoot);
    const saved = (await repo.getProjectRepository()).saveProject({
      name: "Design",
      roots: [projectRoot],
    });
    const fileService = createFileService({
      designSourceAuthority: {
        resolveApprovedRoots: () => readApprovedDesignSourceRoots(projectService),
      },
    });
    const path = join(projectRoot, "index.html");
    const html = "<html>base</html>";
    await writeFile(path, html, "utf-8");

    await expect(
      fileService.readDesignSourceFile({ rootPath: projectRoot, path }),
    ).resolves.toEqual({ content: html });
    await expect(
      fileService.writeDesignSourceFile({
        rootPath: projectRoot,
        path,
        expectedContent: html,
        content: "<html>saved</html>",
      }),
    ).resolves.toEqual({ written: true });
    await expect(readFile(path, "utf-8")).resolves.toBe("<html>saved</html>");

    // 项目改 root：旧 root 不再是批准根，下一次调用必须拒绝（无授权缓存）。
    const otherRoot = join(directory, "other");
    await mkdir(otherRoot);
    (await repo.getProjectRepository()).saveProject({ id: saved.id, roots: [otherRoot] });
    await expect(fileService.readDesignSourceFile({ rootPath: projectRoot, path })).rejects.toThrow(
      "design_source_unauthorized_root",
    );
    await expect(
      fileService.writeDesignSourceFile({
        rootPath: projectRoot,
        path,
        expectedContent: "<html>saved</html>",
        content: "<html>pwned</html>",
      }),
    ).resolves.toEqual({ written: false, reason: "unauthorized_root" });
    await expect(readFile(path, "utf-8")).resolves.toBe("<html>saved</html>");
  });
});
