/** The sticky document bar must stay at the top after every interaction (layout regression). */
export async function assertBarsAtTop(assert, frames) {
  for (const page of frames.filter(Boolean))
    assert.equal(
      await page.evaluate(() =>
        Math.round(document.querySelector(".docbar").getBoundingClientRect().top),
      ),
      0,
      "the document bar stays at the top after all interactions",
    );
}

/** Print the assertion error, then capture every open page so the failure is inspectable. */
export async function reportFailure({ error, browser, errors, artifacts, join }) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  for (const page of browser.contexts().flatMap((context) => context.pages()))
    await page
      .screenshot({ path: join(artifacts, `failure-${Date.now()}.png`) })
      .catch(() => undefined);
  process.stderr.write(`Browser errors:\n${errors.join("\n")}\nScreenshots in ${artifacts}\n`);
}
