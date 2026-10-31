// S11: production PluginsSection + production ProjectService/temp SQLite + scoped loopback config IO.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { build as viteBuild } from "vite";
import { chromium } from "playwright-core";

const root = resolve(import.meta.dirname, "../..");
const temp = await mkdtemp(join(tmpdir(), "s11-config-catalog-"));
// 所有 fixture IO 均在临时目录；不读写真实 HOME，也不下载运行时。
for (const [key, value] of Object.entries({
  HOME: join(temp, "home"),
  XDG_CONFIG_HOME: join(temp, "config"),
  XDG_DATA_HOME: join(temp, "data"),
})) {
  await mkdir(value, { recursive: true });
  process.env[key] = value;
}
const { createConfigDirectoryHost, sourceA, sourceB, sourceOffline, sourceLegacy } =
  await import("./fixtures/config-directory-host.ts");
const host = await createConfigDirectoryHost(temp);
const source = String.raw`
import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { ZCodeIntlProvider } from "./packages/ui/src/i18n/IntlProvider.js";
import { PlatformProvider } from "./packages/ui/src/hooks/usePlatform.js";
import { ServiceProvider } from "./packages/ui/src/hooks/useServices.js";
import { TabStoreProvider, useTabStoreApi } from "./packages/ui/src/store/TabStoreProvider.js";
import { PluginsSection } from "./packages/ui/src/settings/PluginsSection.js";
import { TooltipProvider } from "./packages/ui/src/components/ui/tooltip.js";
import { StoreProvider } from "./packages/ui/src/store/StoreProvider.js";
import { registerSourceSettingsServices } from "./packages/ui/src/store/sourceSettingsServiceStore.js";
import { usePluginManagementStore } from "./packages/ui/src/store/pluginManagementStore.js";
const listeners = new Set();
window.__admissions = [];
window.__attachmentResolved = [];
window.__prefills = [];
window.__rpc = [];
const event = (listener) => { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; };
const rpc = async (scope, method, params) => {
  const call = {scope, method, params, settled: false};
  window.__rpc.push(call);
  try {
    const response = await fetch('/rpc', { method: 'POST', body: JSON.stringify({scope, method, params}) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    return result;
  } finally { call.settled = true; }
};
const scoped = (scope) => ({ pluginManagementService: new Proxy({}, { get: (_, method) => (params) => rpc(scope, method, params) }) });
const services = { ...scoped('local'), projectService: { readProjects: (params) => rpc(new URLSearchParams(location.search).has('empty') ? 'empty-local' : 'local', 'readProjects', params) },
  sourceServerManagementService: { getSnapshot: () => fetch('/snapshot').then((r) => r.json()), onDidChangeState: event, onDidChangeDirectory: event } };
window.__refresh = () => { for (const listener of listeners) listener(); };
window.__pluginState = () => usePluginManagementStore.getState();
// C1：catalog 实际发出的 readProjects hostId（只允许 canonical remote host identity）。
window.__projectHostIds = () => [...new Set(window.__rpc.filter((c) => c.method === 'readProjects').map((c) => c.params.hostId).filter(Boolean))].sort();
const platform = { kind: 'desktop', isDesktop: true, openExternal: async () => {},
  requestSourceSettingsAttachment: new URLSearchParams(location.search).has('missing') ? undefined : async (sourceServerId) => {
    window.__admissions.push(sourceServerId);
    if (new URLSearchParams(location.search).has('late-attachment') && sourceServerId === '11111111-1111-4111-8111-111111111111') await new Promise((resolve) => { window.__releaseAttachmentA = resolve; });
    const attachmentId = 'settings-' + sourceServerId;
    registerSourceSettingsServices({sourceServerId, attachmentId, services: scoped(sourceServerId), dispose: () => {}});
    window.__attachmentResolved.push(sourceServerId);
    return { attachmentId };
  } };
function Fixture() {
  const store = useTabStoreApi();
  useEffect(() => { window.__tabs = store; }, [store]);
  return <PluginsSection isDesktop onCreateTask={(request) => window.__prefills.push(request)} onOpenPluginStore={() => { throw new Error('unexpected marketplace'); }} />;
}
function HostFixture() {
  const [currentServices, setCurrentServices] = useState(services);
  window.__replaceManagement = (snapshot) => setCurrentServices({ ...services, sourceServerManagementService: { ...services.sourceServerManagementService, getSnapshot: async () => snapshot } });
  return <ServiceProvider services={currentServices}><TabStoreProvider><StoreProvider broadcastService={{send: () => {}, onMessage: () => ({dispose: () => {}})}}><TooltipProvider><Fixture /></TooltipProvider></StoreProvider></TabStoreProvider></ServiceProvider>;
}
createRoot(document.getElementById('root')).render(<ZCodeIntlProvider initialLocale="en-US"><PlatformProvider platform={platform}><HostFixture /></PlatformProvider></ZCodeIntlProvider>);
`;
let browser;
let server;
try {
  const fixtureId = "virtual:s11-config-directory.jsx";
  const result = await viteBuild({
    configFile: false,
    root,
    logLevel: "silent",
    build: {
      write: false,
      minify: false,
      cssCodeSplit: false,
      rollupOptions: {
        input: fixtureId,
        output: { format: "esm", entryFileNames: "fixture.js", codeSplitting: false },
      },
    },
    resolve: { alias: { "@": resolve(root, "packages/ui/src") } },
    esbuild: { jsx: "automatic", loader: "jsx" },
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [
      {
        name: "s11-fixture",
        resolveId: (id) => (id === fixtureId ? `\0${fixtureId}` : null),
        load: (id) => (id === `\0${fixtureId}` ? source : null),
      },
    ],
  });
  const script = (Array.isArray(result) ? result : [result])
    .flatMap((item) => item.output ?? [])
    .find((item) => item.type === "chunk" && item.isEntry)?.code;
  assert.ok(script);
  server = createServer(async (request, response) => {
    try {
      if (request.url === "/fixture.js") {
        response.setHeader("Content-Type", "text/javascript");
        response.end(script);
        return;
      }
      if (request.url === "/snapshot") {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(host.snapshot()));
        return;
      }
      if (request.url === "/rpc") {
        let body = "";
        for await (const chunk of request) body += chunk;
        const { scope, method, params } = JSON.parse(body);
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(await host.call(scope, method, params)));
        return;
      }
      response.setHeader("Content-Type", "text/html");
      response.end(
        '<!doctype html><div id="root"></div><script type="module" src="/fixture.js"></script>',
      );
    } catch (error) {
      response.statusCode = 500;
      response.end(JSON.stringify({ error: error.message }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const executablePath = process.env.ZCODE_TEST_CHROMIUM_EXECUTABLE;
  // Playwright 已安装的 Chromium 位于原 HOME（fixture HOME 切换前显式查找）。
  browser = await chromium.launch({
    headless: true,
    executablePath: executablePath || chromium.executablePath(),
  });
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
    console.error("fixture pageerror:", error);
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  await page.goto(url);
  const trigger = page.getByTestId("plugin-settings-scope-trigger");
  async function options() {
    await trigger.click();
    return page.getByRole("menuitemradio");
  }
  async function choose(key) {
    await options();
    const option = page.locator('[role="menuitemradio"]').filter({ hasText: key });
    await option.click();
  }
  async function chooseIdentity(identity) {
    await options();
    await page.locator('[role="menuitemradio"]').evaluateAll((items, key) => {
      const item = items.find((node) => node.getAttribute("data-testid")?.endsWith(key));
      if (!item) throw new Error("missing directory " + key);
      item.click();
    }, identity);
  }
  async function loaded(scope) {
    await page.waitForFunction((expected) => {
      const state = window.__pluginState();
      return !state.loading && state.plugins.some((plugin) => plugin.name === "Plugin " + expected);
    }, scope);
    await page.getByTestId("plugin-settings-enabled-switch").waitFor();
  }
  // setEnabled 是乐观更新：UI 状态变化不证明 Host 已记录变更。
  // 断言 Host 侧 config 前必须等对应 scope 的 RPC 真正 settled，否则 CI 时序下会读到 undefined。
  async function mutationSettled(scope, before) {
    await page.waitForFunction(
      ({ scope, before }) =>
        window.__rpc.filter(
          (call) => call.scope === scope && call.method === "setPluginEnabled" && call.settled,
        ).length > before,
      { scope, before },
    );
  }
  const settledMutations = (scope) =>
    page.evaluate(
      (id) =>
        window.__rpc.filter(
          (call) => call.scope === id && call.method === "setPluginEnabled" && call.settled,
        ).length,
      scope,
    );
  const identity = (id) => `remote:server:${id}:${host.paths.samePath}`;
  // 未打开项目全部 roots 可见；catalog 本身不 admission 远端，不创建 tab/task/default dir。
  await options();
  await page.getByRole("menuitemradio").filter({ hasText: host.paths.localRoot }).waitFor();
  assert.equal(
    await page.getByRole("menuitemradio").filter({ hasText: host.paths.extraRoot }).count(),
    1,
  );
  const offline = page.getByRole("menuitemradio").filter({ hasText: sourceOffline });
  assert.equal(await offline.getAttribute("aria-disabled"), "true");
  const legacy = page.getByRole("menuitemradio").filter({ hasText: sourceLegacy });
  await legacy.filter({ hasText: "Legacy directory" }).waitFor();
  assert.equal(await legacy.getAttribute("aria-disabled"), "true");
  assert.equal(
    await page.getByRole("menuitemradio").filter({ hasText: host.paths.samePath }).count(),
    4,
    "remote readProjects may report local on its own Host, but must not create a local target",
  );
  await page.keyboard.press("Escape");
  assert.deepEqual(await page.evaluate(() => window.__admissions), []);
  assert.equal(
    await page.evaluate(() => window.__rpc.some((call) => call.method !== "readProjects")),
    false,
    "catalog enumeration must not start plugin/config runtime reads",
  );
  assert.equal(await page.evaluate(() => window.__tabs.getState().tabs.length), 0);
  // C1：真实 Host 路由合同只能消费 canonical hostId，旧 server:<id> 必须失败。
  assert.deepEqual(
    await page.evaluate(() => window.__projectHostIds()),
    [sourceA, sourceB, sourceLegacy].map(host.hostId).sort(),
  );
  await host.verifyHostRouting();
  await choose(host.paths.localRoot);
  await loaded("local");
  let mutations = await settledMutations("local");
  await page.getByTestId("plugin-settings-enabled-switch").click();
  await page.waitForFunction(() => !window.__pluginState().plugins[0].enabled);
  await mutationSettled("local", mutations);
  assert.equal((await host.config("local"))[host.paths.localRoot], false);
  assert.equal((await host.facts()).tasks, 0);
  assert.equal((await host.facts()).files.includes("must-not-create"), false);
  assert.equal(await page.evaluate(() => window.__tabs.getState().tabs.length), 0);
  // 同 path 不同 Source 独立 services 与 identity；只有明确选择才申请 Source settings DI。
  await chooseIdentity(identity(sourceA));
  await loaded(sourceA);
  mutations = await settledMutations(sourceA);
  await page.getByTestId("plugin-settings-enabled-switch").click();
  await page.waitForFunction(() => !window.__pluginState().plugins[0].enabled);
  await mutationSettled(sourceA, mutations);
  assert.equal((await host.config(sourceA))[identity(sourceA)], false);
  assert.deepEqual(await host.config(sourceB), {});
  await chooseIdentity(identity(sourceB));
  await loaded(sourceB);
  assert.equal(
    await page.getByTestId("plugin-settings-enabled-switch").getAttribute("aria-checked"),
    "true",
  );
  // late A plugin 读取不能覆盖已经选中的 B，也不能把 B 的 mutation 写给 A。
  host.hold(`plugin:${sourceA}`);
  const aReadsBefore = await page.evaluate(
    (id) =>
      window.__rpc.filter((call) => call.scope === id && call.method === "listPlugins").length,
    sourceA,
  );
  await chooseIdentity(identity(sourceA));
  await page.waitForFunction(
    ({ id, count }) =>
      window.__rpc.filter((call) => call.scope === id && call.method === "listPlugins").length >
      count,
    { id: sourceA, count: aReadsBefore },
  );
  await chooseIdentity(identity(sourceB));
  await loaded(sourceB);
  host.release(`plugin:${sourceA}`);
  await page.waitForFunction(
    (id) => window.__rpc.filter((call) => call.scope === id).every((call) => call.settled),
    sourceA,
  );
  assert.equal(
    await page.evaluate(() => window.__pluginState().workspaceIdentity),
    identity(sourceB),
  );
  assert.equal(
    await page
      .getByTestId("plugin-settings-plugin-row")
      .filter({ hasText: `Plugin ${sourceA}` })
      .count(),
    0,
  );
  mutations = await settledMutations(sourceB);
  await page.getByTestId("plugin-settings-enabled-switch").click();
  await page.waitForFunction(() => !window.__pluginState().plugins[0].enabled);
  await mutationSettled(sourceB, mutations);
  assert.equal((await host.config(sourceB))[identity(sourceB)], false);
  // 失败不伪装成功；既有乐观开关回滚。
  host.failMutation(true);
  await page.getByTestId("plugin-settings-enabled-switch").click();
  await page.waitForFunction(() => window.__pluginState().error?.includes("rejected"));
  assert.equal(
    await page.getByTestId("plugin-settings-enabled-switch").getAttribute("aria-checked"),
    "false",
  );
  host.failMutation(false);
  // Source 换代使 A 离线：选择保留、面板只读、无 mutation/admission 回退本地。
  await chooseIdentity(identity(sourceA));
  await loaded(sourceA);
  host.hold("catalog");
  const catalogReadsBefore = await page.evaluate(
    () => window.__rpc.filter((call) => call.method === "readProjects").length,
  );
  await page.evaluate(() => window.__refresh());
  await page.waitForFunction(
    (count) => window.__rpc.filter((call) => call.method === "readProjects").length > count,
    catalogReadsBefore,
  );
  host.setOnlineA(false);
  await page.evaluate(() => window.__refresh());
  host.release("catalog");
  await page.waitForFunction(() =>
    window.__rpc.filter((call) => call.method === "readProjects").every((call) => call.settled),
  );
  await page
    .getByTestId("plugin-settings-directory-readonly")
    .filter({ hasText: "Source offline" })
    .waitFor();
  assert.equal(await trigger.getAttribute("data-plugin-scope-key"), identity(sourceA));
  assert.equal(await page.getByTestId("plugin-settings-enabled-switch").count(), 0);
  const mutationCount = host.calls.filter((call) => call.method === "setPluginEnabled").length;
  await options();
  const offlineOption = page.getByRole("menuitemradio").filter({ hasText: sourceA });
  assert.equal(await offlineOption.getAttribute("aria-disabled"), "true");
  await page.keyboard.press("Escape");
  assert.equal(
    host.calls.filter((call) => call.method === "setPluginEnabled").length,
    mutationCount,
  );
  // 重连换代：旧 Source settings proxy 已失效，必须重新 admission 才能再次可写。
  const admissionsBeforeReconnect = (await page.evaluate(() => window.__admissions)).length;
  host.setOnlineA(true);
  await page.evaluate(() => window.__refresh());
  await page.getByTestId("plugin-settings-enabled-switch").waitFor({ state: "visible" });
  assert.equal(
    (await page.evaluate(() => window.__admissions)).length,
    admissionsBeforeReconnect + 1,
  );
  // 示例继续委托真实 Composer prefill owner，带目录身份；无 autoSend/install 或隐式建 tab/task。
  await chooseIdentity(identity(sourceB));
  await loaded(sourceB);
  await page.getByTestId("plugin-settings-plugin-row").locator("button").first().click();
  await page.getByTestId("plugin-store-example-prompt").click();
  const prefills = await page.evaluate(() => window.__prefills);
  assert.equal(prefills.length, 1);
  assert.deepEqual(prefills[0].targetWorkspace, {
    workspacePath: host.paths.samePath,
    workspaceIdentity: identity(sourceB),
  });
  assert.ok(prefills[0].initialPrompt.includes("Fixture example prompt"));
  assert.equal(prefills[0].autoSend, undefined);
  assert.equal(
    host.calls.some((call) => /install|createSession|prepareSession/.test(call.method)),
    false,
  );
  assert.equal(await page.evaluate(() => window.__tabs.getState().tabs.length), 0);
  const detailOffline = host.snapshot();
  detailOffline.generation++;
  detailOffline.states = detailOffline.states.map((state) =>
    state.sourceServerId === sourceB ? { ...state, state: "offline" } : state,
  );
  await page.evaluate((snapshot) => window.__replaceManagement(snapshot), detailOffline);
  await page
    .getByTestId("plugin-settings-directory-readonly")
    .filter({ hasText: "Source offline" })
    .waitFor();
  await trigger.waitFor({ state: "visible" });
  assert.equal(await trigger.getAttribute("data-plugin-scope-key"), identity(sourceB));
  assert.equal(await page.getByTestId("plugin-store-detail").count(), 0);
  // A attachment admission 晚到也只能登记 A，不得把已经选中的 B 改回 A。
  host.setOnlineA(true);
  await page.goto(`${url}/?late-attachment=1`);
  await chooseIdentity(identity(sourceA));
  await page.waitForFunction(() => Boolean(window.__releaseAttachmentA));
  await chooseIdentity(identity(sourceB));
  await loaded(sourceB);
  await page.evaluate(() => window.__releaseAttachmentA());
  await page.waitForFunction((id) => window.__attachmentResolved.includes(id), sourceA);
  assert.equal(
    await page.evaluate(() => window.__pluginState().workspaceIdentity),
    identity(sourceB),
  );
  assert.equal(
    await page
      .getByTestId("plugin-settings-plugin-row")
      .filter({ hasText: `Plugin ${sourceA}` })
      .count(),
    0,
  );
  // 没有本机目录时默认 User 也不得为了枚举自动申请远端 attachment。
  await page.goto(`${url}/?empty=1`);
  await options();
  await page.getByRole("menuitemradio").filter({ hasText: sourceB }).waitFor();
  await page.keyboard.press("Escape");
  assert.deepEqual(await page.evaluate(() => window.__admissions), []);
  assert.equal(
    await page.evaluate(() => window.__rpc.some((call) => call.method === "listPlugins")),
    false,
  );
  await chooseIdentity(identity(sourceB));
  await loaded(sourceB);
  assert.deepEqual(await page.evaluate(() => window.__admissions), [sourceB]);
  // 缺平台 Source settings 能力，明确不可操作，不回落本机 plugin service。
  await page.goto(`${url}/?missing=1`);
  await chooseIdentity(identity(sourceB));
  await page.getByTestId("plugin-settings-directory-readonly").waitFor();
  assert.equal(await page.getByTestId("plugin-settings-enabled-switch").count(), 0);
  assert.deepEqual(await page.evaluate(() => window.__admissions), []);
  // 更换 Source snapshot owner 后 generation 可以从 0 开始，旧 owner 在线态不能残留。
  const replacement = host.snapshot();
  replacement.generation = 0;
  replacement.states = replacement.states.map((state) => ({ ...state, state: "offline" }));
  await page.evaluate((snapshot) => window.__replaceManagement(snapshot), replacement);
  await page
    .getByTestId("plugin-settings-directory-readonly")
    .filter({ hasText: "Source offline" })
    .waitFor();
  assert.equal(await trigger.getAttribute("data-plugin-scope-key"), identity(sourceB));
  assert.equal((await host.facts()).tasks, 0);
  assert.equal(await page.evaluate(() => window.__tabs.getState().tabs.length), 0);
  assert.deepEqual(errors, []);
  console.log(
    "S11 catalog E2E: unopened roots/config, Source isolation, offline, late A, mutation failure, missing DI; tabs=0 tasks=0: OK",
  );
} finally {
  host.close();
  await browser?.close();
  if (server) await new Promise((done) => server.close(done));
  // 临时产物保留供失败定位；不会写仓库、HOME 或业务目录。
}
