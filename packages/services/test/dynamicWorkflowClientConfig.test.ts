import { afterEach, describe, expect, it, vi } from "vitest";
import { ZCODE_DYNAMIC_WORKFLOW_MODE_ENV } from "@zcode/shared";
import { createCodingPlanSubscriptionService } from "#src/coding-plan-subscription/codingPlanSubscriptionService.js";

function fakeApiClient(body: unknown) {
  return {
    request: vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ),
  };
}

function createService(options: {
  body?: unknown;
  userMode?: unknown;
  engine?: "supported" | "unsupported";
  fail?: boolean;
}) {
  const apiClient = options.fail
    ? {
        request: vi.fn(async () => {
          throw new Error("offline");
        }),
      }
    : fakeApiClient(options.body);
  const service = createCodingPlanSubscriptionService({
    apiClient,
    ...(options.userMode !== undefined
      ? { resolveDynamicWorkflowUserMode: async () => options.userMode }
      : {}),
    ...(options.engine ? { resolveDynamicWorkflowEngineSupport: () => options.engine } : {}),
  });
  return { service, apiClient };
}

afterEach(() => {
  delete process.env[ZCODE_DYNAMIC_WORKFLOW_MODE_ENV];
});

describe("codingPlanSubscriptionService.getDynamicWorkflowClientConfig", () => {
  it("远端提供的模式与用户选择一起折叠，并带上执行端能力", async () => {
    const { service } = createService({
      body: { data: { configs: { dynamicWorkflow: { mode: "disabled" } } } },
      userMode: "alwaysOn",
    });
    const config = await service.getDynamicWorkflowClientConfig();
    expect(config.offeredMode).toBe("disabled");
    expect(config.mode).toBe("alwaysOn");
    expect(config.userMode).toBe("alwaysOn");
    expect(config.engine).toBe("supported");
  });

  it("旧 Host 语义没有用户选择时就是提供值", async () => {
    const { service } = createService({
      body: { data: { configs: { dynamicWorkflow: { mode: "alwaysOn" } } } },
    });
    const config = await service.getDynamicWorkflowClientConfig();
    expect(config.mode).toBe("alwaysOn");
    expect(config.userMode).toBeUndefined();
  });

  it("Rust runtime（无引擎）不把用户开启当成已生效", async () => {
    const { service } = createService({
      body: { data: { configs: { dynamicWorkflow: { mode: "alwaysOn" } } } },
      userMode: "alwaysOn",
      engine: "unsupported",
    });
    const config = await service.getDynamicWorkflowClientConfig();
    expect(config.engine).toBe("unsupported");
    expect(config.offeredMode).toBe("alwaysOn");
    expect(config.mode).toBe("disabled");
    expect(config.enabled).toBe(false);
  });

  it("远端失败仍套用户选择（离线启动不关掉用户明确打开的功能）", async () => {
    const { service } = createService({ fail: true, userMode: "alwaysOn" });
    const config = await service.getDynamicWorkflowClientConfig();
    expect(config.source).toBe("default");
    expect(config.offeredMode).toBe("disabled");
    expect(config.mode).toBe("alwaysOn");
  });

  it("用户选择读取抛错按跟随提供处理，不阻断快照", async () => {
    const service = createCodingPlanSubscriptionService({
      apiClient: fakeApiClient({
        data: { configs: { dynamicWorkflow: { mode: "alwaysOn" } } },
      }),
      resolveDynamicWorkflowUserMode: async () => {
        throw new Error("settings unavailable");
      },
    });
    const config = await service.getDynamicWorkflowClientConfig();
    expect(config.mode).toBe("alwaysOn");
    expect(config.userMode).toBeUndefined();
  });

  it("本地覆盖读取不打远端请求，但用户选择仍然生效", async () => {
    process.env[ZCODE_DYNAMIC_WORKFLOW_MODE_ENV] = "disabled";
    const { service, apiClient } = createService({ userMode: "alwaysOn" });
    const config = await service.getDynamicWorkflowClientConfig();
    expect(apiClient.request).not.toHaveBeenCalled();
    expect(config.source).toBe("override");
    expect(config.mode).toBe("alwaysOn");
  });
});
