import { describe, expect, it } from "vitest";
import { officePanelCspMeta } from "#office/adapters/resources.ts";

describe("office panel CSP", () => {
  it("grants wasm-unsafe-eval only to profiles with real wasm assets", () => {
    expect(officePanelCspMeta(["pdf"])).toEqual({ "zcode/csp": { wasmUnsafeEval: true } });
    expect(officePanelCspMeta(["xlsx"])).toEqual({ "zcode/csp": { wasmUnsafeEval: true } });
    // docx/pptx 产物没有 WebAssembly 引用，不能顺便获得宿主放宽。
    expect(officePanelCspMeta(["docx"])).toBeUndefined();
    expect(officePanelCspMeta(["pptx"])).toBeUndefined();
  });
});
