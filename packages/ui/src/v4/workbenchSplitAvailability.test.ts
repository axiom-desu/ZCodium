import { describe, expect, it } from "vitest";
import { canCreateWorkbenchSplit } from "./workbenchSplitAvailability.js";

const MAX_PANES = 4;

describe("canCreateWorkbenchSplit", () => {
  it("allows a normal single-pane and multi-pane layout below the pane limit", () => {
    expect(
      canCreateWorkbenchSplit({ splitEntryEnabled: true, paneCount: 1, maxPanes: MAX_PANES }),
    ).toBe(true);
    expect(
      canCreateWorkbenchSplit({ splitEntryEnabled: true, paneCount: 3, maxPanes: MAX_PANES }),
    ).toBe(true);
  });

  it("blocks new splits while the full view owns the only conversation", () => {
    // splitEntryEnabled 由 shell 从现有完整视图 controller 只读派生（!isFullView）。
    expect(
      canCreateWorkbenchSplit({ splitEntryEnabled: false, paneCount: 1, maxPanes: MAX_PANES }),
    ).toBe(false);
  });

  it("still honors the pane limit when the split entry is enabled", () => {
    expect(
      canCreateWorkbenchSplit({
        splitEntryEnabled: true,
        paneCount: MAX_PANES,
        maxPanes: MAX_PANES,
      }),
    ).toBe(false);
  });
});
