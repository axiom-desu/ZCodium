import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NativeRun } from "./linux.js";
import { parseDesktopEntry, queryLinuxApplications } from "./linux.js";
import { parseNativeApplications, parseWindowsApplications } from "./native.js";
import { normalizeWindowsIconDataUrl } from "./windows-icon.js";

let root = "";

beforeAll(async () => {
  // 只用临时 XDG 根，不读真实桌面目录。
  root = await mkdtemp(join(tmpdir(), "bn5-xdg-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeDesktopEntry(id: string, body: string): Promise<void> {
  const path = join(root, "applications", id);
  await mkdir(join(path, ".."), { recursive: true });
  // 真实 .desktop 一定有组头；缺组头的字段必须被解析忽略。
  await writeFile(path, `[Desktop Entry]\n${body}`, "utf8");
}

function linuxRun(outputs: {
  mime?: string;
  gio?: string | Error;
  defaultId?: string;
  calls?: string[][];
}): NativeRun {
  return async (command, args) => {
    outputs.calls?.push([command, ...args]);
    if (command === "xdg-mime" && args[0] === "query" && args[1] === "filetype") {
      return outputs.mime ?? "text/plain\n";
    }
    if (command === "xdg-mime" && args[0] === "query" && args[1] === "default") {
      return outputs.defaultId ?? "";
    }
    if (command === "gio") {
      if (outputs.gio instanceof Error) throw outputs.gio;
      return (
        outputs.gio ??
        "Default application for text/plain:\n\tplain.desktop\n\nRegistered applications:\n\tplain.desktop\n\tother.desktop\n"
      );
    }
    if (command === "xdg-open") return "xdg-open 1.2.1\n";
    throw new Error(`unexpected command ${command}`);
  };
}

describe("parseDesktopEntry", () => {
  it("只读取 [Desktop Entry] 段并跳过注释", () => {
    const fields = parseDesktopEntry(
      [
        "[Desktop Entry]",
        "# comment",
        "Type=Application",
        "Name=Plain Editor",
        "",
        "[Desktop Action new]",
        "Name=New Window",
      ].join("\n"),
    );
    expect(fields.Type).toBe("Application");
    expect(fields.Name).toBe("Plain Editor");
  });

  it("损坏行不抛错，忽略缺少等号的记录", () => {
    expect(parseDesktopEntry("[Desktop Entry]\nType=Application\nbroken line\nName=Foo")).toEqual({
      Type: "Application",
      Name: "Foo",
    });
    // 没有组头的行不属于任何 Desktop Entry 段。
    expect(parseDesktopEntry("Type=Application\nName=Foo")).toEqual({});
  });
});

describe("queryLinuxApplications", () => {
  it("从临时 XDG 根枚举真实 desktop entry 并标记系统默认", async () => {
    await writeDesktopEntry(
      "plain.desktop",
      "Type=Application\nName=Plain Editor\nExec=plain %f\n",
    );
    await writeDesktopEntry(
      "other.desktop",
      "Type=Application\nName=Other Viewer\nExec=other %u\n",
    );
    const apps = await queryLinuxApplications("/tmp/report.pdf", linuxRun({}), [
      join(root, "applications"),
    ]);
    expect(apps.map((app) => app.name)).toEqual(["Plain Editor", "Other Viewer"]);
    expect(apps[0]).toMatchObject({ isDefault: true, identity: "linux-desktop:plain.desktop" });
    expect(apps[1]?.isDefault).toBe(false);
  });

  it("拒绝 Hidden/非 Application/缺 Name/TryExec 不可执行的记录", async () => {
    const gio = [
      "Default application for text/plain:",
      "\tplain.desktop",
      "",
      "Registered applications:",
      "\tplain.desktop",
      "\tother.desktop",
      "\tdbus.desktop",
      "\thidden.desktop",
      "\tlink.desktop",
      "\tnoname.desktop",
      "\ttryexec.desktop",
      "\tnoexec.desktop",
      "",
    ].join("\n");
    await writeDesktopEntry("hidden.desktop", "Type=Application\nName=Hidden\nHidden=true\n");
    await writeDesktopEntry("link.desktop", "Type=Link\nName=Link\n");
    await writeDesktopEntry("noname.desktop", "Type=Application\n");
    await writeDesktopEntry(
      "tryexec.desktop",
      `Type=Application\nName=TryExec\nExec=x\nTryExec=${join(root, "missing-binary")}\n`,
    );
    await writeDesktopEntry("noexec.desktop", "Type=Application\nName=NoExec\n");
    await writeDesktopEntry(
      "dbus.desktop",
      "Type=Application\nName=DBus Only\nDBusActivatable=true\n",
    );
    const apps = await queryLinuxApplications("/tmp/a.pdf", linuxRun({ gio }), [
      join(root, "applications"),
    ]);
    expect(apps.map((app) => app.name)).toContain("DBus Only");
    expect(apps.map((app) => app.name)).not.toContain("Hidden");
    expect(apps.map((app) => app.name)).not.toContain("Link");
    expect(apps.some((app) => app.key.endsWith("tryexec.desktop"))).toBe(false);
  });

  it("接受可执行的绝对 TryExec，并支持子目录 XDG ID", async () => {
    const executable = join(root, "bin-ok");
    await writeFile(executable, "#!/bin/sh\n", "utf8");
    await chmod(executable, 0o755);
    await writeDesktopEntry(
      "sub/nested.desktop",
      `Type=Application\nName=Nested\\sViewer\nExec=nested\nTryExec=${executable}\n`,
    );
    const gio = [
      "Default application for text/plain:",
      "\tplain.desktop",
      "",
      "Registered applications:",
      "\tplain.desktop",
      "\tsub-nested.desktop",
      "",
    ].join("\n");
    const apps = await queryLinuxApplications("/tmp/a.pdf", linuxRun({ gio }), [
      join(root, "applications"),
    ]);
    const nested = apps.find((app) => app.identity === "linux-desktop:sub-nested.desktop");
    expect(nested?.name).toBe("Nested Viewer");
  });

  it("xdg-mime 返回非 MIME 时失败关闭为空", async () => {
    expect(
      await queryLinuxApplications("/tmp/a", linuxRun({ mime: "not a mime\n" }), [
        join(root, "applications"),
      ]),
    ).toEqual([]);
  });

  it("缺少 GIO 时只保留系统默认启动器可确认的项", async () => {
    const apps = await queryLinuxApplications(
      "/tmp/a.pdf",
      linuxRun({ gio: new Error("gio: command not found"), defaultId: "plain.desktop" }),
      [join(root, "applications")],
    );
    expect(apps).toHaveLength(1);
    expect(apps[0]).toMatchObject({ launchKind: "system-default", isDefault: true });
  });

  it("缺少 GIO 且默认应用不是 desktop id 时不臆测", async () => {
    expect(
      await queryLinuxApplications(
        "/tmp/a.pdf",
        linuxRun({ gio: new Error("missing"), defaultId: "weird-handler" }),
        [join(root, "applications")],
      ),
    ).toEqual([]);
  });
});

describe("parseNativeApplications", () => {
  it("解析 macOS 关联 JSON，去 BOM 后保留身份", () => {
    const payload = `\uFEFF${JSON.stringify([
      {
        key: "/Applications/Preview.app",
        name: "Preview",
        isDefault: true,
        iconPath: "/Applications/Preview.app",
        identity: "darwin-bundle:com.apple.preview",
      },
    ])}`;
    expect(parseNativeApplications(payload)).toEqual([
      {
        key: "/Applications/Preview.app",
        name: "Preview",
        isDefault: true,
        iconPath: "/Applications/Preview.app",
        identity: "darwin-bundle:com.apple.preview",
      },
    ]);
  });

  it("拒绝非数组、损坏 JSON 与字段类型不对的记录", () => {
    expect(parseNativeApplications("{}")).toEqual([]);
    expect(parseNativeApplications("not json")).toEqual([]);
    expect(
      parseNativeApplications(
        JSON.stringify([
          { key: "/A.app", name: "A", isDefault: true },
          { key: "", name: "B", isDefault: true },
          { key: "/C.app", name: "", isDefault: true },
          { key: "/D.app", name: "D", isDefault: "yes" },
          { key: "/E.app", name: "E", isDefault: false, identity: 7 },
          { key: "/F.app", name: "F", isDefault: false, iconPath: 42 },
        ]),
      ).map((app) => app.key),
    ).toEqual(["/A.app"]);
  });
});

describe("parseWindowsApplications", () => {
  const application = (overrides: Record<string, unknown>) => ({
    key: "C:\\Program Files\\App\\app.exe",
    name: "App",
    isDefault: false,
    iconPath: null,
    ...overrides,
  });

  it("只按 Shell 的有效默认身份标记默认应用（ProgID/AppID/可执行路径）", () => {
    const parsed = parseWindowsApplications(
      JSON.stringify({
        applications: [
          application({ key: "C:\\Edge\\msedge.exe", name: "Edge", progId: "MSEdgePDF" }),
          application({ key: "C:\\Other\\other.exe", name: "Other", progId: "OtherPDF" }),
        ],
        defaultAssociation: { progId: "MSEdgePDF" },
      }),
    );
    expect(parsed.map((app) => [app.name, app.isDefault])).toEqual([
      ["Edge", true],
      ["Other", false],
    ]);
  });

  it("无法唯一确认默认时不沿用输入旧标记", () => {
    const parsed = parseWindowsApplications(
      JSON.stringify({
        applications: [
          application({ key: "C:\\A\\a.exe", name: "A", isDefault: true }),
          application({ key: "C:\\B\\b.exe", name: "B", isDefault: true }),
        ],
        defaultAssociation: { executable: "C:\\C\\c.exe" },
      }),
    );
    expect(parsed.every((app) => app.isDefault === false)).toBe(true);
  });

  it("损坏记录、非对象载荷与注入字段不进入结果", () => {
    expect(parseWindowsApplications("[]")).toEqual([]);
    expect(parseWindowsApplications("\uFEFF{")).toEqual([]);
    expect(
      parseWindowsApplications(
        JSON.stringify({
          applications: [
            application({ name: "Ok" }),
            application({ key: "C:\\Bad\\bad.exe", name: "BadVersion", version: 7 }),
            { key: 7, name: "NumericKey", isDefault: false },
            null,
          ],
        }),
      ).map((app) => app.name),
    ).toEqual(["Ok"]);
  });
});

/** 生成最小合法 PNG：signature + IHDR + IEND。 */
function png(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "ascii");
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8;
  ihdr[17] = 6;
  const iend = Buffer.alloc(12);
  iend.write("IEND", 4, "ascii");
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    ihdr,
    Buffer.alloc(0),
    iend,
  ]);
}

describe("normalizeWindowsIconDataUrl", () => {
  it("接受有界 PNG，拒绝脚本可注入的其它内容", () => {
    const valid = `data:image/png;base64,${png(48, 48).toString("base64")}`;
    expect(normalizeWindowsIconDataUrl(valid)).toBe(valid);
    expect(normalizeWindowsIconDataUrl("data:image/svg+xml;base64,PHN2Zz4=")).toBeNull();
    expect(
      normalizeWindowsIconDataUrl(`data:image/png;base64,${png(48, 48).toString("base64")}x`),
    ).toBeNull();
    expect(
      normalizeWindowsIconDataUrl(`data:image/png;base64,${png(512, 512).toString("base64")}`),
    ).toBeNull();
    expect(normalizeWindowsIconDataUrl(42)).toBeNull();
  });
});
