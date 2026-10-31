import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { WebSocketServer } from "ws";

const root = resolve(import.meta.dirname, "../..");
const { outputFiles } = await build({
  entryPoints: [resolve(root, "packages/web/src/main.tsx")],
  bundle: true,
  write: false,
  platform: "browser",
  format: "esm",
  jsx: "automatic",
  loader: { ".css": "empty", ".png": "dataurl" },
  define: { "process.env.NODE_ENV": '"production"', "import.meta.env": "{}" },
  plugins: [
    {
      name: "observe-root-boundary",
      setup(builder) {
        builder.onResolve({ filter: /^@zcode\/ui$/ }, () => ({
          path: resolve(import.meta.dirname, "fixtures/web-entry-ui.jsx"),
        }));
      },
    },
  ],
});
const assets =
  process.env.ZCODE_TEST_RENDERER_ASSETS || resolve(root, "packages/desktop/out/renderer/assets");
const cssName = (await readdir(assets)).find((name) => /^styles-.*\.css$/.test(name));
assert.ok(cssName, "Build desktop CSS before the Web entry walkthrough");
const css = await readFile(resolve(assets, cssName), "utf8");
const html = (await readFile(resolve(root, "packages/web/index.html"), "utf8"))
  .replace('src="/src/main.tsx"', 'src="/fixture.js"')
  .replace("</head>", '<link rel="stylesheet" href="/style.css"></head>');
const traffic = [],
  connections = [],
  rejected = [];
const server = createServer((request, response) => {
  traffic.push({ url: request.url, referer: request.headers.referer });
  if (request.url === "/fixture.js") {
    response.setHeader("Content-Type", "text/javascript");
    response.end(outputFiles[0].contents);
  } else if (request.url === "/style.css") {
    response.setHeader("Content-Type", "text/css");
    response.end(css);
  } else if (request.url === "/api/server-info") {
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        workspaces: [{ path: "/fixture/server", workspaceIdentity: "fixture-server-identity" }],
      }),
    );
  } else {
    response.setHeader("Content-Type", "text/html");
    response.end(html);
  }
});
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (request, socket, head) => {
  if (request.headers.cookie !== "fixture_access=allowed") {
    rejected.push(request.url);
    socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    return;
  }
  connections.push(request.url);
  wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.ZCODE_TEST_CHROMIUM_EXECUTABLE || undefined,
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [],
    outside = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    outside.push(route.request().url());
    return route.abort();
  });
  // The ordinary self-hosted access check must still reject unauthenticated sockets.
  await page.goto(origin);
  await page.getByRole("button", { name: "Retry", exact: true }).waitFor();
  assert.deepEqual(rejected, ["/ws"]);
  assert.equal(await page.getByText("Local workspace ready").count(), 0);
  await context.addCookies([{ name: "fixture_access", value: "allowed", url: origin }]);
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await page.getByText("Local workspace ready").waitFor();
  assert.deepEqual(await page.evaluate(() => window.webEntryFixture), {
    workspacePath: "/fixture/server",
    workspaceIdentity: "fixture-server-identity",
    hasCredentials: true,
    hasOfficialOAuth: false,
  });
  assert.equal(connections.at(-1), "/ws");
  const beforeRemote = traffic.filter((request) => request.url === "/api/server-info").length;
  await page.goto(`${origin}/?remote=fixture-session`);
  await page.getByText("Local workspace ready").waitFor();
  assert.equal(connections.at(-1), "/ws/remote/fixture-session");
  assert.equal(
    traffic.filter((request) => request.url === "/api/server-info").length,
    beforeRemote,
  );

  for (const path of ["/share/callback", "/cn/share/callback/", "/share/callback/"]) {
    const state = JSON.stringify({
      nonce: "fixture-code",
      app_return_to: "https://fixture.invalid/steal",
      return_to: "https://fixture.invalid/steal",
    });
    const query = new URLSearchParams({
      state,
      code: "fixture-code",
      access_token: "fixture-token",
      remote: "untrusted-callback-target",
    });
    await page.goto(`${origin}${path}?${query}#fixture-secret`);
    await page.getByText("Local workspace ready").waitFor();
    assert.equal(page.url(), `${origin}/`);
    assert.equal(connections.at(-1), "/ws");
    assert.equal(await page.evaluate(() => localStorage.length), 0);
    assert.equal(await page.evaluate(() => sessionStorage.length), 0);
  }
  assert.ok(
    traffic.every((request) => request.referer === undefined),
    "callback credentials must not leak in resource or API referers",
  );
  assert.ok(!traffic.some((request) => request.url.startsWith("/api/v1/oauth")));
  assert.deepEqual(outside, []);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: resolve(tmpdir(), "zcodium-web-entry-no-oauth.png") });
  console.log(
    "Actual Web entry and WebSocket checks passed: local bootstrap, remote routing, self-hosted 401/retry, retired callback sanitization, no OAuth storage or outbound requests",
  );
} finally {
  await browser?.close();
  for (const client of wss.clients) client.terminate();
  await new Promise((resolve) => wss.close(resolve));
  await new Promise((resolve) => server.close(resolve));
}
