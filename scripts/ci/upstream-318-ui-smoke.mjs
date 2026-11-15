import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";
import { buildFreshUiCss, makeTempDirs, readWebEntry } from "./web-profile-mobile-fixture.mjs";

// 上游 3.18 整合的真实 Chromium 组件守卫（夹具 packages/ui/test/fixtures/upstream-318-ui.jsx）：
// - 图片编辑：画笔标注后“加入对话”，把自然尺寸 PNG 追加到已有草稿（原附件保留）；
// - 会话查找：真实 useConversationTimelineFind + DOM Highlight 注册表，前进后活动命中变化；
// - 工作区 MCP：设置页真实 McpServerList 显示待审核，点击信任按钮携带只读摘要；
// - 插件保留页执行：声明 backgroundRetention 的页面才申请执行，plane 桥面只通知一次；
//   嵌套 frame 的文档导航分类不把 srcdoc/about:blank 当插件重载。
// 临时 profile/HOME/XDG，loopback 页面，外部网络全部拦截。

const root = resolve(import.meta.dirname, "../..");
const cacheDir = resolve(root, "node_modules/.cache");
const IMAGE_PATH = "/#image";
const FIND_PATH = "/#find";
const MCP_PATH = "/#mcp";
const PLUGIN_PATH = "/#plugin";
const TEST_ASSET_URL = "data:text/plain,zcode-test-asset-url";

function assetUrlPlugin() {
  return {
    name: "zcode-test-asset-url",
    setup(build) {
      build.onResolve({ filter: /\?url$/ }, (args) => ({
        path: args.path,
        namespace: "zcode-test-asset-url",
      }));
      build.onLoad({ filter: /.*/, namespace: "zcode-test-asset-url" }, () => ({
        contents: `export default ${JSON.stringify(TEST_ASSET_URL)};`,
        loader: "js",
      }));
    },
  };
}

async function buildFixtureScript() {
  const { build } = createRequire(resolve(root, "packages/services/package.json"))("esbuild");
  const output = await build({
    absWorkingDir: root,
    entryPoints: [resolve(root, "packages/ui/test/fixtures/upstream-318-ui.jsx")],
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
    jsx: "automatic",
    outdir: resolve(cacheDir, "upstream-318-ui-fixture"),
    alias: { "@": resolve(root, "packages/ui/src") },
    plugins: [assetUrlPlugin()],
    loader: { ".css": "empty", ".png": "dataurl", ".svg": "dataurl", ".wasm": "dataurl" },
    define: {
      "process.env.NODE_ENV": '"production"',
      "import.meta.env.PROD": "true",
      "import.meta.env.DEV": "false",
      "import.meta.env.MODE": '"production"',
    },
  });
  const script = output.outputFiles.find((file) => file.path.endsWith(".js"))?.contents;
  if (!script?.length) throw new Error("upstream-318 UI fixture was not built");
  return script;
}

