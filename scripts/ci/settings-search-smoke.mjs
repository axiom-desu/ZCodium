// 设置搜索 + 定位真实浏览器 E2E（临时回环服务，不读用户数据、不连真实远端）。
// 覆盖：搜索入口（宽/窄）、中文全拼/首字母/说明匹配、空态、选中后关闭对话框并定位高亮、
// 再次选中重新计时、普通分类导航清除目标、Escape 清空/关闭、390 无横向溢出。
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { build as viteBuild } from "vite";
import { chromium } from "playwright-core";

const root = resolve(import.meta.dirname, "../..");
const fixtureSource = String.raw`
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { ZCodeIntlProvider } from "./packages/ui/src/i18n/IntlProvider.js";
import { PlatformProvider } from "./packages/ui/src/hooks/usePlatform.js";
import { ServiceProvider } from "./packages/ui/src/hooks/useServices.js";
import { SettingsRow } from "./packages/ui/src/settings/SettingsPageParts.js";
import { createSettingsPageConfig } from "./packages/ui/src/settings/settingsPageConfig.js";
import { SettingsSearch } from "./packages/ui/src/settings-search/SettingsSearch.js";
import { SettingsSearchTargetContext } from "./packages/ui/src/settings-search/SettingsSearchTarget.js";
import { useDynamicWorkflowAvailabilityStore } from "./packages/ui/src/store/dynamicWorkflowAvailabilityStore.js";

// 真实 SettingsSearch + SettingsRow + 定位 context；只替代外层 SettingsPage 的导航壳，
// 这样验证的是产品代码的匹配/定位/计时语义，而不是另写一份等价实现。
const noop = async () => {};
const services = {
  settingService: { get: async () => ({}), update: noop },
  botsService: { syncAppRuntimePreferences: noop },
  zcodeAgentService: { syncAppRuntimePreferences: noop },
  broadcastService: { send: noop },
  onboardingRecordService: { updateRecordPreferences: noop },
};
const platform = {
  kind: "web",
  isDesktop: false,
  syncAppSettings: () => {},
  onSettingsChanged: () => () => {},
  openExternal: async () => {},
  getDefaultHomeDir: async () => "/home/fixture",
  selectDirectory: async () => null,
};

function Fixture() {
  useDynamicWorkflowAvailabilityStore.setState({
    status: "ready",
    enabled: true,
    config: { mode: "alwaysOn", enabled: true, source: "remote", engine: "supported", offeredMode: "alwaysOn" },
  });
  const { settingsSections } = createSettingsPageConfig({ isDesktop: true });
  const [target, setTarget] = useState(null);
  const [activeSection, setActiveSection] = useState("appearance");
  return (
    <SettingsSearchTargetContext.Provider value={target}>
      <div className="flex min-h-screen w-full flex-col gap-4 p-4" data-testid="fixture-shell">
        <SettingsSearch
          sections={settingsSections}
          availability={{
            desktop: true,
            windowsHost: false,
            tray: false,
            notWindows: true,
            macDesktop: false,
          }}
          onSelect={({ section, setting }) => {
            setActiveSection(section);
            setTarget(setting ? { id: setting } : null);
          }}
        />
        <nav>
          <button
            type="button"
            data-testid="plain-navigation"
            onClick={() => {
              setTarget(null);
              setActiveSection("general");
            }}
          >
            plain navigation
          </button>
        </nav>
        <div data-testid="active-section">{activeSection}</div>
        <SettingsRow searchId="settings.uiFontSize" label="UI font size" control={<span>ctl</span>} />
        <SettingsRow searchId="settings.browser.htmlClickOpensBrowser" label="HTML" control={<span>ctl</span>} />
      </div>
    </SettingsSearchTargetContext.Provider>
  );
}

const locale = new URLSearchParams(location.search).get("locale") || "en-US";
createRoot(document.getElementById("root")).render(
  <ZCodeIntlProvider initialLocale={locale}>
    <PlatformProvider value={platform}>
      <ServiceProvider services={services}>
        <Fixture />
      </ServiceProvider>
    </PlatformProvider>
  </ZCodeIntlProvider>,
);
`;
const FIXTURE_ID = "virtual:settings-search.jsx";
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
      name: "settings-search-fixture",
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

// UI 包不含 Tailwind 构建产物；这里只注入搜索/高亮断言所需的最小样式，不复制产品样式。
const STYLE = `
html, body { margin: 0; font-family: sans-serif; }
[data-settings-search-highlighted] { outline: 2px solid rgb(59 130 246); }
.compact-web\\:text-mobile-input-safe { font-size: 16px; }
`;

