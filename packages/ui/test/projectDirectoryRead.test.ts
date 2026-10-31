import { describe, expect, it, vi } from "vitest";
import { readProjectDirectoryEntries } from "@/lib/projectDirectoryRead.js";

const entries = [
  { name: "src", path: "/srv/app/src", type: "directory" as const },
  { name: "README.md", path: "/srv/app/README.md", type: "file" as const },
];

describe("Source 项目目录读取", () => {
  it("有 Project 服务时只走 IProjectService.readDirectory，不触碰文件服务或 Agent", async () => {
    const readDirectory = vi.fn(async () => ({ path: "/srv/app", entries }));
    const readdir = vi.fn(async () => entries);
    const listTasks = vi.fn();
    // 目录读取不需要也不应该触碰 Agent；一旦访问 zcodeAgentService 立即失败。
    const services = new Proxy(
      { projectService: { readDirectory }, fileService: { readdir } },
      {
        get(target, property) {
          if (property === "zcodeAgentService") {
            listTasks();
            throw new Error("directory read must not start Agent");
          }
          return Reflect.get(target, property);
        },
      },
    );

    await expect(
      readProjectDirectoryEntries(services, { path: "/srv/app", includeHidden: true }),
    ).resolves.toEqual(entries);

    expect(readDirectory).toHaveBeenCalledWith({ path: "/srv/app", includeHidden: true });
    expect(readdir).not.toHaveBeenCalled();
    expect(listTasks).not.toHaveBeenCalled();
  });

  it("旧 Host 没有 Project 服务时才回退 file.readdir，并保留隐藏目录参数", async () => {
    const readdir = vi.fn(async () => entries);

    await expect(
      readProjectDirectoryEntries({ fileService: { readdir } }, { path: "/srv/app" }),
    ).resolves.toEqual(entries);

    expect(readdir).toHaveBeenCalledWith({ path: "/srv/app" });
  });
});
