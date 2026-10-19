import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { transform } from "esbuild";
import { createServer as createViteServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const root = resolve(import.meta.dirname, "../..");
const providers = ["astrbot", "weixin", "feishu", "lark", "telegram"];
const moduleMocks = {
  "@/logger.js": "logger",
  "@/BotsDialog.js": "bots-dialog",
  "@/hooks/useWebRemoteControl.js": "remote-hook",
  "@/hooks/useZCodeTaskService.js": "task-hook",
  "@/hooks/useSettingService.js": "settings-hook",
};
const viteCacheDir = await mkdtemp(join(tmpdir(), "zcodium-web-remote-control-vite-"));
const vite = await createViteServer({
  configFile: false,
  cacheDir: viteCacheDir,
  root: resolve(import.meta.dirname, "fixtures"),
  appType: "custom",
  plugins: [
    {
      name: "web-remote-control-smoke-ports",
      enforce: "pre",
      resolveId(source) {
        const mapped =
          moduleMocks[source] ??
          Object.entries(moduleMocks).find(([key]) => source.endsWith(key.slice(1)))?.[1];
        return mapped ? `\0fixture:${mapped}.jsx` : null;
      },
      async transform(code, id) {
        if (!id.startsWith("\0fixture:") || !id.endsWith(".jsx")) return null;
        return (await transform(code, { loader: "jsx", jsx: "automatic", format: "esm" })).code;
      },
      load(id) {
        if (!id.startsWith("\0fixture:")) return null;
        const name = id.slice("\0fixture:".length).replace(/\.jsx$/, "");
        const modules = {
          logger: `export const logger={info(){},warn(){},error(){}};`,
          "bots-dialog": `import React from 'react'; import {createPortal} from 'react-dom'; export function BotsDialog({open,entryProvider,onOpenChange,workspacePath,workspaceIdentity}){const host=document.querySelector('[data-slot="dialog-content"]');return open&&host?createPortal(<div data-testid="bots-dialog" data-entry-provider={entryProvider??''} data-workspace={workspacePath+':'+workspaceIdentity} style={{position:'fixed',inset:'auto 20px 20px auto',zIndex:100}}><button onClick={event=>{event.stopPropagation();onOpenChange(false)}}>Close fixture bots</button></div>,host):null}`,
          "task-hook": `export function useZCodeTaskService(){return {listTasks:async()=>[]}}`,
          "settings-hook": `import {useCallback,useState} from 'react'; export function useSettings(){const [settings,setSettings]=useState({webRemoteControlEndpointMode:'lan',webRemoteControlCustomEndpointUrl:''}); const update=useCallback(async patch=>{setSettings(current=>({...current,...patch})); window.fixtureEvents?.push(['settings-update',patch]);},[]); return {settings,update}}`,
          "remote-hook": `import {useEffect,useState} from 'react'; export function useWebRemoteControl(options){window.remoteOptions=options; const [,render]=useState(0); useEffect(()=>{const update=()=>render(value=>value+1);window.addEventListener('fixture-state',update);return()=>window.removeEventListener('fixture-state',update)},[]);const state=window.fixtureRemoteState??{};return {qrDataUrl:state.qrDataUrl===null?null:'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"%3E%3C/svg%3E',qrUrl:state.qrUrl===null?null:'http://127.0.0.1/fixture-link',busy:window.fixtureBusy??false,status:state.status??'running',snapshot:state.failure?{failure:state.failure}:null,async copyLink(){window.fixtureEvents.push(['copy'])},async refreshPairing(){window.fixtureEvents.push(['refresh'])},async stop(){window.fixtureEvents.push(['stop'])}}}`,
        };
        return modules[name];
      },
    },
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: { "@": resolve(root, "packages/ui/src") },
    // fixture 的虚拟模块和 node_modules 依赖必须共用同一份 React，
    // 否则预构建的 Radix 会拿到另一实例并触发 invalid hook call。
    dedupe: ["react", "react-dom"],
  },
  server: { middlewareMode: true, hmr: false, watch: { ignored: ["**"] } },
  // 虚拟 mock 模块内的依赖不会被预扫描到。全部显式声明，避免运行期二次优化后的整页
  // reload 让预构建 chunk 与原始模块混用两份 React。
  optimizeDeps: {
    include: [
      "react",
      "react-dom",
      "react-dom/client",
      "react/jsx-runtime",
      "react/jsx-dev-runtime",
      "class-variance-authority",
      "clsx",
      "lucide-react",
      "radix-ui",
      "tailwind-merge",
      "zod",
    ],
  },
});
const server = createServer((request, response) => {
  vite.middlewares(request, response, () => {
    response.statusCode = 404;
    response.end("not found");
  });
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;
const localeKeys = {
  "en-US": {
    title: "webRemoteControl.title",
    qr: "webRemoteControl.mobileQr.title",
    bot: "webRemoteControl.botChannel.title",
    copy: "webRemoteControl.copyLink",
    refresh: "webRemoteControl.refreshQr",
    stop: "webRemoteControl.stop",
    cancel: "common.cancel",
    confirmTitle: "webRemoteControl.refreshQr.confirmTitle",
    confirmDescription: "webRemoteControl.refreshQr.confirmDescription",
    manage: "webRemoteControl.botChannel.manageBots",
    close: "common.close",
  },
  "zh-CN": {
    title: "webRemoteControl.title",
    qr: "webRemoteControl.mobileQr.title",
    bot: "webRemoteControl.botChannel.title",
    copy: "webRemoteControl.copyLink",
    refresh: "webRemoteControl.refreshQr",
    stop: "webRemoteControl.stop",
    cancel: "common.cancel",
    confirmTitle: "webRemoteControl.refreshQr.confirmTitle",
    confirmDescription: "webRemoteControl.refreshQr.confirmDescription",
    manage: "webRemoteControl.botChannel.manageBots",
    close: "common.close",
  },
};
let browser;
try {
  browser = await chromium.launch({
    channel: "chromium",
    headless: true,
    executablePath: process.env.ZCODE_TEST_CHROMIUM_EXECUTABLE || undefined,
  });
  const page = await browser.newPage({ viewport: { width: 1200, height: 980 } });
  const errors = [];
  page.on("pageerror", (error) => {
    if (!error.message.includes("WebSocket")) errors.push(error.message);
  });
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("WebSocket"))
      errors.push(message.text());
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!["data:", "blob:"].includes(url.protocol) && url.hostname !== "127.0.0.1")
      errors.push(`blocked unexpected network request: ${request.url()}`);
  });
  page.on("requestfailed", (request) =>
    errors.push(`${request.url()} ${request.failure()?.errorText}`),
  );
  page.on("response", (response) => {
    if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
  });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (["data:", "blob:"].includes(url.protocol) || url.hostname === "127.0.0.1")
      return route.continue();
    return route.abort("blockedbyclient");
  });
  await page.route(`${origin}/__fixture`, async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/web-remote-control-dialog-smoke.jsx"></script>',
    });
  });
  await page.addInitScript(() => {
    window.fixtureTheme = "zai-light";
    window.fixtureBusy = false;
    window.fixtureRemoteState = {};
  });
  await page.goto(`${origin}/__fixture`);
  await page.waitForFunction(() => typeof window.setFixtureLocale === "function");
  const dictionaries = await page.evaluate(() => window.fixtureDictionaries);
  const message = (locale, id) => dictionaries[locale][id];
  let lightColors;
  const geometryFailures = [];

  for (const theme of ["zai-light", "zai-dark"]) {
    for (const locale of ["en-US", "zh-CN"]) {
      for (const width of [1200, 768, 390, 320]) {
        await page.setViewportSize({ width, height: 980 });
        await page.evaluate(
          ({ theme, locale }) => {
            document.documentElement.className = `theme-${theme}`;
            window.fixtureTheme = theme;
            window.setFixtureLocale(locale);
          },
          { theme, locale },
        );
        await page
          .getByRole("heading", { name: message(locale, localeKeys[locale].title) })
          .waitFor();
        const dialog = page.getByRole("dialog").first();
        await dialog.evaluate(async (element) => {
          await Promise.all(
            element.getAnimations().map((animation) => animation.finished.catch(() => undefined)),
          );
        });
        const qrRegion = page.getByRole("region", { name: message(locale, localeKeys[locale].qr) });
        const botRegion = page.getByRole("region", {
          name: message(locale, localeKeys[locale].bot),
        });
        const dialogBox = await dialog.boundingBox();
        const qrBox = await qrRegion.boundingBox();
        const botBox = await botRegion.boundingBox();
        assert.ok(dialogBox && qrBox && botBox, "actual Dialog and named regions render");
        if (dialogBox.x < 15 || dialogBox.x + dialogBox.width > width - 15)
          geometryFailures.push(
            `${theme}/${locale}/${width}px dialog bounds: ${JSON.stringify(dialogBox)}`,
          );
        const overflow = await dialog.evaluate((element) => ({
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
        }));
        if (overflow.scrollWidth > overflow.clientWidth)
          geometryFailures.push(
            `${theme}/${locale}/${width}px dialog has internal overflow: ${JSON.stringify(overflow)}`,
          );
        if (qrBox.x < dialogBox.x || qrBox.x + qrBox.width > dialogBox.x + dialogBox.width)
          geometryFailures.push(
            `${theme}/${locale}/${width}px QR region escapes dialog: ${JSON.stringify(qrBox)}`,
          );
        if (botBox.x < dialogBox.x || botBox.x + botBox.width > dialogBox.x + dialogBox.width)
          geometryFailures.push(
            `${theme}/${locale}/${width}px Bot region escapes dialog: ${JSON.stringify(botBox)}`,
          );
        if (width >= 768 && qrBox.x + qrBox.width > botBox.x)
          geometryFailures.push(`${theme}/${locale}/${width}px QR region overlaps Bot region`);
        if (width < 768 && qrBox.y + qrBox.height > botBox.y)
          geometryFailures.push(
            `${theme}/${locale}/${width}px QR region overlaps Bot region vertically`,
          );
        const image = page.locator("img[alt]").first();
        const imageBox = await image.boundingBox();
        assert.ok(
          imageBox && Math.abs(imageBox.width - imageBox.height) <= 1,
          "QR image remains square",
        );
        assert.ok(
          await qrRegion
            .getByRole("button", { name: message(locale, localeKeys[locale].refresh) })
            .isVisible(),
        );
        const colors = await dialog.evaluate((element) => ({
          background: getComputedStyle(element).backgroundColor,
          foreground: getComputedStyle(element).color,
        }));
        if (theme === "zai-light" && width === 1200) lightColors = colors;
        if (theme === "zai-dark" && width === 1200) {
          assert.notDeepEqual(
            colors,
            lightColors,
            "actual dialog computed colors differ by Zai theme",
          );
        }
        if (theme === "zai-dark" && locale === "en-US" && width === 1200) {
          const evidence = resolve(root, "node_modules/.cache/web-remote-control-dialog-wide.png");
          await mkdir(resolve(root, "node_modules/.cache"), { recursive: true });
          await page.screenshot({ path: evidence });
          console.log(`Screenshot evidence: ${evidence}`);
        }
        if (theme === "zai-dark" && locale === "en-US" && width === 390) {
          const evidence = resolve(
            root,
            "node_modules/.cache/web-remote-control-dialog-narrow.png",
          );
          await page.screenshot({ path: evidence });
          console.log(`Screenshot evidence: ${evidence}`);
        }
      }
    }
  }

  const en = "en-US";
  await page.evaluate(() => window.setFixtureLocale("en-US"));
  const enQrRegion = page.getByRole("region", { name: message(en, localeKeys[en].qr) });
  await page.evaluate(() => window.setFixtureBusy(true));
  for (const id of [localeKeys[en].copy, localeKeys[en].refresh, localeKeys[en].stop])
    assert.equal(
      await enQrRegion.getByRole("button", { name: message(en, id) }).isDisabled(),
      true,
    );
  await page.evaluate(() => window.setFixtureBusy(false));
  await page.evaluate(() => window.setFixtureState({ qrUrl: null }));
  assert.equal(
    await enQrRegion.getByRole("button", { name: message(en, localeKeys[en].copy) }).isDisabled(),
    true,
  );
  await page.evaluate(() => window.setFixtureState({ status: "idle" }));
  assert.equal(
    await enQrRegion.getByRole("button", { name: message(en, localeKeys[en].stop) }).isDisabled(),
    true,
  );
  await page.evaluate(() => window.setFixtureState({ failure: { reason: "sessionExpired" } }));
  assert.ok(
    await page
      .getByText(message(en, "webRemoteControl.failure.sessionExpired"), { exact: false })
      .isVisible(),
  );
  await page.evaluate(() => window.setFixtureState({}));

  await enQrRegion.getByRole("button", { name: message(en, localeKeys[en].copy) }).click();
  await enQrRegion.getByRole("button", { name: message(en, localeKeys[en].refresh) }).click();
  const alert = page.getByRole("alertdialog");
  await alert.getByRole("heading", { name: message(en, localeKeys[en].confirmTitle) }).waitFor();
  assert.ok(await alert.getByText(message(en, localeKeys[en].confirmDescription)).isVisible());
  await alert.getByRole("button", { name: message(en, localeKeys[en].cancel) }).click();
  await alert.waitFor({ state: "detached" });
  assert.equal(
    await page.evaluate(() => window.fixtureEvents.filter(([name]) => name === "refresh").length),
    0,
  );
  await enQrRegion.getByRole("button", { name: message(en, localeKeys[en].refresh) }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: message(en, localeKeys[en].refresh) })
    .click();
  await page.getByRole("alertdialog").waitFor({ state: "detached" });
  assert.equal(
    await page.evaluate(() => window.fixtureEvents.filter(([name]) => name === "refresh").length),
    1,
  );
  await enQrRegion.getByRole("button", { name: message(en, localeKeys[en].stop) }).click();

  await page
    .getByRole("region", { name: message(en, localeKeys[en].qr) })
    .getByRole("button", { name: message(en, "webRemoteControl.endpoint.modeCustom") })
    .click();
  assert.ok(
    await page.evaluate(() =>
      window.fixtureEvents.some(
        ([name, update]) =>
          name === "settings-update" && update.webRemoteControlEndpointMode === "custom",
      ),
    ),
    "endpoint mode change is saved through the mocked settings port",
  );
  const endpoint = page.getByRole("textbox", {
    name: message(en, "webRemoteControl.endpoint.urlLabel"),
  });
  await endpoint.fill("wss://local.example/ws");
  await page.getByRole("button", { name: message(en, "webRemoteControl.endpoint.save") }).click();
  await page.getByText(message(en, "webRemoteControl.endpoint.saved")).waitFor();
  assert.ok(
    await page.evaluate(() =>
      window.fixtureEvents.some(
        ([name, update]) =>
          name === "settings-update" &&
          update.webRemoteControlCustomEndpointUrl === "wss://local.example/ws",
      ),
    ),
  );

  for (const provider of providers) {
    const label = message(en, `webRemoteControl.botChannel.${provider}.title`);
    await page.getByRole("button", { name: new RegExp(label, "i") }).click();
    const botsDialog = page.getByTestId("bots-dialog");
    assert.equal(await botsDialog.getAttribute("data-entry-provider"), provider);
    assert.equal(
      await botsDialog.getAttribute("data-workspace"),
      "/fixture/workspace:fixture-identity",
    );
    await botsDialog.getByRole("button", { name: "Close fixture bots" }).click();
  }
  await page.getByRole("button", { name: message(en, localeKeys[en].manage) }).click();
  assert.equal(await page.getByTestId("bots-dialog").getAttribute("data-entry-provider"), "");
  await page.getByTestId("bots-dialog").getByRole("button", { name: "Close fixture bots" }).click();
  await page
    .getByRole("button", { name: message(en, localeKeys[en].close) })
    .last()
    .click();
  await page.getByRole("dialog").waitFor({ state: "detached" });
  const remoteOptions = await page.evaluate(() => ({
    workspacePath: window.remoteOptions.workspacePath,
    workspaceIdentity: window.remoteOptions.workspaceIdentity,
    remoteSessionId: window.remoteOptions.remoteSessionId,
  }));
  assert.deepEqual(remoteOptions, {
    workspacePath: "/fixture/workspace",
    workspaceIdentity: "fixture-identity",
    remoteSessionId: "fixture-session",
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(
    geometryFailures,
    [],
    "dialog must retain at least 15px viewport margins across all tested sizes",
  );
  const actions = await page.getByTestId("fixture-events").textContent();
  assert.match(actions, /\["copy"\]/);
  assert.match(actions, /\["stop"\]/);
  console.log(
    "PASS WebRemoteControlDialog Chromium smoke: actual UI primitives/styles/endpoint/icons/botsUi, real locale dictionaries, responsive layout, themes and controls",
  );
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
  await vite.close();
  await rm(viteCacheDir, { recursive: true, force: true });
}
