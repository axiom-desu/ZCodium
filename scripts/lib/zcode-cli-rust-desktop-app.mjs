// M8 桌面 E2E：用现有 playwright-core 的 `_electron` 启动真实 App，并通过真实 UI 元素驱动。
//
// 不修改产品代码；网络拦截通过运行时注入 main 的 webRequest（测试专用）与 renderer route 完成。
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { _electron as electron } from "playwright-core";
import {
  installMainProcessNetworkGuard,
  isAllowedRendererUrl,
} from "./zcode-cli-rust-desktop-network.mjs";

const require = createRequire(import.meta.url);

export function resolveElectronBinary(desktopRoot) {
  const packageJsonPath = require.resolve("electron/package.json", { paths: [desktopRoot] });
  const electronRoot = resolve(packageJsonPath, "..");
  const candidates =
    process.platform === "win32"
      ? [resolve(electronRoot, "dist", "electron.exe")]
      : process.platform === "darwin"
        ? [resolve(electronRoot, "dist", "Electron.app", "Contents", "MacOS", "Electron")]
        : [resolve(electronRoot, "dist", "electron")];
  const binary = candidates.find((candidate) => existsSync(candidate));
  if (!binary) throw new Error(`Electron binary not found under ${electronRoot}`);
  return binary;
}

const MAIN_BLOCKED_SINK = "__M8_E2E_BLOCKED_MAIN__";

/**
 * 启动真实桌面 App。`args[0]` 是桌面包目录（package.json main 指向 out/main/index.js），
 * 因此 app.isPackaged=false，走已构建的 out/renderer。
 */
export async function launchDesktopApp({
  electronBinary,
  desktopRoot,
  env,
  proxyUrl,
  extraArgs = [],
  packaged = false,
  timeoutMs = 90_000,
}) {
  const networkArgs = [
    // 只放行 loopback 之外全部解析失败，配合 fail-closed 代理覆盖 IP 直连。
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost",
    ...(proxyUrl ? [`--proxy-server=${proxyUrl}`, "--proxy-bypass-list=127.0.0.1;localhost"] : []),
  ];
  const app = await electron.launch({
    executablePath: electronBinary,
    // deb smoke 直接启动包内 executable；传 desktopRoot 会强制 Electron 进入开发态。
    args: [...(packaged ? [] : [desktopRoot]), "--no-sandbox", ...networkArgs, ...extraArgs],
    // 打包态不能继承仓库 cwd，否则 dev runtime discovery 可能掩盖漏打包资源。
    cwd: packaged ? dirname(electronBinary) : desktopRoot,
    env,
    timeout: timeoutMs,
  });
  const page = await app.firstWindow({ timeout: timeoutMs });
  const rendererBlocked = [];
  await page.context().route("**/*", (route) => {
    const url = route.request().url();
    if (isAllowedRendererUrl(url)) {
      route.continue();
      return;
    }
    rendererBlocked.push(url);
    route.abort("blockedbyclient");
  });
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (isAllowedRendererUrl(url)) {
      route.continue();
      return;
    }
    rendererBlocked.push(url);
    route.abort("blockedbyclient");
  });
  await installMainProcessNetworkGuard(app, { blocked: MAIN_BLOCKED_SINK }).catch(() => {});
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  return {
    app,
    page,
    errors,
    rendererBlocked,
    async blockedMainUrls() {
      return app
        .evaluate((_electron, sink) => globalThis[sink] ?? [], MAIN_BLOCKED_SINK)
        .catch(() => []);
    },
  };
}

async function composerReady(page) {
  return (await page.locator('[data-testid="v4-composer-input"]').count()) > 0;
}

/** 等待数据库启动完成（composer 出现）；失败态直接抛出带 errorCode 的错误。 */
export async function waitForDatabaseReady(page, { timeoutMs = 120_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const failed = await page
      .locator('[data-testid="database-startup-status"][data-phase="failed"]')
      .first();
    if ((await failed.count()) > 0) {
      const errorCode = await failed.getAttribute("data-error-code");
      const databasePhase = await failed.getAttribute("data-database-phase");
      throw new Error(
        `database startup failed: errorCode=${errorCode ?? "unknown"} phase=${databasePhase ?? "unknown"}`,
      );
    }
    if (await composerReady(page)) return { phase: "ready" };
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error("database startup timed out waiting for v4-composer-input");
}

/** 用 Lexical 真实 editor bridge 写入文本；bridge 缺失时回退到 click+keyboard.type。 */
async function typeIntoComposer(page, text) {
  const input = page.locator('[data-testid="v4-composer-input"]');
  await input.waitFor({ state: "visible", timeout: 30_000 });
  const usedBridge = await input.evaluate((element, value) => {
    const bridge = element.__zcodeLexicalInputE2E;
    if (!bridge) return false;
    bridge.setText(value);
    return true;
  }, text);
  if (!usedBridge) {
    await input.click();
    await page.keyboard.type(text);
  }
  return usedBridge;
}

export async function sendPrompt(page, text) {
  const usedBridge = await typeIntoComposer(page, text);
  const send = page.locator('[data-testid="v4-composer-send"]');
  await send.waitFor({ state: "visible", timeout: 10_000 });
  await send.click();
  return { usedBridge };
}

/** 等待 timeline 文本包含期望子串；同时保留最近一次 timeline snapshot 供诊断。 */
export async function waitForTimelineText(page, expected, { timeoutMs = 120_000 } = {}) {
  const timeline = page.locator('[data-testid="v4-timeline"]');
  const deadline = Date.now() + timeoutMs;
  let lastText = "";
  while (Date.now() < deadline) {
    const count = await timeline.count();
    if (count > 0) {
      lastText = await timeline
        .first()
        .innerText()
        .catch(() => "");
      if (lastText.includes(expected)) return { found: true, text: lastText };
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(
    `timeline did not contain ${JSON.stringify(expected)} within ${timeoutMs}ms; last=${JSON.stringify(
      lastText.slice(-600),
    )}`,
  );
}

export async function readTimelineText(page) {
  const timeline = page.locator('[data-testid="v4-timeline"]');
  if ((await timeline.count()) === 0) return "";
  return timeline
    .first()
    .innerText()
    .catch(() => "");
}

export async function closeDesktopApp(app) {
  try {
    await app.close();
  } catch {
    // Electron 已被外部强杀时 close 会抛；忽略，进程树由外层 finally 兜底。
  }
}
