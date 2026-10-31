import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";
import { Cron } from "croner";
import { build } from "esbuild";
import { createRequire } from "node:module";

const { createClientScenesService } = await tsImport(
  "../../packages/services/src/client-scenes/clientScenesService.ts",
  import.meta.url,
);
const { createClientConfigService } = await tsImport(
  "../../packages/services/src/client-config/clientConfigService.ts",
  import.meta.url,
);
const { mapClientScenesToDraftSuggestedPromptItems, resolveDraftSuggestedPromptText } =
  await tsImport("../../packages/ui/src/v4/draftSuggestedPromptItems.ts", import.meta.url);
const { mapClientScenesToAutomationTemplates, materializeScheduledTemplateDraft } = await tsImport(
  "../../packages/ui/src/settings/automationTemplateCatalog.ts",
  {
    parentURL: import.meta.url,
    tsconfig: fileURLToPath(new URL("../../packages/ui/tsconfig.json", import.meta.url)),
  },
);

const forbiddenNetwork = {
  apiClient: {
    request() {
      throw new Error("network forbidden");
    },
  },
  resolveRequestContext() {
    throw new Error("endpoint/device context forbidden");
  },
};

test("feature recommendation icons are bundled and retain localized prompts and plugin identities", async () => {
  const { outputFiles } = await build({
    entryPoints: [
      fileURLToPath(
        new URL("../../packages/ui/src/v4/featureSuggestedPrompts.ts", import.meta.url),
      ),
    ],
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    alias: { "@": fileURLToPath(new URL("../../packages/ui/src", import.meta.url)) },
    loader: { ".png": "dataurl" },
  });
  const { getRecommendedPromptPool } = await import(
    `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`
  );
  const require = createRequire(new URL("../../packages/ui/package.json", import.meta.url));
  const { dynamicIconImports } = await import(require.resolve("lucide-react/dynamic.mjs"));
  for (const mode of ["office", "coding"]) {
    const items = getRecommendedPromptPool(mode === "office");
    assert.ok(items.length > 5);
    assert.equal(new Set(items.map((item) => item.id)).size, items.length);
    for (const item of items) {
      assert.equal(item.mode, mode);
      assert.doesNotMatch(
        JSON.stringify([item.label, item.prompt]),
        /闲时|idle[- ]time|off[- ]peak/i,
      );
      assert.ok(item.label.cn && item.label.en && item.prompt.cn && item.prompt.en);
      if (item.iconUrl) assert.match(item.iconUrl, /^data:image\//);
      else assert.ok(Object.hasOwn(dynamicIconImports, item.iconName), item.id);
      if (item.plugin) assert.ok(item.prompt.en.includes(`plugin://${item.plugin.stableId}`));
    }
  }
});

test("bundled recommendations and scheduled templates remain usable without any network context", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("fetch forbidden");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const response = await createClientScenesService(forbiddenNetwork).list();
  assert.equal(response.code, 0);
  const prompts = mapClientScenesToDraftSuggestedPromptItems(response.data);
  assert.ok(prompts.length >= 4);
  const templates = mapClientScenesToAutomationTemplates(response.data, (value) => {
    const cron = new Cron(value, { paused: true });
    try {
      return Boolean(cron.nextRun());
    } finally {
      cron.stop();
    }
  });
  assert.deepEqual(templates.rejectedScheduledTemplateIds, []);
  assert.ok(templates.scheduled.length >= 3);
  assert.equal(Object.hasOwn(templates, "offPeak"), false);
  for (const locale of ["zh-CN", "en-US"]) {
    for (const prompt of prompts) {
      assert.ok(resolveDraftSuggestedPromptText(prompt.label, locale));
      assert.ok(resolveDraftSuggestedPromptText(prompt.prompt, locale));
      assert.ok(!prompt.iconUrl);
      assert.ok(!prompt.actions?.includes("NAVIGATE:AUTOMATIONS:OFFPEAK"));
    }
    for (const template of templates.scheduled) {
      const draft = materializeScheduledTemplateDraft(template, locale);
      assert.ok(draft.title && draft.prompt);
      assert.equal(draft.cronExpr, template.cronExpr);
    }
  }
  assert.doesNotMatch(JSON.stringify(response), /https?:\/\//);
});

test("callers cannot mutate bundled scenes or public config for later reads", async () => {
  const scenes = createClientScenesService(forbiddenNetwork);
  const expectedScenes = await scenes.list();
  const mutated = await scenes.list();
  mutated.data[0].options.prompts.items[0].contents.cn = "changed by caller";
  mutated.data.splice(1);
  assert.deepEqual(await scenes.list(), expectedScenes);
  assert.deepEqual(await createClientScenesService(forbiddenNetwork).list(), expectedScenes);
  const config = createClientConfigService(forbiddenNetwork);
  // 既定 3.16 行为（upstream-3.16-settings-and-navigation.md）：ClientConfigSnapshot
  // 由 pluginStoreOrder/zsrcUrl/uiPluginRecommendations 三字段构成，解析器恒返回全部键，
  // 空值即 null/[]；断言保持全量深度相等（非子集），只补齐既定字段。
  const emptySnapshot = { pluginStoreOrder: null, zsrcUrl: null, uiPluginRecommendations: [] };
  const snapshot = await config.getSnapshot();
  assert.deepEqual(snapshot, emptySnapshot);
  snapshot.pluginStoreOrder = { code: { categoryOrder: ["caller"] } };
  assert.deepEqual(await config.getSnapshot({ forceRefresh: true }), emptySnapshot);
});
