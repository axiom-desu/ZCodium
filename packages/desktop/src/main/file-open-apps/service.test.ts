import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FileApplicationNativeAdapter, NativeFileApplication } from "./contract.js";
import { createFileApplicationService } from "./index.js";

let workspace = "";
let filePath = "";
const opened: Array<{ key: string; path: string }> = [];

beforeAll(async () => {
  // 只使用临时 workspace 文件，绝不读真实用户目录。
  workspace = await mkdtemp(join(tmpdir(), "bn5-file-apps-"));
  filePath = join(workspace, "report.pdf");
  await writeFile(filePath, "pdf-bytes", "utf8");
});

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
});

function adapter(applications: NativeFileApplication[]): FileApplicationNativeAdapter {
  return {
    async query() {
      return applications;
    },
    async open(application, path) {
      opened.push({ key: application.key, path });
    },
  };
}

const target = () => ({ path: filePath, pathKind: "file" as const });

describe("getFileApplications", () => {
  it("枚举本机真实文件关联并按身份去重、默认优先", async () => {
    const service = createFileApplicationService({
      adapter: adapter([
        {
          key: "/usr/share/applications/plain.desktop",
          name: "Plain",
          isDefault: true,
          identity: "linux-desktop:plain.desktop",
        },
        {
          key: "/home/user/.local/share/applications/plain.desktop",
          name: "Plain",
          isDefault: false,
          identity: "linux-desktop:plain.desktop",
        },
        {
          key: "/usr/share/applications/other.desktop",
          name: "Other",
          isDefault: false,
          identity: "linux-desktop:other.desktop",
        },
      ]),
    });
    const apps = await service.getFileApplications(target());
    expect(apps.map((app) => app.name)).toEqual(["Plain", "Other"]);
    expect(apps.map((app) => app.isDefault)).toEqual([true, false]);
    expect(apps[0]?.id).toMatch(/^file-app:[0-9a-f]{64}$/);
  });

  it("同名不同身份附带身份后缀，避免菜单出现两条相同条目", async () => {
    const service = createFileApplicationService({
      adapter: adapter([
        { key: "/opt/a/chromium", name: "Chromium", isDefault: false, identity: "path:/opt/a" },
        { key: "/opt/b/chromium", name: "Chromium", isDefault: false, identity: "path:/opt/b" },
      ]),
    });
    const apps = await service.getFileApplications(target());
    expect(apps.map((app) => app.name)).toEqual(["Chromium (/opt/a)", "Chromium (/opt/b)"]);
  });

  it("图标失败不隐藏有效应用", async () => {
    const service = createFileApplicationService({
      adapter: adapter([
        {
          key: "/Applications/Preview.app",
          name: "Preview",
          isDefault: true,
          iconPath: "/Applications/Preview.app",
        },
      ]),
      getIcon: async () => {
        throw new Error("icon failed");
      },
    });
    const apps = await service.getFileApplications(target());
    expect(apps).toHaveLength(1);
    expect(apps[0]?.iconDataUrl).toBeUndefined();
  });

  it.each([
    ["目录", { path: workspace, pathKind: "directory" as const }],
    ["远端目标", { ...target(), remoteTarget: { kind: "ssh" as const, host: "h" } }],
    ["身份隔离路径", { ...target(), workspaceIdentity: "remote:ws" }],
    ["相对路径", { path: "report.pdf", pathKind: "file" as const }],
    ["NUL 字节", { path: `${filePath}\u0000`, pathKind: "file" as const }],
    ["不存在的文件", { path: join(workspace, "missing.pdf"), pathKind: "file" as const }],
    ["缺 target", undefined],
  ])("拒绝非本机真实文件目标：%s", async (_label, badTarget) => {
    const service = createFileApplicationService({
      adapter: adapter([{ key: "/a", name: "A", isDefault: true }]),
    });
    expect(await service.getFileApplications(badTarget as never)).toEqual([]);
  });

  it("原生查询抛错时失败关闭为空数组", async () => {
    const service = createFileApplicationService({
      adapter: {
        async query() {
          throw new Error("native query failed");
        },
        async open() {},
      },
    });
    expect(await service.getFileApplications(target())).toEqual([]);
  });
});

describe("openFileWithApplication", () => {
  it("只打开重新查到的真实应用，不执行 renderer 给的命令", async () => {
    opened.length = 0;
    const service = createFileApplicationService({
      adapter: adapter([
        {
          key: "/usr/share/applications/plain.desktop",
          name: "Plain",
          isDefault: true,
          identity: "linux-desktop:plain.desktop",
        },
      ]),
    });
    const [app] = await service.getFileApplications(target());
    expect(await service.openFileWithApplication(app!.id, target())).toEqual({ success: true });
    expect(opened).toEqual([{ key: "/usr/share/applications/plain.desktop", path: filePath }]);
  });

  it("未知 id / 注入式 id 不会触发任何启动", async () => {
    opened.length = 0;
    const service = createFileApplicationService({
      adapter: adapter([
        {
          key: "/usr/share/applications/plain.desktop",
          name: "Plain",
          isDefault: true,
          identity: "linux-desktop:plain.desktop",
        },
      ]),
    });
    for (const id of ["", "file-app:deadbeef", "/bin/sh -c 'id'", "plain.desktop; rm -rf /"]) {
      expect(await service.openFileWithApplication(id, target())).toEqual({
        success: false,
        error: "application_not_available",
      });
    }
    expect(opened).toEqual([]);
  });

  it("目标不合法时返回 unsupported_file_target", async () => {
    const service = createFileApplicationService({
      adapter: adapter([{ key: "/a", name: "A", isDefault: true }]),
    });
    expect(
      await service.openFileWithApplication("file-app:x", {
        ...target(),
        remoteTarget: { kind: "ssh", host: "h", username: "u" },
      }),
    ).toEqual({ success: false, error: "unsupported_file_target" });
  });

  it("原生启动失败时返回 application_open_failed 且不泄漏错误细节", async () => {
    const service = createFileApplicationService({
      adapter: {
        async query() {
          return [{ key: "/a.desktop", name: "A", isDefault: true }];
        },
        async open() {
          throw new Error("/home/user/secret path failed");
        },
      },
    });
    const [app] = await service.getFileApplications(target());
    const result = await service.openFileWithApplication(app!.id, target());
    expect(result).toEqual({ success: false, error: "application_open_failed" });
  });
});
