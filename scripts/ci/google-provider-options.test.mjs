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
  const rule = rules.find((candidate) => candidate.apiTypeMatch === "google-generative-ai");
  assert.ok(
    rule,
    "Gemini 需要一条 modelApiRules，否则请求体拿不到 maxOutputTokens / thinkingConfig",
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
