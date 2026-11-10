import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { buildFreshUiCss, makeTempDirs, readWebEntry } from "./web-profile-mobile-fixture.mjs";
import { buildComposerFocusFixtureScript } from "./composer-mobile-focus-fixture.mjs";

// 真实 ConversationComposer 的手机焦点回归（spec：.agents/specs/web-profile-mobile.md）。
// 夹具 (packages/ui/test/fixtures/conversation-composer-mobile-focus.jsx) 只挂生产组件：
// snapshot=null + draftMode + composerDraft，服务/平台是内存 fake，不读真实配置、不联网。
// 断言对象是浏览器事实（document.activeElement），不模拟任何焦点决策：
// - 手机（真实 packages/web/index.html 的 data-zcode-entry=web + 390px 视口）草稿恢复后不得聚焦；
// - 手机重挂载且 autoFocusEnabled=false 同样不得聚焦；
// - 桌面默认（autoFocusEnabled 缺省 true）恢复草稿后必须聚焦（正向对照，证明手机结论不是「永远不聚焦」）。
// 桌面 autoFocusEnabled=false 的焦点只打印观测值：Lexical 程序化恢复的抢焦点与视口无关，
// 而本片 spec 只收口手机分支，给它加断言会让用例在正确的手机修复下仍然红。
//
// 手机/桌面各自「先设视口再导航」的独立页面：不在已挂载的 composer 上改视口。
// 夹具缺少真实壳层的全部宿主 props，运行期 resize 会把它推进与产品无关的重排循环；
// 用两个页面既能保证视口语义（matchMedia 在导航前已确定），也不会伪造焦点结论。
const root = resolve(import.meta.dirname, "../..");
const cacheDir = resolve(root, "node_modules/.cache");
const COMPOSER_INPUT_SELECTOR = '[data-testid="v4-composer-input"]';
const MOBILE_VIEWPORT = { width: 390, height: 844 };
const DESKTOP_VIEWPORT = { width: 1280, height: 860 };
const MOBILE_TEXT = "mobile restored plain draft";
const MOBILE_JSON_TEXT = "mobile restored json draft";
const MOBILE_MENTION_TEXT = "mobile restored mention draft";
const MOBILE_NO_AUTOFOCUS_TEXT = "mobile restored draft without autofocus";
const DESKTOP_TEXT = "desktop restored draft";
const DESKTOP_NO_AUTOFOCUS_TEXT = "desktop restored draft without autofocus";
const MENTION = {
  id: "fixture-file",
  category: "files",
  label: "fixture.ts",
  value: "/fixture/workspace/fixture.ts",
  markdown: "[@fixture.ts](/fixture/workspace/fixture.ts)",
};
const MENTION_TEXT = `${MENTION.markdown} ${MOBILE_MENTION_TEXT}`;
// 草稿恢复在 rAF 里，自动聚焦兑现再排一帧；给足稳定窗口再把「没有焦点」当事实断言。
const FOCUS_SETTLE_MS = 500;

