import { describe, expect, it } from "vitest";
import {
  MCP_APPS_EXTENSION_ID,
  MCP_APPS_RESOURCE_MIME_TYPE,
  MCP_APPS_UI_RESOURCE_SCHEME,
  MCP_APPS_LEGACY_RESOURCE_URI_META_KEY,
  buildMcpAppsClientCapabilities,
} from "./contract.js";
import { normalizeMcpAppCspRelaxations, normalizeMcpToolUiMeta } from "./toolMeta.js";
import {
  exampleClientCapabilities,
  exampleResourceMetaWithRelaxations,
  exampleSandboxHandle,
  exampleToolUiDescriptor,
} from "./contract.example.js";

describe("mcp-apps-protocol contract", () => {
  it("扩展标识与 UI 资源 mimeType 与官方 SDK 常量一致", () => {
    expect(MCP_APPS_EXTENSION_ID).toBe("io.modelcontextprotocol/ui");
    expect(MCP_APPS_RESOURCE_MIME_TYPE).toBe("text/html;profile=mcp-app");
    expect(MCP_APPS_LEGACY_RESOURCE_URI_META_KEY).toBe("ui/resourceUri");
    expect(buildMcpAppsClientCapabilities()).toEqual(exampleClientCapabilities);
  });

  it("resourceUri 同时接受标准键、弃用扁平键与 openai/outputTemplate", () => {
    expect(normalizeMcpToolUiMeta({ ui: { resourceUri: "ui://a/b" } })?.resourceUri).toBe(
      "ui://a/b",
    );
    expect(normalizeMcpToolUiMeta({ "ui/resourceUri": "ui://a/c" })?.resourceUri).toBe("ui://a/c");
    expect(normalizeMcpToolUiMeta({ "openai/outputTemplate": "ui://a/d" })?.resourceUri).toBe(
      "ui://a/d",
    );
    expect(normalizeMcpToolUiMeta({ ui: { resourceUri: "https://a/b" } })).toBeNull();
  });

  it("zcode/csp 只认已知布尔键", () => {
    expect(normalizeMcpAppCspRelaxations(exampleResourceMetaWithRelaxations)).toEqual({
      unsafeEval: true,
    });
    expect(normalizeMcpAppCspRelaxations({ "zcode/csp": { unsafeEval: false, other: true } })).toBe(
      null,
    );
  });

  it("示例描述与句柄满足契约形状", () => {
    expect(exampleToolUiDescriptor.resourceUri.startsWith(MCP_APPS_UI_RESOURCE_SCHEME)).toBe(true);
    expect(exampleSandboxHandle.shellUrl).toBe(
      `zcode-sandbox://shell-${exampleSandboxHandle.sandboxId}/`,
    );
    expect(exampleSandboxHandle.partition.startsWith("persist:plugin-sandbox-")).toBe(true);
  });
});
