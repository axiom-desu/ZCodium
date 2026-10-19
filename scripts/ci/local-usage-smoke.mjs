import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright-core";
const root = resolve(import.meta.dirname, "../..");
const { outputFiles } = await build({
  entryPoints: [resolve(import.meta.dirname, "fixtures/local-usage.jsx")],
  bundle: true,
  write: false,
  platform: "browser",
  format: "esm",
  jsx: "automatic",
  alias: { "@": resolve(root, "packages/ui/src") },
  loader: { ".css": "empty", ".svg": "dataurl", ".png": "dataurl" },
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [
    {
      name: "local-usage-only",
      setup(builder) {
        // 额度展示只允许走"用户自带 API Key"这条链路；账号、权益、OAuth 仍然禁止。
        builder.onResolve(
          {
            // shared/oauth.ts 只剩 Provider 标识类型，不是账号服务；只拦真正的账号/权益链路。
            filter:
              /useUsageEntitlement|usageEntitlement|useStableAccountAccess|AccountAccess|OAuthService|oauthService|useOAuth/,
          },
          ({ path }) => {
            throw new Error(`Official usage dependency in local statistics: ${path}`);
          },
        );
      },
    },
  ],
});
const directory =
  process.env.ZCODE_TEST_RENDERER_ASSETS || resolve(root, "packages/desktop/out/renderer/assets");
const cssName = (await readdir(directory)).find((name) => /^styles-.*\.css$/.test(name));
assert.ok(cssName, "Build desktop renderer before local usage browser checks");
const css = await readFile(resolve(directory, cssName), "utf8");
const server = createServer((request, response) => {
  if (request.url === "/fixture.js") {
    response.setHeader("Content-Type", "text/javascript");
    response.end(outputFiles[0].contents);
  } else if (request.url === "/style.css") {
    response.setHeader("Content-Type", "text/css");
    response.end(css);
  } else {
    response.setHeader("Content-Type", "text/html");
    response.end(
      '<!doctype html><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/style.css"><style>html,body,#root { height: auto; overflow: visible; }</style><div id="root"></div><script type="module" src="/fixture.js"></script>',
    );
  }
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
  const errors = [],
    requests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    if (new URL(route.request().url()).hostname === "127.0.0.1") return route.continue();
    requests.push(route.request().url());
    return route.abort();
  });
  for (const locale of ["en-US", "zh-CN"])
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(
        `http://127.0.0.1:${server.address().port}/?locale=${locale}&theme=${width === 1280 ? "dark" : "light"}`,
      );
      await page.getByText("7d-model", { exact: true }).first().waitFor();
      const tabs = page.getByRole("tab", {
        name: locale === "en-US" ? /^Last (7|30) days$/ : /^近 (7|30) 日$/,
      });
      assert.equal(await tabs.count(), 2);
      // 未配置 Coding Plan 连接时必须给出"去填 Key"的引导，而不是零额度或账号入口。
      await page
        .getByText(
          locale === "en-US"
            ? /No Coding Plan connection configured/
            : /还没有配置 Coding Plan 连接/,
        )
        .waitFor();
      // Actual range tabs preserve local queries and the selected state without account discovery.
      await tabs.nth(1).press("Enter");
      await page.getByText("30d-model", { exact: true }).first().waitFor();
      assert.equal(await tabs.nth(1).getAttribute("aria-selected"), "true");
      const refresh = page.getByRole("button", {
        name: locale === "en-US" ? "Refresh" : "刷新",
        exact: true,
      });
      await page.evaluate(() => {
        window.localUsageFixture.failNext = true;
      });
      await refresh.click();
      await page.getByRole("alert").waitFor();
      // A failed refresh leaves the last local chart visible and the retry available.
      await page.getByText("30d-model", { exact: true }).first().waitFor();
      await refresh.click();
      await page.getByRole("alert").waitFor({ state: "hidden" });
      await page.evaluate(() => {
        window.localUsageFixture.holdNext = true;
      });
      await tabs.nth(0).click();
      await page.waitForFunction(() => window.localUsageFixture.release !== null);
      await tabs.nth(1).click();
      await page.getByText("30d-model", { exact: true }).first().waitFor();
      await page.evaluate(() => window.localUsageFixture.release());
      assert.equal(await tabs.nth(1).getAttribute("aria-selected"), "true");
      await page.getByText("7d-model", { exact: true }).first().waitFor({ state: "hidden" });
      const state = await page.evaluate(() => window.localUsageFixture);
      assert.deepEqual(state.forbidden, []);
      assert.ok(state.requests.length >= 8);
      for (const request of state.requests) {
        assert.deepEqual(Object.keys(request).sort(), ["range", "timeZone"]);
        assert.ok(request.timeZone);
      }
      // Wait for actual chart geometry, not just the legend text, before the visual check.
      await page.waitForFunction(() =>
        [...document.querySelectorAll(".recharts-pie path")].some(
          (path) => (path.getAttribute("d") || "").length > 20,
        ),
      );
      await page.evaluate(async () => {
        let previous = "",
          stableFrames = 0;
        for (let frame = 0; frame < 240; frame++) {
          await new Promise(requestAnimationFrame);
          const current = [...document.querySelectorAll(".recharts-pie path")]
            .map((path) => path.getAttribute("d"))
            .join("|");
          stableFrames = current === previous ? stableFrames + 1 : 0;
          if (current && stableFrames >= 6) return;
          previous = current;
        }
        throw new Error("Usage chart animation did not settle");
      });
      if (process.env.ZCODE_TEST_SCREENSHOTS) {
        await mkdir(process.env.ZCODE_TEST_SCREENSHOTS, { recursive: true });
        await page.screenshot({
          path: resolve(process.env.ZCODE_TEST_SCREENSHOTS, `local-usage-${locale}-${width}.png`),
          fullPage: true,
        });
      }
    }
  await page.goto(`http://127.0.0.1:${server.address().port}/?failure&locale=en-US`);
  await page.getByRole("alert").waitFor();
  assert.equal(await page.getByRole("button", { name: /API Key/i }).count(), 0);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByText("7d-model", { exact: true }).first().waitFor();
  await page.getByRole("alert").waitFor({ state: "hidden" });
  assert.deepEqual(errors, []);
  assert.deepEqual(requests, []);
  console.log(
    "Local usage browser checks passed: charts, ranges, refresh, failure recovery and stale response, EN/ZH narrow/wide; no official queries or external requests.",
  );
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
