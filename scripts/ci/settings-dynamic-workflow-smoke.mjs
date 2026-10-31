// S12 真实设置页浏览器 E2E（本地临时服务/回环，不读用户数据、不连真实远端）。
// 覆盖：ToolSearch 设置行三选项往返、DWF 设置行可见性（灰度关/引擎不支持/旧 Host）、
// 选择落盘 patch 与「跟随默认」空串哨兵。
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { build as viteBuild } from "vite";
import { chromium } from "playwright-core";

const root = resolve(import.meta.dirname, "../..");
// fixture 内联在本文件：浏览器用例是脚本的一部分，不额外落一个只有本脚本引用的入口文件。
const fixtureSource = String.raw`
import { createRoot } from "react-dom/client";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  applyDynamicWorkflowUserMode,
  createDynamicWorkflowClientConfig,
} from "./packages/shared/src/dynamic-workflow-feature.js";
import { ZCodeIntlProvider } from "./packages/ui/src/i18n/IntlProvider.js";
import { PlatformProvider } from "./packages/ui/src/hooks/usePlatform.js";
import { ServiceProvider } from "./packages/ui/src/hooks/useServices.js";
import { GeneralSectionContent } from "./packages/ui/src/settingsPageHelpers.js";
import { useDynamicWorkflowAvailabilityStore } from "./packages/ui/src/store/dynamicWorkflowAvailabilityStore.js";

// 真实设置页组件 + 真实 DWF store；只替代持久化边界（setting.json）与 Host 传输。
// 这样验证的是产品代码的可见性规则、写入 patch 与 testid，而不是另写一份等价实现。

const initialSettings = {
  locale: "en-US",
  localePreference: "en-US",
  recentProjects: [],
  toolSearchMode: "off",
  taskAutoArchiveEnabled: false,
  taskAutoArchiveOlderThanDays: 30,
  nativeSearchEnhancementsEnabled: true,
  keepAwakeWhileRunning: false,
};


/** 服务集合只提供本页访问到的成员；缺失即真实产品里也不会被调用。 */
function createServices(settingService) {
  const noop = async () => {};
  return {
    settingService,
    botsService: { syncAppRuntimePreferences: noop },
    zcodeAgentService: { syncAppRuntimePreferences: noop },
    broadcastService: { send: noop },
    onboardingRecordService: { updateRecordPreferences: noop },
  };
}

const platform = {
  kind: "web",
  isDesktop: false,
  syncAppSettings: () => {},
  onSettingsChanged: () => () => {},
  openExternal: async () => {},
  getDefaultHomeDir: async () => "/home/fixture",
  selectDirectory: async () => null,
};

function Fixture({ scenario }) {
  const [settings, setSettings] = useState(initialSettings);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const patchesRef = useRef([]);
  // 每个场景只设置一次 DWF 快照，模拟 Host 返回的结果。
  useMemo(() => {
    useDynamicWorkflowAvailabilityStore.setState({
      status: "ready",
      enabled: scenario.config
        ? applyDynamicWorkflowUserMode(scenario.config, undefined).enabled
        : false,
      config: scenario.config,
    });
  }, [scenario]);

  const settingService = useMemo(
    () => ({
      async get() {
        return settingsRef.current;
      },
      async update(patch) {
        patchesRef.current.push(patch);
        window.__settingsPatches = patchesRef.current;
        setSettings((current) => ({ ...current, ...patch }));
      },
    }),
    [],
  );
  const services = useMemo(() => createServices(settingService), [settingService]);
  const noopAsync = useCallback(async () => {}, []);
  const noop = useCallback(() => {}, []);

  return (
    <PlatformProvider platform={platform}>
      <ServiceProvider services={services}>
        <GeneralSectionContent
          localePreference={settings.localePreference}
          notificationEnabled={false}
          notificationSoundEnabled={false}
          closeToTrayOnWindows
          receivePreviewUpdates={false}
          autoDownloadAndInstallUpdates={false}
          dataBaseDir="/tmp/zcode-fixture"
          terminalInheritSystemProfile
          terminalFontFamily=""
          nativeSearchEnhancementsEnabled
          toolSearchMode={settings.toolSearchMode}
          defaultHomeDir="/home/fixture"
          taskAutoArchiveEnabled={settings.taskAutoArchiveEnabled}
          taskAutoArchiveOlderThanDays={settings.taskAutoArchiveOlderThanDays}
          messageStreamShowReasoning
          messageStreamShowTodos={false}
          toolGroupingExploreEnabled
          toolGroupingTerminalEnabled
          toolGroupingChangesEnabled={false}
          zcodeInteractionBehavior="queue"
          setLocalePreference={noop}
          setNotificationEnabled={noop}
          setNotificationSoundEnabled={noop}
          onDataBaseDirChange={noopAsync}
          onSelectDataBaseDir={async () => null}
          onTerminalInheritSystemProfileChange={noopAsync}
          onTerminalFontFamilyChange={noopAsync}
          onNativeSearchEnhancementsEnabledChange={noopAsync}
          onToolSearchModeChange={async (mode) => {
            await settingService.update({ toolSearchMode: mode });
          }}
          onTaskAutoArchiveEnabledChange={noopAsync}
          onTaskAutoArchiveOlderThanDaysChange={async (days) => {
            await settingService.update({ taskAutoArchiveOlderThanDays: days });
          }}
          onCloseToTrayOnWindowsChange={noopAsync}
          onReceivePreviewUpdatesChange={noopAsync}
          onAutoDownloadAndInstallUpdatesChange={noopAsync}
          onMessageStreamShowReasoningChange={noopAsync}
          onMessageStreamShowTodosChange={noopAsync}
          onToolGroupingExploreEnabledChange={noopAsync}
          onToolGroupingTerminalEnabledChange={noopAsync}
          onToolGroupingChangesEnabledChange={noopAsync}
          onZCodeInteractionBehaviorChange={noopAsync}
          onOpenOnboardingDialog={noop}
        />
      </ServiceProvider>
    </PlatformProvider>
  );
}

// 场景由查询参数选择：默认「灰度关 + 引擎可用」，unsupported 场景验证设置行不出现。
const scenarioName = new URLSearchParams(location.search).get("scenario") || "gray-off";
const scenarios = {
  "gray-off": { config: createDynamicWorkflowClientConfig("disabled", "remote") },
  "gray-on": { config: createDynamicWorkflowClientConfig("alwaysOn", "remote") },
  "gray-on-demand": { config: createDynamicWorkflowClientConfig("onDemand", "remote") },
  "user-off": {
    config: applyDynamicWorkflowUserMode(
      createDynamicWorkflowClientConfig("alwaysOn", "remote"),
      "disabled",
    ),
  },
  unsupported: {
    config: createDynamicWorkflowClientConfig("alwaysOn", "remote", "unsupported"),
  },
  legacy: {
    // 旧 Host：没有 offeredMode → 设置行必须不出现。
    config: { mode: "alwaysOn", enabled: true, source: "remote", engine: "supported" },
  },
};

createRoot(document.getElementById("root")).render(
  <ZCodeIntlProvider initialLocale="en-US">
    <Fixture scenario={scenarios[scenarioName] ?? scenarios["gray-off"]} />
  </ZCodeIntlProvider>,
);

`;
const FIXTURE_ID = "virtual:settings-dynamic-workflow.jsx";
const viteResult = await viteBuild({
  configFile: false,
  root,
  logLevel: "silent",
  build: {
    write: false,
    minify: false,
    cssCodeSplit: false,
    rollupOptions: {
      input: FIXTURE_ID,
      output: { format: "esm", entryFileNames: "fixture.js", codeSplitting: false },
    },
  },
  resolve: { alias: { "@": resolve(root, "packages/ui/src") } },
  esbuild: { jsx: "automatic", loader: "jsx" },
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [
    {
      name: "settings-dynamic-workflow-fixture",
      resolveId(id) {
        if (id === FIXTURE_ID) return `\0${FIXTURE_ID}`;
        return null;
      },
      load(id) {
        if (id === `\0${FIXTURE_ID}`) return fixtureSource;
        return null;
      },
    },
  ],
});
const outputs = Array.isArray(viteResult) ? viteResult : [viteResult];
const script = outputs
  .flatMap((output) => ("output" in output ? output.output : []))
  .find((item) => item.type === "chunk" && item.isEntry)?.code;
