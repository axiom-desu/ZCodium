import { describe, expect, it } from "vitest";
import {
  ApiKeyAccessConfig,
  ModelConfig,
  ModelConfigRules,
  ProviderApiConfig,
  ProviderConfig,
  ProviderConfigMap,
  ProviderConfigResolver,
  ProviderTemplate,
  ProviderTemplateMap,
  type ProviderApiConfigInput,
  type ProviderConfigInput,
  type ProviderConfigResolverInput,
} from "../src/index.js";

const endpoint = "https://provider.example.test/v1";
const logo = { type: "builtin", key: "fixture-logo" } as const;

function provider(input: ProviderConfigInput = {}): ProviderConfig {
  return new ProviderConfig({
    group: "standard-personal",
    access: new ApiKeyAccessConfig({ apiKey: "synthetic-test-key" }),
    api: new ProviderApiConfig({ type: "openai-chat-completions", baseUrl: endpoint }),
    ...input,
  });
}

function templates(configs: readonly ProviderConfig[]): ProviderTemplateMap {
  return new ProviderTemplateMap(
    configs.map((config, index) => {
      const templateId = `template:fixture-${index}`;
      return [templateId, new ProviderTemplate({ templateId, templateNameMap: {}, config })];
    }),
  );
}

function resolve(
  config: ProviderConfig,
  templateConfigs?: readonly ProviderConfig[],
  extra: Partial<ProviderConfigResolverInput> = {},
) {
  return new ProviderConfigResolver().resolve({
    zcodeBuiltinProviders: ProviderConfigMap.empty(),
    personalProviders: new ProviderConfigMap([["personal:legacy", config]]),
    zcodeBuiltinModelRules: ModelConfigRules.empty(),
    personalModels: ModelConfigRules.empty(),
    accountProviders: ProviderConfigMap.empty(),
    ...(templateConfigs === undefined
      ? {}
      : { zcodeBuiltinProviderTemplates: templates(templateConfigs) }),
    ...extra,
  });
}

function resolvedLogo(config: ProviderConfig, templateConfigs?: readonly ProviderConfig[]) {
  return resolve(config, templateConfigs).effectiveProviders.get("personal:legacy")?.logo;
}

// 使用完整合成模型，确保“不改变准入”的比较不是对空 Registry 的空泛断言。
const model = ModelConfig.fromData({
  enabled: true,
  properties: {
    requiresMfjsToolSchema: false,
    contextWindow: 4096,
    inputFormat: {
      supportsText: true,
      supportsImage: false,
      supportsVideo: false,
      supportsAudio: false,
      supportsPdf: false,
    },
    outputFormat: { supportsText: true },
    supportsToolCall: true,
    supportsJsonSchemaOutput: false,
    supportsNativeWebSearch: false,
    supportsMidConversationSystem: false,
  },
  optionSpecs: {
    reasoningLevel: { values: ["low"], map: "({})" },
    maxOutputTokens: { max: 1024, map: "({})" },
  },
});

function withoutLogos(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (key, entry) => (key === "logo" ? undefined : entry)));
}

