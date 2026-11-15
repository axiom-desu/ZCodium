import { describe, expect, it, vi } from "vitest";
import { V4_METHODS } from "@zcode/shared/zcode-protocol-v4";

const WORKSPACE_PATH = "/workspace/app";

class MockProcessManagerBase {
  onRuntimeLifecycle() {
    return { dispose() {} };
  }
  onRuntimeRestarted() {
    return { dispose() {} };
  }
  markReady() {}
  // existing-only 语义的关键：没有已登记 client 时返回 undefined，绝不新建进程。
  getExistingClient() {
    return undefined;
  }
}

/** 进程管理器 mock：所有载体（项目 / 管理面）共用同一个 request spy。 */
async function setup(result: Record<string, unknown>) {
  const request = vi.fn(async (method: string) => {
    if (method === V4_METHODS.sessionDataMeasure || method === V4_METHODS.sessionDataPurge)
      return result;
    throw new Error(`Unexpected method ${method}`);
  });
  const getClient = vi.fn(async () => ({
    request,
    transportKind: "stdio" as const,
    onNotification: () => ({ dispose() {} }),
    onRequest: () => ({ dispose() {} }),
    onClose: () => ({ dispose() {} }),
  }));
  vi.resetModules();
  vi.doMock("../src/zcode-agent/zcodeAgentProcessManager.js", () => ({
    ZCodeAgentProcessManager: class extends MockProcessManagerBase {
      getClient = getClient;
      disposeAll() {}
    },
  }));
  const { createZCodeAgentService } = await import("../src/zcode-agent/zcodeAgentService.js");
  const service = createZCodeAgentService({
    modelSelectionReadinessSource: {
      getView: async () => ({ revision: 1, providers: [] }) as never,
    },
  });
  return { service, request, getClient };
}

const directories = [{ workspacePath: "/work/site" }];

describe("sessionData 载体选择", () => {
  it("测量走全局工作流同一载体（无活跃 runtime 时用管理面进程）", async () => {
    const payload = {
      sessions: [{ sessionId: "s1", bytes: 12 }],
      memory: [{ workspacePath: "/work/site", bytes: 3 }],
    };
    const { service, request } = await setup(payload);
    const measured = await service.measureSessionData!({ sessionIds: ["s1"], directories });
    expect(measured).toEqual(payload);
    expect(request).toHaveBeenCalledWith(
      V4_METHODS.sessionDataMeasure,
      { sessionIds: ["s1"], directories },
      expect.anything(),
    );
  });

  it("删除交给该 workspace 已有进程；没有进程时回退管理面进程且不泄漏 workspace 字段", async () => {
    const payload = {
      deleted: [{ sessionId: "s1", bytes: 12 }],
      kept: [],
      failed: [],
      memory: [],
    };
    const { service, request, getClient } = await setup(payload);
    const purged = await service.purgeSessionData!({
      workspace: { workspacePath: WORKSPACE_PATH },
      sessionIds: ["s1"],
      directories,
    });
    expect(purged).toEqual(payload);
    // 第一次是 existing-only 探测（无进程），第二次回退到管理面 workspace。
    expect(getClient).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      V4_METHODS.sessionDataPurge,
      { sessionIds: ["s1"], directories },
      expect.anything(),
    );
  });

  it("远程 workspace 拒绝删除（数据在远端设备上）", async () => {
    const { service, request } = await setup({});
    await expect(
      service.purgeSessionData!({
        workspace: {
          workspacePath: WORKSPACE_PATH,
          workspaceIdentity: "remote:server:srv-1:/workspace/app",
        },
        sessionIds: ["s1"],
        directories: [],
      }),
    ).rejects.toThrow("project.data-local-only");
    expect(request).not.toHaveBeenCalled();
  });
});
