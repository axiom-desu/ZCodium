/**
 * PDF CJK acceptance: system same-style faces are registered before drawing, radicals are
 * normalized, and a machine without any CJK font loads the bundled fallback slices.
 */
export async function runCjkScenario(ctx) {
  const { assert, has, agent, outer, frame, open, artifacts, join, shot } = ctx;
  if (!has("pdf")) return;
  // 2b. CJK with non-embedded fonts: the panel registers same-style system CJK faces, radicals in
  // ToUnicode read as ideographs, and with no CJK font installed the bundled fallback draws them.
  if (has("pdf")) {
    await agent(outer, "open_document", { path: "docs/cjk.pdf" });
    await frame.locator(".textLayer span", { hasText: "天地玄黄" }).waitFor({ timeout: 20000 });
    assert.ok(
      await frame.evaluate(() =>
        [...document.fonts].some(
          (face) => face.family.startsWith("zcode-cjk-") && face.status === "loaded",
        ),
      ),
      "CJK faces are registered before the page is drawn",
    );
    await agent(outer, "show_in_viewer", {
      targets: [{ anchor: "docs/cjk.pdf#page:1", quote: "天地玄黄" }],
      note: "Radicals read as ideographs",
    });
    await frame.locator(".callout", { hasText: "Radicals read as ideographs" }).waitFor();
    await shot("pdf-cjk.png");
    await frame.locator(".callout").getByRole("button", { name: "Close" }).click();
    await frame.getByRole("button", { name: "Find" }).click();
    await frame.getByLabel("Find", { exact: true }).fill("文");
    await frame.locator(".findfield .count", { hasText: /^1 of 4$/ }).waitFor();
    await frame.getByLabel("Find", { exact: true }).press("Escape");
    await frame.locator(".findbar").waitFor({ state: "detached" });

    // No CJK font on the machine: every local() lookup fails, as on a minimal Linux.
    const bare = await open("", undefined, () => {
      const NativeFontFace = window.FontFace;
      window.FontFace = class extends NativeFontFace {
        constructor(family, source, descriptors) {
          const local = typeof source === "string" && source.includes("local(");
          super(family, local ? 'local("zcode-e2e-missing")' : source, descriptors);
        }
      };
    });
    await agent(bare.outer, "open_document", { path: "docs/cjk.pdf" });
    await bare.frame.waitForFunction(
      () =>
        [...document.fonts].filter(
          (face) => face.family === "zcode-cjk-fallback" && face.status === "loaded",
        ).length >= 50,
      null,
      { timeout: 30000 },
    );
    assert.equal(
      await bare.frame.evaluate(() =>
        [...document.fonts].some((face) => /^zcode-cjk-(sc|tc|jp|kr)-/.test(face.family)),
      ),
      false,
      "faces without an installed font are not registered",
    );
    await bare.frame.locator('.pdf-page[data-at="page:1"] canvas').waitFor({ timeout: 20000 });
    await bare.outer.screenshot({ path: join(artifacts, "pdf-cjk-fallback.png") });
    await bare.outer.close();
  }
}