describe("ProviderConfigResolver template logo fallback", () => {
  it.each([
    [endpoint, `${endpoint}///`],
    [`${endpoint}///`, endpoint],
    [`${endpoint}/`, `${endpoint}//`],
  ])("matches protocol and trailing-slash-only URLs (%s, %s)", (baseUrl, templateUrl) => {
    expect(
      resolvedLogo(
        provider({ api: new ProviderApiConfig({ type: "openai-chat-completions", baseUrl }) }),
        [
          provider({
            api: new ProviderApiConfig({ type: "openai-chat-completions", baseUrl: templateUrl }),
            logo,
          }),
        ],
      ),
    ).toEqual(logo);
  });

  it.each<ProviderApiConfigInput>([
    { type: "anthropic-messages", baseUrl: endpoint },
    { type: "openai-responses", baseUrl: endpoint },
    { type: "openai-chat-completions", baseUrl: "http://provider.example.test/v1" },
    { type: "openai-chat-completions", baseUrl: "https://PROVIDER.example.test/v1" },
    { type: "openai-chat-completions", baseUrl: `${endpoint}/other` },
    { type: "openai-chat-completions", baseUrl: `${endpoint}?mode=test` },
    { type: "openai-chat-completions", baseUrl: `${endpoint} ` },
    { type: "openai-chat-completions" },
    { baseUrl: endpoint },
    {},
  ])("does not normalize or infer other API differences: %j", (api) => {
    expect(
      resolvedLogo(provider({ api: new ProviderApiConfig(api) }), [provider({ logo })]),
    ).toBeUndefined();
  });

  it.each([null, undefined])("does not fill missing API: %s", (api) => {
    expect(resolvedLogo(provider({ api }), [provider({ logo })])).toBeUndefined();
  });

  it.each([logo, null])("preserves explicit logo: %j", (existingLogo) => {
    const config = provider({ logo: existingLogo });
    const resolution = resolve(config, [provider({ logo: { type: "builtin", key: "other" } })]);
    expect(resolution.effectiveProviders.get("personal:legacy")).toBe(config);
    expect(resolution.effectiveProviders.get("personal:legacy")?.logo).toEqual(existingLogo);
  });

  it("leaves ambiguous keys disabled even after further matching templates", () => {
    const other = { type: "builtin", key: "other" } as const;
    for (const logos of [
      [logo, other, logo],
      [other, logo, other],
      [logo, logo, other],
    ]) {
      expect(
        resolvedLogo(
          provider(),
          logos.map((item) => provider({ logo: item })),
        ),
      ).toBeUndefined();
    }
    expect(resolvedLogo(provider(), [provider({ logo }), provider({ logo })])).toEqual(logo);
  });

  it("ignores incomplete templates rather than poisoning a valid key", () => {
    const incomplete = [
      provider(),
      provider({ logo: null }),
      provider({ logo, api: null }),
      provider({ logo, api: new ProviderApiConfig({ baseUrl: endpoint }) }),
      provider({ logo, api: new ProviderApiConfig({ type: "openai-chat-completions" }) }),
      provider({
        logo,
        api: new ProviderApiConfig({ type: "openai-chat-completions", baseUrl: "" }),
      }),
    ];
    expect(resolvedLogo(provider(), incomplete)).toBeUndefined();
    expect(resolvedLogo(provider(), [...incomplete, provider({ logo })])).toEqual(logo);
  });

  it("does not retain template state across calls and needs no template source", () => {
    const config = provider();
    expect(resolvedLogo(config, [provider({ logo })])).toEqual(logo);
    expect(resolve(config).effectiveProviders.get("personal:legacy")).toBe(config);
    expect(resolvedLogo(config, [])).toBeUndefined();
  });

  it("changes only logo, not membership, credentials, request settings or admission", () => {
    const config = provider({
      api: new ProviderApiConfig({
        type: "openai-chat-completions",
        baseUrl: `${endpoint}///`,
        headers: { "x-fixture": "personal" },
      }),
      builtinModelIds: ["builtin-model"],
      personalModelIds: ["personal-model", "builtin-model", "invalid-model"],
      modelOrder: ["personal-model", "invalid-model", "builtin-model"],
      visibility: "hidden",
    });
    const extra: Partial<ProviderConfigResolverInput> = {
      personalProviders: new ProviderConfigMap([
        { providerId: "personal:legacy", providerName: "Kept name", templateId: null, config },
        {
          providerId: "personal:disabled",
          enabled: false,
          config: provider({ personalModelIds: ["builtin-model"] }),
        },
        ["personal:invalid", provider({ access: null })],
      ]),
      personalProviderOrder: ["personal:invalid", "personal:legacy", "personal:disabled"],
      zcodeBuiltinModelRules: new ModelConfigRules([
        { type: "model", modelMatch: "(?:builtin|personal)-model", config: model },
      ]),
    };
    const template = provider({
      logo,
      access: new ApiKeyAccessConfig({ apiKey: "must-not-use-template-key" }),
      api: new ProviderApiConfig({
        type: "openai-chat-completions",
        baseUrl: endpoint,
        headers: { "x-fixture": "template" },
      }),
      builtinModelIds: ["must-not-add"],
    });
    const beforeInput = config.toJSON();
    const baseline = resolve(config, undefined, extra);
    const result = resolve(config, [template], extra);
    expect(result.effectiveProviders.get("personal:legacy")?.logo).toEqual(logo);
    expect(withoutLogos(result)).toEqual(withoutLogos(baseline));
    expect(result.issues.length).toBeGreaterThan(0);
    expect(
      result.registryProviders.map((entry) => [
        entry.providerId,
        entry.models.map((item) => item.modelId),
      ]),
    ).toEqual([["personal:legacy", ["personal-model", "builtin-model"]]]);
    expect(config.toJSON()).toEqual(beforeInput);
    expect(config.logo).toBeUndefined();
    expect(result.effectiveProviders.getRule("personal:legacy")?.templateId).toBeNull();
  });

  it("fills after builtin/account/personal overlays without changing explicit template behavior", () => {
    const builtin = provider({
      group: "zai-family",
      api: new ProviderApiConfig({
        type: "openai-chat-completions",
        baseUrl: "https://old.example.test",
      }),
    });
    const extra: Partial<ProviderConfigResolverInput> = {
      zcodeBuiltinProviders: new ProviderConfigMap([["account:fixture", builtin]]),
      accountProviders: new ProviderConfigMap([
        [
          "account:fixture",
          new ProviderConfig({ api: new ProviderApiConfig({ baseUrl: endpoint }) }),
        ],
      ]),
      personalProviders: new ProviderConfigMap([
        ["account:fixture", new ProviderConfig({ visibility: "hidden" })],
        {
          providerId: "personal:explicit",
          templateId: "template:fixture-0",
          config: new ProviderConfig(),
        },
      ]),
    };
    const result = resolve(provider(), [provider({ logo })], extra);
    expect(result.effectiveProviders.get("account:fixture")?.logo).toEqual(logo);
    expect(result.effectiveBuiltinProviders.get("account:fixture")?.logo).toBeUndefined();
    expect(result.effectiveProviders.get("account:fixture")?.group).toBe("zai-family");
    expect(result.effectiveProviders.get("account:fixture")?.visibility).toBe("hidden");
    expect(result.effectiveProviders.get("personal:explicit")?.logo).toEqual(logo);
    expect(result.effectiveProviders.getRule("personal:explicit")?.templateId).toBe(
      "template:fixture-0",
    );
  });
});
