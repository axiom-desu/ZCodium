// Real navigator in isolated Chromium; fixture CSS only constrains virtual-rail geometry.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright-core";

const root = resolve(import.meta.dirname, "../..");
let browser;
let server;
try {
  const { outputFiles } = await build({
    entryPoints: [resolve(import.meta.dirname, "fixtures/conversation-navigator.jsx")],
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
    jsx: "automatic",
    alias: { "@": resolve(root, "packages/ui/src") },
    define: { "process.env.NODE_ENV": '"production"' },
  });
  server = createServer((request, response) => {
    if (request.url !== "/" && request.url !== "/fixture.js") {
      response.writeHead(404).end();
      return;
    }
    response.setHeader(
      "Content-Type",
      request.url === "/fixture.js" ? "text/javascript" : "text/html",
    );
    response.end(
      request.url === "/fixture.js"
        ? outputFiles[0].contents
        : `<!doctype html>
      <meta name="viewport" content="width=device-width"><style>
      /* Fixture-only virtual rail viewport; not production CSS visual coverage. */
      [data-testid="v4-turn-navigator"] { visibility:visible!important; opacity:1!important; pointer-events:auto!important; transform:none!important; position:fixed!important; left:0!important; top:40px!important; bottom:0!important; width:64px!important; }
      [data-testid="v4-turn-navigator"] > div:first-child { position:absolute!important; left:8px!important; top:0!important; bottom:0!important; width:48px!important; max-height:none!important; transform:none!important; overflow-y:auto!important; overflow-x:hidden!important; }
      [data-testid="v4-turn-navigator"] > div:first-child > div { position:relative!important; width:40px!important; }
      [data-testid="v4-turn-navigator"] > div:first-child > div > div { position:absolute!important; left:0!important; top:0!important; height:10px!important; width:40px!important; pointer-events:none!important; }
      [data-testid="v4-turn-navigator"] [data-testid^="v4-turn-navigator-item-"] { width:40px!important; height:10px!important; pointer-events:auto!important; }
      .controls { position:fixed; left:80px; top:8px; z-index:1000; display:flex; gap:4px; }
      </style><div id="root"></div><script type="module" src="/fixture.js"></script>`,
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.ZCODE_TEST_CHROMIUM_EXECUTABLE || undefined,
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  const externalRequests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    if (new URL(route.request().url()).hostname === "127.0.0.1") return route.continue();
    externalRequests.push(route.request().url());
    return route.abort();
  });
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const rail = page.locator('[data-testid="v4-turn-navigator"]');
  await rail.waitFor({ state: "visible" });
  const itemFor = (rowId) =>
    page.locator(`[data-testid^="v4-turn-navigator-item-"][data-query-row-id="${rowId}"]`);
  const visibleTooltip = () =>
    page.locator('[data-testid^="v4-turn-navigator-tooltip-"]:visible').first();
  const waitTooltip = () => visibleTooltip().waitFor({ state: "visible" });
  const expectDom = (predicate) => page.waitForFunction(predicate, undefined, { timeout: 5000 });

  await itemFor(3001).hover();
  await waitTooltip();
  await expectDom(() => {
    const text =
      [...document.querySelectorAll('[data-testid^="v4-turn-navigator-tooltip-"]')].find(
        (element) => element.getClientRects().length > 0,
      )?.innerText ?? "";
    return /alpha question 1/.test(text) && /alpha answer 1/.test(text);
  });
  await page.getByTestId("clock").click();
  await expectDom(() => document.querySelector('[data-testid="revision"]')?.textContent === "1");
  await page.getByTestId("replace").click();
  await itemFor(3001).waitFor({ state: "attached" });
  await itemFor(3001).hover();
  await waitTooltip();
  await expectDom(
    () =>
      document
        .querySelector('[data-testid^="v4-turn-navigator-tooltip-"]')
        ?.innerText.includes("IMMUTABLE REPLACED ASSISTANT") ?? false,
  );

  // The transition populates previews, then a sibling suspends. Abandon it and
  // verify a fresh committed render cannot show its discarded assistant text.
  await page.getByTestId("pending").click();
  await expectDom(() => window.navigatorSuspendedAttempts > 0);
  assert.equal(await page.getByTestId("pending-fallback").count(), 0);
  await page.getByTestId("cancel-pending").click();
  await itemFor(3001).hover();
  await waitTooltip();
  await expectDom(() => {
    const text =
      [...document.querySelectorAll('[data-testid^="v4-turn-navigator-tooltip-"]')].find(
        (element) => element.getClientRects().length > 0,
      )?.innerText ?? "";
    return text.includes("IMMUTABLE REPLACED ASSISTANT") && !text.includes("ABANDONED");
  });

  // Scroll the actual rail div first: virtual rows outside its window are not mounted/focusable.
  await rail.locator(":scope > div").evaluate((element) => {
    element.scrollTop = 50 * 10;
  });
  await itemFor(3151).waitFor({ state: "attached" });
  await itemFor(3151).focus();
  await waitTooltip();
  await page.keyboard.press("Enter");
  await expectDom(() =>
    JSON.parse(document.querySelector('[data-testid="actions"]')?.textContent ?? "[]").some(
      (target) => target.rowId === 3151 && target.unitIndex === 50,
    ),
  );
  await page.getByTestId("prepend").click();
  await itemFor(2701).waitFor({ state: "attached" });
  await itemFor(3151).click();
  await expectDom(() => {
    const actions = JSON.parse(
      document.querySelector('[data-testid="actions"]')?.textContent ?? "[]",
    );
    return actions.at(-1)?.rowId === 3151 && actions.at(-1)?.unitIndex === 51;
  });

  // Turn 3 has no assistant. Verify en-US fallback then in-place zh-CN localization.
  await itemFor(3007).waitFor({ state: "attached" });
  await itemFor(3007).hover();
  await waitTooltip();
  await expectDom(
    () =>
      [...document.querySelectorAll('[data-testid^="v4-turn-navigator-tooltip-"]')]
        .find((element) => element.getClientRects().length > 0)
        ?.innerText.includes("No assistant text yet") ?? false,
  );
  const itemBeforeLocale = await itemFor(3007).getAttribute("data-testid");
  await page.getByTestId("locale").click();
  await itemFor(3007).hover();
  await waitTooltip();
  await expectDom(
    () =>
      [...document.querySelectorAll('[data-testid^="v4-turn-navigator-tooltip-"]')]
        .find((element) => element.getClientRects().length > 0)
        ?.innerText.includes("暂无助手正文") ?? false,
  );
  assert.equal(await itemFor(3007).getAttribute("data-testid"), itemBeforeLocale);

  await page.getByTestId("running").click();
  await rail.locator(":scope > div").evaluate((element) => {
    element.scrollTop = 100 * 10;
  });
  await itemFor(3298).waitFor({ state: "attached" });
  await expectDom(
    () =>
      document.querySelector('[data-query-row-id="3298"]')?.getAttribute("data-running") === "true",
  );
  await itemFor(3298).hover();
  await waitTooltip();
  await expectDom(
    () =>
      [...document.querySelectorAll('[data-testid^="v4-turn-navigator-tooltip-"]')]
        .find((element) => element.getClientRects().length > 0)
        ?.innerText.includes("助手仍在工作") ?? false,
  );
  await page.getByTestId("session").click();
  await itemFor(3001).waitFor({ state: "attached" });
  await expectDom(
    () => document.querySelector('[data-testid="v4-turn-navigator"] > div')?.scrollTop < 10,
  );
  await itemFor(3001).hover();
  await waitTooltip();
  await expectDom(() => {
    const text =
      [...document.querySelectorAll('[data-testid^="v4-turn-navigator-tooltip-"]')].find(
        (element) => element.getClientRects().length > 0,
      )?.innerText ?? "";
    return (
      text.includes("beta question 1") && text.includes("beta answer 1") && !text.includes("alpha")
    );
  });

  const renderedCount = Number(await rail.getAttribute("data-rendered-item-count"));
  assert.ok(renderedCount < 100, `virtualized rail rendered ${renderedCount} of 100 items`);
  assert.deepEqual(externalRequests, []);
  assert.deepEqual(errors, []);
  console.log(
    `Conversation navigator smoke passed (virtual rail rendered ${renderedCount} items).`,
  );
} finally {
  await browser?.close();
  if (server?.listening) await new Promise((done) => server.close(done));
}
