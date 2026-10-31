import assert from "node:assert/strict";
import { build } from "esbuild";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

// 真实 mobile entry + 真实 LAN endpoint：浏览器自行计算 proof 并与 endpoint 完成握手。
const root = resolve(import.meta.dirname, "../..");
const cacheDir = resolve(root, "node_modules/.cache");
await mkdir(cacheDir, { recursive: true });
const temp = await mkdtemp(resolve(cacheDir, "mobile-remote-smoke-"));
const mobileDir = resolve(temp, "mobile");
const endpointBundle = resolve(temp, "endpoint.mjs");
const endpointSource = resolve(root, "packages/desktop/src/main/webRemoteControl/lanEndpoint.ts");
const originalMobileDir = process.env.ZCODE_WEB_REMOTE_MOBILE_DIR;
let context;
let endpoint;
try {
  const browserBundle = await build({
    entryPoints: [resolve(root, "packages/web/src/mobile/main.tsx")],
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
    jsx: "automatic",
    loader: { ".css": "empty" },
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env": "{}" },
  });
  await build({
    entryPoints: [endpointSource],
    outfile: endpointBundle,
    bundle: true,
    platform: "node",
    format: "esm",
    external: ["ws"],
  });
  await mkdir(mobileDir, { recursive: true });
  process.env.ZCODE_WEB_REMOTE_MOBILE_DIR = mobileDir;
  await writeFile(
    resolve(mobileDir, "mobile.html"),
    (await readFile(resolve(root, "packages/web/mobile.html"), "utf8")).replace(
      "/src/mobile/main.tsx",
      "/mobile.js",
    ),
  );
  await writeFile(resolve(mobileDir, "mobile.js"), browserBundle.outputFiles[0].contents);
  const { LanRemoteControlEndpoint } = await import(`${endpointBundle}?${Date.now()}`);
  const endpointEvents = [];
  endpoint = new LanRemoteControlEndpoint({
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    deviceMid: "smoke-mid",
    deviceName: "fixture",
    appVersion: "smoke",
    maxPhysicalFrameBytes: 1024 * 1024,
    handleMobilePayload(deviceSid, payload) {
      endpointEvents.push(payload.zcode_type);
      if (payload.zcode_type === "bootstrap-request")
        device.sendPayload({
          zcode_type: "bootstrap-response",
          requestId: payload.requestId,
          success: true,
          result: {
            windowControlSessionId: "fixture-window",
            desktopAppVersion: "smoke",
            workspaces: [
              {
                workspaceKey: "fixture-workspace",
                workspacePath: "/fixture",
                kind: "local",
                label: "Fixture workspace",
              },
            ],
            tasks: [],
          },
        });
    },
  });
  const secret = randomBytes(32).toString("base64url");
  const passHash = createHash("sha256").update(secret).digest("base64");
  let pairedCount = 0;
  const device = endpoint.registerDevice(
    { mode: "register", passHash },
    {
      onStateChange(state) {
        if (state === "paired") pairedCount++;
      },
      onPayload() {},
      onRegisteredAuth() {},
      onError() {},
      onInvalidPersistedAuth() {},
      onMobileDisconnected() {},
    },
  );
  const info = await endpoint.start();
  const profileDir = resolve(temp, "browser-profile");
  await mkdir(profileDir, { recursive: true });
  context = await chromium.launchPersistentContext(profileDir, {
    channel: "chromium",
    headless: true,
    executablePath: process.env.ZCODE_TEST_CHROMIUM_EXECUTABLE || undefined,
    args: ["--no-proxy-server", "--host-resolver-rules=MAP mobile.fixture.test 127.0.0.1"],
    ...devicesForMobile(),
  });
  await context.addInitScript(() => {
    window.__mobileWsCount = 0;
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = class extends NativeWebSocket {
      constructor(...args) {
        window.__mobileWsCount++;
        super(...args);
      }
    };
  });
  const origin = `http://mobile.fixture.test:${info.port}`;
  const url = `${origin}/?sid=${encodeURIComponent(device.deviceSid)}&hash=${encodeURIComponent(passHash)}&mid=fixture&name=smoke&app_version=smoke`;
  const pageErrors = [];
  context.on("page", (page) => page.on("pageerror", (error) => pageErrors.push(error)));
  const first = await context.newPage();
  const externalRequests = [];
  context.on("request", (request) => {
    const host = new URL(request.url()).hostname;
    if (!["127.0.0.1", "localhost", "mobile.fixture.test"].includes(host)) {
      externalRequests.push(request.url());
    }
  });
  await first.goto(url);
  assert.deepEqual(
    await first.evaluate(() => ({ secure: isSecureContext, subtle: Boolean(crypto.subtle) })),
    { secure: false, subtle: false },
  );
  await first.getByText("已连接到当前桌面窗口").waitFor();
  await first.getByText("1 个工作区 · 0 个任务").waitFor();
  // known-device 只展示 pairing URL 的公开 name；同时确认临时 profile 没有落 passHash。
  await first.getByTestId("mobile-known-device-name").getByText("smoke").waitFor();
  const persistedDisplay = await first.evaluate(() => {
    const entries = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key) entries.push([key, localStorage.getItem(key)]);
    }
    return JSON.stringify(entries);
  });
  assert.match(persistedDisplay, /smoke/u);
  assert.ok(
    !persistedDisplay.includes(passHash),
    "known-device display cache must never persist the pairing secret",
  );
  assert.ok(
    endpointEvents.includes("bootstrap-request"),
    "real mobile client must request bootstrap",
  );

  const bad = await context.newPage();
  await bad.goto(
    url.replace(encodeURIComponent(passHash), encodeURIComponent(`${passHash.slice(0, -2)}xx`)),
  );
  await bad.getByText("连接已终止").first().waitFor();
  const badInitial = await bad.evaluate(() => window.__mobileWsCount);
  await bad.evaluate(() => {
    dispatchEvent(new Event("online"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await bad.waitForTimeout(2300);
  assert.equal(
    await bad.evaluate(() => window.__mobileWsCount),
    badInitial,
    "terminal auth failure must not reconnect",
  );
  assert.equal(pairedCount, 1, "wrong hash must not pair");

  const second = await context.newPage();
  await second.goto(url);
  await second.getByText("已连接到当前桌面窗口").waitFor();
  await first.getByText("此配对仅支持一个手机页面，请关闭其他重复页面后重新扫码。").waitFor();
  const oldCount = await first.evaluate(() => window.__mobileWsCount);
  await first.evaluate(() => {
    dispatchEvent(new Event("online"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await first.waitForTimeout(2300);
  assert.equal(
    await first.evaluate(() => window.__mobileWsCount),
    oldCount,
    "kicked page must not reclaim pairing",
  );

  // 仅对活动页面模拟暂时离线：真实 socket 被浏览器断开，恢复网络后应由客户端自动重连。
  const cdp = await context.newCDPSession(second);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: true,
    latency: 0,
    downloadThroughput: 0,
    uploadThroughput: 0,
  });
  // CDP 的 offline 标志不会在所有 Chromium 版本主动关闭既有 WS；在 endpoint 上终止真实 socket，
  // 模拟传输中断，再由真实 MobileRemoteControlClient 执行退避重连。
  endpoint.pairs.get(device.deviceSid).mobile.terminate();
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  // 先等新 socket，再等配对；否则旧页面尚未处理 close 时残留的「已连接」会造成竞态。
  await second.waitForFunction(() => window.__mobileWsCount >= 2, undefined, { timeout: 12000 });
  await second.getByText("已连接到当前桌面窗口").waitFor({ timeout: 12000 });
  assert.deepEqual(
    await first.evaluate(() => ({ secure: isSecureContext, subtle: Boolean(crypto.subtle) })),
    { secure: false, subtle: false },
  );
  assert.deepEqual(
    pageErrors.map((error) => error.message),
    [],
    "mobile pages must not emit uncaught browser errors",
  );
  assert.deepEqual(externalRequests, [], "mobile smoke must not request external network");
  console.log(
    "PASS real Chromium mobile entry + LAN endpoint: insecure-context HMAC pairing/bootstrap; bad hash terminal/no reconnect; second page kicks first; offline close auto-reconnect",
  );
  console.log("Rerun: node scripts/ci/web-remote-control-mobile-smoke.mjs");
} finally {
  try {
    await context?.close();
  } finally {
    try {
      await endpoint?.stop();
    } finally {
      try {
        await rm(temp, { recursive: true, force: true });
      } finally {
        if (originalMobileDir === undefined) delete process.env.ZCODE_WEB_REMOTE_MOBILE_DIR;
        else process.env.ZCODE_WEB_REMOTE_MOBILE_DIR = originalMobileDir;
      }
    }
  }
}

function devicesForMobile() {
  return {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  };
}