let dirs;
let server;
let context;
try {
  await mkdir(cacheDir, { recursive: true });
  dirs = await makeTempDirs(cacheDir);
  const fixtureScript = await buildFixtureScript();
  const css = await buildFreshUiCss(root, dirs.tempDir);
  const { html } = await readWebEntry(root);

  server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname === "/fixture.js") {
      response.setHeader("Content-Type", "text/javascript");
      response.end(fixtureScript);
      return;
    }
    if (pathname === "/styles.css") {
      response.setHeader("Content-Type", "text/css");
      response.end(css);
      return;
    }
    if (pathname.startsWith("/assets/")) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.setHeader("Content-Type", "text/html");
    response.end(html);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;

  context = await chromium.launchPersistentContext(dirs.profileDir, {
    headless: true,
    executablePath: process.env.ZCODE_TEST_CHROMIUM_EXECUTABLE || undefined,
    viewport: { width: 1280, height: 860 },
    env: {
      ...process.env,
      HOME: dirs.homeDir,
      XDG_CONFIG_HOME: dirs.xdgConfigDir,
      XDG_CACHE_HOME: dirs.xdgCacheDir,
      TMPDIR: dirs.tempDir,
    },
    args: ["--no-proxy-server", "--disable-background-networking"],
  });
  const errors = [];
  context.on("request", (request) => {
    const hostname = new URL(request.url()).hostname;
    if (hostname !== "127.0.0.1") errors.push(`external request: ${request.url()}`);
  });
  await context.route("**/*", (route) => {
    const hostname = new URL(route.request().url()).hostname;
    return hostname === "127.0.0.1" ? route.continue() : route.abort();
  });
  for (const initialPage of context.pages()) await initialPage.close();

  const openPage = async (path) => {
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.goto(`${origin}${path}`);
    return page;
  };

  // 1. 图片编辑 + 追加到已有草稿
  {
    const page = await openPage(IMAGE_PATH);
    await page.locator("[data-image-preview-surface]").waitFor();
    await page.waitForFunction(() => {
      const image = document.querySelector('[data-testid="upstream-image-fixture"]');
      return image instanceof HTMLImageElement && image.naturalWidth > 0;
    });
    await page.locator("[data-image-preview-annotate]").click();
    await page.locator('[data-image-preview-tool="pen"]').click();
    const box = await page.locator("[data-image-preview-surface]").boundingBox();
    assert.ok(box, "image surface has layout bounds");
    const start = { x: box.x + box.width * 0.3, y: box.y + box.height * 0.3 };
    const end = { x: box.x + box.width * 0.7, y: box.y + box.height * 0.7 };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 8 });
    await page.mouse.up();
    await page.locator("[data-image-preview-save]").click();
    await page.waitForFunction(() => window.imageFixture.saved === 1, null, { timeout: 15_000 });
    const appended = await page.evaluate(() => window.imageFixture.appended);
    assert.equal(appended.length, 2, "existing draft entry is preserved");
    assert.equal(appended[0].name, "existing-draft.png");
    assert.match(appended[1].type, /^image\/png$/u);
    assert.ok(appended[1].size > 0);
    await page.close();
  }

  // 2. 会话查找命中、前进与 DOM Highlight
  {
    const page = await openPage(FIND_PATH);
    const rootLocator = page.locator("[data-find-root]");
    await rootLocator.waitFor();
    await page.waitForFunction(
      () =>
        document.querySelector("[data-find-root]")?.getAttribute("data-find-match-count") === "3",
    );
    const readHighlights = () =>
      page.evaluate(() => ({
        all: CSS.highlights.get("zcode-v4-conversation-find")?.size ?? 0,
        active: CSS.highlights.get("zcode-v4-conversation-find-active")?.size ?? 0,
      }));
    assert.deepEqual(await readHighlights(), { all: 3, active: 1 });
    await page.locator("[data-find-next]").click();
    await page.waitForFunction(
      () =>
        document.querySelector("[data-find-root]")?.getAttribute("data-find-active-index") === "1",
    );
    assert.deepEqual(await readHighlights(), { all: 3, active: 1 });
    const scrolled = await rootLocator.evaluate((element) => element.scrollTop);
    assert.ok(scrolled > 0, "active match scrolls into view");
    await page.close();
  }

  // 3. MCP 工作区信任审核路径
  {
    const page = await openPage(MCP_PATH);
    await page.locator('[data-mcp-workspace-trust="pending"]').waitFor();
    const action = page.locator('[data-mcp-workspace-trust-action="trust"]');
    await action.click();
    await page.waitForFunction(() => window.mcpTrustFixture.trusts.length === 1);
    const trusts = await page.evaluate(() => window.mcpTrustFixture.trusts);
    assert.equal(trusts[0].name, "fixture-project");
    assert.equal(trusts[0].digest, "b".repeat(64));
    await page.locator('[data-mcp-workspace-trust="pending"]').waitFor({ state: "detached" });
    await page.close();
  }

  // 4. 插件保留页执行桥 + 嵌套 frame 导航分类
  {
    const page = await openPage(PLUGIN_PATH);
    await page.locator("[data-plugin-anchor]").waitFor();
    const initial = await page.evaluate(() => window.pluginExecutionFixture);
    assert.deepEqual(initial.retention, [true, false]);
    assert.deepEqual(initial.nestedFrames, {
      sandbox: true,
      aboutBlank: false,
      srcdoc: true,
      capability: true,
    });
    await page.locator("[data-execution-on]").click();
    await page.waitForFunction(() => window.pluginExecutionFixture.execution.includes(true));
    const activeStyle = await page.locator("[data-sandbox-page-root]").evaluate((element) => ({
      display: getComputedStyle(element).display,
      opacity: getComputedStyle(element).opacity,
    }));
    assert.equal(activeStyle.display, "block");
    assert.equal(activeStyle.opacity, "0.001");
    await page.locator("[data-execution-off]").click();
    await page.waitForFunction(() => window.pluginExecutionFixture.execution.includes(false));
    const idleStyle = await page
      .locator("[data-sandbox-page-root]")
      .evaluate((element) => getComputedStyle(element).display);
    assert.equal(idleStyle, "none");
    await page.close();
  }

  assert.deepEqual(errors, []);
  console.log("[upstream-318-ui] PASS image/find/mcp-trust/plugin-execution");
} finally {
  await context?.close().catch(() => {});
  if (server) {
    server.close();
    await once(server, "close").catch(() => {});
  }
  if (dirs) await rm(dirs.tempDir, { recursive: true, force: true }).catch(() => {});
}
