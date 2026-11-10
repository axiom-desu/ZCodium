import { describe, expect, it } from "vitest";
import {
  isSameResizableLayoutPanels,
  resolveLayoutPersistenceStep,
} from "../src/components/ui/resizable.js";

// 手机预览是覆盖层：Group 实例不重建，只关掉布局持久化。
// 这里只测迁移模型（何时冻结桌面比例、何时还原），不渲染组件。

describe("resolveLayoutPersistenceStep", () => {
  it("桌面 ↔ 手机切换时只在关闭时冻结、在开启时还原", () => {
    // 桌面 → 手机：先冻结桌面比例，之后手机上的拖拽不再落盘。
    expect(resolveLayoutPersistenceStep(true, false)).toBe("freeze-desktop-layout");
    // 手机 → 桌面：重新开启时用内存快照还原，顶掉手机上的拖拽结果。
    expect(resolveLayoutPersistenceStep(false, true)).toBe("restore-desktop-layout");
  });

  it("开关没有变化时不做任何动作（含首次挂载）", () => {
    expect(resolveLayoutPersistenceStep(true, true)).toBe("none");
    expect(resolveLayoutPersistenceStep(false, false)).toBe("none");
  });

  it("连续同向变化是幂等的：重复关闭不会再次覆盖快照", () => {
    // 第二次进入手机（wasPersisting=false）必须返回 none，否则会用手机比例覆盖已冻结的桌面快照。
    expect(resolveLayoutPersistenceStep(false, false)).toBe("none");
  });
});

describe("isSameResizableLayoutPanels", () => {
  it("面板集合一致时允许还原快照", () => {
    expect(
      isSameResizableLayoutPanels(
        { "conversation-column": 52, browser: 48 },
        { "conversation-column": 40, browser: 60 },
      ),
    ).toBe(true);
  });

  it("面板数量不同（条件渲染）时拒绝还原，避免库抛错", () => {
    expect(
      isSameResizableLayoutPanels(
        { "conversation-column": 100 },
        { "conversation-column": 40, browser: 60 },
      ),
    ).toBe(false);
    expect(
      isSameResizableLayoutPanels(
        { "conversation-column": 40, browser: 60 },
        { "conversation-column": 100 },
      ),
    ).toBe(false);
  });

  it("面板 id 不同时拒绝还原", () => {
    expect(
      isSameResizableLayoutPanels({ conversation: 70, terminal: 30 }, { conversation: 100 }),
    ).toBe(false);
    expect(
      isSameResizableLayoutPanels(
        { conversation: 70, terminal: 30 },
        { conversation: 50, browser: 50 },
      ),
    ).toBe(false);
  });

  it("空布局视为不可还原（Group 尚未完成初始化）", () => {
    expect(isSameResizableLayoutPanels({}, { "conversation-column": 40, browser: 60 })).toBe(false);
  });
});
