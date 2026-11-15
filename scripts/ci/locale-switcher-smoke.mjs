// 语言选择器 + 设置 Scope 菜单的真实浏览器 E2E（临时回环服务，不读用户 HOME/XDG、不连真实远端）。
// 覆盖：ja-JP / ko-KR / ru-RU 真实切换 → localStorage + settingService 持久化 → 刷新后恢复；
// Scope 菜单按设备分组（离线设备整组不出现）、离线设备只出阻断提示；390px 紧凑 Web 无横向溢出。
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
import { LocaleSelectorRow } from "./packages/ui/src/settings/LocaleSelectorRow.js";
import { SettingsScopePicker } from "./packages/ui/src/settings-scope/ui/SettingsScopePicker.js";
import { SettingsScopeBlockedNotice } from "./packages/ui/src/settings-scope/ui/SettingsScopeBlockedNotice.js";
import { useZCodeIntl } from "./packages/ui/src/i18n/IntlProvider.js";

// 真实 selector / picker / provider 与真实持久化路径；只替代 window.zcode 与 Host services。
const updates = [];
const services = {
  settingService: {
    get: async () => ({}),
    update: async (patch) => {
      updates.push(patch);
    },
  },
  // 真实 provider 会调用 send(...).finally(...)：桩必须返回 Promise，否则持久化步骤被跳过。
  broadcastService: { send: async () => {}, onMessage: () => () => {} },
};
window.__localeUpdates = updates;
const platform = {
  kind: "web",
  isDesktop: false,
  syncAppSettings: () => {},
  onSettingsChanged: () => () => {},
  openExternal: async () => {},
  getDefaultHomeDir: async () => "/home/fixture",
  selectDirectory: async () => null,
};

const scopeGroups = [
  {
    device: { kind: "local" },
    options: [
      { key: "user", kind: "user" },
      {
        key: "/work/alpha",
        kind: "workspace",
        target: { workspacePath: "/work/alpha", label: "Alpha" },
      },
    ],
  },
  {
    device: { kind: "remote", id: "source-a", sourceServerId: "source-a", name: "Source A" },
    options: [
      { key: "source-user:source-a", kind: "user" },
      {
        key: "remote:server:source-a:/srv/project",
        kind: "workspace",
        target: {
          workspacePath: "/srv/project",
          label: "Project",
          workspaceIdentity: "remote:server:source-a:/srv/project",
        },
      },
    ],
  },
];

function Fixture() {
  // 语言与 Scope 都走产品代码的唯一入口：provider 的 setLocalePreference（localStorage +
  // settingService + 广播）与 settings-scope 的选中 key。
  const { localePreference, setLocalePreference } = useZCodeIntl();
  const [selectedScopeKey, setSelectedScopeKey] = useState("remote:server:source-a:/srv/project");
  const [blocked, setBlocked] = useState(false);
  return (
    <div className="space-y-4 p-4" data-testid="fixture-shell">
      <LocaleSelectorRow
        localePreference={localePreference}
        onLocalePreferenceChange={setLocalePreference}
      />
      <div data-testid="scope-row" className="flex flex-wrap items-center gap-2">
        <SettingsScopePicker
          scope={{
            groups: scopeGroups,
            selectedScopeKey,
            setSelectedScopeKey,
            resolution: {
              status: "ready",
              kind: "workspace",
              key: selectedScopeKey,
              device: scopeGroups[1].device,
              target: scopeGroups[1].options[1].target,
            },
          }}
          triggerTestId="fixture-scope-trigger"
          userOptionTestId="fixture-scope-user-option"
          workspaceOptionTestIdPrefix="fixture-scope-option"
        />
        <button type="button" data-testid="toggle-blocked" onClick={() => setBlocked((value) => !value)}>
          toggle
        </button>
      </div>
      {blocked ? <SettingsScopeBlockedNotice state="offline" device={scopeGroups[1].device} /> : null}
    </div>
  );
}

createRoot(document.getElementById("root")).render(
  <PlatformProvider value={platform}>
    <ServiceProvider services={services}>
      <ZCodeIntlProvider
        settingService={services.settingService}
        broadcastService={services.broadcastService}
        initialLocale="en-US"
      >
        <Fixture />
      </ZCodeIntlProvider>
    </ServiceProvider>
  </PlatformProvider>,
);
`;
const FIXTURE_ID = "virtual:locale-switcher.jsx";
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
      name: "locale-switcher-fixture",
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

// UI 包不含 Tailwind 产物：只注入断言需要的最小样式。
const STYLE = `
html, body { margin: 0; font-family: sans-serif; }
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

