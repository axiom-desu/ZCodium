import assert from "node:assert/strict";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer as createNetServer } from "node:net";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { createServer as createViteServer } from "vite";

import {
  buildServicePreview,
  LARGE_ARTIFACT_BYTES,
  LARGE_ARTIFACT_ID,
  UNAVAILABLE_SUMMARY,
  UNKNOWN_BLOCK_SUMMARY,
} from "./conversation-share-web-fixture.mjs";

/**
 * 公开分享页的真实浏览器验收。
 *
 * 不用复制版 harness：起的是 packages/web 的真实 Vite 入口（main.tsx → 分享路由 →
 * @zcode/ui 的只读时间线与内容块渲染器），分享 API 走 127.0.0.1 的 loopback 假服务，
 * 全程不会触碰任何生产分享端点。
 *
 * 预览载荷来自 conversation-share-web-fixture.mjs：由 packages/services 的真实分享流水线
 * （内嵌图片 → workflow 快照 → 公开投影）生成，覆盖线上服务会发出的形状，包括 run 读不到时
 * 合成的 assistantText 摘要 + `unavailable` workflow 块。
 */

const root = resolve(import.meta.dirname, "../..");
const webRoot = resolve(root, "packages/web");

function reservePort() {
  return new Promise((resolvePort, reject) => {
    const server = createNetServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

const apiRequests = [];
const apiPort = await reservePort();
const apiBase = `http://127.0.0.1:${apiPort}`;
const vitePort = await reservePort();
const pageBase = `http://127.0.0.1:${vitePort}`;
// artifact 也走页面同源：只有这样才能观察到 <img>/fetch 默认是否携带访客 cookie。
const { payload, unavailableBlockId, largeArtifactId, files } = await buildServicePreview(pageBase);
assert.ok(unavailableBlockId, "the preview payload must contain the source-unavailable block");
assert.equal(largeArtifactId, LARGE_ARTIFACT_ID);

const api = createHttpServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  apiRequests.push({
    method: request.method ?? "GET",
    path: url.pathname,
    headers: request.headers,
  });
  // 落地页与 API 在生产上是同源部署；浏览器用例把预览与 artifact 都代理到页面同源。
  // 这里仍显式放开 CORS，避免测试 harness 与生产同源语义互相混淆。
  response.setHeader("Access-Control-Allow-Origin", "*");
  if (url.pathname === "/api/v1/__cookie_probe") {
    response.writeHead(204);
    response.end();
    return;
  }
  const artifactId = url.pathname.startsWith("/files/")
    ? decodeURIComponent(url.pathname.slice("/files/".length))
    : undefined;
  if (artifactId === LARGE_ARTIFACT_ID) {
    // 故意不声明 Content-Length：客户端只能靠累计块大小截止，并在越界时主动取消。
    response.on("error", () => undefined);
    response.writeHead(200, { "Content-Type": "text/markdown" });
    const chunk = Buffer.alloc(1024 * 1024, "x");
    let sent = 0;
    const writeNext = () => {
      if (response.destroyed || response.writableEnded) return;
      if (sent > LARGE_ARTIFACT_BYTES) {
        response.end();
        return;
      }
      sent += chunk.length;
      if (response.write(chunk)) setImmediate(writeNext);
      else response.once("drain", writeNext);
    };
    writeNext();
    return;
  }
  if (artifactId !== undefined) {
    const file = files.get(artifactId);
    if (!file) {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ code: 3211, msg: "not found" }));
      return;
    }
    response.writeHead(200, { "Content-Type": file.mimeType });
    response.end(file.bytes);
    return;
  }
  const match = /^\/api\/v1\/shares\/([^/]+)\/preview$/u.exec(url.pathname);
  if (!match) {
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ code: 3211, msg: "not found" }));
    return;
  }
  if (decodeURIComponent(match[1]) === "missing-share") {
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ code: 3211, msg: "share not found" }));
    return;
  }
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ code: 0, msg: "ok", data: payload }));
});
await new Promise((resolveReady) => api.listen(apiPort, "127.0.0.1", resolveReady));

// 同源部署：预览与 artifact 请求都经 Vite 中间件转到 loopback API，才可能观察到
// “默认会带 cookie”的语义，也才能证明匿名 reader 真的退出了凭据。
const sameOriginApiPlugin = {
  name: "conversation-share-same-origin-preview",
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (!url.pathname.startsWith("/api/v1/") && !url.pathname.startsWith("/files/")) {
        next();
        return;
      }
      const upstream = httpRequest(
        `${apiBase}${url.pathname}${url.search}`,
        {
          method: request.method,
          headers: { ...request.headers, host: `127.0.0.1:${apiPort}` },
        },
        (upstreamResponse) => {
          response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
          upstreamResponse.pipe(response);
        },
      );
      upstream.on("error", () => {
        if (!response.headersSent) response.writeHead(502);
        response.end();
      });
      request.pipe(upstream);
    });
  },
};

