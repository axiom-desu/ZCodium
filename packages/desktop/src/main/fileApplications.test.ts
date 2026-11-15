import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getFileApplicationDefs,
  matchesFileApplication,
  resolveFileApplicationPath,
} from "./fileApplications.js";

let root = "";

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "bn5-app-path-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("getFileApplicationDefs", () => {
  it("Linux 不再返回空占位，按扩展名给出真实应用定义", () => {
    const defs = getFileApplicationDefs("linux");
    expect(defs.length).toBeGreaterThan(0);
    expect(defs.find((def) => def.id === "evince")).toMatchObject({
      fileExtensions: ["pdf"],
      executableNames: ["evince"],
    });
    expect(defs.find((def) => def.id === "libreoffice-impress")).toMatchObject({
      fileExtensions: ["pptx"],
      launchArgs: ["--impress"],
    });
    // 所有定义都必须声明扩展名，否则文件菜单无法按类型筛选。
    expect(defs.every((def) => def.fileExtensions.length > 0)).toBe(true);
  });

  it("macOS/Windows 定义完整，未知平台返回空", () => {
    for (const platform of ["darwin", "win32"] as const) {
      const defs = getFileApplicationDefs(platform);
      expect(defs.length).toBeGreaterThan(0);
      expect(defs.every((def) => def.appPath.length > 0)).toBe(true);
    }
    expect(getFileApplicationDefs("freebsd")).toEqual([]);
  });
});

describe("matchesFileApplication", () => {
  const pdf = getFileApplicationDefs("linux").find((def) => def.id === "evince")!;

  it("按扩展名匹配且大小写不敏感", () => {
    expect(matchesFileApplication(pdf, "/tmp/Report.PDF")).toBe(true);
    expect(matchesFileApplication(pdf, "C:\\tmp\\report.Pdf")).toBe(true);
  });

  it("无路径或不匹配扩展名时不返回文件类型应用", () => {
    expect(matchesFileApplication(pdf, undefined)).toBe(false);
    expect(matchesFileApplication(pdf, "/tmp/notes.txt")).toBe(false);
    expect(matchesFileApplication(pdf, "/tmp/noext")).toBe(false);
  });
});

describe("resolveFileApplicationPath", () => {
  it("只返回真实安装的应用：缺失返回 null，临时可执行文件返回路径", async () => {
    const missing = await resolveFileApplicationPath(
      {
        id: "bn5-missing",
        name: "Missing",
        appPath: join(root, "missing-app"),
        command: null,
        fileExtensions: ["pdf"],
        executableNames: ["bn5-missing-binary"],
      },
      "linux",
      join(root, "empty-path"),
    );
    expect(missing).toBeNull();

    const executable = join(root, "installed-app");
    await writeFile(executable, "#!/bin/sh\n", "utf8");
    await chmod(executable, 0o755);
    expect(
      await resolveFileApplicationPath(
        {
          id: "bn5-installed",
          name: "Installed",
          appPath: executable,
          command: null,
          fileExtensions: ["pdf"],
        },
        "linux",
        join(root, "empty-path"),
      ),
    ).toBe(executable);
  });
});
