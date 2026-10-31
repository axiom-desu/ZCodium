import { expect, it } from "vitest";
import { supportsPluginUiGuest } from "./pluginUiSupport.js";

const local = { hasPlatformSandbox: true, hasBridge: true };

it("allows only local desktop guests and keeps Web/mobile/remote on ordinary MCP rows", () => {
  expect(supportsPluginUiGuest(local)).toBe(true);
  expect(supportsPluginUiGuest({ ...local, hasPlatformSandbox: false })).toBe(false);
  expect(supportsPluginUiGuest({ ...local, hasBridge: false })).toBe(false);
  expect(supportsPluginUiGuest({ ...local, enabled: false })).toBe(false);
  expect(supportsPluginUiGuest({ ...local, remoteSessionId: "remote-1" })).toBe(false);
  expect(
    supportsPluginUiGuest({ ...local, workspaceIdentity: "remote:ssh:host:22:user:/workspace" }),
  ).toBe(false);
});
