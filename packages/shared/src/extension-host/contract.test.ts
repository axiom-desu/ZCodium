import { describe, expect, it } from "vitest";
import { exampleExtensionManifest, exampleExtensionManifestInput } from "./contract.example.js";
import { isCapabilityId, getCapabilityDef } from "./capabilities.js";
import {
  EXTENSION_PROTOCOL_VERSIONS,
  grantsCover,
  isProtocolCompatible,
  normalizeGrants,
} from "./grants.js";
import { validateExtensionManifest } from "./manifest.js";
import { sortSlotProjections } from "./contributions.js";
import { extensionCapabilityRequestSchema } from "./protocol.js";

describe("extension manifest validation", () => {
  it("accepts the example and normalizes duplicate grants", () => {
    expect(exampleExtensionManifest.id).toBe("example-extensions");
    expect(normalizeGrants(["projects.read", "projects.read"])).toEqual(["projects.read"]);
  });

  it("rejects unknown keys instead of silently dropping them", () => {
    const result = validateExtensionManifest({
      ...exampleExtensionManifestInput,
      html: "<b>x</b>",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid-manifest");
  });

  it("rejects unknown capabilities", () => {
    const result = validateExtensionManifest({
      ...exampleExtensionManifestInput,
      capabilities: ["settings.get", "files.readAny"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("unknown-capability");
  });

  it("requires the grant that a declared capability needs", () => {
    const result = validateExtensionManifest({
      ...exampleExtensionManifestInput,
      grants: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("undeclared-grant");
  });

  it("rejects duplicate slot ids and unsafe main paths", () => {
    const duplicate = validateExtensionManifest({
      ...exampleExtensionManifestInput,
      slots: [
        { id: "a", slot: "navigation.primary", title: "A" },
        { id: "a", slot: "status.composer", title: "B" },
      ],
    });
    expect(duplicate.ok).toBe(false);
    const traversal = validateExtensionManifest({
      ...exampleExtensionManifestInput,
      main: "../escape.mjs",
    });
    expect(traversal.ok).toBe(false);
  });
});

describe("extension grants and protocols", () => {
  it("treats none as always covered and other grants as explicit", () => {
    expect(grantsCover([], "none")).toBe(true);
    expect(grantsCover([], "projects.read")).toBe(false);
    expect(grantsCover(["projects.read"], "projects.read")).toBe(true);
  });

  it("declares only known capabilities", () => {
    expect(isCapabilityId("projects.list")).toBe(true);
    expect(isCapabilityId("files.readAny")).toBe(false);
    expect(getCapabilityDef("projects.list")?.grant).toBe("projects.read");
  });

  it("rejects incompatible projection versions only when declared", () => {
    expect(isProtocolCompatible({}, "projects")).toBe(true);
    expect(
      isProtocolCompatible({ projects: EXTENSION_PROTOCOL_VERSIONS.projects }, "projects"),
    ).toBe(true);
    expect(isProtocolCompatible({ projects: 99 }, "projects")).toBe(false);
  });
});

describe("extension wire frames", () => {
  it("requires generation, workspace identity and a plugin declaration on capability calls", () => {
    const parsed = extensionCapabilityRequestSchema.safeParse({
      v: 1,
      generation: 2,
      workspaceIdentity: "local:/tmp/ws",
      pluginId: "example-extensions",
      capabilityId: "projects.list",
    });
    expect(parsed.success).toBe(true);
    expect(
      extensionCapabilityRequestSchema.safeParse({
        v: 1,
        pluginId: "example-extensions",
        capabilityId: "projects.list",
      }).success,
    ).toBe(false);
    // 身份只来自 Authorization 头：body 带 token 也不再是合法帧。
    expect(
      extensionCapabilityRequestSchema.safeParse({
        v: 1,
        token: "t".repeat(32),
        generation: 2,
        workspaceIdentity: "local:/tmp/ws",
        pluginId: "example-extensions",
        capabilityId: "projects.list",
      }).success,
    ).toBe(false);
  });

  it("sorts slot contributions deterministically", () => {
    const base = { pluginName: "P", generation: 1, slot: "navigation.primary" as const };
    const sorted = sortSlotProjections([
      { ...base, pluginId: "b", id: "x", title: "B", order: 1 },
      { ...base, pluginId: "a", id: "z", title: "A", order: -1 },
      { ...base, pluginId: "a", id: "a", title: "A", order: -1 },
    ]);
    expect(sorted.map((slot) => `${slot.pluginId}/${slot.id}`)).toEqual(["a/a", "a/z", "b/x"]);
  });
});
