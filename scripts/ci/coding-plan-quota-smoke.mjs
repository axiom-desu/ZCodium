import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright-core";
const BIGMODEL_BASE = "https://open.bigmodel.cn/api/anthropic";
const root = resolve(import.meta.dirname, "../..");
const { outputFiles } = await build({
  entryPoints: [resolve(import.meta.dirname, "fixtures/coding-plan-quota.jsx")],
  bundle: true,
  write: false,
  platform: "browser",
  format: "esm",
  jsx: "automatic",
  alias: { "@": resolve(root, "packages/ui/src") },
  loader: { ".css": "empty", ".svg": "dataurl", ".png": "dataurl" },
  define: { "process.env.NODE_ENV": '"production"' },
});

const directory =
  process.env.ZCODE_TEST_RENDERER_ASSETS || resolve(root, "packages/desktop/out/renderer/assets");
const cssName = (await readdir(directory)).find((name) => /^styles-.*\.css$/.test(name));
assert.ok(cssName, "Build desktop renderer before Coding Plan quota browser checks");
const css = await readFile(resolve(directory, cssName), "utf8");

const server = createServer((request, response) => {
  if (request.url === "/fixture.js") {
    response.setHeader("Content-Type", "text/javascript");
    response.end(outputFiles[0].contents);
    return;
  }
  if (request.url === "/style.css") {
    response.setHeader("Content-Type", "text/css");
    response.end(css);
    return;
  }
  response.setHeader("Content-Type", "text/html");
  response.end(
    '<!doctype html><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/style.css"><style>html,body,#root { height: auto; overflow: visible; }</style><div id="root"></div><script type="module" src="/fixture.js"></script>',
  );
});
server.listen(0, "127.0.0.1");
await once(server, "listening");

let browser;
try {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.ZCODE_TEST_CHROMIUM_EXECUTABLE || undefined,
  });
  const page = await browser.newPage();
  const errors = [];
  const external = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    if (new URL(route.request().url()).hostname === "127.0.0.1") return route.continue();
    external.push(route.request().url());
    return route.abort();
  });

  const base = () => `http://127.0.0.1:${server.address().port}/`;
  const readFixture = () => page.evaluate(() => window.codingPlanQuotaFixture);

  for (const locale of ["en-US", "zh-CN"]) {
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(
        `${base()}?locale=${locale}&scenario=ready&theme=${width === 1280 ? "dark" : "light"}`,
      );
      const ready = locale === "en-US" ? /Coding Plan remaining quota/ : /编程套餐剩余额度/;
      await page.getByText(ready).waitFor();
      // 剩余额度必须真的渲染出来，而不是只显示空态。
      await page
        .getByText(locale === "en-US" ? /182 left/ : /剩余 182/, { exact: false })
        .first()
        .waitFor();
      const state = await readFixture();
      assert.equal(state.requests.length, 1);
      assert.deepEqual(Object.keys(state.requests[0]).sort(), ["apiKey", "baseUrl", "providerId"]);
      assert.equal(state.requests[0].baseUrl, BIGMODEL_BASE);
      if (process.env.ZCODE_TEST_SCREENSHOTS) {
        await mkdir(process.env.ZCODE_TEST_SCREENSHOTS, { recursive: true });
        await page.screenshot({
          path: resolve(
            process.env.ZCODE_TEST_SCREENSHOTS,
            `coding-plan-quota-${locale}-${width}.png`,
          ),
          fullPage: true,
        });
      }
    }
  }

  // 未填 Key：不发请求，给出"去填 Key"而不是零额度。
  await page.goto(`${base()}?locale=en-US&scenario=no-key`);
  await page.getByText(/No Coding Plan API key yet/).waitFor();
  assert.equal(await page.getByText(/0 left/).count(), 0);
  assert.equal((await readFixture()).requests.length, 0);

  // 完全没配置连接：给出"去添加"，同样不发请求。
  await page.goto(`${base()}?locale=zh-CN&scenario=no-provider`);
  await page.getByText(/还没有配置 Coding Plan 连接/).waitFor();
  assert.equal((await readFixture()).requests.length, 0);

  // 查询失败：显示失败提示 + 保留刷新入口，不能渲染成"额度用完"。
  await page.goto(`${base()}?locale=en-US&scenario=failure`);
  await page.getByRole("alert").waitFor();
  assert.equal(await page.getByText(/0 left/).count(), 0);
  await page.getByRole("button", { name: "Refresh", exact: true }).waitFor();
  assert.equal((await readFixture()).requests.length, 1);

  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  console.log(
    "Coding Plan quota browser checks passed: API-key-only query, remaining rendering, EN/ZH narrow/wide, plus distinct pending/failure empty states; no external requests.",
  );
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
