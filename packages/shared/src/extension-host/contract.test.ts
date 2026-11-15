import { describe, expect, it } from "vitest";
import {
  appCreateSessionInputSchema,
  appForkSessionInputSchema,
  appInterruptSessionInputSchema,
  appListProjectsInputSchema,
  appListSessionsInputSchema,
  appListSessionsResultSchema,
  appOpenSessionInputSchema,
  appReadSessionInputSchema,
  appRenameSessionInputSchema,
  appSendToSessionInputSchema,
  appSetSessionArchivedInputSchema,
  appSetSessionPinnedInputSchema,
  appWaitSessionsInputSchema,
  createSessionResultSchema,
  forkSessionResultSchema,
  listProjectsResultSchema,
  mutationResultSchema,
  openSessionResultSchema,
  readSessionResultSchema,
  sendToSessionResultSchema,
  waitSessionsResultSchema,
} from "@zcode/session-control/contracts";
import {
  exampleExtensionManifest,
  exampleExtensionManifestInput,
  exampleSessionExtensionManifest,
  exampleSessionExtensionManifestInput,
} from "./contract.example.js";
import { EXTENSION_CAPABILITIES, isCapabilityId, getCapabilityDef } from "./capabilities.js";
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

  it("accepts a session write grant that covers the declared reads", () => {
    expect(exampleSessionExtensionManifest.grants).toEqual(["sessions.write"]);
    expect(exampleSessionExtensionManifest.protocols).toEqual({ sessions: 1 });
    // 只声明 sessions.read 档位却不能调用会话写。
    const readGrantWithWrite = validateExtensionManifest({
      ...exampleSessionExtensionManifestInput,
      grants: ["sessions.read"],
      capabilities: ["sessions.readSession", "sessions.sendToSession"],
    });
    expect(readGrantWithWrite.ok).toBe(false);
    if (!readGrantWithWrite.ok) expect(readGrantWithWrite.code).toBe("undeclared-grant");
    // 只读档位配合四个读是合法的最小白名单。
    const readOnly = validateExtensionManifest({
      ...exampleSessionExtensionManifestInput,
      grants: ["sessions.read"],
      capabilities: ["sessions.readSession", "sessions.listSessions"],
    });
    expect(readOnly.ok).toBe(true);
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

  it("treats sessions.write as covering sessions.read but not the reverse", () => {
    expect(grantsCover(["sessions.write"], "sessions.read")).toBe(true);
    expect(grantsCover(["sessions.write"], "sessions.write")).toBe(true);
    expect(grantsCover(["sessions.read"], "sessions.write")).toBe(false);
    expect(grantsCover(["projects.read"], "sessions.read")).toBe(false);
    // 规范化只保留最小集合：write 存在时丢掉被它覆盖的 read。
    expect(normalizeGrants(["sessions.read", "sessions.write"])).toEqual(["sessions.write"]);
    expect(normalizeGrants(["projects.read", "sessions.read", "sessions.read"])).toEqual([
      "projects.read",
      "sessions.read",
    ]);
  });

  it("declares only known capabilities", () => {
    expect(isCapabilityId("projects.list")).toBe(true);
    expect(isCapabilityId("files.readAny")).toBe(false);
    expect(getCapabilityDef("projects.list")?.grant).toBe("projects.read");
  });

  it("exposes the twelve session facade intents with canonical app schemas", () => {
    const sessions = Object.keys(EXTENSION_CAPABILITIES).filter((id) => id.startsWith("sessions."));
    expect(sessions.sort()).toEqual(
      [
        "sessions.createSession",
        "sessions.forkSession",
        "sessions.interruptSession",
        "sessions.listProjects",
        "sessions.listSessions",
        "sessions.openSession",
        "sessions.readSession",
        "sessions.renameSession",
        "sessions.sendToSession",
        "sessions.setSessionArchived",
        "sessions.setSessionPinned",
        "sessions.waitSessions",
      ].sort(),
    );
    for (const id of sessions) {
      const def = getCapabilityDef(id);
      expect(def?.backend).toBe("service");
      expect(def?.protocol).toBe("sessions");
      expect(def?.grant === "sessions.read" || def?.grant === "sessions.write").toBe(true);
    }
    expect(getCapabilityDef("sessions.readSession")?.grant).toBe("sessions.read");
    expect(getCapabilityDef("sessions.waitSessions")?.grant).toBe("sessions.read");
    expect(getCapabilityDef("sessions.renameSession")?.grant).toBe("sessions.write");
    // 写动作带幂等身份；openSession 没有 requestId。
    expect(getCapabilityDef("sessions.renameSession")?.requestIdentity).toBe(true);
    expect(getCapabilityDef("sessions.openSession")?.requestIdentity).toBeUndefined();
  });

  it("reuses the canonical app schemas by reference instead of copying DTOs", () => {
    // 入参与返回必须是 session-control 的同一份 schema 对象：复制一份会让扩展面与
    // 模型会话控制工具的字段悄悄分叉（这里比对象身份，不比“形状相似”）。
    const shared = {
      "sessions.listProjects": [appListProjectsInputSchema, listProjectsResultSchema],
      "sessions.listSessions": [appListSessionsInputSchema, appListSessionsResultSchema],
      "sessions.readSession": [appReadSessionInputSchema, readSessionResultSchema],
      "sessions.waitSessions": [appWaitSessionsInputSchema, waitSessionsResultSchema],
      "sessions.createSession": [appCreateSessionInputSchema, createSessionResultSchema],
      "sessions.forkSession": [appForkSessionInputSchema, forkSessionResultSchema],
      "sessions.sendToSession": [appSendToSessionInputSchema, sendToSessionResultSchema],
      "sessions.interruptSession": [appInterruptSessionInputSchema, mutationResultSchema],
      "sessions.renameSession": [appRenameSessionInputSchema, mutationResultSchema],
      "sessions.openSession": [appOpenSessionInputSchema, openSessionResultSchema],
      "sessions.setSessionArchived": [appSetSessionArchivedInputSchema, mutationResultSchema],
      "sessions.setSessionPinned": [appSetSessionPinnedInputSchema, mutationResultSchema],
    } as const;
    for (const [id, [input, output]] of Object.entries(shared)) {
      const def = getCapabilityDef(id);
      expect(def?.input, `${id} input`).toBe(input);
      expect(def?.output, `${id} output`).toBe(output);
    }
  });

  it("rejects incompatible projection versions only when declared", () => {
    expect(isProtocolCompatible({}, "projects")).toBe(true);
    expect(
      isProtocolCompatible({ projects: EXTENSION_PROTOCOL_VERSIONS.projects }, "projects"),
    ).toBe(true);
    expect(isProtocolCompatible({ projects: 99 }, "projects")).toBe(false);
    expect(isProtocolCompatible({}, "sessions")).toBe(true);
    expect(
      isProtocolCompatible({ sessions: EXTENSION_PROTOCOL_VERSIONS.sessions }, "sessions"),
    ).toBe(true);
    expect(isProtocolCompatible({ sessions: 99 }, "sessions")).toBe(false);
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
