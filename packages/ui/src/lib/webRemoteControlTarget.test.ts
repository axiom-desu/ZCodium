import { describe, expect, it } from "vitest";
import type { WebRemoteControlStatusSnapshot } from "@zcode/shared";
import {
  isReusableWebRemoteControlSession,
  isSameWebRemoteControlTarget,
} from "./webRemoteControlTarget.js";

function snapshot(
  overrides: Partial<WebRemoteControlStatusSnapshot> = {},
): WebRemoteControlStatusSnapshot {
  return { status: "running", ...overrides };
}

describe("isSameWebRemoteControlTarget", () => {
  it("idle / error 快照永远不是同一目标", () => {
    expect(isSameWebRemoteControlTarget(snapshot({ status: "idle" }), "/a")).toBe(false);
    expect(isSameWebRemoteControlTarget(snapshot({ status: "error" }), "/a")).toBe(false);
  });

  it("缺少 workspacePath 的快照不是同一目标", () => {
    expect(
      isSameWebRemoteControlTarget(snapshot({ status: "running", sessionId: "s" }), "/a"),
    ).toBe(false);
  });

  it("不同 workspace 的旧会话不算同一目标（拒绝跨 workspace 误复用）", () => {
    const status = snapshot({ status: "starting", workspacePath: "/other", sessionId: "s" });
    expect(isSameWebRemoteControlTarget(status, "/a")).toBe(false);
  });

  it("同名路径但 workspaceIdentity 不同不算同一目标", () => {
    const status = snapshot({
      status: "running",
      workspacePath: "/a",
      workspaceIdentity: "remote:ssh:host2:22:user:/a",
      sessionId: "s",
    });
    expect(isSameWebRemoteControlTarget(status, "/a", "remote:ssh:host1:22:user:/a")).toBe(false);
  });

  it("身份与路径都一致、且有会话 id 时才算同一目标", () => {
    const status = snapshot({
      status: "running",
      workspacePath: "/a",
      workspaceIdentity: "remote:ssh:host1:22:user:/a",
      sessionId: "s",
    });
    expect(isSameWebRemoteControlTarget(status, "/a", "remote:ssh:host1:22:user:/a")).toBe(true);
    // 本地路径没有 identity 时回退路径比较。
    expect(
      isSameWebRemoteControlTarget(snapshot({ sessionId: "s", workspacePath: "/a" }), "/a"),
    ).toBe(true);
  });

  it("有会话 id 但没有 workspacePath 也不能复用", () => {
    expect(isSameWebRemoteControlTarget(snapshot({ sessionId: "s" }), "/a")).toBe(false);
  });

  it("remoteSessionId 必须对应：快照有、期望没有时不算同一目标", () => {
    const status = snapshot({ workspacePath: "/a", remoteSessionId: "r1", sessionId: "s" });
    expect(isSameWebRemoteControlTarget(status, "/a")).toBe(false);
    expect(isSameWebRemoteControlTarget(status, "/a", undefined, "r1")).toBe(true);
    expect(isSameWebRemoteControlTarget(status, "/a", undefined, "r2")).toBe(false);
  });

  it("同路径不同 remoteSessionId 不复用，同 identity + 同 remoteSessionId 复用", () => {
    const identity = "remote:ssh:host1:22:user:/a";
    const status = snapshot({
      status: "active",
      workspacePath: "/a",
      workspaceIdentity: identity,
      remoteSessionId: "r1",
      sessionId: "s",
    });
    // 同路径 + 同 identity，但远端重连换了连接实例：不复用（当前目标需重新 start）。
    expect(isSameWebRemoteControlTarget(status, "/a", identity, "r2")).toBe(false);
    // 同路径 + 同 identity + 同 remoteSessionId：复用。
    expect(isSameWebRemoteControlTarget(status, "/a", identity, "r1")).toBe(true);
    // 期望没带 remoteSessionId 时，快照带也不复用，避免把远端会话当成本地目标。
    expect(isSameWebRemoteControlTarget(status, "/a", identity)).toBe(false);
  });

  it("没有任何会话 id 时不算同一目标", () => {
    expect(isSameWebRemoteControlTarget(snapshot({ workspacePath: "/a" }), "/a")).toBe(false);
  });
});

describe("isReusableWebRemoteControlSession", () => {
  it("只有已连上手机且会话 id 在才跨 workspace 复用", () => {
    expect(
      isReusableWebRemoteControlSession(
        snapshot({ status: "running", mobileConnected: true, sessionId: "s" }),
      ),
    ).toBe(true);
    // 未连手机：不能因为别的 workspace 在跑就拒绝为当前 workspace start。
    expect(isReusableWebRemoteControlSession(snapshot({ status: "running", sessionId: "s" }))).toBe(
      false,
    );
    expect(
      isReusableWebRemoteControlSession(snapshot({ status: "running", mobileConnected: true })),
    ).toBe(false);
  });

  it("idle / error 永不复用", () => {
    expect(
      isReusableWebRemoteControlSession(
        snapshot({ status: "idle", mobileConnected: true, sessionId: "s" }),
      ),
    ).toBe(false);
    expect(
      isReusableWebRemoteControlSession(
        snapshot({ status: "error", mobileConnected: true, sessionId: "s" }),
      ),
    ).toBe(false);
  });
});
