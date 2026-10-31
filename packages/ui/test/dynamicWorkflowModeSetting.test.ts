import { describe, expect, it } from "vitest";
import {
  applyDynamicWorkflowUserMode,
  createDynamicWorkflowClientConfig,
  type DynamicWorkflowClientConfig,
} from "@zcode/shared";
import {
  buildDynamicWorkflowModePatch,
  resolveDynamicWorkflowModeSettingView,
} from "@/settings/DynamicWorkflowModeSetting.js";
import type { DynamicWorkflowAvailabilitySnapshot } from "@/store/dynamicWorkflowAvailabilityStore.js";

function snapshot(config: DynamicWorkflowClientConfig): DynamicWorkflowAvailabilitySnapshot {
  return { status: "ready", enabled: config.enabled, config };
}

describe("设置行可见性（resolveDynamicWorkflowModeSettingView）", () => {
  it("加载中 / 读取失败不显示", () => {
    expect(
      resolveDynamicWorkflowModeSettingView({ status: "loading", enabled: false, config: null }),
    ).toBeNull();
    expect(
      resolveDynamicWorkflowModeSettingView({ status: "ready", enabled: false, config: null }),
    ).toBeNull();
  });

  it("旧 Host 快照（没有 offeredMode）不显示：否则选择写进一个不生效的设置", () => {
    const legacy = {
      mode: "alwaysOn",
      enabled: true,
      source: "remote",
    } as unknown as DynamicWorkflowClientConfig;
    expect(resolveDynamicWorkflowModeSettingView(snapshot(legacy))).toBeNull();
  });

  it("执行端没有引擎时不显示（这不是灰度关，选了也做不到）", () => {
    const config = createDynamicWorkflowClientConfig("alwaysOn", "remote", "unsupported");
    expect(resolveDynamicWorkflowModeSettingView(snapshot(config))).toBeNull();
  });

  it("灰度关仍然显示，默认项标在关闭上", () => {
    const config = applyDynamicWorkflowUserMode(
      createDynamicWorkflowClientConfig("disabled", "remote"),
      undefined,
    );
    expect(resolveDynamicWorkflowModeSettingView(snapshot(config))).toEqual({
      value: "disabled",
      offeredMode: "disabled",
    });
  });

  it("onDemand 默认项原样保留，不折叠成 alwaysOn", () => {
    const config = createDynamicWorkflowClientConfig("onDemand", "remote");
    expect(resolveDynamicWorkflowModeSettingView(snapshot(config))).toEqual({
      value: "onDemand",
      offeredMode: "onDemand",
    });
  });

  it("用户显式选择优先于提供；三档都能回显", () => {
    const offeredOn = createDynamicWorkflowClientConfig("alwaysOn", "remote");
    expect(resolveDynamicWorkflowModeSettingView(snapshot(offeredOn))?.value).toBe("alwaysOn");
    for (const mode of ["disabled", "onDemand", "alwaysOn"] as const) {
      expect(
        resolveDynamicWorkflowModeSettingView(
          snapshot(applyDynamicWorkflowUserMode(offeredOn, mode)),
        )?.value,
      ).toBe(mode);
    }
  });
});

describe("选择 → 落盘补丁（buildDynamicWorkflowModePatch）", () => {
  it("选回提供值等于删除选择（空串哨兵）", () => {
    expect(buildDynamicWorkflowModePatch("onDemand", "onDemand")).toEqual({
      dynamicWorkflowMode: "",
    });
    expect(buildDynamicWorkflowModePatch("disabled", "disabled")).toEqual({
      dynamicWorkflowMode: "",
    });
  });

  it("显式选择另一档原样保存，即使与当前默认同属开启也不折成跟随", () => {
    expect(buildDynamicWorkflowModePatch("alwaysOn", "onDemand")).toEqual({
      dynamicWorkflowMode: "alwaysOn",
    });
    expect(buildDynamicWorkflowModePatch("onDemand", "alwaysOn")).toEqual({
      dynamicWorkflowMode: "onDemand",
    });
    expect(buildDynamicWorkflowModePatch("disabled", "alwaysOn")).toEqual({
      dynamicWorkflowMode: "disabled",
    });
  });
});
