import { describe, expect, it } from "vitest";
import {
  applyDesignStyleEdits,
  designSourcePathFromUrl,
  getDesignStyleChanges,
  isDesignSourcePath,
  sanitizeDesignStyleValue,
  type DesignSourcePath,
} from "../src/browser-use/browserDesignSource.js";

const SOURCE = `<!doctype html>
<html>
  <head><title>Design</title></head>
  <body>
    <main>
      <h1 id="title" class="hero" style="color: #111; font-size: 24px">Hello</h1>
      <p>Body</p>
    </main>
  </body>
</html>
`;

const TITLE_PATH: DesignSourcePath = {
  steps: [
    { tag: "body", index: 1, siblings: 2 },
    { tag: "main", index: 0, siblings: 1 },
    { tag: "h1", index: 0, siblings: 2 },
  ],
  id: "title",
  className: "hero",
};

describe("browser design source edit", () => {
  it("derives only local HTML files from a file URL", () => {
    expect(designSourcePathFromUrl("file:///tmp/design%20one/index.html")).toBe(
      "/tmp/design one/index.html",
    );
    expect(designSourcePathFromUrl("file:///C:/project/index.htm")).toBe("C:/project/index.htm");
    expect(designSourcePathFromUrl("https://example.com/index.html")).toBeNull();
    expect(designSourcePathFromUrl("file://host/share/index.html")).toBeNull();
    expect(designSourcePathFromUrl("file:///tmp/index.txt")).toBeNull();
  });

  it("rejects CSS injection and accepts the bounded value shapes", () => {
    expect(sanitizeDesignStyleValue("fontSize", "46px")).toBe("46px");
    expect(sanitizeDesignStyleValue("padding", "8px 12px")).toBe("8px 12px");
    expect(sanitizeDesignStyleValue("color", "#AABBCC")).toBe("#AABBCC");
    expect(sanitizeDesignStyleValue("opacity", "0.5")).toBe("0.5");
    expect(sanitizeDesignStyleValue("fontSize", "46px; color: red")).toBeNull();
    expect(sanitizeDesignStyleValue("color", "url(https://evil.test/a.png)")).toBeNull();
    expect(sanitizeDesignStyleValue("backgroundColor", "expression(alert(1))")).toBeNull();
    expect(sanitizeDesignStyleValue("fontSize", "<script>")).toBeNull();
    expect(sanitizeDesignStyleValue("opacity", "2")).toBeNull();
  });

  it("rewrites only the target style attribute and preserves every other byte", () => {
    const result = applyDesignStyleEdits(SOURCE, TITLE_PATH, {
      fontSize: "46px",
      color: "#222222",
    });
    expect(result).not.toBeNull();
    expect(result?.changes.map((change) => change.cssProperty)).toEqual(["font-size", "color"]);
    expect(result?.content).toBe(
      SOURCE.replace(
        'style="color: #111; font-size: 24px"',
        'style="font-size: 46px; color: #222222"',
      ),
    );
    expect(result?.content.slice(0, result.content.indexOf("<h1"))).toBe(
      SOURCE.slice(0, SOURCE.indexOf("<h1")),
    );
  });

  it("inserts a style attribute without touching the rest of the tag", () => {
    const path: DesignSourcePath = {
      steps: [
        { tag: "body", index: 1, siblings: 2 },
        { tag: "main", index: 0, siblings: 1 },
        { tag: "p", index: 1, siblings: 2 },
      ],
      id: null,
      className: null,
    };
    const result = applyDesignStyleEdits(SOURCE, path, { padding: "4px" });
    expect(result?.content).toContain('<p style="padding: 4px">Body</p>');
  });

  it("collapses duplicate declarations instead of leaving an old value behind", () => {
    const source = SOURCE.replace(
      'style="color: #111; font-size: 24px"',
      'style="color: red; color: blue; font-size: 24px"',
    );
    const result = applyDesignStyleEdits(source, TITLE_PATH, { color: "#222222" });
    expect(result?.content).toContain('style="font-size: 24px; color: #222222"');
    expect(result?.content).not.toContain("color: blue");
  });

  it("refuses a forged path instead of writing another element", () => {
    const forged: DesignSourcePath = {
      ...TITLE_PATH,
      steps: [
        { tag: "body", index: 1, siblings: 2 },
        { tag: "main", index: 0, siblings: 1 },
        { tag: "h1", index: 1, siblings: 2 },
      ],
    };
    expect(applyDesignStyleEdits(SOURCE, forged, { fontSize: "46px" })).toBeNull();
    expect(
      applyDesignStyleEdits(SOURCE, { ...TITLE_PATH, id: "other" }, { fontSize: "46px" }),
    ).toBeNull();
    expect(isDesignSourcePath(forged)).toBe(true);
    expect(
      isDesignSourcePath({
        steps: [{ tag: "h1", index: 2, siblings: 2 }],
        id: null,
        className: null,
      }),
    ).toBe(false);
  });

  it("computes a diff only for changed, valid values", () => {
    expect(
      getDesignStyleChanges(
        { fontSize: "24px", color: "#111111" },
        { fontSize: "46px", color: "#111111", opacity: "bad" },
      ),
    ).toEqual([
      {
        property: "fontSize",
        cssProperty: "font-size",
        before: "24px",
        after: "46px",
      },
    ]);
  });
});
