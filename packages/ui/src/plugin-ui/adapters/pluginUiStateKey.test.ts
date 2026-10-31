import { expect, it } from "vitest";
import { pluginUiStateKey } from "./pluginUiStateKey.js";

it("derives a stable opaque state key without exposing the internal surface key", async () => {
  const surfaceKey = JSON.stringify(["/private/workspace", "session", "plugin", "ui://documents"]);
  const digest = await pluginUiStateKey(surfaceKey);
  expect(digest).toMatch(/^[a-f0-9]{64}$/u);
  expect(digest).not.toContain("private");
  expect(await pluginUiStateKey(surfaceKey)).toBe(digest);
  expect(await pluginUiStateKey(`${surfaceKey}:other`)).not.toBe(digest);
});
