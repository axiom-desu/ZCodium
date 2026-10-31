import { expect, it } from "vitest";
import { createClientConfigService } from "./clientConfigService.js";

it("local bundled client config is explicit and never invents recommendations or endpoints", async () => {
  await expect(createClientConfigService().getSnapshot()).resolves.toEqual({
    pluginStoreOrder: null,
    zsrcUrl: null,
    uiPluginRecommendations: [],
  });
});
