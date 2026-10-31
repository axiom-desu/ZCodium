import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ZCODE_USER_DATA_DIR_NAME } from "@zcode/shared";
import { createSettingService } from "#src/setting/settingService.js";

// 真实 SettingService + 临时 HOME：验证迁移/往返确实落盘（不是只在内存 schema 里）。
const homes: string[] = [];
let previousHome: string | undefined;

async function createTempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "zcode-settings-"));
  homes.push(home);
  previousHome = process.env.ZCODE_DESKTOP_HOME_DIR;
  process.env.ZCODE_DESKTOP_HOME_DIR = home;
  await mkdir(join(home, ZCODE_USER_DATA_DIR_NAME, "v2"), { recursive: true });
  return home;
}

function settingsFile(home: string): string {
  return join(home, ZCODE_USER_DATA_DIR_NAME, "v2", "setting.json");
}

async function writeSettings(home: string, value: unknown): Promise<void> {
  await writeFile(settingsFile(home), JSON.stringify(value), "utf-8");
}

async function readSettings(home: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(settingsFile(home), "utf-8")) as Record<string, unknown>;
}

beforeEach(() => {
  previousHome = process.env.ZCODE_DESKTOP_HOME_DIR;
});

afterEach(async () => {
  if (previousHome === undefined) {
    delete process.env.ZCODE_DESKTOP_HOME_DIR;
  } else {
    process.env.ZCODE_DESKTOP_HOME_DIR = previousHome;
  }
  for (const home of homes.splice(0)) {
    await rm(home, { recursive: true, force: true });
  }
});

describe("taskAutoArchiveResetVersion 一次性迁移（真实设置文件）", () => {
  it("旧文件首读关闭开关、写版本标记，重启后用户重新开启的选择保留", async () => {
    const home = await createTempHome();
    await writeSettings(home, {
      taskAutoArchiveEnabled: true,
      taskAutoArchiveOlderThanDays: 14,
      locale: "en-US",
    });

    const first = createSettingService();
    const migrated = await first.get();
    expect(migrated.taskAutoArchiveEnabled).toBe(false);
    expect(migrated.taskAutoArchiveResetVersion).toBe(1);
    expect(migrated.taskAutoArchiveOlderThanDays).toBe(14);
    expect(migrated.locale).toBe("en-US");

    // 迁移必须落盘：读路径已经在写队列里重读并写回。
    await expect.poll(async () => (await readSettings(home)).taskAutoArchiveResetVersion).toBe(1);
    expect((await readSettings(home)).taskAutoArchiveEnabled).toBe(false);

    // 用户重新开启后，新进程（新 service 实例）不得再重置。
    await first.update({ taskAutoArchiveEnabled: true });
    const restarted = createSettingService();
    const reloaded = await restarted.get();
    expect(reloaded.taskAutoArchiveEnabled).toBe(true);
    expect((await readSettings(home)).taskAutoArchiveEnabled).toBe(true);
  });

  it("已带标记的文件不会被二次迁移", async () => {
    const home = await createTempHome();
    await writeSettings(home, {
      taskAutoArchiveEnabled: true,
      taskAutoArchiveResetVersion: 1,
    });
    const service = createSettingService();
    expect((await service.get()).taskAutoArchiveEnabled).toBe(true);
    expect((await readSettings(home)).taskAutoArchiveEnabled).toBe(true);
  });

  it("迁移写盘与用户并发 set 共用同一串行链，保留全部字段", async () => {
    const home = await createTempHome();
    await writeSettings(home, {
      taskAutoArchiveEnabled: true,
      taskAutoArchiveOlderThanDays: 7,
      toolSearchMode: "auto",
      locale: "en-US",
    });
    const service = createSettingService();

    // 迁移的读-改-写与用户的 set 同时发起：两者都必须走同一个 setting.json owner 队列，
    // 迁移写盘前重读最新文件，不能拿旧快照覆盖用户刚写的字段。
    await Promise.all([service.get(), service.update({ dynamicWorkflowMode: "onDemand" })]);

    const persisted = await readSettings(home);
    expect(persisted).toMatchObject({
      taskAutoArchiveEnabled: false,
      taskAutoArchiveResetVersion: 1,
      taskAutoArchiveOlderThanDays: 7,
      toolSearchMode: "auto",
      locale: "en-US",
      dynamicWorkflowMode: "onDemand",
    });
    expect((await createSettingService().get()).dynamicWorkflowMode).toBe("onDemand");
  });

  it("损坏 JSON 走既有隔离路径，不把重置标记写进坏文件", async () => {
    const home = await createTempHome();
    await writeFile(settingsFile(home), '{"taskAutoArchiveEnabled": tru', "utf-8");
    const service = createSettingService();
    const settings = await service.get();
    expect(settings.taskAutoArchiveEnabled).toBe(false);
    expect(settings.taskAutoArchiveResetVersion).toBe(1);
  });
});

describe("dynamicWorkflowMode 往返（真实设置文件）", () => {
  it("写入后读回；空串哨兵删除选择；跟进提供值不被写死", async () => {
    const home = await createTempHome();
    const service = createSettingService();

    await service.update({ dynamicWorkflowMode: "alwaysOn" });
    expect((await createSettingService().get()).dynamicWorkflowMode).toBe("alwaysOn");

    await service.update({ dynamicWorkflowMode: "onDemand" });
    expect((await createSettingService().get()).dynamicWorkflowMode).toBe("onDemand");

    await service.update({ dynamicWorkflowMode: "disabled" });
    expect((await createSettingService().get()).dynamicWorkflowMode).toBe("disabled");

    // 空串 = 跟随服务端默认：字段必须真的从文件里消失。
    await service.update({ dynamicWorkflowMode: "" });
    expect((await createSettingService().get()).dynamicWorkflowMode).toBeUndefined();
    expect(await readSettings(home)).not.toHaveProperty("dynamicWorkflowMode");
  });

  it("未知值不会被写坏文件（patch 严格拒绝）", async () => {
    const home = await createTempHome();
    const service = createSettingService();
    await service.update({ dynamicWorkflowMode: "alwaysOn" });
    await expect(
      // @ts-expect-error 故意传非法值，模拟旧/未来客户端
      service.update({ dynamicWorkflowMode: "someday" }),
    ).rejects.toThrow();
    expect((await service.get()).dynamicWorkflowMode).toBe("alwaysOn");
    expect((await readSettings(home)).dynamicWorkflowMode).toBe("alwaysOn");
  });
});
