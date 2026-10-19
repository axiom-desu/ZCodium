import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { tsImport } from "tsx/esm/api";

const root = new URL("../../", import.meta.url);
const { compileModelOptionMaps } = await tsImport(
  "../../packages/model-option-map/src/option-maps.ts",
  import.meta.url,
);

const bundled = JSON.parse(
  await readFile(new URL("config/provider/zcode-builtin.json", root), "utf8"),
);

function googleRule() {
  const rules = bundled.config.modelConfigRules.modelApiRules;
  // 取带 optionSpecs 的那条：纯元数据规则（contextWindow/inputFormat）不定义 map。
  const rule = rules.find(
    (candidate) =>
      candidate.apiTypeMatch === "google-generative-ai" &&
      candidate.config.optionSpecs?.maxOutputTokens?.map,
  );
  assert.ok(
    rule,
    "Gemini 需要一条带 optionSpecs 的 modelApiRules，否则请求体拿不到 maxOutputTokens / thinkingConfig",
  );
  return rule;
}

test("google api rule keeps generation fields inside generationConfig", () => {
  const rule = googleRule();
  const specs = rule.config.optionSpecs;

  // Gemini 的 generationConfig 是唯一入口；写到顶层会被网关忽略而不报错，
  // 表现为“设了 maxOutputTokens 但请求里没有”，因此这里断言嵌套位置。
  assert.match(specs.maxOutputTokens.map, /generationConfig/);
  assert.match(specs.reasoningLevel.map, /generationConfig/);

  const maps = compileModelOptionMaps({
    reasoningLevel: { map: specs.reasoningLevel.map },
    maxOutputTokens: { map: specs.maxOutputTokens.map },
  });

  // merge-patch 产出的是无原型对象，比较前先归一成普通 JSON。
  const plain = (value) => JSON.parse(JSON.stringify(value));

  const enabled = plain(
    maps.apply(
      { generationConfig: {}, contents: [] },
      {
        reasoningLevel: "enabled",
        maxOutputTokens: 65536,
      },
    ),
  );
  assert.deepEqual(enabled.generationConfig, {
    thinkingConfig: { thinkingLevel: "high", includeThoughts: true },
    maxOutputTokens: 65536,
  });
  // 顶层不得出现散落字段。
  assert.deepEqual(Object.keys(enabled).sort(), ["contents", "generationConfig"]);

  const disabled = plain(
    maps.apply(
      { generationConfig: {}, contents: [] },
      {
        reasoningLevel: "disabled",
        maxOutputTokens: 1024,
      },
    ),
  );
  // disabled 档必须**省略** thinkingConfig：实测 gemini-4-argon / gemini-3.1-pro /
  // gemini-3.8-flash 既拒绝 thinkingBudget:0，也拒绝 thinkingLevel:"minimal"，
  // 省略反而是唯一对所有模型都 200 的选择。
  assert.deepEqual(disabled.generationConfig, { maxOutputTokens: 1024 });
  assert.equal(disabled.generationConfig.thinkingConfig, undefined);
});

test("google per-model rules are scoped to OpenCode and do not shadow", () => {
  // 这批是给 OpenCode 擦屁股的临时补丁，必须限定 baseUrlMatch；
  // 若挪回全局 modelApiRules，会用 OpenCode 的上限污染用户自建端点。
  const rules = bundled.config.modelConfigRules.providerSiteRules.filter(
    (r) => r.apiTypeMatch === "google-generative-ai",
  );
  assert.ok(rules.length > 0, "OpenCode Gemini 的上限补丁丢失");
  for (const rule of rules) {
    assert.match(
      rule.baseUrlMatch,
      /opencode/,
      "Gemini 元数据规则必须限定 baseUrlMatch，不能全局生效",
    );
  }
  const globalGoogleRules = bundled.config.modelConfigRules.modelApiRules.filter(
    (r) =>
      r.apiTypeMatch === "google-generative-ai" && r.config.properties?.contextWindow !== undefined,
  );
  assert.deepEqual(globalGoogleRules, [], "modelApiRules 不应包含 Gemini 的 contextWindow 覆盖");
  // 顺序敏感：具体规则必须排在通配之前，否则 lite 会被 flash 覆盖、contributor 会被 argon 覆盖。
  for (const rule of rules) new RegExp(rule.modelMatch);

  const resolve = (modelId) => {
    let contextWindow;
    let maxOutputTokens;
    for (const rule of rules) {
      if (!new RegExp(rule.modelMatch).test(modelId)) continue;
      // providerSiteRules 需要 baseUrl 匹配；统一按 Zen 网关注入。
      if (!new RegExp(rule.baseUrlMatch).test("https://opencode.ai/inference/google/v1beta"))
        continue;
      const ctx = rule.config.properties?.contextWindow;
      const max = rule.config.optionSpecs?.maxOutputTokens?.max;
      if (ctx !== undefined) contextWindow = ctx;
      if (max !== undefined) maxOutputTokens = max;
    }
    return { contextWindow, maxOutputTokens };
  };

  // 值来自 OpenRouter /api/v1/models 的 google/* 条目；OpenCode 自身不返回任何能力字段。
  assert.deepEqual(resolve("gemini-4-argon"), { contextWindow: 1048576, maxOutputTokens: 943718 });
  assert.deepEqual(resolve("gemini-4-argon-contributor"), {
    contextWindow: 1048576,
    maxOutputTokens: 943718,
  });
  assert.deepEqual(resolve("gemini-3.5-flash-lite"), {
    contextWindow: 1048576,
    maxOutputTokens: 65536,
  });
  assert.deepEqual(resolve("gemini-3.5-flash"), { contextWindow: 1048576, maxOutputTokens: 65536 });
  assert.deepEqual(resolve("gemini-3.1-pro"), { contextWindow: 1048576, maxOutputTokens: 65536 });
  // 未知模型不得被 Gemini 规则误伤。
  assert.deepEqual(resolve("definitely-unknown-model"), {
    contextWindow: undefined,
    maxOutputTokens: undefined,
  });
});

test("google templates declare the native api type and stay metadata-compatible", () => {
  const templates = bundled.config.providerConfigRules.templateRules;
  const native = templates.filter((t) => t.config.api.type === "google-generative-ai");
  assert.ok(native.length >= 2, "OpenCode Go/Zen 的 Gemini 模板都应使用原生 api type");

  for (const template of native) {
    // 版本段必须在 baseUrl 里：SDK 只追加 /models/{id}:generateContent。
    assert.match(
      template.config.api.baseUrl,
      /\/v\d+(?:alpha|beta)?\d*$/,
      `${template.templateId} 的 baseUrl 必须以版本段结尾`,
    );
    assert.ok(template.config.builtinModelIds.length > 0);
    // 原生协议靠 x-goog-api-key，access 必须是 api-key 而不能是账号型。
    assert.equal(template.config.access.type, "api-key");
    assert.ok(template.config.access.apiKeyManagementUrl);
  }
});
