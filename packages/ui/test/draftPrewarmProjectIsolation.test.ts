import { describe, expect, it } from "vitest";
import { buildDraftPrewarmOwnerKey } from "@/v4/composer/useDraftSessionPrewarm.js";

// 预热会话 owner key 必须把“项目意图”纳入身份：两个项目可以共享同一个 primaryRoot
// （同一 cwd），只要项目不同就不能复用同一份 draft session / 冻结目录。
describe("draft prewarm owner key", () => {
  it("同一 workspace + pane + 项目稳定复用同一 owner", () => {
    expect(buildDraftPrewarmOwnerKey("/repo", "pane-1", "project-a")).toBe(
      buildDraftPrewarmOwnerKey("/repo", "pane-1", "project-a"),
    );
  });

  it("同 cwd 的不同项目互不复用预热会话", () => {
    expect(buildDraftPrewarmOwnerKey("/shared-root", "pane-1", "project-a")).not.toBe(
      buildDraftPrewarmOwnerKey("/shared-root", "pane-1", "project-b"),
    );
  });

  it("项目与全局任务（null）分属不同 owner；undefined 与 null 等价", () => {
    expect(buildDraftPrewarmOwnerKey("/repo", "pane-1", null)).not.toBe(
      buildDraftPrewarmOwnerKey("/repo", "pane-1", "project-a"),
    );
    expect(buildDraftPrewarmOwnerKey("/repo", "pane-1", undefined)).toBe(
      buildDraftPrewarmOwnerKey("/repo", "pane-1", null),
    );
  });

  it("同项目不同 pane 仍是不同 owner（分屏各自独立）", () => {
    expect(buildDraftPrewarmOwnerKey("/repo", "pane-1", "project-a")).not.toBe(
      buildDraftPrewarmOwnerKey("/repo", "pane-2", "project-a"),
    );
  });
});
