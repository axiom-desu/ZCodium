import { describe, expect, it } from "vitest";
import { exampleSidePaneFullView } from "@/side-pane-full-view/contract.example.js";
import { sidePaneFullViewModule } from "@/side-pane-full-view/module.js";
import { SIDE_PANE_FULL_VIEW_ENTER_STATE } from "@/side-pane-full-view/model.js";
import type { SidePaneFullViewController } from "@/side-pane-full-view/contract.js";

/** 契约 fixtures（module.ts / contract.example.ts）必须被真实 import，避免只靠文档描述边界。 */
describe("side pane full view module contract", () => {
  it("declares the managed module identity used by architecture-policy.yaml", () => {
    expect(sidePaneFullViewModule).toEqual({
      id: "side-pane-full-view",
      requires: ["shared", "ui"],
      provides: ["side-pane-full-view"],
      publicEntrypoints: ["index.ts", "contract.ts"],
    });
  });

  it("derives host mode and tab surface from the read-only controller", () => {
    const calls: string[] = [];
    let fullView: SidePaneFullViewController["fullView"] = null;
    const controller: SidePaneFullViewController = {
      get fullView() {
        return fullView;
      },
      enabled: true,
      enter: () => calls.push("enter"),
      exit: () => calls.push("exit"),
      toggle: () => calls.push("toggle"),
      setSurface: (surface) => calls.push(`surface:${surface}`),
      setFloating: (floating) => calls.push(`floating:${floating}`),
    };
    expect(exampleSidePaneFullView(controller)).toMatchObject({ mode: "normal" });
    expect(calls).toEqual(["surface:side-pane"]);

    fullView = SIDE_PANE_FULL_VIEW_ENTER_STATE;
    const floating = exampleSidePaneFullView(controller);
    expect(floating.mode).toBe("floating");
    // 侧栏显隐仍由用户开关决定：完整视图不接管左侧任务列表。
    expect(floating.sidebarVisible(true)).toBe(true);

    fullView = { surface: "conversation", floating: "collapsed" };
    expect(exampleSidePaneFullView(controller).mode).toBe("conversation");
  });
});