if (typeof script !== "string") throw new Error("fixture bundle produced no entry chunk");

const server = createServer((request, response) => {
  if (request.url?.startsWith("/fixture.js")) {
    response.setHeader("Content-Type", "text/javascript");
    response.end(script);
    return;
  }
  response.setHeader("Content-Type", "text/html");
  response.end(
    '<!doctype html><meta name="viewport" content="width=device-width"><div id="root"></div><script type="module" src="/fixture.js"></script>',
  );
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const { port } = server.address();
const baseUrl = `http://127.0.0.1:${port}`;

const TID_SETTINGS_TOOL_SEARCH_SELECT = "settings-tool-search-select";
const TID_TOOL_SEARCH_OPTION = (mode) => `settings-tool-search-option-${mode}`;
const TID_DWF_TRIGGER = "settings-dynamic-workflow-mode-trigger";
const TID_DWF_OPTION = (mode) => `settings-dynamic-workflow-mode-item-${mode}`;

let browser;
const failures = [];
try {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.ZCODE_TEST_CHROMIUM_EXECUTABLE || undefined,
  });
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });

  async function open(scenario) {
    const page = await context.newPage();
    page.on("pageerror", (error) => failures.push(`pageerror(${scenario}): ${error.message}`));
    await page.goto(`${baseUrl}/?scenario=${scenario}`);
    await page.waitForSelector(`[data-testid="${TID_SETTINGS_TOOL_SEARCH_SELECT}"]`);
    return page;
  }

  async function pickOption(page, triggerId, optionId) {
    await page.click(`[data-testid="${triggerId}"]`);
    await page.click(`[data-testid="${optionId}"]`);
  }

  async function patches(page) {
    return page.evaluate(() => window.__settingsPatches ?? []);
  }

  // 1) ToolSearch：默认 Off → 选 Auto 写 shared settings，选项只有 off/auto/local。
  {
    const page = await open("gray-off");
    const trigger = page.locator(`[data-testid="${TID_SETTINGS_TOOL_SEARCH_SELECT}"]`);
    assert.equal((await trigger.textContent())?.trim(), "Off");
    await page.click(`[data-testid="${TID_SETTINGS_TOOL_SEARCH_SELECT}"]`);
    for (const mode of ["off", "auto", "local"]) {
      assert.equal(
        await page.locator(`[data-testid="${TID_TOOL_SEARCH_OPTION(mode)}"]`).count(),
        1,
        `tool search option ${mode} must exist`,
      );
    }
    // CLI 内部模式不能出现在设置里。
    assert.equal(
      await page.locator('[data-testid="settings-tool-search-option-native"]').count(),
      0,
    );
    await page.click(`[data-testid="${TID_TOOL_SEARCH_OPTION("auto")}"]`);
    await page.waitForFunction(() => (window.__settingsPatches ?? []).length > 0);
    assert.deepEqual(await patches(page), [{ toolSearchMode: "auto" }]);
    assert.equal((await trigger.textContent())?.trim(), "Auto");
    await page.close();
  }

  // 2) DWF 灰度关：行出现，默认项标关闭；三个真实档位都出现。
  {
    const page = await open("gray-off");
    const trigger = page.locator(`[data-testid="${TID_DWF_TRIGGER}"]`);
    assert.equal(await trigger.count(), 1, "灰度关也必须显示设置行（服务端只决定默认）");
    assert.equal((await trigger.textContent())?.trim(), "Off");
    await page.click(`[data-testid="${TID_DWF_TRIGGER}"]`);
    for (const mode of ["disabled", "onDemand", "alwaysOn"]) {
      assert.equal(
        await page.locator(`[data-testid="${TID_DWF_OPTION(mode)}"]`).count(),
        1,
        `dynamic workflow option ${mode} must exist`,
      );
    }
    // 默认标记只落在 offered 项（这里 offered=disabled）。
    assert.equal(
      await page
        .locator(`[data-testid="${TID_DWF_OPTION("disabled")}"]`)
        .getByText("Default")
        .count(),
      1,
    );
    await page.click(`[data-testid="${TID_DWF_OPTION("alwaysOn")}"]`);
    await page.waitForFunction(() => (window.__settingsPatches ?? []).length > 0);
    assert.deepEqual(await patches(page), [{ dynamicWorkflowMode: "alwaysOn" }]);
    await page.close();
  }

  // 3) onDemand 提供：默认项、选中值与 mapper 都保留 onDemand，不折叠成 alwaysOn。
  {
    const page = await open("gray-on-demand");
    const trigger = page.locator(`[data-testid="${TID_DWF_TRIGGER}"]`);
    assert.equal((await trigger.textContent())?.trim(), "On command");
    await pickOption(page, TID_DWF_TRIGGER, TID_DWF_OPTION("alwaysOn"));
    await page.waitForFunction(() => (window.__settingsPatches ?? []).length > 0);
    assert.deepEqual(await patches(page), [{ dynamicWorkflowMode: "alwaysOn" }]);
    await page.close();
  }

  // 4) 用户显式关闭覆盖 offered=alwaysOn；选回提供值写空串哨兵。
  {
    const page = await open("user-off");
    const trigger = page.locator(`[data-testid="${TID_DWF_TRIGGER}"]`);
    assert.equal((await trigger.textContent())?.trim(), "Off");
    await pickOption(page, TID_DWF_TRIGGER, TID_DWF_OPTION("alwaysOn"));
    await page.waitForFunction(() => (window.__settingsPatches ?? []).length > 0);
    assert.deepEqual(await patches(page), [{ dynamicWorkflowMode: "" }]);
    await page.close();
  }

  // 5) 归档关闭时天数仍可编辑：改了不等于打开归档。
  {
    const page = await open("gray-off");
    await page.getByText("Archive after 30 days", { exact: true }).click();
    await page.getByText("Archive after 7 days", { exact: true }).click();
    await page.waitForFunction(() => (window.__settingsPatches ?? []).length > 0);
    assert.deepEqual(await patches(page), [{ taskAutoArchiveOlderThanDays: 7 }]);
    await page.close();
  }

  // 6) 执行端没有 DWF 引擎（Rust runtime）：不出现设置行，也不写任何 patch。
  {
    const page = await open("unsupported");
    assert.equal(
      await page.locator(`[data-testid="${TID_DWF_TRIGGER}"]`).count(),
      0,
      "引擎不支持时不能提供选择（选了也做不到）",
    );
    await page.close();
  }

  // 7) 旧 Host（没有 offeredMode）：不出现设置行。
  {
    const page = await open("legacy");
    assert.equal(await page.locator(`[data-testid="${TID_DWF_TRIGGER}"]`).count(), 0);
    await page.close();
  }

  assert.deepEqual(failures, [], `fixture page errors: ${failures.join("; ")}`);
  console.log("settings dynamic workflow smoke: OK");
} finally {
  await browser?.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}
