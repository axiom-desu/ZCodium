import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrowserDesignInspector } from "../src/browser-use/BrowserDesignInspector.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";

// 面板是纯展示组件：确认宿主校验后的 diff、只读原因和 Apply 门控都能真实渲染。
// 页面交互与写回在 browserDesignInspect.chromium.test.ts 里用真实 Chromium 覆盖。

describe("browser design inspector component", () => {
  it("renders the precise source diff and enables apply only when writable", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(BrowserDesignInspector, {
          applied: false,
          canApply: true,
          changes: [
            {
              property: "fontSize",
              cssProperty: "font-size",
              before: "24px",
              after: "46px",
            },
          ],
          draft: { fontSize: "46px" },
          error: null,
          fileName: "index.html",
          onApply: () => undefined,
          onCancel: () => undefined,
          onDraftChange: () => undefined,
          selection: {
            selector: '[data-zcode-design-target="abc"]',
            tagName: "h1",
            sourcePath: {
              steps: [{ tag: "h1", index: 0, siblings: 1 }],
              id: "title",
              className: null,
            },
            styleAttribute: "font-size: 24px",
            editable: { fontSize: "24px" },
            rect: null,
          },
          sourceWritable: true,
          status: "selected",
        }),
      ),
    );
    expect(html).toContain("index.html");
    expect(html).toContain("font-size: 24px");
    expect(html).toContain("font-size: 46px");
    expect(html).toContain("Apply to file");
    expect(html).toContain('data-testid="browser-design-apply" type="button"');
  });

  it("shows a read-only reason and disables apply when the source cannot be written", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(BrowserDesignInspector, {
          applied: false,
          canApply: false,
          changes: [],
          draft: {},
          error: "notMatched",
          fileName: null,
          onApply: () => undefined,
          onCancel: () => undefined,
          onDraftChange: () => undefined,
          selection: {
            selector: '[data-zcode-design-target="abc"]',
            tagName: "h1",
            sourcePath: { steps: [], id: null, className: null },
            styleAttribute: null,
            editable: {},
            rect: null,
          },
          sourceWritable: false,
          status: "selected",
        }),
      ),
    );
    expect(html).toContain("not found in the source file");
    expect(html).toMatch(/data-testid="browser-design-apply"[^>]*disabled/);
  });
});
