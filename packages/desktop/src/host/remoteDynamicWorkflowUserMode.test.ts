import { describe, expect, it, vi } from "vitest";
import { pushDynamicWorkflowUserModeToRemoteHosts } from "./remoteDynamicWorkflowUserMode.js";

function fakeAgentService() {
  return { syncDynamicWorkflowUserMode: vi.fn(async () => {}) };
}

describe("pushDynamicWorkflowUserModeToRemoteHosts", () => {
  it("把选择推给每个远端 Host：有选择带 mode，跟随默认带空参数", async () => {
    const on = fakeAgentService();
    const auto = fakeAgentService();
    await pushDynamicWorkflowUserModeToRemoteHosts(
      [{ zcodeAgentService: on }, { zcodeAgentService: auto }],
      "disabled",
      () => {},
    );
    expect(on.syncDynamicWorkflowUserMode).toHaveBeenCalledWith({ mode: "disabled" });
    expect(auto.syncDynamicWorkflowUserMode).toHaveBeenCalledWith({ mode: "disabled" });

    await pushDynamicWorkflowUserModeToRemoteHosts(
      [{ zcodeAgentService: auto }],
      undefined,
      () => {},
    );
    expect(auto.syncDynamicWorkflowUserMode).toHaveBeenLastCalledWith({});
  });

  it("单个连接失败只上报，不影响其它连接，也不抛给调用方", async () => {
    const failing = {
      syncDynamicWorkflowUserMode: vi.fn(async () => {
        throw new Error("method not found");
      }),
    };
    const healthy = fakeAgentService();
    const onError = vi.fn();

    await expect(
      pushDynamicWorkflowUserModeToRemoteHosts(
        [
          { sourceServerId: "s1", zcodeAgentService: failing },
          { sourceServerId: "s2", zcodeAgentService: healthy },
        ],
        "alwaysOn",
        onError,
      ),
    ).resolves.toBeUndefined();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(healthy.syncDynamicWorkflowUserMode).toHaveBeenCalledWith({ mode: "alwaysOn" });
  });

  it("没有在线远端时是空操作", async () => {
    const onError = vi.fn();
    await pushDynamicWorkflowUserModeToRemoteHosts([], "alwaysOn", onError);
    expect(onError).not.toHaveBeenCalled();
  });
});