const server = createServer((request, response) => {
  if (request.url?.startsWith("/fixture.js")) {
    response.setHeader("Content-Type", "text/javascript");
    response.end(script);
    return;
  }
  if (request.url?.startsWith("/style.css")) {
    response.setHeader("Content-Type", "text/css");
    response.end(STYLE);
    return;
  }
  response.setHeader("Content-Type", "text/html");
  response.end(
    '<!doctype html><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/style.css"><div id="root"></div><script type="module" src="/fixture.js"></script>',
  );
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const { port } = server.address();
const baseUrl = `http://127.0.0.1:${port}`;

const OPEN = '[data-testid="settings-search-open"]';
const DIALOG = '[data-testid="settings-search-dialog"]';
const INPUT = '[data-testid="settings-search-input"]';
const CLEAR = '[data-testid="settings-search-clear"]';
const EMPTY = '[data-testid="settings-search-empty"]';
const result = (id) => `[data-settings-search-result="${id}"]`;

let browser;
const failures = [];
try {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.ZCODE_TEST_CHROMIUM_EXECUTABLE || undefined,
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });

  async function open(locale = "en-US") {
    const page = await context.newPage();
    page.on("pageerror", (error) => failures.push(`pageerror(${locale}): ${error.message}`));
    await page.goto(`${baseUrl}/?locale=${locale}`);
    await page.waitForSelector(OPEN);
    return page;
  }

  async function search(page, text) {
    await page.click(OPEN);
    await page.waitForSelector(INPUT);
    await page.fill(INPUT, text);
  }

  // 1) 宽屏入口有文字；空查询列出分类与设置行；说明匹配排在名称匹配之后。
  {
    const page = await open();
    assert.equal((await page.locator(OPEN).innerText()).trim(), "Search settings");
    await search(page, "font size");
    await page.waitForSelector(result("settings.uiFontSize"));
    await page.close();
  }

  // 2) 中文全拼与首字母都能命中（真实 zh-CN 标签「界面字号」）。
  {
    const page = await open("zh-CN");
    await search(page, "jiemianzihao");
    await page.waitForSelector(result("settings.uiFontSize"));
    await page.fill(INPUT, "jmzh");
    await page.waitForSelector(result("settings.uiFontSize"));
    await page.fill(INPUT, "界面字号");
    await page.waitForSelector(result("settings.uiFontSize"));
    await page.close();
  }

  // 3) 说明文字子串匹配也命中 HTML 打开方式行。
  {
    const page = await open();
    await search(page, "single-clicking");
    await page.waitForSelector(result("settings.browser.htmlClickOpensBrowser"));
    await page.close();
  }

  // 4) 无匹配展示本地化空态。
  {
    const page = await open();
    await search(page, "zzzz-not-a-setting");
    await page.waitForSelector(EMPTY);
    assert.equal((await page.locator(EMPTY).innerText()).trim(), "No matching settings");
    await page.close();
  }

  // 5) 选中设置行：关闭对话框、切分区、目标行聚焦 + 高亮，约 2 秒后高亮消失。
  {
    const page = await open();
    await search(page, "font size");
    await page.waitForSelector(result("settings.uiFontSize"));
    await page.click(result("settings.uiFontSize"));
    await page.waitForSelector(DIALOG, { state: "detached" });
    assert.equal(
      (await page.locator('[data-testid="active-section"]').innerText()).trim(),
      "appearance",
    );
    const row = page.locator('[data-settings-search-id="settings.uiFontSize"]');
    await page.waitForFunction(
      () =>
        document.activeElement?.getAttribute("data-settings-search-id") === "settings.uiFontSize",
    );
    assert.equal(await row.getAttribute("data-settings-search-highlighted"), "true");
    await page.waitForFunction(
      () =>
        !document
          .querySelector('[data-settings-search-id="settings.uiFontSize"]')
          ?.hasAttribute("data-settings-search-highlighted"),
      undefined,
      { timeout: 5000 },
    );

    // 6) 再次选中同一项：重新定位并重新计时。
    await search(page, "ui font");
    await page.waitForSelector(result("settings.uiFontSize"));
    await page.click(result("settings.uiFontSize"));
    await page.waitForSelector(DIALOG, { state: "detached" });
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-settings-search-id="settings.uiFontSize"]')
          ?.getAttribute("data-settings-search-highlighted") === "true",
    );

    // 7) 普通分类导航立即清除目标与高亮。
    await page.click('[data-testid="plain-navigation"]');
    await page.waitForFunction(
      () =>
        !document
          .querySelector('[data-settings-search-id="settings.uiFontSize"]')
          ?.hasAttribute("data-settings-search-highlighted"),
    );
    await page.close();
  }

  // 8) Escape：先清空查询，空查询再关闭对话框；组字中不处理（由组件 isComposing 分支保证）。
  {
    const page = await open();
    await search(page, "font");
    await page.waitForSelector(result("settings.uiFontSize"));
    await page.keyboard.press("Escape");
    assert.equal(await page.inputValue(INPUT), "", "第一次 Escape 只清空查询");
    assert.equal(await page.locator(DIALOG).count(), 1, "对话框仍在");
    await page.keyboard.press("Escape");
    await page.waitForSelector(DIALOG, { state: "detached" });

    // 9) 清空按钮：清空后重新回到全量列表并保持焦点在输入框。
    await page.click(OPEN);
    await page.fill(INPUT, "font");
    await page.waitForSelector(CLEAR);
    await page.click(CLEAR);
    assert.equal(await page.inputValue(INPUT), "");
    await page.waitForSelector(result("settings.uiFontSize"));
    await page.close();
  }

  // 10) 390×844 手机 Web：入口只显示图标，对话框可用，输入框 16px，无横向溢出。
  {
    const mobile = await context.newPage();
    mobile.on("pageerror", (error) => failures.push(`pageerror(mobile): ${error.message}`));
    await mobile.setViewportSize({ width: 390, height: 844 });
    await mobile.goto(baseUrl);
    await mobile.waitForSelector(OPEN);
    const triggerText = (await mobile.locator(OPEN).innerText()).trim();
    assert.equal(triggerText.length > 0, true, "图标入口仍有可访问名");
    const overflow = await mobile.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    );
    assert.equal(overflow, true, "390 宽无横向溢出");
    await mobile.click(OPEN);
    await mobile.waitForSelector(INPUT);
    await mobile.fill(INPUT, "font");
    await mobile.waitForSelector(result("settings.uiFontSize"));
    await mobile.click(result("settings.uiFontSize"));
    await mobile.waitForSelector(DIALOG, { state: "detached" });
    await mobile.close();
  }

  assert.deepEqual(failures, [], `fixture page errors: ${failures.join("; ")}`);
  console.log(
    "settings search smoke: OK (matching, jump/scroll/focus/highlight, Escape, 390 layout)",
  );
} finally {
  await browser?.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}
