import { describe, expect, it } from "vitest";
import { appSettingsPatchSchema, appSettingsSchema } from "../src/validationAppSettings.js";

describe("自动归档一次性重置迁移", () => {
  it("旧文件（开启且无版本标记）首读统一关闭并写入标记", () => {
    const parsed = appSettingsSchema.parse({
      taskAutoArchiveEnabled: true,
      taskAutoArchiveOlderThanDays: 7,
    });
    expect(parsed.taskAutoArchiveEnabled).toBe(false);
    expect(parsed.taskAutoArchiveResetVersion).toBe(1);
    // 阈值是用户的偏好，迁移不能顺手动它。
    expect(parsed.taskAutoArchiveOlderThanDays).toBe(7);
  });

  it("已迁移过的文件保留用户重新开启的选择", () => {
    const parsed = appSettingsSchema.parse({
      taskAutoArchiveEnabled: true,
      taskAutoArchiveResetVersion: 1,
    });
    expect(parsed.taskAutoArchiveEnabled).toBe(true);
    expect(parsed.taskAutoArchiveResetVersion).toBe(1);
  });

  it("缺字段的新装用户得到默认关闭与标记，不会二次迁移", () => {
    const parsed = appSettingsSchema.parse({});
    expect(parsed.taskAutoArchiveEnabled).toBe(false);
    expect(parsed.taskAutoArchiveResetVersion).toBe(1);
  });

  it("坏值（非对象）由读取层处理：迁移不会把崩溃变成默认值", () => {
    // 与本次改动前一致：非对象在 schema 边界直接报错，隔离/备份由 settingService 的读路径完成。
    // 迁移函数内部的非对象守卫只是防御，不把错误输入伪装成“已迁移”。
    for (const broken of [null, [], "taskAutoArchiveEnabled", 42]) {
      expect(() => appSettingsSchema.parse(broken)).toThrow();
    }
  });

  it("patch 允许显式写版本标记（迁移落盘路径）", () => {
    expect(
      appSettingsPatchSchema.parse({
        taskAutoArchiveEnabled: false,
        taskAutoArchiveResetVersion: 1,
      }),
    ).toMatchObject({ taskAutoArchiveResetVersion: 1 });
    expect(() => appSettingsPatchSchema.parse({ taskAutoArchiveResetVersion: 2 })).toThrow();
  });
});

describe("dynamicWorkflowMode 设置", () => {
  it("缺席 = 跟随（不写入字段）", () => {
    expect(appSettingsSchema.parse({}).dynamicWorkflowMode).toBeUndefined();
  });

  it("合法值原样读回", () => {
    for (const mode of ["disabled", "onDemand", "alwaysOn"] as const) {
      expect(appSettingsSchema.parse({ dynamicWorkflowMode: mode }).dynamicWorkflowMode).toBe(mode);
    }
  });

  it("未知值（降级后读到新版本写的值）按跟随处理，不把整份设置读坏", () => {
    const parsed = appSettingsSchema.parse({ dynamicWorkflowMode: "sometimes", locale: "en-US" });
    expect(parsed.dynamicWorkflowMode).toBeUndefined();
    expect(parsed.locale).toBe("en-US");
  });

  it("patch 允许空串哨兵（表示删除选择）", () => {
    expect(appSettingsPatchSchema.parse({ dynamicWorkflowMode: "" }).dynamicWorkflowMode).toBe("");
    expect(() => appSettingsPatchSchema.parse({ dynamicWorkflowMode: "sometimes" })).toThrow();
  });
});
