import { describe, expect, it } from "vitest";
import {
  claimPluginUiSidePaneAutoOpen,
  getSidePaneCollapsedPreference,
  peekTaskSidePaneFullView,
  readTaskSidePaneMemoryState,
  saveTaskSidePaneCollapsedPreference,
  saveTaskSidePaneFullView,
  saveTaskSidePaneMemoryState,
} from "./taskSidePaneMemory.js";
import { buildPluginUiSurfaceKey } from "../plugin-ui/contract.js";

const target = {
  workspacePath: "/project",
  sessionId: "session",
  pluginId: "plugin",
  serverName: "server",
  resourceUri: "ui://view",
};
const callKey = (changes = {}, toolCallId = "call") =>
  buildPluginUiSurfaceKey({ ...target, ...changes }, { kind: "toolCall", toolCallId });

describe("MCP App automatic sidebar opening", () => {
  it("consumes a call across remounts without changing the saved close preference", () => {
    const workspace = "sidebar-remount";
    expect(claimPluginUiSidePaneAutoOpen(workspace, callKey())).toBe(true);
    saveTaskSidePaneCollapsedPreference(workspace, target.sessionId, true);
    saveTaskSidePaneMemoryState(workspace, { browserUrls: { tab: "about:blank" } });
    expect(claimPluginUiSidePaneAutoOpen(workspace, callKey())).toBe(false);
    expect(
      getSidePaneCollapsedPreference(readTaskSidePaneMemoryState(workspace), target.sessionId),
    ).toBe(true);
    expect(claimPluginUiSidePaneAutoOpen(workspace, callKey({}, "next-call"))).toBe(true);
  });
  it("isolates execution identity, session, source and actual tool calls", () => {
    const workspace = "sidebar-isolation";
    const keys = [
      callKey(),
      callKey({ sessionId: "other" }),
      callKey({ pluginId: "other" }),
      callKey({ serverName: "other" }),
      callKey({ resourceUri: "ui://other" }),
      callKey({ workspaceIdentity: "ssh:first:/project" }),
      callKey({ workspaceIdentity: "ssh:second:/project" }),
    ];
    for (const key of keys) expect(claimPluginUiSidePaneAutoOpen(workspace, key)).toBe(true);
    for (const key of keys) expect(claimPluginUiSidePaneAutoOpen(workspace, key)).toBe(false);
    expect(claimPluginUiSidePaneAutoOpen("other-workspace-cache", keys[0]!)).toBe(true);
  });
});

describe("side pane full view memory", () => {
  const fullView = { surface: "side-pane", floating: "expanded" } as const;

  it("keeps one record per conversation owner and separates the draft owner", () => {
    const workspace = "full-view-owner";
    expect(peekTaskSidePaneFullView(workspace, "task-a")).toBeNull();
    saveTaskSidePaneFullView(workspace, "task-a", fullView);
    saveTaskSidePaneFullView(workspace, null, { surface: "conversation", floating: "minimized" });
    expect(peekTaskSidePaneFullView(workspace, "task-a")).toEqual(fullView);
    expect(peekTaskSidePaneFullView(workspace, "__draft__")).toEqual({
      surface: "conversation",
      floating: "minimized",
    });
    expect(peekTaskSidePaneFullView(workspace, "task-b")).toBeNull();
  });

  it("clears only the addressed owner on exit", () => {
    const workspace = "full-view-exit";
    saveTaskSidePaneFullView(workspace, "task-a", fullView);
    saveTaskSidePaneFullView(workspace, "task-b", fullView);
    saveTaskSidePaneFullView(workspace, "task-a", null);
    expect(peekTaskSidePaneFullView(workspace, "task-a")).toBeNull();
    expect(peekTaskSidePaneFullView(workspace, "task-b")).toEqual(fullView);
  });

  it("does not leak the same task id across workspaces", () => {
    // 身份 key 仍是 identity.trim() || path：同一 taskId 在不同 workspace/远端身份下是两份记录。
    saveTaskSidePaneFullView("local:/project", "task-x", fullView);
    saveTaskSidePaneFullView("ssh:host-a:/project", "task-x", {
      surface: "conversation",
      floating: "collapsed",
    });
    expect(peekTaskSidePaneFullView("local:/project", "task-x")).toEqual(fullView);
    expect(peekTaskSidePaneFullView("ssh:host-a:/project", "task-x")).toEqual({
      surface: "conversation",
      floating: "collapsed",
    });
    expect(peekTaskSidePaneFullView("ssh:host-b:/project", "task-x")).toBeNull();
  });

  it("keeps peek read-only and ignores a missing memory key", () => {
    const workspace = "full-view-readonly";
    saveTaskSidePaneMemoryState(workspace, { browserUrls: { tab: "about:blank" } });
    expect(peekTaskSidePaneFullView(workspace, "task-a")).toBeNull();
    // peek 不创建条目：未写入前状态里没有该 owner 的 key。
    expect(readTaskSidePaneMemoryState(workspace).sidePaneFullViewByOwner).toEqual({});
    expect(peekTaskSidePaneFullView(null, "task-a")).toBeNull();
    saveTaskSidePaneFullView(null, "task-a", fullView);
    expect(peekTaskSidePaneFullView(null, "task-a")).toBeNull();
  });

  it("survives unrelated memory writes for the same workspace", () => {
    const workspace = "full-view-coexist";
    saveTaskSidePaneFullView(workspace, "task-a", fullView);
    saveTaskSidePaneCollapsedPreference(workspace, "task-a", true);
    saveTaskSidePaneMemoryState(workspace, { browserUrls: { tab: "https://example.test" } });
    expect(peekTaskSidePaneFullView(workspace, "task-a")).toEqual(fullView);
  });
});
