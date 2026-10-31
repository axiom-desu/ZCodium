import { describe, expect, it } from "vitest";
import { shouldRestoreFloatingFromMinimized } from "./model.js";

describe("floating blocking interaction restore", () => {
  it("restores a minimized floating view only for a new blocking interaction on the same owner", () => {
    const previous = { ownerKey: "task-a", interactionId: null };
    expect(
      shouldRestoreFloatingFromMinimized({
        isMinimized: true,
        previous,
        next: { ownerKey: "task-a", interactionId: "ask-user-1" },
      }),
    ).toBe(true);
    // 同一请求等待期间用户再次最小化，不会被重复弹开。
    expect(
      shouldRestoreFloatingFromMinimized({
        isMinimized: true,
        previous: { ownerKey: "task-a", interactionId: "ask-user-1" },
        next: { ownerKey: "task-a", interactionId: "ask-user-1" },
      }),
    ).toBe(false);
    // 切 owner 后旧 owner 的迟到阻塞交互不能把新会话弹开。
    expect(
      shouldRestoreFloatingFromMinimized({
        isMinimized: true,
        previous,
        next: { ownerKey: "task-b", interactionId: "ask-user-2" },
      }),
    ).toBe(false);
    // 非最小化、或只是清除阻塞交互时都不改变形态。
    expect(
      shouldRestoreFloatingFromMinimized({
        isMinimized: false,
        previous,
        next: { ownerKey: "task-a", interactionId: "ask-user-1" },
      }),
    ).toBe(false);
    expect(
      shouldRestoreFloatingFromMinimized({
        isMinimized: true,
        previous: { ownerKey: "task-a", interactionId: "ask-user-1" },
        next: { ownerKey: "task-a", interactionId: null },
      }),
    ).toBe(false);
  });
});
