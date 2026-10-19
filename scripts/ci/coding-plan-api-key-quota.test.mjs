import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const { fetchCodingPlanQuota, resolveCodingPlanQuotaUrl, normalizeQuotaLimits } = await tsImport(
  "../../packages/services/src/usage-stats/codingPlanQuota.ts",
  import.meta.url,
);
const { createUsageStatsService } = await tsImport(
  "../../packages/services/src/usage-stats/usageStatsService.ts",
  import.meta.url,
);

const BIGMODEL_BASE = "https://open.bigmodel.cn/api/anthropic";
const ZAI_BASE = "https://api.z.ai/api/anthropic";

function createApiClient(handler) {
  const calls = [];
  return {
    calls,
    async request(input, init) {
      const url = typeof input === "string" ? input : input.toString();
      calls.push({ url, init });
      const result = await handler(url, init);
      return {
        ok: result.status >= 200 && result.status < 300,
        status: result.status,
        headers: new Headers(),
        async json() {
          return result.body;
        },
        async text() {
          return JSON.stringify(result.body);
        },
      };
    },
  };
}

test("quota endpoint is chosen by provider family and never guesses", () => {
  assert.deepEqual(resolveCodingPlanQuotaUrl({ baseUrl: BIGMODEL_BASE }), {
    family: "bigmodel",
    url: "https://bigmodel.cn/api/monitor/usage/quota/limit",
  });
  assert.deepEqual(resolveCodingPlanQuotaUrl({ baseUrl: ZAI_BASE }), {
    family: "zai",
    url: "https://api.z.ai/api/monitor/usage/quota/limit",
  });
  // 未知域名必须拒绝，不能回退到任一官方域。
  assert.equal(resolveCodingPlanQuotaUrl({ baseUrl: "https://example.invalid/v1" }), null);
  assert.equal(resolveCodingPlanQuotaUrl({ baseUrl: "" }), null);
});

test("empty API key is rejected before any network IO", async () => {
  const apiClient = createApiClient(() => {
    throw new Error("must not be called");
  });
  const result = await fetchCodingPlanQuota({
    apiClient,
    request: { providerId: "p", baseUrl: BIGMODEL_BASE, apiKey: "   " },
  });
  assert.equal(result.success, false);
  assert.equal(result.error.code, "missing-api-key");
  assert.equal(apiClient.calls.length, 0);
});

test("unknown provider family is rejected before any network IO", async () => {
  const apiClient = createApiClient(() => {
    throw new Error("must not be called");
  });
  const result = await fetchCodingPlanQuota({
    apiClient,
    request: { providerId: "p", baseUrl: "https://example.invalid/v1", apiKey: "k" },
  });
  assert.equal(result.success, false);
  assert.equal(result.error.code, "unsupported-provider");
  assert.equal(apiClient.calls.length, 0);
});

test("api key is sent as a bare authorization header without Bearer", async () => {
  const apiClient = createApiClient(() => ({
    status: 200,
    body: { success: true, data: { level: "pro", limits: [{ type: "TIME_LIMIT", remaining: 3 }] } },
  }));
  const result = await fetchCodingPlanQuota({
    apiClient,
    request: { providerId: "p", baseUrl: BIGMODEL_BASE, apiKey: " fixture-key " },
  });
  assert.equal(result.success, true);
  assert.equal(apiClient.calls.length, 1);
  assert.equal(apiClient.calls[0].url, "https://bigmodel.cn/api/monitor/usage/quota/limit");
  assert.equal(apiClient.calls[0].init.headers.authorization, "fixture-key");
  assert.equal(apiClient.calls[0].init.headers.Authorization, undefined);
  assert.equal(result.snapshot.family, "bigmodel");
  assert.equal(result.snapshot.level, "pro");
  assert.equal(result.snapshot.remaining.type, "TIME_LIMIT");
});

test("business failure is surfaced as an error, never as an empty quota", async () => {
  const apiClient = createApiClient(() => ({
    status: 200,
    body: { success: false, code: 1001, msg: "invalid api key" },
  }));
  const result = await fetchCodingPlanQuota({
    apiClient,
    request: { providerId: "p", baseUrl: BIGMODEL_BASE, apiKey: "k" },
  });
  assert.equal(result.success, false);
  assert.equal(result.error.code, "invalid-response");
  assert.match(result.error.message, /invalid api key/);
});

test("HTTP failure is surfaced as request-failed without leaking the body", async () => {
  const apiClient = createApiClient(() => ({ status: 401, body: { msg: "secret detail" } }));
  const result = await fetchCodingPlanQuota({
    apiClient,
    request: { providerId: "p", baseUrl: BIGMODEL_BASE, apiKey: "k" },
  });
  assert.equal(result.success, false);
  assert.equal(result.error.code, "request-failed");
  assert.match(result.error.message, /HTTP 401/);
  assert.doesNotMatch(result.error.message, /secret detail/);
});

test("missing data yields an empty limit list instead of a fake zero", () => {
  assert.deepEqual(normalizeQuotaLimits(undefined), []);
  assert.deepEqual(normalizeQuotaLimits({ limits: [] }), []);
  assert.deepEqual(normalizeQuotaLimits({ limits: [{ type: "" }] }), []);
});

test("service rejects instead of returning an empty snapshot on failure", async () => {
  const apiClient = createApiClient(() => ({ status: 500, body: {} }));
  const service = createUsageStatsService({
    apiClient,
    zcodeAgentService: { getAppUsageStats: async () => ({}) },
  });
  await assert.rejects(
    service.getCodingPlanQuota({ providerId: "p", baseUrl: BIGMODEL_BASE, apiKey: "k" }),
    /request-failed/,
  );
});
