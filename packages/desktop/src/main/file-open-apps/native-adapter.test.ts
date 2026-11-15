import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFileApplicationService } from "./index.js";

/** 真实生产链路：默认 native adapter → 真子进程 → 临时 XDG 根 → 系统关联结果。 */
let root = "";
let binDir = "";
let recordFile = "";
let originalEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "bn5-native-"));
  binDir = join(root, "bin");
  recordFile = join(root, "launch.log");
  await mkdir(binDir, { recursive: true });
  await mkdir(join(root, "data/applications"), { recursive: true });

  // PATH 上只放 sh stub，保证不会调用真实桌面命令。
  const stub = (name: string, body: string) =>
    writeFile(join(binDir, name), `#!/bin/sh\n${body}\n`, "utf8").then(() =>
      chmod(join(binDir, name), 0o755),
    );
  await stub(
    "xdg-mime",
    [
      'if [ "$1" = "query" ] && [ "$2" = "filetype" ]; then',
      '  case "$3" in',
      '    *noassoc*) echo "inode/x-empty" ;;',
      '    *) echo "text/plain" ;;',
      "  esac",
      'elif [ "$1" = "query" ] && [ "$2" = "default" ]; then',
      '  echo "plain.desktop"',
      "else",
      "  exit 1",
      "fi",
    ].join("\n"),
  );
  await stub(
    "gio",
    [
      'if [ "$1" = "mime" ]; then',
      '  case "$2" in',
      '    inode/x-empty) printf "Default application for inode/x-empty:\\n\\t(none)\\n" ;;',
      '    *) printf "Default application for text/plain:\\n\\tplain.desktop\\n\\nRegistered applications:\\n\\tplain.desktop\\n" ;;',
      "  esac",
      'elif [ "$1" = "launch" ]; then',
      `  printf "%s\\n" "$@" >> "${recordFile}"`,
      "else",
      "  exit 1",
      "fi",
    ].join("\n"),
  );
  await writeFile(
    join(root, "data/applications/plain.desktop"),
    "[Desktop Entry]\nType=Application\nName=Plain Editor\nExec=plain %f\n",
    "utf8",
  );

  originalEnv = {
    PATH: process.env.PATH,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    XDG_DATA_DIRS: process.env.XDG_DATA_DIRS,
  };
  process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
  process.env.XDG_DATA_HOME = join(root, "data");
  process.env.XDG_DATA_DIRS = join(root, "data");
});

afterAll(async () => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
});

describe("native adapter linux", () => {
  it("枚举临时 XDG 根的真实 desktop entry（无图标也保留）", async () => {
    const filePath = join(root, "report.pdf");
    await writeFile(filePath, "pdf", "utf8");
    const service = createFileApplicationService({
      getIcon: async () => null,
      logger: { warn: () => {} },
    });
    const apps = await service.getFileApplications({ path: filePath, pathKind: "file" });
    expect(apps).toHaveLength(1);
    expect(apps[0]).toMatchObject({ name: "Plain Editor", isDefault: true });
    expect(apps[0]?.id).toMatch(/^file-app:[0-9a-f]{64}$/);
    expect(apps[0]?.iconDataUrl).toBeUndefined();
  });

  it("打开时重新查询并调用 gio launch，路径作为独立 argv 不经过 shell", async () => {
    const filePath = join(root, "report;touch pwned.pdf");
    await writeFile(filePath, "pdf", "utf8");
    const service = createFileApplicationService({ logger: { warn: () => {} } });
    const [app] = await service.getFileApplications({ path: filePath, pathKind: "file" });
    expect(
      await service.openFileWithApplication(app!.id, { path: filePath, pathKind: "file" }),
    ).toEqual({ success: true });
    const record = await readFile(recordFile, "utf8");
    expect(record).toContain("launch");
    expect(record).toContain("plain.desktop");
    expect(record).toContain("report;touch pwned.pdf");
    // 若把路径拼进 shell，会生成 pwned 文件；argv 传递不会。
    await expect(stat(join(root, "pwned"))).rejects.toThrow();
  });

  it("系统没有该类型关联时返回空数组而不是占位", async () => {
    const filePath = join(root, "noassoc.bin");
    await writeFile(filePath, "bin", "utf8");
    const service = createFileApplicationService({ logger: { warn: () => {} } });
    expect(await service.getFileApplications({ path: filePath, pathKind: "file" })).toEqual([]);
  });
});
