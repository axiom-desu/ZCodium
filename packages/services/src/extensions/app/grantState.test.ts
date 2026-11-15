import { describe, expect, it } from "vitest";
import {
  decideGrant,
  isGrantRunnable,
  resolveGrantState,
  type DeclaredPlugin,
} from "./grantState.js";

const PLUGIN: DeclaredPlugin = {
  pluginId: "demo",
  name: "Demo",
  version: "1.0.0",
  capabilities: [],
  slotIds: [],
  protocols: {},
  declared: [],
};

describe("extension grant state", () => {
  it("does not treat a plugin without a consent record as runnable", () => {
    const state = resolveGrantState(PLUGIN, undefined);
    expect(state.status).toBe("needs-consent");
    expect(state.granted).toEqual([]);
    expect(isGrantRunnable(state)).toBe(false);
  });

  it("records explicit consent even when the plugin declares no grants", () => {
    const decision = decideGrant({ declared: PLUGIN, requested: [], now: 5 });
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    const state = resolveGrantState(PLUGIN, decision.record);
    expect(state.status).toBe("granted");
    expect(isGrantRunnable(state)).toBe(true);
  });

  it("requires the grant request to match the current declaration", () => {
    const declared = { ...PLUGIN, declared: ["projects.read" as const] };
    expect(decideGrant({ declared, requested: [], now: 1 })).toMatchObject({
      ok: false,
      code: "stale-approval",
    });
    expect(decideGrant({ declared, requested: ["projects.read"], now: 1 })).toMatchObject({
      ok: true,
    });
  });

  it("returns to needs-consent after the plugin version changes", () => {
    const declared = { ...PLUGIN, declared: ["projects.read" as const] };
    const decision = decideGrant({ declared, requested: ["projects.read"], now: 1 });
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    const upgraded = { ...declared, version: "2.0.0" };
    expect(resolveGrantState(upgraded, decision.record).status).toBe("needs-consent");
  });

  it("does not keep an old grant when the same version adds a session write", () => {
    // 同版本 read → write 也是权限扩张：旧记录必须回到 needs-consent，不能被沿用。
    const readDeclared = { ...PLUGIN, declared: ["sessions.read" as const] };
    const decision = decideGrant({ declared: readDeclared, requested: ["sessions.read"], now: 1 });
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    const writeDeclared = { ...readDeclared, declared: ["sessions.write" as const] };
    const state = resolveGrantState(writeDeclared, decision.record);
    expect(state.status).toBe("needs-consent");
    expect(state.granted).toEqual([]);
    // 过期对话框里的 read 请求也不能用来批准 write 声明。
    expect(
      decideGrant({ declared: writeDeclared, requested: ["sessions.read"], now: 2 }),
    ).toMatchObject({ ok: false, code: "stale-approval" });
  });

  it("lets a recorded session write cover a later read-only declaration", () => {
    const writeDeclared = { ...PLUGIN, declared: ["sessions.write" as const] };
    const decision = decideGrant({
      declared: writeDeclared,
      requested: ["sessions.write"],
      now: 1,
    });
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    const readDeclared = { ...writeDeclared, declared: ["sessions.read" as const] };
    expect(resolveGrantState(readDeclared, decision.record).status).toBe("granted");
  });
});
