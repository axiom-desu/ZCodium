import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
const { createCodingPlanSubscriptionService } = await tsImport(
  "../../packages/services/src/coding-plan-subscription/codingPlanSubscriptionService.ts",
  import.meta.url,
);
const { createUsageStatsService } = await tsImport(
  "../../packages/services/src/usage-stats/usageStatsService.ts",
  import.meta.url,
);
const { ProxyChannel } = await tsImport("../../packages/rpc/src/proxy-channel.ts", import.meta.url);

test("retired payment RPC cannot read credentials or contact a payment endpoint", async () => {
  const forbidden = () => {
    throw new Error("Payment IO must not occur");
  };
  const service = createCodingPlanSubscriptionService({
    apiClient: new Proxy({}, { get: () => forbidden }),
    credentialService: { load: forbidden },
  });
  const channel = ProxyChannel.fromService(service);
  for (const command of [
    "preview",
    "batchPreview",
    "getStaticProducts",
    "getStartPlanPreview",
    "productInfo",
    "createSign",
    "updateSign",
    "checkPayment",
    "checkPendingOrders",
    "queryStripeCards",
    "bindStripeCard",
    "unbindStripeCard",
    "payStripe",
    "checkPaypalSupport",
    "createPaypalSetupToken",
    "subscribePaypal",
    "getEnterpriseBalance",
    "calculateEnterpriseOrder",
    "createEnterpriseOrder",
    "getEnterprisePendingOrders",
    "cancelEnterpriseOrder",
    "continueEnterpriseOrderPayment",
    "checkEnterpriseOrderStatus",
    "getEnterprisePricing",
    "getStaticTeamProducts",
    "getForceUpdateConfig",
    "getModelContextBudgetStrategy",
  ]) {
    await assert.rejects(
      async () => channel.call(undefined, command, [{ providerId: "fixture", bizId: "fixture" }]),
      /Method not found/,
    );
  }
});

test("local App Usage still reads Agent statistics without any account or payment IO", async () => {
  const forbidden = () => {
    throw new Error("Official IO must not occur");
  };
  const requests = [];
  const result = { fixture: "local usage" };
  const service = createUsageStatsService({
    apiClient: new Proxy({}, { get: () => forbidden }),
    credentialService: { load: forbidden },
    accountRequestAuthService: new Proxy({}, { get: () => forbidden }),
    zcodeAgentService: {
      getAppUsageStats: async (request) => {
        requests.push(request);
        return result;
      },
    },
  });
  assert.equal(await service.getAppUsageSnapshot({ range: "week", timeZone: "UTC" }), result);
  assert.deepEqual(requests, [{ range: "week", timeZone: "UTC" }]);
});

test("remaining workflow configuration has no account dependency and preserves snapshot semantics", async (t) => {
  const key = "ZCODE_DYNAMIC_WORKFLOW_MODE";
  const previous = process.env[key];
  delete process.env[key];
  t.after(() => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  });
  let requests = 0;
  let mode = "onDemand";
  let fail = false;
  const apiClient = {
    async request(input, init) {
      requests++;
      assert.equal(new URL(input).pathname, "/api/v1/client/configs");
      assert.equal(init.method, "GET");
      assert.equal(init.headers, undefined);
      assert.equal(init.body, undefined);
      if (fail) throw new Error("Fixture request failed");
      return Response.json({ data: { configs: { dynamicWorkflow: { mode } } } });
    },
  };
  const service = createCodingPlanSubscriptionService({
    apiClient,
    get credentialService() {
      throw new Error("Workflow must not acquire account credentials");
    },
  });
  const [a, b] = await Promise.all([
    service.getDynamicWorkflowClientConfig(),
    service.getDynamicWorkflowClientConfig(),
  ]);
  // 既定 3.16 快照三档字段（upstream-3.16-settings-and-navigation.md）：
  // offeredMode（服务端/本地覆盖提供的默认）、mode/enabled（生效值）、engine（执行端能力）；
  // 无用户选择时不落 userMode。保持全量深度相等，防购买/无凭据语义不变。
  assert.deepEqual(a, {
    mode: "onDemand",
    enabled: true,
    source: "remote",
    offeredMode: "onDemand",
    engine: "supported",
  });
  assert.deepEqual(b, a);
  assert.equal(requests, 1);
  mode = "disabled";
  assert.deepEqual(await service.getDynamicWorkflowClientConfig(), a);
  assert.equal(requests, 1);
  assert.deepEqual(await service.getDynamicWorkflowClientConfig({ forceRefresh: true }), {
    mode: "disabled",
    enabled: false,
    source: "remote",
    offeredMode: "disabled",
    engine: "supported",
  });
  process.env[key] = "alwaysOn";
  assert.deepEqual(await service.getDynamicWorkflowClientConfig(), {
    mode: "alwaysOn",
    enabled: true,
    source: "override",
    offeredMode: "alwaysOn",
    engine: "supported",
  });
  assert.equal(requests, 2);
  delete process.env[key];
  fail = true;
  assert.deepEqual(await service.getDynamicWorkflowClientConfig({ forceRefresh: true }), {
    mode: "disabled",
    enabled: false,
    source: "default",
    offeredMode: "disabled",
    engine: "supported",
  });
  fail = false;
  mode = "alwaysOn";
  assert.equal((await service.getDynamicWorkflowClientConfig()).enabled, true);
  assert.equal(requests, 4);
});