process.env.VITE_ZCODE_BASE_URL = pageBase;
process.env.ZCODE_ENV = "test";
const vite = await createViteServer({
  root: webRoot,
  configFile: resolve(webRoot, "vite.config.ts"),
  mode: "development",
  logLevel: "error",
  plugins: [sameOriginApiPlugin],
  server: { host: "127.0.0.1", port: vitePort, strictPort: true, hmr: false },
});
await vite.listen();

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1180, height: 900 } });
// 先种一个同源 cookie：如果预览请求没有 credentials:omit，API 会看到它。
await context.addCookies([{ name: "share-session", value: "cookie-secret-value", url: pageBase }]);
await context.addInitScript(() => {
  window.__shareOpened = [];
  window.open = (...args) => {
    window.__shareOpened.push(String(args[0]));
    return null;
  };
});
const page = await context.newPage();
const externalRequests = [];
page.on("request", (request) => {
  const url = new URL(request.url());
  // blob:/data: 是渲染器本地生成的 URL，不会发起外部网络请求。
  if (url.protocol === "blob:" || url.protocol === "data:") return;
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    externalRequests.push(request.url());
  }
});
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(error.message));

try {
  await page.goto(`${pageBase}/cn/share/verified-share`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-conversation-share-landing]", { timeout: 60_000 });
  await page.waitForSelector("[data-workflow-completion-card]", { timeout: 60_000 });
  await page.waitForSelector("[data-share-tool-presentation]", { timeout: 30_000 });

  assert.equal(
    await page.locator("[data-conversation-share-title]").innerText(),
    "Quarterly review",
  );
  // 正常 workflow 仍由卡片呈现（回归：修复摘要认领后不能把正常卡片弄丢）。
  assert.match(await page.locator("[data-workflow-completion-card]").innerText(), /Weekly report/u);
  assert.match(await page.locator("[data-share-tool-presentation]").innerText(), /all green/u);

  // 匿名读取：同源 cookie 已种下，但预览请求不得携带，控制探针必须能证明 cookie 语义可见。
  const previewRequest = apiRequests.find((entry) =>
    entry.path.startsWith("/api/v1/shares/verified-share/preview"),
  );
  assert.ok(previewRequest, "the preview request must reach the loopback API");
  assert.equal(previewRequest.headers.cookie, undefined);
  const probeStatus = await page.evaluate(async () => {
    const response = await fetch("/api/v1/__cookie_probe");
    return response.status;
  });
  assert.equal(probeStatus, 204);
  const probeRequest = apiRequests.find((entry) => entry.path === "/api/v1/__cookie_probe");
  assert.ok(probeRequest, "the cookie probe must reach the loopback API");
  assert.match(probeRequest.headers.cookie ?? "", /share-session=cookie-secret-value/u);

  const timelineText = await page.locator("[data-conversation-share-timeline]").innerText();
  const countOccurrences = (haystack, needle) => haystack.split(needle).length - 1;
  // 服务端唯一的一句摘要必须出现且只出现一次；卡片块不再额外画一个空壳。
  assert.equal(countOccurrences(timelineText, UNAVAILABLE_SUMMARY), 1);
  assert.equal(await page.locator(`[data-share-content-block="${unavailableBlockId}"]`).count(), 0);
  // 正常卡片替代了自己的回退摘要（不重复）。
  assert.equal(countOccurrences(timelineText, "Workflow · completed"), 0);
  // 本 build 不认识的块不认领 fallback row：正文仍然只出现一次。
  assert.equal(countOccurrences(timelineText, UNKNOWN_BLOCK_SUMMARY), 1);

  // 图片由匿名 reader 读成 Blob/object URL；<img src> 不能再是原始同源 URL，
  // 否则浏览器会按默认凭据语义带上访客 cookie。
  const imageSrc = await page.locator("[data-share-tool-presentation] img").getAttribute("src");
  assert.ok(imageSrc?.startsWith("blob:"), "tool image must render from a scoped blob URL");
  const imageRequest = apiRequests.find((entry) => entry.path === "/files/share-artifact-2");
  assert.ok(imageRequest, "the tool image request must reach the loopback API");
  assert.equal(imageRequest.headers.cookie, undefined);
  await page.waitForFunction(
    () => {
      const image = document.querySelector("[data-share-tool-presentation] img");
      return image instanceof HTMLImageElement && image.complete && image.naturalWidth === 1;
    },
    { timeout: 30_000 },
  );

  // 超限 artifact 走真实完成卡 → 弹窗渲染：分块流没有 Content-Length，必须被主动取消，
  // 只让这张卡显示限额错误，其他卡片保持原样。
  await page.locator('[data-testid="workflow-completion-row"]').click();
  await page.getByText(/超出大小上限|size limit exceeded/u).waitFor({ timeout: 30_000 });
  const largeRequest = apiRequests.find((entry) => entry.path === `/files/${LARGE_ARTIFACT_ID}`);
  assert.ok(largeRequest, "the oversized artifact request must reach the loopback API");
  assert.equal(largeRequest.headers.cookie, undefined);
  assert.match(await page.locator("[data-workflow-completion-card]").innerText(), /Weekly report/u);
  assert.match(await page.locator("[data-share-tool-presentation]").innerText(), /all green/u);
  await page.keyboard.press("Escape");

  // 不可信内容不执行：脚本/事件处理器都没有生效。
  assert.equal(await page.evaluate(() => window.__sharePwned), undefined);
  const injectedScripts = await page.locator("[data-conversation-share-timeline] script").count();
  assert.equal(injectedScripts, 0);
  assert.equal(await page.locator("[data-conversation-share-timeline] img[src='x']").count(), 0);

  // 外链策略：本机/内网的十进制、十六进制、百分号编码写法都不打开；公网链接照常打开。
  for (const name of ["decimal", "hex", "enc"]) {
    await page.getByRole("button", { name }).click();
  }
  assert.deepEqual(
    await page.evaluate(() => window.__shareOpened),
    [],
    "private links must not open",
  );
  await page.getByRole("button", { name: "public" }).click();
  assert.deepEqual(await page.evaluate(() => window.__shareOpened), ["https://example.com/shared"]);

  // 未知 row 有软提示，但不阻断整页。
  assert.equal(await page.locator("[data-conversation-share-unsupported-notice]").count(), 1);

  await page.screenshot({ path: "/tmp/s11b-share-landing.png", fullPage: true });

  // 分享交互：错误态可见，重试会真正再发一次请求。
  const requestsBeforeRetry = apiRequests.length;
  await page.goto(`${pageBase}/share/missing-share`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-conversation-share-error="not_found"]', { timeout: 60_000 });
  const retryButton = page.getByRole("button", { name: /重试|Try again/u });
  assert.equal(await page.locator('[data-conversation-share-error="not_found"]').count(), 1);
  await retryButton.click();
  const startedAt = Date.now();
  while (apiRequests.length <= requestsBeforeRetry && Date.now() - startedAt < 15_000) {
    await page.waitForTimeout(100);
  }
  assert.ok(apiRequests.length > requestsBeforeRetry, "retry must issue another preview request");

  // 分享 code 里的点号不是路径段：合法 code（含 `a..b`）必须原样请求，
  // 且任何 code 都不能被 URL 归一化成 shares 以外的 endpoint（`..` 那种 code 在
  // client 里已按 invalid_contract 拒绝，不会发出请求）。
  await page.goto(`${pageBase}/cn/share/a..b.c~d`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-conversation-share-landing]", { timeout: 60_000 });
  assert.ok(
    apiRequests.some((entry) => entry.path === "/api/v1/shares/a..b.c~d/preview"),
    "a legal code containing dots must reach shares/<code>/preview verbatim",
  );
  assert.equal(
    apiRequests.some((entry) => entry.path === "/api/v1/preview"),
    false,
    "no share code may be normalized into an endpoint outside /shares/<code>/preview",
  );

  assert.deepEqual(externalRequests, [], "the share page must not call non-loopback hosts");
  assert.deepEqual(pageErrors, [], "the share page must not raise uncaught errors");
  console.log(
    JSON.stringify(
      {
        ok: true,
        apiRequests: apiRequests.map((entry) => `${entry.method} ${entry.path}`),
        screenshot: "/tmp/s11b-share-landing.png",
      },
      null,
      2,
    ),
  );
} finally {
  await context.close().catch(() => undefined);
  await browser.close().catch(() => undefined);
  await vite.close().catch(() => undefined);
  await new Promise((resolveClosed) => {
    api.closeAllConnections();
    api.close(resolveClosed);
  });
}
