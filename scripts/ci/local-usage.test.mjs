import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { build } from "esbuild";

// Guard the actual entrypoint: local Usage must not restore account discovery on mount.
// Coding Plan remaining quota is allowed, but only through the API-key path — account,
// entitlement and OAuth dependencies stay banned.
test("settings and local usage hooks have no official quota query dependencies", async () => {
  const banned =
    /UsageEntitlement|AccountAccess|accountProviderAccess|usageEntitlement|oauth|OAuth/;
  for (const path of [
    "packages/ui/src/SettingsPage.tsx",
    "packages/ui/src/settings/UsageStatsSection.tsx",
    "packages/ui/src/hooks/useUsageStats.ts",
    "packages/ui/src/hooks/useCodingPlanQuota.ts",
    "packages/ui/src/settings/usage-stats/CodingPlanQuotaPanel.tsx",
  ]) {
    const text = await readFile(path, "utf8");
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    const imports = source.statements
      .filter(ts.isImportDeclaration)
      .map((node) => node.getText(source));
    assert.doesNotMatch(imports.join("\n"), banned);
  }
});

test("old usage tab intent is consumed without affecting local usage or other settings navigation", async () => {
  const storage = () => {
    const data = new Map();
    return {
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => data.set(key, String(value)),
      removeItem: (key) => data.delete(key),
    };
  };
  const previous = globalThis.window;
  const target = new EventTarget();
  globalThis.window = Object.assign(target, { localStorage: storage(), sessionStorage: storage() });
  try {
    const { outputFiles } = await build({
      entryPoints: ["packages/ui/src/lib/settingsNavigation.ts"],
      bundle: true,
      write: false,
      platform: "node",
      format: "esm",
      plugins: [
        {
          name: "logger-boundary",
          setup(builder) {
            builder.onResolve({ filter: /^@\/logger\.js$/ }, () => ({
              path: "logger",
              namespace: "fixture",
            }));
            builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
              contents: "export const logger = { warn() {} };",
            }));
          },
        },
      ],
    });
    const navigation = await import(
      `data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString("base64")}`
    );
    window.sessionStorage.setItem("zcode-settings-section-intent", "usage");
    window.sessionStorage.setItem("zcode-settings-usage-tab-intent", "codingPlan");
    assert.equal(navigation.consumeInitialSettingsSection(), "usage");
    assert.equal(window.sessionStorage.getItem("zcode-settings-usage-tab-intent"), null);
    const events = [];
    const stop = navigation.addPendingSettingsSectionListener((section, detail) =>
      events.push({ section, detail }),
    );
    navigation.setPendingSettingsUsageIntent();
    assert.equal(events.at(-1).section, "usage");
    assert.equal(Object.hasOwn(events.at(-1).detail, "usageTab"), false);
    navigation.setPendingSettingsSectionIntent("modelProvider", { modelProviderId: "fixture-api" });
    assert.equal(events.at(-1).detail.modelProviderId, "fixture-api");
    navigation.setPendingSettingsPluginIntent("plugins", {
      scopeKey: "fixture-workspace",
      origin: "plugin-store",
    });
    assert.equal(events.at(-1).section, "plugin");
    assert.equal(events.at(-1).detail.pluginScopeKey, "fixture-workspace");
    stop();
  } finally {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
});
