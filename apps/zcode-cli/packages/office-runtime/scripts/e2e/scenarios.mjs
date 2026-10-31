import { join } from "node:path";
import { appendFile, copyFile, rm, writeFile } from "node:fs/promises";
import { assertBarsAtTop, reportFailure } from "./checks.mjs";
import { runCjkScenario } from "./cjk.mjs";

/**
 * The browser/AppBridge acceptance flow for one built viewer plugin. Helpers and the
 * server/browser/client handles are injected so the entry script stays about setup.
 */
export async function runScenarios(ctx) {
  const {
    assert,
    open,
    agent,
    capture,
    getView,
    waitForView,
    artifacts,
    workspace,
    root,
    base,
    has,
    name,
    kinds,
    browser,
    server,
    client,
    errors,
  } = ctx;
  try {
    const width = Number(process.env.OFFICE_E2E_WIDTH || 900);
    let { outer, frame } = await open();
    const shot = (name) => outer.screenshot({ path: join(artifacts, name) });
    let bar = frame.locator(".pop.bar");
    await frame.locator(".empty-open").waitFor();
    await shot("empty.png");
    const tools = await outer.evaluate(() => window.__listPageTools());
    assert.deepEqual(
      tools.tools.map((tool) => tool.name),
      ["capture_view"],
    );

    // 1. File browser → docx; click a paragraph; reference it in chat.
    if (has("docx")) {
      const chooser = outer.waitForEvent("filechooser");
      await frame.locator(".empty-open").click();
      await (await chooser).setFiles(join(root, "fixtures/report.docx"));
      await frame.locator('[data-at="p:4"]').first().waitFor({ timeout: 20000 });
      await outer.reload();
      await outer.waitForFunction(() => window.__initializations === 1);
      const restored = outer.frames().find((item) => item !== outer.mainFrame());
      await restored.locator('[data-at="p:4"]').first().waitFor({ timeout: 20000 });
      // 同一存储分区内的新窗口不能继承服务器的最后文档。
      await outer.goto(base + "/?tab=second");
      await outer.waitForFunction(() => window.__initializations === 1);
      const fresh = outer.frames().find((item) => item !== outer.mainFrame());
      await fresh.locator(".empty-open").waitFor();
      await outer.goto(base);
      await outer.waitForFunction(() => window.__initializations === 1);
      frame = outer.frames().find((item) => item !== outer.mainFrame());
      bar = frame.locator(".pop.bar");
      await frame.locator('[data-at="p:4"]').first().waitFor({ timeout: 20000 });
      await agent(outer, "open_document", { path: "docs/report.docx" });
      await frame.locator('[data-at="p:4"]').first().waitFor({ timeout: 20000 });
      await frame.locator('[data-at="t:1"]').first().waitFor();
      await frame.locator(".pill").waitFor();
      await frame.locator('[data-at="p:4"]').first().click();
      await bar.locator(".where", { hasText: "Paragraph 4" }).waitFor();
      await bar.getByRole("button", { name: "Add to chat" }).click();
      await outer.waitForFunction(() => window.__context !== null);
      const context = await outer.evaluate(() => window.__context);
      assert.match(context.content[0].text, /docs\/report\.docx#p:4: "Revenue grew by 12 percent/);
      await bar.getByText("Added to chat").waitFor();
      await bar.waitFor({ state: "detached", timeout: 4000 });
      await waitForView(/User selection: docs\/report\.docx#p:4/);
      // A table cell click addresses the cell.
      await frame.locator('[data-at="t:1"] td', { hasText: "South" }).click();
      await bar.locator(".where", { hasText: "Table 1 · R3C1" }).waitFor();
      // Ask: the bar grows into a question box and posts a user message with the anchor.
      await bar.getByRole("button", { name: "Ask" }).click();
      await frame.getByPlaceholder("Ask about this…").fill("Is this region growing?");
      await shot("docx-ask.png");
      await frame.locator(".pop.ask").getByRole("button", { name: "Send" }).click();
      await outer.waitForFunction(() => window.__messages.length === 1);
      assert.match(
        await outer.evaluate(() => window.__messages[0]),
        /Is this region growing\?[\s\S]*docs\/report\.docx#t:1\/r3c1/,
      );
      await frame.locator(".pop").waitFor({ state: "detached" });
      // Agent points at a paragraph with a quote: amber mark and a note beside it.
      await agent(outer, "show_in_viewer", {
        targets: [{ anchor: "docs/report.docx#p:6", quote: "steady growth" }],
        note: "Outlook",
      });
      await frame.locator(".callout", { hasText: "Outlook" }).waitFor();
      await shot("docx-panel.png");
      assert.match(
        await capture(outer, { anchor: "docs/report.docx#p:6" }, "docx.png"),
        /Captured docs\/report\.docx#p:6/,
      );
    }

    // 2. Agent opens the PDF at page 2; text layer, quote highlight, link routing, capture.
    if (has("pdf")) {
      await agent(outer, "open_document", { path: "docs/paper.pdf", at: "page:2" });
      await frame
        .locator('.pdf-page[data-at="page:1"] .textLayer span')
        .first()
        .waitFor({ timeout: 20000 });
      await frame.locator(".textLayer span", { hasText: "缓存显著降低延迟" }).waitFor();
      await waitForView(/Visible location: docs\/paper\.pdf#page:2/);
      await frame.locator(".pill .pgin").waitFor();
      // Several targets: the callout steps through them.
      await agent(outer, "show_in_viewer", {
        targets: [
          { anchor: "docs/paper.pdf#page:1", quote: "40 percent reduction" },
          { anchor: "docs/paper.pdf#page:2" },
        ],
        note: "Headline result",
      });
      await frame.locator(".callout", { hasText: "Agent · 1 of 2" }).waitFor();
      await shot("pdf-agent.png");
      await frame.locator(".callout").getByRole("button", { name: "Next" }).click();
      await frame.locator(".callout", { hasText: "Agent · 2 of 2" }).waitFor();
      await frame.locator(".callout").getByRole("button", { name: "Close" }).click();
      await frame.locator(".callout").waitFor({ state: "detached" });
      // Clicking a mark brings its note back (scroll back to it first: Next moved to page 2).
      await frame.evaluate(() => document.querySelector(".viewer-scroll").scrollTo({ top: 0 }));
      await new Promise((done) => setTimeout(done, 300));
      const mark = await frame.evaluate(() => {
        const range = [...CSS.highlights.get("office-reveal")][0];
        const rect = range.getClientRects()[0];
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      });
      await frame.page().mouse.click(mark.x, mark.y);
      await frame.locator(".callout", { hasText: "Agent · 1 of 2" }).waitFor();
      assert.equal(await bar.count(), 0, "a click on a mark opens no selection bar");
      await frame.locator(".callout").getByRole("button", { name: "Close" }).click();
      await frame.locator(".pdf-link").first().click();
      await outer.waitForFunction(() => window.__links.length === 1);
      assert.equal(await outer.evaluate(() => window.__links[0]), "https://example.com/paper");
      const box = await frame.locator(".textLayer span", { hasText: "Abstract" }).boundingBox();
      await frame
        .locator('.pdf-page[data-at="page:1"]')
        .first()
        .evaluate(() => {
          const span = [...document.querySelectorAll(".textLayer span")].find((item) =>
            item.textContent.includes("Abstract"),
          );
          const range = document.createRange();
          range.selectNodeContents(span);
          getSelection().removeAllRanges();
          getSelection().addRange(range);
        });
      await frame
        .locator(".textLayer span", { hasText: "Abstract" })
        .dispatchEvent("mouseup", { clientX: box.x, clientY: box.y });
      await bar.getByRole("button", { name: "Copy" }).waitFor();
      await waitForView(/Selected text: """Abstract/);
      await shot("pdf-selection.png");
      await bar.getByRole("button", { name: "Add to chat" }).click();
      await outer.waitForFunction(() =>
        /paper\.pdf#page:1/.test(window.__context?.content[0].text),
      );
      assert.match(
        await outer.evaluate(() => window.__context.content[0].text),
        /docs\/paper\.pdf#page:1: "Abstract/,
      );
      // Find: search as you type, count, step, Esc closes.
      await frame.getByRole("button", { name: "Find" }).click();
      await frame.getByLabel("Find", { exact: true }).fill("percent");
      await frame.locator(".findfield .count", { hasText: /^1 of \d+$/ }).waitFor();
      await frame.getByLabel("Find", { exact: true }).press("Enter");
      await frame.locator(".findfield .count", { hasText: /^2 of \d+$|^1 of 1$/ }).waitFor();
      await shot("pdf-find.png");
      await frame.getByLabel("Find", { exact: true }).press("Escape");
      await frame.locator(".findbar").waitFor({ state: "detached" });
      // Zoom from the page control and back through the More menu.
      // 指针离开 1.5s 后面板控件会淡出（pointer-events:none），先强制悬停把控件唤醒。
      await frame.locator(".pill").hover({ force: true });
      await frame.getByRole("button", { name: "Zoom in (⌘+)" }).click();
      await frame.locator(".pill .zoom", { hasText: "%" }).waitFor();
      await frame.getByRole("button", { name: "More" }).click();
      await frame.getByRole("menuitemradio", { name: "Fit width" }).click();
      await frame.locator(".pill .zoom", { hasText: "Fit" }).waitFor();
      // Pages drawer: thumbnails; picking one goes there.
      await frame.getByRole("button", { name: "Pages and outline" }).click();
      await frame.locator(".drawer .thumb canvas").first().waitFor({ timeout: 10000 });
      await shot("pdf-drawer.png");
      await frame.locator('.drawer .thumb[data-page="2"]').click();
      await waitForView(/Visible location: docs\/paper\.pdf#page:2/);
      if (width < 720) await frame.locator(".drawer").waitFor({ state: "detached" });
      else await frame.getByRole("button", { name: "Pages and outline" }).click();
      assert.match(await capture(outer, { anchor: "docs/paper.pdf#page:1" }, "pdf.png"), /page:1/);
      assert.equal(
        await frame.evaluate(() =>
          Math.round(document.querySelector(".docbar").getBoundingClientRect().top),
        ),
        0,
        "the document bar stays at the top of the panel",
      );
      await shot("pdf-panel.png");
    }

    // 2b. PDF CJK fonts and text normalization.
    await runCjkScenario({ assert, has, agent, outer, frame, open, artifacts, join, shot });

    // 3. Presentation: slide rendering, shape hit testing, reveal of a shape, capture.
    if (has("pptx")) {
      await agent(outer, "open_document", { path: "docs/launch.pptx" });
      await frame
        .locator('.slide-frame[data-at="slide:2"] .slide-host > :not(.slide-overlay)')
        .first()
        .waitFor({ timeout: 20000 });
      const hit = (
        await client.callTool({
          name: "search_document",
          arguments: { path: "docs/launch.pptx", query: "Owner" },
        })
      ).structuredContent.hits[0].anchor;
      await agent(outer, "show_in_viewer", { targets: [{ anchor: hit }] });
      await frame.locator(".shape-revealed").waitFor();
      await new Promise((done) => setTimeout(done, 1000)); // let the smooth scroll settle
      const owner = await frame.locator(".shape-revealed").boundingBox();
      await frame.page().mouse.click(owner.x + owner.width / 2, owner.y + owner.height / 2);
      await bar.locator(".where", { hasText: "Slide 2 · Shape" }).waitFor();
      const selected = await waitForView(/User selection: docs\/launch\.pptx#slide:2\/shape:\d+/);
      assert.ok(selected.includes(`User selection: ${hit}`), selected);
      assert.match(selected, /Owner: Dana/);
      assert.match(
        await capture(outer, { anchor: "docs/launch.pptx#slide:3" }, "pptx.png"),
        /slide:3/,
      );
      await shot("pptx-panel.png");
    }

    // 4. Spreadsheet (wasm under CSP): reveal a range, select cells, capture.
    if (has("xlsx")) {
      await agent(outer, "show_in_viewer", {
        targets: [{ anchor: "docs/budget.xlsx#Revenue!B2:D4" }],
      });
      await waitForView(/Visible location: docs\/budget\.xlsx#Revenue/);
      await waitForView(/User selection: docs\/budget\.xlsx#Revenue!B2:D4/);
      const view = await getView();
      assert.match(view, /100\t110\t120/);
      await agent(outer, "show_in_viewer", { targets: [{ anchor: "docs/budget.xlsx#Notes!B2" }] });
      await frame.locator(".sheet-tabs button.active", { hasText: "Notes" }).waitFor();
      assert.match(await capture(outer, {}, "xlsx.png"), /Captured docs\/budget\.xlsx#Notes/);
      // The grid is a canvas: press inside it and the bar names the cell that got selected.
      const grid = await frame.locator(".xlsx-grid").boundingBox();
      await frame.page().mouse.click(grid.x + grid.width * 0.4, grid.y + grid.height * 0.25);
      await bar.locator(".where", { hasText: /^Notes · [A-Z]+\d+$/ }).waitFor();
      await shot("xlsx-panel.png");
    }

    // capture_view refuses a document that is not open.
    const refused = await outer.evaluate(
      (anchor) => window.__callPageTool("capture_view", { anchor }),
      {
        docx: "docs/other.docx#p:1",
        xlsx: "docs/other.xlsx#Sheet1!A1",
        pptx: "docs/other.pptx#slide:1",
        pdf: "docs/other.pdf#page:1",
      }[kinds[0]],
    );
    assert.ok(refused.isError && /open_document/.test(refused.content[0].text));

    // 两个窗口上报后，模型必须先选择窗口，不能收到最后上报者的选区。
    await client.callTool({
      name: "report_view",
      arguments: {
        viewId: "other-window",
        path: {
          docx: "docs/report.docx",
          pdf: "docs/paper.pdf",
          xlsx: "docs/budget.xlsx",
          pptx: "docs/launch.pptx",
        }[kinds[0]],
        at: null,
      },
    });
    const ambiguous = await client.callTool({ name: "get_view", arguments: {} });
    assert.equal(ambiguous.structuredContent.ambiguous, true);
    assert.ok(ambiguous.structuredContent.views.some((view) => view.viewId === "other-window"));
    await client.callTool({ name: "release_view", arguments: { viewId: "other-window" } });

    // 5. The file changes on disk: a notice offers to reload.
    if (has("pdf")) {
      await copyFile(join(workspace, "docs/paper.pdf"), join(workspace, "docs/draft.pdf"));
      await agent(outer, "open_document", { path: "docs/draft.pdf" });
      // Wait for the panel to report the new file: the previous PDF's canvas matches too, and
      // editing the file before the panel loads it would leave nothing to notice.
      await waitForView(/Visible location: docs\/draft\.pdf/);
      await frame.locator('.pdf-page[data-at="page:1"] canvas').waitFor({ timeout: 20000 });
      await appendFile(join(workspace, "docs/draft.pdf"), "\n% edited\n");
      await frame
        .locator(".banner", { hasText: "This file changed on disk." })
        .waitFor({ timeout: 10000 });
      await shot("changed.png");
      await frame.locator(".banner").getByRole("button", { name: "Reload" }).click();
      await frame.locator(".banner").waitFor({ state: "detached" });
      await frame.locator('.pdf-page[data-at="page:1"] canvas').waitFor({ timeout: 20000 });

      // 6. A damaged file shows a plain error with one way forward.
      await writeFile(join(workspace, "docs/broken.pdf"), "not a pdf");
      const brokenChooser = outer.waitForEvent("filechooser");
      await frame.getByRole("button", { name: /Switch document/ }).click();
      await frame.getByRole("menuitem", { name: "Open file" }).click();
      await (await brokenChooser).setFiles(join(workspace, "docs/broken.pdf"));
      await frame.locator(".failed h3").waitFor();
      await shot("error.png");
      const retryChooser = outer.waitForEvent("filechooser");
      await frame.getByRole("button", { name: "Open another file" }).click();
      await (await retryChooser).setFiles(join(workspace, "docs/paper.pdf"));
      await frame.locator(".pdf-page canvas").first().waitFor({ timeout: 20000 });
    }

    // 7. 新的深色中文窗口由 Agent 显式打开文档，不继承其他窗口。
    const inline = has("xlsx")
      ? ["docs/budget.xlsx", ".xlsx-root"]
      : has("pdf")
        ? ["docs/paper.pdf", ".pdf-page canvas"]
        : has("pptx")
          ? [
              "docs/launch.pptx",
              '.slide-frame[data-at="slide:1"] .slide-host > :not(.slide-overlay)',
            ]
          : ["docs/report.docx", '[data-at="p:1"]'];
    await agent(outer, "open_document", { path: inline[0] });
    const dark = await open("?theme=dark&locale=zh-CN&mode=inline", { width: 420, height: 380 });
    await agent(dark.outer, "open_document", { path: inline[0] });
    await dark.frame.locator(inline[1]).first().waitFor({ timeout: 20000 });
    assert.equal(await dark.frame.locator("html").getAttribute("data-theme"), "dark");
    await dark.frame.getByRole("button", { name: "在侧栏打开" }).first().waitFor();
    assert.ok(
      await dark.frame.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      "no horizontal overflow at 420px",
    );
    await dark.outer.screenshot({ path: join(artifacts, "zh-dark-inline.png") });

    // 8. Dark side panel opened by the agent while ZCode animates the pane's width: the mark must
    // end up on the live text layer, not on one a resize replaced.
    const darkPanel = has("pdf") ? await open("?theme=dark", { width: 300, height: 760 }) : null;
    if (darkPanel) {
      await agent(darkPanel.outer, "show_in_viewer", {
        targets: [{ anchor: "docs/paper.pdf#page:1", quote: "40 percent reduction" }],
        note: "The headline result.",
      });
      for (let w = 300; w <= 460; w += 8) {
        await darkPanel.outer.setViewportSize({ width: w, height: 760 });
        await new Promise((done) => setTimeout(done, 16));
      }
      await darkPanel.outer.setViewportSize({ width: 440, height: 760 });
      await darkPanel.frame.locator(".callout", { hasText: "The headline result." }).waitFor({
        timeout: 20000,
      });
      await darkPanel.frame.waitForFunction(
        () => {
          const ranges = [...(CSS.highlights.get("office-reveal") ?? [])];
          return ranges.some((range) => {
            const rect = range.getBoundingClientRect();
            return (
              range.startContainer.isConnected &&
              range.startContainer.parentElement?.closest(".textLayer")?.isConnected &&
              rect.width > 0 &&
              rect.top >= 0 &&
              rect.bottom <= innerHeight
            );
          });
        },
        null,
        { timeout: 10000 },
      );
      await darkPanel.outer.screenshot({ path: join(artifacts, "pdf-dark.png") });
    }

    await assertBarsAtTop(assert, [frame, dark.frame, darkPanel?.frame]);
    assert.deepEqual(errors, []);
    process.stdout.write(`${name} e2e (${kinds.join(", ")}): ok (screenshots in ${artifacts})\n`);
  } catch (error) {
    // 先输出断言错误，避免连接清理等待掩盖实际失败位置。
    await reportFailure({ error, browser, errors, artifacts, join });
    throw error;
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    await client.close();
    await rm(workspace, { recursive: true, force: true });
  }
}
