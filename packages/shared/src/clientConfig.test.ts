import { expect, it } from "vitest";
import { parseClientConfigSnapshot } from "./clientConfig.js";

it("validates the public envelope and keeps only real consumer fields", () => {
  expect(parseClientConfigSnapshot({ code: 0, data: null })).toEqual({
    pluginStoreOrder: null,
    zsrcUrl: null,
    uiPluginRecommendations: [],
  });
  expect(
    parseClientConfigSnapshot({
      code: 0,
      data: {
        configs: {
          pluginStoreOrder: { work: { categoryOrder: ["finance"] } },
          zsrc: { url: "  https://security.example.test/report  ", secret: "no" },
          uiPluginRecommendations: [
            { pluginId: " documents@zcode-plugins-official ", surfaceId: " documents ", extra: 1 },
          ],
          privateField: "must not escape",
        },
      },
    }),
  ).toEqual({
    pluginStoreOrder: { work: { categoryOrder: ["finance"] } },
    zsrcUrl: "https://security.example.test/report",
    uiPluginRecommendations: [
      { pluginId: "documents@zcode-plugins-official", surfaceId: "documents" },
    ],
  });
});

it("invalid or empty recommendations are an explicit empty list", () => {
  for (const value of [
    undefined,
    null,
    {},
    [],
    [{ pluginId: "p" }],
    [{ pluginId: "", surfaceId: "s" }],
    [{ pluginId: "p", surfaceId: 2 }],
  ]) {
    const snapshot = parseClientConfigSnapshot({
      code: 0,
      data: { configs: { uiPluginRecommendations: value, zsrc: { url: "https://example.com" } } },
    });
    expect(snapshot.uiPluginRecommendations).toEqual([]);
    expect(snapshot.zsrcUrl).toBe("https://example.com");
  }
});

it("rejects non-http zsrc without failing the rest of the snapshot", () => {
  for (const zsrc of ["javascript:alert(1)", "file:///tmp/x", "/relative", { url: "" }]) {
    expect(
      parseClientConfigSnapshot({
        code: 0,
        data: { configs: { zsrc, pluginStoreOrder: { code: { categoryOrder: ["other"] } } } },
      }),
    ).toEqual({
      pluginStoreOrder: { code: { categoryOrder: ["other"] } },
      zsrcUrl: null,
      uiPluginRecommendations: [],
    });
  }
});
