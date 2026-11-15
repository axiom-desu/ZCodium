import { describe, expect, it } from "vitest";
import {
  MCP_APPS_NESTED_FRAMES_EXPERIMENTAL_KEY,
  normalizeMcpAppResourceMeta,
  normalizeMcpToolUiMeta,
} from "@zcode/shared/mcp-apps";
import { isSandboxDocumentNavigation } from "@/plugin-ui/adapters/pluginUiPagePlane.js";
import { buildPluginUiHostCapabilities } from "@/plugin-ui/domain/buildPluginUiHostCapabilities.js";

describe("plugin-ui nested frames", () => {
  it("只把插件沙箱文档自身的导航当作页面重载", () => {
    expect(isSandboxDocumentNavigation("zcode-sandbox://plugin-abc/index.html")).toBe(true);
    // 缺失 URL 时保持旧的撤销语义，避免把未知导航当子 frame。
    expect(isSandboxDocumentNavigation(undefined)).toBe(true);
    expect(isSandboxDocumentNavigation("about:blank")).toBe(false);
    expect(isSandboxDocumentNavigation("https://example.com/frame")).toBe(false);
    expect(isSandboxDocumentNavigation("about:srcdoc")).toBe(false);
  });

  it("宿主宣告 nestedFrames 扩展能力，并保留原有扩展键", () => {
    const capabilities = buildPluginUiHostCapabilities({
      canSendFollowUpMessage: true,
      canUpdateModelContext: true,
      canSetWidgetState: true,
      canSubscribeResources: true,
      canDownloadFile: false,
    });
    expect(capabilities.experimental).toHaveProperty(MCP_APPS_NESTED_FRAMES_EXPERIMENTAL_KEY);
    expect(MCP_APPS_NESTED_FRAMES_EXPERIMENTAL_KEY).toBe("zcode/nestedFrames");
    expect(capabilities.experimental).toHaveProperty("zcode/widgetState");
    expect(capabilities.experimental).toHaveProperty("zcode/resourceSubscribe");
  });

  it("后台保留只认资源 _meta.ui.backgroundRetention", () => {
    expect(normalizeMcpAppResourceMeta({ ui: { backgroundRetention: true } })).toEqual({
      backgroundRetention: true,
    });
    expect(normalizeMcpAppResourceMeta({ ui: { backgroundRetention: false } })).toEqual({
      backgroundRetention: false,
    });
    expect(normalizeMcpAppResourceMeta({ ui: { backgroundRetention: "yes" } })).toBeNull();
    // 工具 metadata 即使写同名字段也不授予保留。
    expect(
      normalizeMcpToolUiMeta({
        ui: { resourceUri: "ui://widget/app.html", backgroundRetention: true },
      }),
    ).not.toHaveProperty("backgroundRetention");
  });
});
