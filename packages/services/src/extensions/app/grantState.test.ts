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
});
