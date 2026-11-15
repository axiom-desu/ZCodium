import { describe, expect, it } from "vitest";
import { isPluginFrameNavigation } from "../src/main/pluginSandbox/guestPolicy.js";
import {
  PLUGIN_SANDBOX_PARTITION_PREFIX,
  buildPluginSandboxPartition,
} from "../src/main/pluginSandbox/contract.js";
import { createPluginSandboxRegistry } from "../src/main/pluginSandbox/registry.js";

describe("plugin-sandbox 子 frame 导航", () => {
  it("shell 主 frame 的直接子 frame 才是插件 frame 自身", () => {
    // 主 frame 或拿不到父级时保持旧的撤销语义（主 frame 另有 isMainFrame 分支判定）。
    expect(isPluginFrameNavigation({ frame: { parent: null } })).toBe(true);
    // 插件的直接父级是 shell 主 frame → 只有它自己的文档导航才撤销登记。
    expect(isPluginFrameNavigation({ frame: { parent: { parent: null } } })).toBe(true);
    // 插件文档内部更深层的子 frame（srcdoc / frameDomains）不是重载。
    expect(isPluginFrameNavigation({ frame: { parent: { parent: { parent: null } } } })).toBe(
      false,
    );
    // 已销毁的 frame 拿不到层级：按插件 frame 处理，保持撤销语义。
    expect(isPluginFrameNavigation({ frame: null })).toBe(true);
    expect(isPluginFrameNavigation({})).toBe(true);
  });

  it("registry 把资源声明的 backgroundRetention 放进句柄 resourceMeta", () => {
    const registry = createPluginSandboxRegistry({ createId: () => "sb-background" });
    const base = {
      instance: { runtimeId: "r", generation: 1, token: "t", appIdentity: "a".repeat(64) },
      ownerWebContentsId: 7,
      workspacePath: "/repo",
      sessionId: "session_1",
      pluginId: "example-plugin@example-marketplace",
      serverName: "plugin:example-plugin:widget",
      scopeId: "tool:call_1",
      html: "<!doctype html><p>widget</p>",
    };
    const retained = registry.register({ ...base, backgroundRetention: true });
    expect(retained.resourceMeta?.backgroundRetention).toBe(true);
    expect(retained.partition.startsWith(PLUGIN_SANDBOX_PARTITION_PREFIX)).toBe(true);
    expect(retained.partition).toBe(
      buildPluginSandboxPartition({ appIdentity: base.instance.appIdentity }),
    );

    const plain = registry.register({ ...base, scopeId: "tool:call_2" });
    expect(plain.resourceMeta).toBeUndefined();
  });
});
