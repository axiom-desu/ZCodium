import { describe, expect, it } from "vitest";
import { browserCommandSchema } from "./commands.js";

describe("browser command protocol", () => {
  it("closeSession 接受可选 closeTabs，拒绝非布尔值", () => {
    expect(browserCommandSchema.parse({ method: "closeSession" })).toEqual({
      method: "closeSession",
    });
    expect(browserCommandSchema.parse({ method: "closeSession", closeTabs: true })).toEqual({
      method: "closeSession",
      closeTabs: true,
    });
    // strict()：多出来的键与类型不符的值都必须被拒，否则 closeTabs 会静默失效。
    expect(() =>
      browserCommandSchema.parse({ method: "closeSession", closeTabs: "yes" }),
    ).toThrow();
    expect(() =>
      browserCommandSchema.parse({ method: "closeSession", closeTabs: true, extra: 1 }),
    ).toThrow();
  });
});
