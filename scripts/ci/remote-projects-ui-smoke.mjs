import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { build } from "vite";
import { chromium } from "playwright-core";

// W6 远端项目入口 UI 浏览器验证：真实 RemoteProjectsDialog + ServiceProvider 契约，
// 只使用临时目录与 loopback；服务实现是内存夹具（不连接真实远端）。
const root = resolve(import.meta.dirname, "../..");
const tempRoot = await mkdtemp(resolve(tmpdir(), "zcode-remote-projects-ui-"));
process.env.HOME = resolve(tempRoot, "home");
process.env.XDG_CONFIG_HOME = resolve(tempRoot, "xdg-config");
process.env.XDG_DATA_HOME = resolve(tempRoot, "xdg-data");
process.env.XDG_CACHE_HOME = resolve(tempRoot, "xdg-cache");

const outputs = await build({
  configFile: false,
  logLevel: "error",
  root,
  resolve: { alias: { "@": resolve(root, "packages/ui/src") } },
  define: { "process.env.NODE_ENV": '"production"' },
  build: {
    write: false,
    cssCodeSplit: false,
    rollupOptions: {
      input: resolve(root, "packages/ui/test/fixtures/remote-projects-dialog.jsx"),
      output: { format: "es", codeSplitting: false },
    },
  },
});
const built = (Array.isArray(outputs) ? outputs : [outputs])
  .flatMap((output) => output.output)
  .find((chunk) => chunk.type === "chunk");
assert.ok(built?.code, "remote projects dialog fixture bundle was not produced");

const server = createServer((request, response) => {
  if (request.url === "/") {
    response.writeHead(200, { "content-type": "text/html" });
    response.end('<div id="root"></div><script type="module" src="/app.js"></script>');
    return;
  }
  response.writeHead(200, { "content-type": "text/javascript" });
  response.end(built.code);
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const baseUrl = `http://127.0.0.1:${server.address().port}`;

let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    const host = new URL(route.request().url()).hostname;
    return host === "127.0.0.1" ? route.continue() : route.abort();
  });

  await page.goto(baseUrl);
  await page.getByTestId("remote-project-row").first().waitFor();
  assert.equal(await page.getByTestId("remote-project-row").count(), 2);
  assert.equal(await page.getByTestId("remote-project-cached-deleted").count(), 1);

  // 移除入口必须经过确认，且只调用本机 membership/cache removal。
  await page.getByTestId("remote-project-remove").click();
  await page.getByTestId("remote-project-remove-confirm").click();
  await page.waitForFunction(() => window.remoteProjectFixture.removed.length === 1);
  assert.deepEqual(await page.evaluate(() => window.remoteProjectFixture.removed), ["entry-live"]);

  // 缓存删除入口可以显式恢复显示；仍不发送远端删除或重建。
  await page.getByTestId("remote-project-restore").click();
  await page.waitForFunction(() => window.remoteProjectFixture.restored.length === 1);
  assert.deepEqual(await page.evaluate(() => window.remoteProjectFixture.restored), [
    "entry-deleted",
  ]);

  assert.deepEqual(errors, [], `page errors: ${errors.join("; ")}`);
  console.log("remote projects UI smoke passed");
} finally {
  await browser?.close();
  server.close();
  await rm(tempRoot, { recursive: true, force: true });
}
