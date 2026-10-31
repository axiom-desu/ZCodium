import { describe, expect, it, vi } from "vitest";
import {
  createDynamicWorkflowClientConfig,
  zcodeProtocolMethods,
  type DynamicWorkflowClientConfig,
  type DynamicWorkflowMode,
} from "@zcode/shared";
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
}

function sessionSnapshot(sessionId: string) {
  return {
    session: { sessionId, traceId: undefined },
    messages: [],
    settings: { model: { current: undefined } },
  };
}

async function setup(params: {
  configResolver?: () => Promise<DynamicWorkflowClientConfig | undefined>;
  policyResponse?: (request: unknown) => unknown | Promise<unknown>;
  userModeResolver?: () => Promise<DynamicWorkflowMode | undefined>;
  engineSupport?: "supported" | "unsupported";
  forwardUserMode?: (mode: DynamicWorkflowMode | undefined) => void;
}) {
  const resolveConfig = vi.fn(
    params.configResolver ??
      (async (): Promise<DynamicWorkflowClientConfig> =>
        createDynamicWorkflowClientConfig("alwaysOn", "remote")),
  );
  const request = vi.fn(async (method: string, requestParams?: unknown) => {
    if (method === zcodeProtocolMethods.workspaceUpdateDynamicWorkflowPolicy) {
      if (params.policyResponse) return params.policyResponse(requestParams);
      return requestParams;
    }
    if (method === zcodeProtocolMethods.sessionCreate) return sessionSnapshot("session-created");
    if (method === zcodeProtocolMethods.sessionResume) return sessionSnapshot("session-resumed");
    if (method === V4_METHODS.command) {
      return {
        status: "accepted",
        commandId: (requestParams as { commandId: string }).commandId,
        result: { type: "createSession", sessionId: "v4-session" },
      };
    }
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
      getView: async () =>
        ({
          revision: 1,
          providers: [
            {
              providerId: "provider",
              providerName: "Provider",
              templateId: "template",
              config: {},
              models: [{ modelId: "model" }],
            },
          ],
        }) as never,
    },
    resolveDynamicWorkflowClientConfig: resolveConfig,
    ...(params.userModeResolver ? { resolveDynamicWorkflowUserMode: params.userModeResolver } : {}),
    ...(params.engineSupport
      ? { resolveDynamicWorkflowEngineSupport: () => params.engineSupport! }
      : {}),
    ...(params.forwardUserMode ? { forwardDynamicWorkflowUserMode: params.forwardUserMode } : {}),
  });
  return { service, request, getClient, resolveConfig };
}

function policyCalls(request: ReturnType<typeof vi.fn>) {
  return request.mock.calls.filter(
    ([method]) => method === zcodeProtocolMethods.workspaceUpdateDynamicWorkflowPolicy,
  );
}

function paramsOf(request: ReturnType<typeof vi.fn>, method: string) {
  return request.mock.calls.filter(([called]) => called === method).map(([, value]) => value);
}

function v4CreateSessionEnvelope(commandId: string) {
  return {
    commandId,
    clientId: "client-dwf",
    sessionId: null,
    type: "createSession" as const,
    payload: { workspaceId: WORKSPACE_PATH },
    issuedAt: 1700000000000,
  };
}