const TRIGGER = '[data-testid="settings-locale-select-trigger"]';
const OPTION = '[role="option"][data-testid^="settings-locale-select-item-"]';
const SCOPE_TRIGGER = '[data-testid="fixture-scope-trigger"]';

let browser;
const failures = [];
try {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.ZCODE_TEST_CHROMIUM_EXECUTABLE || undefined,
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));
  await page.goto(baseUrl);
  await page.waitForSelector(TRIGGER);

  async function chooseLocale(locale, expectedLabel) {
    await page.click(TRIGGER);
    await page.waitForSelector(OPTION);
    await page.locator(`${OPTION}[data-testid$="${locale}"]`).click();
    await page.waitForFunction(
      ({ locale, label }) => {
        const stored = window.localStorage.getItem("zcode-locale-preference");
        const update = (window.__localeUpdates ?? []).at(-1);
        const row = document.querySelector('[data-settings-search-id="settings.locale"]');
        const trigger = document.querySelector('[data-testid="settings-locale-select-trigger"]');
        return (
          stored === locale &&
          update?.locale === locale &&
          update?.localePreference === locale &&
          Boolean(row?.textContent?.includes(label)) &&
          Boolean(trigger?.textContent?.includes(label))
        );
      },
      { locale, label: expectedLabel },
      { timeout: 10_000 },
    );
  }

  // 1) 日语：真实切换 → localStorage + settingService.update → 行标签换成日语。
  await chooseLocale("ja-JP", "日本語");
  // 2) 韩语、俄语：同一入口连续切换，每次都落盘（不被上一次的 RPC 串行阻塞）。
  await chooseLocale("ko-KR", "한국어");
  await chooseLocale("ru-RU", "Русский");

  // 3) 刷新后仍用已持久化的偏好（localStorage 唯一恢复路径）。
  await page.reload();
  await page.waitForSelector(TRIGGER);
  assert.equal(
    await page.locator(TRIGGER).innerText(),
    "Русский",
    "刷新后应从 localStorage 恢复 ru-RU",
  );
  assert.equal(await page.evaluate(() => window.__localeUpdates.length), 0, "刷新后不应重复写盘");

  // 4) Scope 菜单：按设备分组，设备名可见；离线设备不会出现在这里。
  await page.click(SCOPE_TRIGGER);
  await page.waitForSelector('[data-scope-device="local"]');
  // 设备名来自管理快照（不翻译）；本机组标题随界面语言本地化。
  assert.ok((await page.locator('[data-scope-device="local"]').innerText()).trim().length > 0);
  assert.equal(await page.locator('[data-scope-device="source-a"]').innerText(), "Source A");
  const optionCount = await page.locator('[role="menuitemradio"]').count();
  assert.equal(optionCount, 4, "本机与在线设备各列「用户」+ 项目");
  await page.keyboard.press("Escape");

  // 5) 离线设备/离线目标只出阻断提示（fail-closed）。
  await page.click('[data-testid="toggle-blocked"]');
  await page.waitForSelector(
    '[data-testid="settings-scope-blocked"][data-scope-blocked="offline"]',
  );
  assert.match(
    await page.locator('[data-testid="settings-scope-blocked"]').innerText(),
    /Source A/,
  );

  // 6) 390×844 手机 Web：无横向溢出，两个控件仍可用。
  const mobile = await context.newPage();
  mobile.on("pageerror", (error) => failures.push(`pageerror(mobile): ${error.message}`));
  await mobile.setViewportSize({ width: 390, height: 844 });
  await mobile.goto(baseUrl);
  await mobile.waitForSelector(TRIGGER);
  assert.equal(
    await mobile.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    true,
    "390 宽无横向溢出",
  );
  await mobile.click(TRIGGER);
  await mobile.waitForSelector(OPTION);
  await mobile.keyboard.press("Escape");
  await mobile.click(SCOPE_TRIGGER);
  await mobile.waitForSelector('[data-scope-device="source-a"]');
  await mobile.close();

  assert.deepEqual(failures, [], `fixture page errors: ${failures.join("; ")}`);
  console.log(
    "locale switcher smoke: OK (ja/ko/ru selection, localStorage + settingService persistence, device-grouped scope, fail-closed notice, 390 layout)",
  );
} finally {
  await browser?.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}
