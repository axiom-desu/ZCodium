import { afterEach, describe, expect, it } from "vitest";
import {
  applyDynamicWorkflowUserMode,
  createDynamicWorkflowClientConfig,
  type DynamicWorkflowClientConfig,
} from "@zcode/shared";
import type { ICodingPlanSubscriptionService } from "@zcode/services";
import {
  resetDynamicWorkflowAvailabilityStoreForTests,
  useDynamicWorkflowAvailabilityStore,
} from "@/store/dynamicWorkflowAvailabilityStore.js";

function fakeService(
  responses: Array<() => Promise<DynamicWorkflowClientConfig>>,
): ICodingPlanSubscriptionService & { calls: number } {
  let calls = 0;
  const service = {
    get calls() {
      return calls;
    },
    async getDynamicWorkflowClientConfig(): Promise<DynamicWorkflowClientConfig> {
      const next = responses[Math.min(calls, responses.length - 1)]!;
      calls += 1;
      return next();
    },
  };
  return service as ICodingPlanSubscriptionService & { calls: number };
}

afterEach(() => {
  resetDynamicWorkflowAvailabilityStoreForTests();
});

describe("dynamicWorkflowAvailabilityStore", () => {
  it("同一个 service 只取一次（闩住），reload 会重读但不 forceRefresh", async () => {
    const initial = createDynamicWorkflowClientConfig("disabled", "remote");
    const afterUserMode = applyDynamicWorkflowUserMode(initial, "alwaysOn");
    const service = fakeService([async () => initial, async () => afterUserMode]);

    await useDynamicWorkflowAvailabilityStore.getState().ensureLoaded(service);
    expect(useDynamicWorkflowAvailabilityStore.getState().enabled).toBe(false);

    await useDynamicWorkflowAvailabilityStore.getState().ensureLoaded(service);
    expect(service.calls).toBe(1);

    await useDynamicWorkflowAvailabilityStore.getState().reload(service);
    expect(service.calls).toBe(2);
    const state = useDynamicWorkflowAvailabilityStore.getState();
    expect(state.enabled).toBe(true);
    expect(state.config?.userMode).toBe("alwaysOn");
    expect(state.config?.offeredMode).toBe("disabled");
  });

  it("读取失败 fail-closed 到 disabled 且不缓存失败", async () => {
    let shouldFail = true;
    const service = fakeService([
      async () => {
        if (shouldFail) throw new Error("offline");
        return createDynamicWorkflowClientConfig("alwaysOn", "remote");
      },
    ]);

    await useDynamicWorkflowAvailabilityStore.getState().ensureLoaded(service);
    expect(useDynamicWorkflowAvailabilityStore.getState()).toMatchObject({
      status: "ready",
      enabled: false,
      config: null,
    });

    // 失败不记住：换一份 service 实例后重试能纠正回来。
    shouldFail = false;
    const healthy = fakeService([
      async () => createDynamicWorkflowClientConfig("alwaysOn", "remote"),
    ]);
    await useDynamicWorkflowAvailabilityStore.getState().ensureLoaded(healthy);
    expect(useDynamicWorkflowAvailabilityStore.getState().enabled).toBe(true);
  });

  it("并发首次取数共用同一次请求", async () => {
    const service = fakeService([
      async () => createDynamicWorkflowClientConfig("alwaysOn", "remote"),
    ]);
    await Promise.all([
      useDynamicWorkflowAvailabilityStore.getState().ensureLoaded(service),
      useDynamicWorkflowAvailabilityStore.getState().ensureLoaded(service),
      useDynamicWorkflowAvailabilityStore.getState().ensureLoaded(service),
    ]);
    expect(service.calls).toBe(1);
  });

  it("换代时在途的旧 service 先落定，新 service 的结论最终胜出", async () => {
    let resolveOld!: (config: DynamicWorkflowClientConfig) => void;
    const oldService = fakeService([
      () => new Promise<DynamicWorkflowClientConfig>((resolve) => (resolveOld = resolve)),
    ]);
    const newService = fakeService([
      async () => createDynamicWorkflowClientConfig("disabled", "remote"),
    ]);

    // 新 service 的取数排在在途请求之后（不并发打远端），旧结果晚到也不会盖住新结论。
    const oldLoad = useDynamicWorkflowAvailabilityStore.getState().ensureLoaded(oldService);
    const newLoad = useDynamicWorkflowAvailabilityStore.getState().ensureLoaded(newService);
    resolveOld(createDynamicWorkflowClientConfig("alwaysOn", "remote"));
    await Promise.all([oldLoad, newLoad]);

    expect(useDynamicWorkflowAvailabilityStore.getState().enabled).toBe(false);
  });

  it("reset 清掉快照与闩（测试隔离）", async () => {
    const service = fakeService([
      async () => createDynamicWorkflowClientConfig("alwaysOn", "remote"),
    ]);
    await useDynamicWorkflowAvailabilityStore.getState().ensureLoaded(service);
    resetDynamicWorkflowAvailabilityStoreForTests();
    expect(useDynamicWorkflowAvailabilityStore.getState()).toMatchObject({
      status: "loading",
      enabled: false,
      config: null,
    });
    await useDynamicWorkflowAvailabilityStore.getState().ensureLoaded(service);
    expect(service.calls).toBe(2);
  });
});
