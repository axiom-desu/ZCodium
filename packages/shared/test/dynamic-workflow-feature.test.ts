import { describe, expect, it } from "vitest";
import {
  DEFAULT_DYNAMIC_WORKFLOW_MODE,
  applyDynamicWorkflowUserMode,
  createDynamicWorkflowClientConfig,
  isDynamicWorkflowModeEnabled,
  normalizeDynamicWorkflowMode,
  readDynamicWorkflowOfferedMode,
  resolveDynamicWorkflowClientConfig,
  ZCODE_DYNAMIC_WORKFLOW_MODE_ENV,
} from "../src/dynamic-workflow-feature.js";

const REMOTE_ON = { mode: "alwaysOn" };

describe("resolveDynamicWorkflowClientConfig（提供）", () => {
  it("远端缺 key / 非对象 / 非法值都回落到 disabled/default", () => {
    for (const remote of [undefined, null, {}, { mode: "sometimes" }, [], "alwaysOn"]) {
      const config = resolveDynamicWorkflowClientConfig({ remote });
      expect(config.mode).toBe(DEFAULT_DYNAMIC_WORKFLOW_MODE);
      expect(config.enabled).toBe(false);
      expect(config.source).toBe("default");
      expect(config.offeredMode).toBe("disabled");
    }
  });

  it("远端合法值成为「提供」，并原样记入 offeredMode", () => {
    const config = resolveDynamicWorkflowClientConfig({ remote: REMOTE_ON });
    expect(config.source).toBe("remote");
    expect(config.mode).toBe("alwaysOn");
    expect(config.offeredMode).toBe("alwaysOn");
    expect(config.enabled).toBe(true);
  });

  it("本地覆盖优先于远端", () => {
    const config = resolveDynamicWorkflowClientConfig({
      remote: { mode: "disabled" },
      env: { [ZCODE_DYNAMIC_WORKFLOW_MODE_ENV]: " alwaysOn " },
    });
    expect(config.source).toBe("override");
    expect(config.offeredMode).toBe("alwaysOn");
  });
});

describe("用户选择永远生效", () => {
  it("合法的用户选择覆盖 disabled 提供（功能已全量，服务端只决定默认）", () => {
    const config = resolveDynamicWorkflowClientConfig({
      remote: { mode: "disabled" },
      userMode: "alwaysOn",
    });
    expect(config.offeredMode).toBe("disabled");
    expect(config.mode).toBe("alwaysOn");
    expect(config.userMode).toBe("alwaysOn");
    expect(config.enabled).toBe(true);
  });

  it("用户关闭覆盖 alwaysOn 提供", () => {
    const config = resolveDynamicWorkflowClientConfig({
      remote: REMOTE_ON,
      userMode: "disabled",
    });
    expect(config.offeredMode).toBe("alwaysOn");
    expect(config.mode).toBe("disabled");
    expect(config.enabled).toBe(false);
  });

  it("缺席 / 非法用户选择 = 跟随提供", () => {
    for (const userMode of [undefined, null, "", "   ", "someday", 42]) {
      const config = resolveDynamicWorkflowClientConfig({
        remote: REMOTE_ON,
        userMode,
      });
      expect(config.mode).toBe("alwaysOn");
      expect(config.userMode).toBeUndefined();
    }
  });

  it("onDemand 是独立的用户选择，不被折叠成 alwaysOn", () => {
    const config = resolveDynamicWorkflowClientConfig({
      remote: { mode: "alwaysOn" },
      userMode: "onDemand",
    });
    expect(config.mode).toBe("onDemand");
    expect(config.userMode).toBe("onDemand");
    expect(config.enabled).toBe(true);
    // 选回提供值时仍是显式选择（由设置侧用空串哨兵删除），shared 不擅自抹掉。
    expect(applyDynamicWorkflowUserMode(config, "alwaysOn").mode).toBe("alwaysOn");
  });

  it("对已应用过选择的快照重放是覆盖而不是叠加（幂等）", () => {
    const applied = resolveDynamicWorkflowClientConfig({
      remote: REMOTE_ON,
      userMode: "disabled",
    });
    const replayed = applyDynamicWorkflowUserMode(applied, "onDemand");
    expect(replayed.offeredMode).toBe("alwaysOn");
    expect(replayed.mode).toBe("onDemand");
    // 第二次以同一选择重放结果不变。
    expect(applyDynamicWorkflowUserMode(replayed, "onDemand")).toEqual(replayed);
    // 再以「跟随」重放必须回到提供值，而不是停在上一轮选择。
    expect(applyDynamicWorkflowUserMode(replayed, undefined).mode).toBe("alwaysOn");
  });
});

describe("执行端引擎能力（unsupported 与「灰度关」必须区分）", () => {
  it("没有引擎时即使提供与用户选择都是开启，生效值仍为 disabled", () => {
    const config = resolveDynamicWorkflowClientConfig({
      remote: REMOTE_ON,
      userMode: "alwaysOn",
      engine: "unsupported",
    });
    expect(config.engine).toBe("unsupported");
    expect(config.offeredMode).toBe("alwaysOn");
    // 用户选择照实记录（不是用户的错，也不是「灰度关」），但生效值不冒充。
    expect(config.userMode).toBe("alwaysOn");
    expect(config.mode).toBe("disabled");
    expect(config.enabled).toBe(false);
  });

  it("引擎不支持时 onDemand 用户选择也照实保留，生效值仍 disabled", () => {
    const config = resolveDynamicWorkflowClientConfig({
      remote: REMOTE_ON,
      userMode: "onDemand",
      engine: "unsupported",
    });
    expect(config.userMode).toBe("onDemand");
    expect(config.mode).toBe("disabled");
    expect(config.enabled).toBe(false);
  });

  it("灰度关（提供 disabled）与引擎不支持是两条不同的事实", () => {
    const grayOff = resolveDynamicWorkflowClientConfig({ remote: { mode: "disabled" } });
    const noEngine = resolveDynamicWorkflowClientConfig({
      remote: { mode: "disabled" },
      engine: "unsupported",
    });
    expect(grayOff.mode).toBe("disabled");
    expect(grayOff.engine).toBe("supported");
    expect(grayOff.offeredMode).toBe("disabled");
    expect(noEngine.engine).toBe("unsupported");
  });
});

describe("旧 Host 快照", () => {
  it("没有 offeredMode 的旧快照读不到默认项（设置行据此不出现）", () => {
    const legacy = {
      mode: "alwaysOn",
      enabled: true,
      source: "remote",
    } as unknown as Parameters<typeof readDynamicWorkflowOfferedMode>[0];
    expect(readDynamicWorkflowOfferedMode(legacy)).toBeUndefined();
  });

  it("新快照总能读到 offeredMode（含 disabled）", () => {
    expect(
      readDynamicWorkflowOfferedMode(createDynamicWorkflowClientConfig("disabled", "remote")),
    ).toBe("disabled");
  });
});

describe("取值域", () => {
  it("normalize / enabled 折叠", () => {
    expect(normalizeDynamicWorkflowMode("onDemand")).toBe("onDemand");
    expect(normalizeDynamicWorkflowMode(" ONdemand ")).toBeUndefined();
    expect(isDynamicWorkflowModeEnabled("disabled")).toBe(false);
    expect(isDynamicWorkflowModeEnabled("onDemand")).toBe(true);
    expect(isDynamicWorkflowModeEnabled("alwaysOn")).toBe(true);
  });
});
