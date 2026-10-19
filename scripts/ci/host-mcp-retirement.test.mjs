import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const { createUsageStatsService } = await tsImport(
  "../../packages/services/src/usage-stats/usageStatsService.ts",
  import.meta.url,
);

const { appUsageSnapshotSchema } = await tsImport(
  "../../packages/shared/src/usage-stats.ts",
  import.meta.url,
);
const localSnapshot = appUsageSnapshotSchema.parse({
  range: "7d",
  generatedAt: 1,
  timeZone: "UTC",
  source: "agent-db",
  summary: {
    totalTokens: 150,
    inputTokens: 100,
    outputTokens: 50,
    reasoningTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    cacheHitRate: 0,
    totalSessions: 1,
    totalTurns: 1,
    toolCallCount: 0,
    toolErrorRate: 0,
    modelErrorRate: 0,
    avgTimeToFirstTokenMs: 200,
    avgTurnDurationMs: 900,
    activeDays: 1,
    currentStreakDays: 1,
    longestSessionMs: 900,
    longestStreakDays: 1,
    peakDayTokens: 150,
    favoriteModel: { modelId: "fixture-model", totalTokens: 150, share: 1 },
  },
  heatmap: { startDate: null, endDate: null, maxTokens: 0, weeks: [] },
  dailyModelUsage: [],
  models: [],
  tools: [],
});

function setup() {
  const usageCalls = [];
  const service = createUsageStatsService(
    new Proxy(
      {
        zcodeAgentService: {
          async getAppUsageStats(request) {
            usageCalls.push(request);
            return localSnapshot;
          },
        },
      },
      {
        get(target, key) {
          assert.equal(
            key,
            "zcodeAgentService",
            `Usage must not read official dependency: ${String(key)}`,
          );
          return target[key];
        },
      },
    ),
  );
  return { service, usageCalls, snapshot: localSnapshot };
}

const { ProxyChannel } = await tsImport("../../packages/rpc/src/proxy-channel.ts", import.meta.url);
test("retired quota, monitor and entitlement RPCs are absent without account dependencies", () => {
  const { service } = setup();
  // getCodingPlanQuota 是用户自带 API Key 的额度查询，不含任何账号/权益依赖。
  assert.deepEqual(Object.keys(service), ["getAppUsageSnapshot", "getCodingPlanQuota"]);
  const channel = ProxyChannel.fromService(service);
  for (const method of [
    "getSnapshot",
    "getEntitlementSnapshot",
    "getCodingPlanUsageSnapshot",
    "getCodingPlanResetStatus",
    "requestCodingPlanResetOpportunity",
    "useCodingPlanReset",
    "markCodingPlanResetHistoryRead",
  ]) {
    assert.throws(() => channel.call(undefined, method, [{}]), /Method not found/);
  }
});

test("local usage remains a direct Agent database query without account or network reads", async () => {
  const f = setup();
  const request = { range: "7d", timeZone: "UTC" };
  assert.equal(await f.service.getAppUsageSnapshot(request), f.snapshot);
  assert.deepEqual(f.usageCalls, [request]);
});

test("local usage failures are preserved so the caller can retry without false empty success", async () => {
  let attempts = 0;
  const error = new Error("Fixture Agent database unavailable");
  const service = createUsageStatsService({
    zcodeAgentService: {
      getAppUsageStats: async () => {
        if (++attempts === 1) throw error;
        return localSnapshot;
      },
    },
  });
  await assert.rejects(
    service.getAppUsageSnapshot({ range: "7d", timeZone: "UTC" }),
    (actual) => actual === error,
  );
  assert.deepEqual(
    await service.getAppUsageSnapshot({ range: "7d", timeZone: "UTC" }),
    localSnapshot,
  );
});
