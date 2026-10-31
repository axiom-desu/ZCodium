import { describe, expect, it } from "vitest";
import { SHORTCUT_COMMANDS, getDefaultShortcutBindings } from "@zcode/shared";
import { isSamePhysicalBinding } from "@/shortcuts/conflicts.js";

describe("toggleSidePaneFullView shortcut", () => {
  it("rides the shared command table with the documented default", () => {
    const entry = SHORTCUT_COMMANDS.find((item) => item.id === "toggleSidePaneFullView");
    expect(entry?.channel).toBe("window");
    expect(entry?.scope).toBeUndefined();
    expect(getDefaultShortcutBindings("toggleSidePaneFullView")).toEqual(["CmdOrCtrl+Shift+f"]);
  });

  it("does not collide with any existing physical binding", () => {
    const target = getDefaultShortcutBindings("toggleSidePaneFullView");
    for (const entry of SHORTCUT_COMMANDS) {
      if (entry.id === "toggleSidePaneFullView") continue;
      for (const binding of entry.defaultBindings) {
        for (const own of target) {
          expect(
            isSamePhysicalBinding(own, binding),
            `${entry.id} (${entry.channel}) 已占用 ${binding}`,
          ).toBe(false);
        }
      }
    }
  });
});
