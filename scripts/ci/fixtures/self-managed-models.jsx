import bundled from "../../../config/provider/zcode-builtin.json";
import { createRoot } from "react-dom/client";
import { ModelProviderSection } from "../../../packages/ui/src/settings/ModelProviderSection.js";
import { ConfirmDialogHost } from "../../../packages/ui/src/ConfirmDialog.js";
import { ServiceProvider } from "../../../packages/ui/src/hooks/useServices.js";
import { PlatformProvider } from "../../../packages/ui/src/hooks/usePlatform.js";
import { ZCodeIntlProvider } from "../../../packages/ui/src/i18n/IntlProvider.js";
import { TooltipProvider } from "../../../packages/ui/src/components/ui/tooltip.js";
const modelDefaults = bundled.config.modelConfigRules.modelRules[0].config;
const params = new URLSearchParams(location.search);
const locale = params.get("locale") || "en-US";
document.documentElement.className = params.get("theme") === "dark" ? "dark zai-dark" : "zai-light";
const template = {
  templateId: "fixture-api",
  templateNameMap: { "en-US": "Fixture API", "zh-CN": "测试 API" },
  config: {
    group: "standard-personal",
    api: { type: "openai-chat-completions", baseUrl: "https://model.example.invalid/v1" },
    access: { type: "api-key" },
  },
};
const account = {
  providerId: "fixture-account",
  providerName: "Official account",
  enabled: true,
  executable: false,
  effectiveConfig: {
    group: "zai-family",
    access: { type: "zhipu-account", accountType: "zai", mode: "start-plan" },
  },
  issues: [],
  models: [],
};
let revision = 1;
const providers = [account];
if (params.get("mode") === "gemini-native") {
  const config = {
    group: "standard-personal",
    access: { type: "api-key", apiKey: "fixture-gemini-key" },
    api: {
      type: "google-generative-ai",
      baseUrl: "https://opencode.ai/inference/google/v1beta",
    },
  };
  providers.push({
    providerId: "personal:gemini",
    providerName: "Gemini Native",
    enabled: true,
    executable: true,
    personalConfig: config,
    effectiveConfig: structuredClone(config),
    models: [],
    issues: [],
  });
}
if (params.get("mode") === "legacy-api") {
  const config = {
    ...structuredClone(template.config),
    group: "zai-family",
    access: { type: "api-key", apiKey: "fixture-existing-key" },
  };
  providers.push({
    providerId: "legacy:manual",
    providerName: "Existing manual API",
    enabled: true,
    executable: true,
    personalConfig: config,
    effectiveConfig: config,
    models: [],
    issues: [],
  });
}
const snapshot = () =>
  structuredClone({
    revision,
    providerTemplates: [template],
    providerOrder: providers.map((p) => p.providerId),
    providers,
  });
