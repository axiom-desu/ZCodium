import { describe, expect, it } from "vitest";
import {
  buildPluginUiRecommendationTargetKey,
  selectVisibleUiPluginRecommendations,
} from "./pluginUiRecommendationPolicy.js";

describe("plugin UI recommendation identity", () => {
  it("isolates same path by identity, remote session and session", () => {
    const base = { workspacePath: "/w", workspaceIdentity: " remote:a ", sessionId: "s1" };
    const key = buildPluginUiRecommendationTargetKey(base);
    expect(buildPluginUiRecommendationTargetKey({ ...base, workspaceIdentity: "/w" })).not.toBe(
      key,
    );
    expect(buildPluginUiRecommendationTargetKey({ ...base, remoteSessionId: "r1" })).not.toBe(key);
    expect(buildPluginUiRecommendationTargetKey({ ...base, sessionId: "s2" })).not.toBe(key);
  });

  it("keeps only the first surface per plugin and never fabricates missing catalog items", () => {
    const entries = selectVisibleUiPluginRecommendations(
      [
        { pluginId: "documents", surfaceId: "main" },
        { pluginId: "documents", surfaceId: "secondary" },
        { pluginId: "missing", surfaceId: "main" },
      ],
      [{ id: "documents" }],
    );
    expect(entries).toEqual([
      { pluginId: "documents", surfaceId: "main", item: { id: "documents" } },
    ]);
  });
});