describe("workspace/updateDynamicWorkflowPolicy 同步", () => {
  it("开启时下发 enabled + mode；onDemand 原样保留", async () => {
    const { service, request } = await setup({
      configResolver: async () => createDynamicWorkflowClientConfig("onDemand", "remote"),
    });
    try {
      await service.initialize({ workspacePath: WORKSPACE_PATH });
      expect(policyCalls(request).map(([, value]) => value)).toEqual([
        expect.objectContaining({ enabled: true, mode: "onDemand" }),
      ]);
    } finally {
      service.disposeAll();
    }
  });

  it("瞬时失败不记账：下一次同值同步仍会重发（无自动定时器）", async () => {
    let fail = true;
    const { service, request } = await setup({
      configResolver: async () => createDynamicWorkflowClientConfig("alwaysOn", "remote"),
      policyResponse: (value) => {
        if (fail) throw new Error("request timed out");
        return value;
      },
    });
    try {
      await service.initialize({ workspacePath: WORKSPACE_PATH });
      expect(policyCalls(request)).toHaveLength(1);
      // 第一次失败后 applied 必须仍是 disabled；同一选择再次同步要重新发。
      fail = false;
      await service.syncDynamicWorkflowUserMode({ mode: "alwaysOn" });
      expect(policyCalls(request)).toHaveLength(2);
      // 已被接受后才记账：再来一次同值同步不再发。
      await service.syncDynamicWorkflowUserMode({ mode: "alwaysOn" });
      expect(policyCalls(request)).toHaveLength(2);
    } finally {
      service.disposeAll();
    }
  });

  it("提供读取失败 + Rust 引擎不支持：用户选择保留，但不能冒充开启", async () => {
    const { service, request } = await setup({
      configResolver: async () => {
        throw new Error("offline");
      },
      engineSupport: "unsupported",
      userModeResolver: async () => "onDemand",
    });
    try {
      await service.createSession({ workspacePath: WORKSPACE_PATH, sessionId: "s-rust-offline" });
      expect(policyCalls(request)).toHaveLength(0);
      expect(paramsOf(request, zcodeProtocolMethods.sessionCreate)[0]).not.toHaveProperty(
        "dynamicWorkflowMode",
      );
    } finally {
      service.disposeAll();
    }
  });

  it("同一 workspace 的策略同步串行：慢请求返回前不发下一条，最后落地最新选择", async () => {
    let choice: DynamicWorkflowMode | undefined;
    let releaseSlow: (() => void) | undefined;
    let policyRequests = 0;
    const { service, request } = await setup({
      userModeResolver: async () => choice,
      policyResponse: async (value) => {
        policyRequests += 1;
        if (policyRequests === 2) {
          await new Promise<void>((resolveSlow) => {
            releaseSlow = resolveSlow;
          });
        }
        return value;
      },
    });
    try {
      await service.initialize({ workspacePath: WORKSPACE_PATH });
      choice = "disabled";
      const slow = service.syncDynamicWorkflowUserMode({ mode: "disabled" });
      await vi.waitFor(() => expect(releaseSlow).toBeDefined());
      choice = "onDemand";
      const fast = service.syncDynamicWorkflowUserMode({ mode: "onDemand" });
      // 第二条必须排队：第一条未返回时不能出现第三条请求。
      expect(policyCalls(request)).toHaveLength(2);
      releaseSlow?.();
      await Promise.all([slow, fast]);
      const sent = policyCalls(request).map(([, value]) => value as Record<string, unknown>);
      expect(sent).toHaveLength(3);
      expect(sent[1]).toEqual({
        workspace: expect.objectContaining({ workspacePath: WORKSPACE_PATH }),
        enabled: false,
      });
      expect(sent[2]).toMatchObject({ enabled: true, mode: "onDemand" });
    } finally {
      service.disposeAll();
    }
  });

  it("旧 CLI 的 -32601 同样不记账，但降级不阻断", async () => {
    const { service, request } = await setup({
      configResolver: async () => createDynamicWorkflowClientConfig("alwaysOn", "remote"),
      policyResponse: () => {
        throw Object.assign(new Error("Method not found"), { code: -32601 });
      },
    });
    try {
      await service.initialize({ workspacePath: WORKSPACE_PATH });
      expect(policyCalls(request)).toHaveLength(1);
    } finally {
      service.disposeAll();
    }
  });
});

describe("session create / resume / v4 createSession 的 mode", () => {
  it("三条创建路径都带 dynamicWorkflowMode:onDemand", async () => {
    const { service, request } = await setup({
      configResolver: async () => createDynamicWorkflowClientConfig("onDemand", "remote"),
    });
    try {
      await service.createSession({ workspacePath: WORKSPACE_PATH, sessionId: "s-create" });
      await service.resumeSession({ workspacePath: WORKSPACE_PATH, sessionId: "s-resume" });
      await service.sendConversationCommandV4({
        workspacePath: WORKSPACE_PATH,
        envelope: v4CreateSessionEnvelope("cmd-dwf-on-demand"),
      });
      expect(paramsOf(request, zcodeProtocolMethods.sessionCreate)[0]).toMatchObject({
        dynamicWorkflowEnabled: true,
        dynamicWorkflowMode: "onDemand",
      });
      expect(paramsOf(request, zcodeProtocolMethods.sessionResume)[0]).toMatchObject({
        dynamicWorkflowEnabled: true,
        dynamicWorkflowMode: "onDemand",
      });
      expect(paramsOf(request, V4_METHODS.command)[0]).toMatchObject({
        payload: { dynamicWorkflowEnabled: true, dynamicWorkflowMode: "onDemand" },
      });
    } finally {
      service.disposeAll();
    }
  });

  it("用户选择每次现读：两次建会话之间改选择，第二次带新模式", async () => {
    let choice: DynamicWorkflowMode | undefined = "onDemand";
    const { service, request, resolveConfig } = await setup({
      userModeResolver: async () => choice,
    });
    try {
      await service.createSession({ workspacePath: WORKSPACE_PATH, sessionId: "s-1" });
      choice = "alwaysOn";
      await service.createSession({ workspacePath: WORKSPACE_PATH, sessionId: "s-2" });
      const creates = paramsOf(request, zcodeProtocolMethods.sessionCreate);
      expect(creates[0]).toMatchObject({ dynamicWorkflowMode: "onDemand" });
      expect(creates[1]).toMatchObject({ dynamicWorkflowMode: "alwaysOn" });
      expect(resolveConfig).toHaveBeenCalledTimes(1);
    } finally {
      service.disposeAll();
    }
  });

  it("用户关闭即使提供开启也不带字段", async () => {
    const { service, request } = await setup({
      userModeResolver: async () => "disabled",
    });
    try {
      await service.createSession({ workspacePath: WORKSPACE_PATH, sessionId: "s-off" });
      expect(paramsOf(request, zcodeProtocolMethods.sessionCreate)[0]).not.toHaveProperty(
        "dynamicWorkflowMode",
      );
    } finally {
      service.disposeAll();
    }
  });

  it("同步时把读到的用户选择交给转发回调（desktop 再推远程）", async () => {
    const forwardUserMode = vi.fn();
    const { service } = await setup({
      userModeResolver: async () => "onDemand",
      forwardUserMode,
    });
    try {
      await service.syncDynamicWorkflowUserMode({ mode: "disabled" });
      expect(forwardUserMode).toHaveBeenCalledWith("onDemand");
    } finally {
      service.disposeAll();
    }
  });
});
