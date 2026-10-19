import { createRoot } from "react-dom/client";
import { CodingPlanQuotaPanel } from "../../../packages/ui/src/settings/usage-stats/CodingPlanQuotaPanel.js";
import { ServiceProvider } from "../../../packages/ui/src/hooks/useServices.js";
import { ZCodeIntlProvider } from "../../../packages/ui/src/i18n/IntlProvider.js";
import { TooltipProvider } from "../../../packages/ui/src/components/ui/tooltip.js";
import { connectProviderSettingsSnapshot } from "../../../packages/ui/src/lib/providerSettingsSnapshot.js";

const params = new URLSearchParams(location.search);
const locale = params.get("locale") || "en-US";
const scenario = params.get("scenario") || "ready";
document.documentElement.className = params.get("theme") === "dark" ? "dark zai-dark" : "zai-light";

const BIGMODEL_BASE = "https://open.bigmodel.cn/api/anthropic";

function provider({ providerId, name, apiKey, baseUrl = BIGMODEL_BASE }) {
  return {
    providerId,
    providerName: name,
    templateId: "bigmodel-api",
    enabled: true,
    executable: Boolean(apiKey),
    effectiveConfig: {
      group: "standard-personal",
      access: { type: "zhipu-coding-plan-api-key", ...(apiKey ? { apiKey } : {}) },
      api: { type: "anthropic-messages", baseUrl },
    },
    models: [],
    issues: [],
  };
}

const withKey = scenario !== "no-key";
const providers =
  scenario === "no-provider"
    ? []
    : [
        provider({
          providerId: "bigmodel-plan",
          name: "BigModel Coding Plan",
          apiKey: withKey ? "fixture-key" : "",
        }),
      ];

const view = {
  revision: 1,
  providerTemplates: [],
  providerOrder: providers.map((item) => item.providerId),
  providers,
  models: [],
};

const fixture = (window.codingPlanQuotaFixture = { requests: [], fail: scenario === "failure" });

const usageStatsService = {
  async getAppUsageSnapshot() {
    throw new Error("unused in this fixture");
  },
  async getCodingPlanQuota(request) {
    fixture.requests.push(request);
    if (fixture.fail) {
      throw new Error("request-failed: HTTP 401");
    }
    return {
      fetchedAt: Date.parse("2026-10-19T08:00:00Z"),
      family: "bigmodel",
      level: "pro",
      limits: [
        { type: "TIME_LIMIT", remaining: 182, number: 300, percentage: 0.39, usageDetails: [] },
        { type: "TOKENS_LIMIT", remaining: 4200000, number: 6000000, usageDetails: [] },
      ],
      remaining: {
        type: "TIME_LIMIT",
        remaining: 182,
        number: 300,
        percentage: 0.39,
        usageDetails: [],
      },
    };
  },
};

// 复用真实装配：Provider Settings 快照来自 service.getView()。
connectProviderSettingsSnapshot({
  getView: async () => view,
  onDidChange: () => ({ dispose() {} }),
});

createRoot(document.getElementById("root")).render(
  <ServiceProvider services={{ usageStatsService }}>
    <ZCodeIntlProvider initialLocale={locale}>
      <TooltipProvider>
        <main className="min-h-screen bg-background text-foreground p-4">
          <CodingPlanQuotaPanel />
        </main>
      </TooltipProvider>
    </ZCodeIntlProvider>
  </ServiceProvider>,
);