window.modelFixture = {
  calls: [],
  saves: [],
  createCount: 0,
  deleteCount: 0,
  tests: [],
  draftSaves: [],
  failRefresh: false,
  holdCreate: false,
};
const fixture = window.modelFixture;
const view = () => {
  revision++;
  return snapshot();
};
let failRead = params.get("mode") === "read-failure";
let failCreate = params.get("mode") === "create-failure";
const service = {
  onDidChange() {
    return { dispose() {} };
  },
  async getView() {
    fixture.calls.push("getView");
    if (failRead) {
      failRead = false;
      throw new Error("Internal fixture read failure");
    }
    return snapshot();
  },
  async refresh() {
    fixture.calls.push("refresh");
    if (fixture.failRefresh) {
      fixture.failRefresh = false;
      throw new Error("Internal fixture refresh failure");
    }
    return view();
  },
  async createPersonalProvider(input) {
    fixture.createCount++;
    fixture.calls.push("createPersonalProvider");
    if (failCreate) {
      failCreate = false;
      throw new Error("Internal fixture create failure");
    }
    if (fixture.holdCreate)
      await new Promise((resolve) => {
        window.releaseModelCreate = resolve;
      });
    const config = structuredClone(template.config);
    const provider = {
      providerId: "personal:fixture-" + fixture.createCount,
      providerName: input.providerName || "Fixture API",
      templateId: input.templateId,
      enabled: true,
      executable: false,
      personalConfig: config,
      effectiveConfig: structuredClone(config),
      models: [],
      issues: [],
    };
    providers.push(provider);
    return { providerId: provider.providerId, view: view() };
  },
  async savePersonalProviderOverlay(id, config, options) {
    if (fixture.failSave) {
      fixture.failSave = false;
      throw new Error("Fixture save failed");
    }
    fixture.saves.push(structuredClone({ id, config, options }));
    const provider = providers.find((p) => p.providerId === id);
    provider.personalConfig = structuredClone(config);
    provider.effectiveConfig = structuredClone(config);
    if (options?.providerNameUpdate !== undefined)
      provider.providerName = options.providerNameUpdate;
    if (options?.enabledUpdate !== undefined) provider.enabled = options.enabledUpdate;
    return view();
  },
  async deletePersonalProvider(id) {
    fixture.deleteCount++;
    if (fixture.failDelete) {
      fixture.failDelete = false;
      throw new Error("Internal fixture delete failure");
    }
    providers.splice(
      providers.findIndex((p) => p.providerId === id),
      1,
    );
    return view();
  },
  async resolveModelConfig() {
    fixture.calls.push("resolveModelConfig");
    return { inheritedConfig: modelDefaults, effectiveConfig: modelDefaults, issues: [] };
  },
  async addPersonalModel(id, modelId, config) {
    fixture.calls.push("addPersonalModel");
    const provider = providers.find((p) => p.providerId === id);
    provider.models.push({
      kind: "candidate",
      modelId,
      builtin: false,
      personalExactConfig: config,
      effectiveBuiltinConfig: structuredClone(modelDefaults),
      effectiveConfig: { ...structuredClone(modelDefaults), ...config },
      selectable: true,
      executable: true,
      issues: [],
    });
    return view();
  },
  async savePersonalModelDraft(input) {
    // 与主进程 ProviderSettingsFacade 相同的乐观并发校验：
    // basedOnRevision 过期时必须拒绝，设置页漏传 revision 会在这里暴露。
    if (input.basedOnRevision !== revision) {
      throw new Error(
        `Provider Settings revision conflict: expected ${input.basedOnRevision}, current ${revision}`,
      );
    }
    fixture.draftSaves.push(structuredClone({ ...input, serverRevisionAtSave: revision }));
    const provider = providers.find((p) => p.providerId === input.providerId);
    const model = provider.models.find((m) => m.modelId === input.originalModelId);
    model.modelId = input.nextModelId;
    model.personalExactConfig = structuredClone(input.personalConfig);
    model.effectiveBuiltinConfig = structuredClone(modelDefaults);
    model.effectiveConfig = { ...structuredClone(modelDefaults), ...input.personalConfig };
    return view();
  },
  async testModelConnectivity(input) {
    fixture.tests.push(input);
    return { success: true };
  },
  async listProviderModels(input) {
    fixture.calls.push(["listProviderModels", input]);
    // Gemini 原生端点不实现 models.list；这里复现真实 404。
    if (params.get("mode") === "gemini-native") {
      return {
        success: false,
        error: { code: "request-failed", message: "HTTP 404" },
      };
    }
    return { success: true, modelIds: ["fixture-model", "catalog-model"], source: "primary" };
  },
};
const services = new Proxy(
  { providerSettingsService: service },
  {
    get(target, key) {
      if (key in target) return target[key];
      throw new Error("Unexpected service read: " + String(key));
    },
  },
);
const platform = {
  openExternal() {
    throw new Error("Unexpected external navigation");
  },
};
createRoot(document.getElementById("root")).render(
  <ZCodeIntlProvider initialLocale={locale}>
    <ServiceProvider services={services}>
      <PlatformProvider platform={platform}>
        <TooltipProvider>
          <main className="min-h-screen bg-background text-foreground p-3">
            <ModelProviderSection
              workspacePath="/fixture/local"
              pendingModelProviderTarget={
                params.get("mode") === "retired-target"
                  ? { providerId: account.providerId }
                  : undefined
              }
            />
            <ConfirmDialogHost />
          </main>
        </TooltipProvider>
      </PlatformProvider>
    </ServiceProvider>
  </ZCodeIntlProvider>,
);