let dirs;
let server;
let context;
try {
  await mkdir(cacheDir, { recursive: true });
  dirs = await makeTempDirs(cacheDir);
  const fixtureScript = await buildComposerFocusFixtureScript(root, cacheDir);
  const css = await buildFreshUiCss(root, dirs.tempDir);
  const { raw: rawIndexHtml, html: indexHtml } = await readWebEntry(root);
  assert.match(
    rawIndexHtml,
    /data-zcode-entry\s*=\s*["']web["']/u,
    "packages/web/index.html must declare data-zcode-entry=web; mobile viewport detection reads it",
  );

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
    response.end(indexHtml);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;

  context = await chromium.launchPersistentContext(dirs.profileDir, {
    headless: true,
    executablePath: process.env.ZCODE_TEST_CHROMIUM_EXECUTABLE || undefined,
    viewport: MOBILE_VIEWPORT,
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
  const external = [];
  context.on("request", (request) => {
    if (new URL(request.url()).hostname !== "127.0.0.1") external.push(request.url());
  });
  await context.route("**/*", (route) => {
    if (new URL(route.request().url()).hostname === "127.0.0.1") return route.continue();
    return route.abort();
  });
  await context.addInitScript(() => localStorage.clear());
  // persistent context 自带的空白页会让测试页变后台标签页，rAF 被节流后焦点断言会抖动。
  for (const initialPage of context.pages()) await initialPage.close();

  const attachDiagnostics = (page) => {
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
  };

  /** 先设视口再导航：视口语义由 matchMedia 在首帧确定，不依赖运行期 resize。 */
  const openComposerPage = async (viewport) => {
    const page = await context.newPage();
    await page.setViewportSize(viewport);
    attachDiagnostics(page);
    await page.bringToFront();
    await page.goto(`${origin}/?surface=web`);
    await page.getByTestId("composer-focus-harness").waitFor();
    await page.locator(COMPOSER_INPUT_SELECTOR).waitFor();
    return page;
  };

  const readFocus = (page) =>
    page.evaluate((selector) => {
      const input = document.querySelector(selector);
      const active = document.activeElement;
      return {
        documentHasFocus: document.hasFocus(),
        activeTag: active?.tagName ?? null,
        activeTestId: active?.getAttribute?.("data-testid") ?? null,
        editorFocused: Boolean(input && active && (active === input || input.contains(active))),
      };
    }, COMPOSER_INPUT_SELECTOR);

  const readMounts = (page) => page.evaluate(() => window.composerMobileFixture.mounts);

  /** 让夹具以给定草稿/autoFocusEnabled 重挂载真实 composer，并等恢复与焦点落定。 */
  const remount = async (page, { autoFocusEnabled, draft, expectText }) => {
    const mountsBefore = await readMounts(page);
    await page.evaluate(
      ({ next }) => {
        window.composerMobileFixture.blurActiveElement();
        window.composerMobileFixture.remount(next);
      },
      { next: { autoFocusEnabled, draft } },
    );
    // 重挂载是异步渲染 + effect：等 mount 计数真正递增，再等草稿落到真实编辑器。
    await page.waitForFunction(({ expected }) => window.composerMobileFixture.mounts === expected, {
      expected: mountsBefore + 1,
    });
    await page.locator(COMPOSER_INPUT_SELECTOR).waitFor();
    await page.waitForFunction(
      ({ expected }) => window.composerMobileFixture.readEditorText() === expected,
      { expected: expectText },
    );
    await page.waitForTimeout(FOCUS_SETTLE_MS);
    return readFocus(page);
  };

  // ── 手机：390x844 + 真实 Web 入口标记 ──────────────────────────────
  const mobilePage = await openComposerPage(MOBILE_VIEWPORT);
  const mobileContext = await mobilePage.evaluate(() => ({
    entry: document.documentElement.dataset.zcodeEntry ?? null,
    mobileViewport: window.matchMedia("(max-width: 767px)").matches,
  }));
  assert.equal(mobileContext.entry, "web", "fixture must use the real Web entry marker");
  assert.equal(mobileContext.mobileViewport, true, "390x844 must be a mobile viewport");
  assert.equal(
    (await readFocus(mobilePage)).documentHasFocus,
    true,
    "mobile test page must own browser focus",
  );

  // 1) 手机 + 纯文本草稿：恢复文本，但不得抢焦点（否则会直接弹软键盘）。
  const mobilePlainFocus = await remount(mobilePage, {
    autoFocusEnabled: true,
    draft: { text: MOBILE_TEXT },
    expectText: MOBILE_TEXT,
  });
  assert.equal(
    mobilePlainFocus.editorFocused,
    false,
    `mobile draft restore must not focus the composer: ${JSON.stringify(mobilePlainFocus)}`,
  );

  // 2) 手机 + 重挂载（autoFocusEnabled=false）：同样不得聚焦。
  const mobileDisabledFocus = await remount(mobilePage, {
    autoFocusEnabled: false,
    draft: { text: MOBILE_NO_AUTOFOCUS_TEXT },
    expectText: MOBILE_NO_AUTOFOCUS_TEXT,
  });
  assert.equal(
    mobileDisabledFocus.editorFocused,
    false,
    `mobile remount without autofocus must not focus the composer: ${JSON.stringify(mobileDisabledFocus)}`,
  );

  // 3) 手机 + editorStateJson 草稿（真实 Lexical 序列化快照）：恢复后仍不得聚焦。
  //    先让真实编辑器产出一份序列化状态，再把它当作持久化草稿重挂载。
  await mobilePage.evaluate(
    ({ text, selector }) => {
      const input = document.querySelector(selector);
      window.composerMobileFixture.blurActiveElement();
      input.__zcodeLexicalInputE2E.setText(text);
    },
    { text: MOBILE_JSON_TEXT, selector: COMPOSER_INPUT_SELECTOR },
  );
  await mobilePage.waitForFunction(
    ({ expected }) => window.composerMobileFixture.readEditorText() === expected,
    { expected: MOBILE_JSON_TEXT },
  );
  const editorStateJson = await mobilePage.evaluate((selector) => {
    const input = document.querySelector(selector);
    return JSON.stringify(input.__zcodeLexicalInputE2E.getEditorState().toJSON());
  }, COMPOSER_INPUT_SELECTOR);
  assert.ok(editorStateJson.length > 2, "editor state JSON must be captured from the real editor");
  const mobileJsonFocus = await remount(mobilePage, {
    autoFocusEnabled: true,
    draft: { text: MOBILE_JSON_TEXT, editorStateJson },
    expectText: MOBILE_JSON_TEXT,
  });
  assert.equal(
    mobileJsonFocus.editorFocused,
    false,
    `mobile editorStateJson restore must not focus the composer: ${JSON.stringify(mobileJsonFocus)}`,
  );

  // 4) 手机 + mention 草稿：结构化 mention 走 setMention 恢复，同样不得聚焦。
  const mobileMentionFocus = await remount(mobilePage, {
    autoFocusEnabled: true,
    draft: { text: MENTION_TEXT, mention: MENTION },
    expectText: MENTION_TEXT,
  });
  assert.equal(
    mobileMentionFocus.editorFocused,
    false,
    `mobile mention restore must not focus the composer: ${JSON.stringify(mobileMentionFocus)}`,
  );
  await mobilePage.close();

  // ── 桌面：1280x860（不是手机视口），生产默认 autoFocusEnabled=true ──────────
  const desktopPage = await openComposerPage(DESKTOP_VIEWPORT);
  assert.equal(
    await desktopPage.evaluate(() => window.matchMedia("(max-width: 767px)").matches),
    false,
    "1280x860 must not be a mobile viewport",
  );
  const desktopFocusBefore = await readFocus(desktopPage);
  assert.equal(
    desktopFocusBefore.documentHasFocus,
    true,
    "desktop test page must own browser focus",
  );
  // 挂载期草稿恢复 + 默认自动聚焦：桌面必须把光标交还输入框。
  assert.equal(
    desktopFocusBefore.editorFocused,
    true,
    `desktop initial mount must focus the composer: ${JSON.stringify(desktopFocusBefore)}`,
  );

  // 5) 桌面 + autoFocusEnabled=false：只记录浏览器事实，不当作本片断言。
  //    根因：Lexical 程序化恢复（setText/setEditorState/setMention → selectEnd）在
  //    reconcileSelection 里调用 setBaseAndExtent，Chromium 会顺手把 contenteditable
  //    设为 activeElement；手机分支要显式跳过该 DOM selection（SKIP_DOM_SELECTION_TAG）。
  //    桌面 autoFocusEnabled=false 走的是同一条恢复路径，但本片 spec 只规定手机不抢焦点，
  //    因此这里只打印观测值，避免用一条无法在当前修法下通过的断言冒充回归。
  const desktopDisabledFocus = await remount(desktopPage, {
    autoFocusEnabled: false,
    draft: { text: DESKTOP_NO_AUTOFOCUS_TEXT },
    expectText: DESKTOP_NO_AUTOFOCUS_TEXT,
  });
  console.log(
    `[observed] desktop autoFocusEnabled=false after draft restore: editorFocused=${desktopDisabledFocus.editorFocused} (out of the mobile focus scope; not asserted)`,
  );

  // 6) 桌面默认（autoFocusEnabled=true）重挂载仍必须聚焦：证明桌面结论不是「永远不聚焦」。
  const desktopFocus = await remount(desktopPage, {
    autoFocusEnabled: true,
    draft: { text: DESKTOP_TEXT },
    expectText: DESKTOP_TEXT,
  });
  assert.equal(
    desktopFocus.editorFocused,
    true,
    `desktop default autofocus must focus the composer: ${JSON.stringify(desktopFocus)}`,
  );
  await desktopPage.close();

  assert.deepEqual(
    errors,
    [],
    `composer fixture must not emit runtime errors: ${errors.join(" | ")}`,
  );
  assert.deepEqual(external, [], `test must not request external network: ${external.join(", ")}`);
  console.log(
    "PASS conversation composer mobile focus: real ConversationComposer (snapshot=null, draftMode) on the real packages/web/index.html at 390x844 restores plain text / editorStateJson / mention drafts without focusing the editor; mobile remount with autoFocusEnabled=false also stays unfocused; desktop 1280x860 default autofocus focuses the editor on mount and again after a remount.",
  );
  console.log("Rerun: node scripts/ci/composer-mobile-focus-smoke.mjs");
} finally {
  await context?.close();
  server?.close();
  if (dirs) await rm(dirs.tempDir, { recursive: true, force: true });
}
