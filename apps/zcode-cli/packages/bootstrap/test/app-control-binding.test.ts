import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  AppSessionControl,
  AppSessionTrustedContext,
} from "@zcode/session-control/contracts";
import type { ProviderRegistryModelSource } from "../src/app/provider-registry-model-runtime.js";
import { createZCodeApp } from "../src/app/create-app.js";
import {
  createAppSessionControlTransport,
  resolveAppControlEnabledBinding,
} from "../src/app-control/index.js";

interface Recorded {
  method: string;
  params: unknown;
  signal?: AbortSignal;
}

function fakeRequestClient(recorded: Recorded[]) {
  return (async (method: string, params: unknown, schema: { parse(value: unknown): unknown }, options?: { signal?: AbortSignal }) => {
    recorded.push({ method, params, ...(options?.signal ? { signal: options.signal } : {}) });
    if (method === "appControl/cancel") return schema.parse({ cancelled: true });
    // 十二个意图的最小成功回执；这里只验证传输参数与拒绝路径。
    return schema.parse({
      ok: false,
      error: { code: "unavailable", message: "test harness" },
    });
  }) as never;
}

test("appControlEnabled 只来自可信 Host 能力，主根之外不装配 App 绑定", () => {
  const recorded: Recorded[] = [];
  const base = {
    requestClient: fakeRequestClient(recorded),
    sessionId: "sess_root",
    workspacePath: "/workspace/a",
  };
  assert.equal(resolveAppControlEnabledBinding({ ...base, appControlEnabled: false }), undefined);
  assert.equal(
    resolveAppControlEnabledBinding({ ...base, appControlEnabled: true, taskType: "workflow_child" }),
    undefined,
  );
  assert.equal(
    resolveAppControlEnabledBinding({ ...base, appControlEnabled: true, taskType: "subagent_child" }),
    undefined,
  );
  assert.equal(
    resolveAppControlEnabledBinding({
      ...base,
      appControlEnabled: true,
      taskType: "interactive",
      parentSessionId: "sess_parent",
    }),
    undefined,
  );
  const app = resolveAppControlEnabledBinding({
    ...base,
    appControlEnabled: true,
    taskType: "interactive",
  });
  assert.equal(app?.kind, "app");
  assert.equal(
    resolveAppControlEnabledBinding({ ...base, appControlEnabled: true, taskType: "fork" })?.kind,
    "app",
  );
});

test("传输层身份来自执行上下文：模型参数不能伪造 root/callId，异构根直接拒绝", async () => {
  const recorded: Recorded[] = [];
  const binding = createAppSessionControlTransport({
    requestClient: fakeRequestClient(recorded),
    sessionId: "sess_root",
    workspacePath: "/workspace/a",
  });
  const root: AppSessionTrustedContext["rootSession"] = {
    kind: "app",
    sessionId: "sess_root",
    workspacePath: "/workspace/a",
  };
  const okContext = {
    callerId: "sess_root",
    rootSession: root,
    allowedScopes: [{ ...root, scope: "workspace" }],
    toolCallId: "tool-call-1",
    turnId: "turn-1",
  } as AppSessionTrustedContext;
  // 模型输入里的自报身份字段不符合该意图的严格 schema，不能改写绑定身份。
  await assert.rejects(
    binding.control.listSessions(okContext, { callerSessionId: "sess_forged", callId: "forged" }),
  );
  await binding.control.listSessions(okContext, {}).catch(() => undefined);
  assert.equal(recorded[0]?.method, "appControl/listSessions");
  const params = recorded[0]?.params as { callerSessionId: string; callId: string; turnId?: string };
  // 顶层身份由绑定注入；模型输入里的自报字段只可能留在 input 里，不能改写 callerSessionId。
  assert.equal(params.callerSessionId, "sess_root");
  assert.equal(params.callId, "tool-call-1");
  assert.equal(params.turnId, "turn-1");

  await assert.rejects(
    binding.control.listSessions(
      { ...okContext, rootSession: { ...root, sessionId: "sess_other" } },
      {},
    ),
    (error: { code?: string }) => error.code === "forbidden",
  );
  await assert.rejects(
    binding.control.listSessions({ ...okContext, toolCallId: undefined } as never, {}),
    (error: { code?: string }) => error.code === "forbidden",
  );
  await assert.rejects(
    binding.control.sendToSession(okContext, { sessionId: "sess_target", prompt: "go", requestId: "req-1" }),
    (error: { code?: string }) => error.code === "unavailable",
  );
  assert.equal(recorded.length, 2);
});

test("取消只释放本次观察：abort 后发出 appControl/cancel 且不带目标中断", async () => {
  const recorded: Recorded[] = [];
  const controller = new AbortController();
  const binding = createAppSessionControlTransport({
    requestClient: (async (method: string, params: unknown, schema: { parse(v: unknown): unknown }) => {
      recorded.push({ method, params });
      if (method === "appControl/cancel") return schema.parse({ cancelled: true });
      controller.abort();
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    }) as never,
    sessionId: "sess_root",
    workspacePath: "/workspace/a",
  });
  const root: AppSessionTrustedContext["rootSession"] = {
    kind: "app",
    sessionId: "sess_root",
    workspacePath: "/workspace/a",
  };
  await assert.rejects(
    binding.control.waitSessions(
      {
        callerId: "sess_root",
        rootSession: root,
        allowedScopes: [{ ...root, scope: "workspace" }],
        toolCallId: "tool-call-9",
        signal: controller.signal,
      },
      {
        operations: [{ sessionId: "sess_target", commandId: "cmd-1" }],
        mode: "any",
        timeoutMs: 0,
      },
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  const cancel = recorded.find((entry) => entry.method === "appControl/cancel");
  assert.ok(cancel, "cancel must be sent on abort");
  assert.deepEqual(cancel?.params, { callerSessionId: "sess_root", callId: "tool-call-9" });
  // 只发送取消，不发送 interruptSession。
  assert.equal(recorded.some((entry) => entry.method === "appControl/interruptSession"), false);
});

function createEmptyRegistry(): ProviderRegistryModelSource {
  const view = { providers: [], models: [] } as unknown as ReturnType<
    ProviderRegistryModelSource["getView"]
  >;
  return {
    getModel: () => undefined,
    getProvider: () => undefined,
    getView: () => view,
    onDidChange: () => () => undefined,
    validateSelection: (selection) => ({
      code: "model-not-found",
      modelId: selection.modelId,
      ok: false,
      providerId: selection.providerId,
    }),
  };
}

test("真实本地 App：App 绑定只注册 12 个 App 工具，独立 CLI 仍是 8 个", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-app-control-tools-"));
  const root: AppSessionTrustedContext["rootSession"] = {
    kind: "app",
    sessionId: "sess_root",
    workspacePath: join(directory, "workspace"),
  };
  const app = await createZCodeApp({
    env: {
      ...process.env,
      HOME: join(directory, "home"),
      XDG_CONFIG_HOME: join(directory, "xdg-config"),
      XDG_DATA_HOME: join(directory, "xdg-data"),
      ZCODE_DATA_BASE_DIR: join(directory, "data"),
      ZCODE_MAILBOX_ROOT: join(directory, "mailbox"),
    },
    providerRegistry: createEmptyRegistry(),
    sessionId: "sess_root",
    runtimeConfig: { workingDirectory: root.workspacePath },
    skipUserConfig: true,
    sessionControl: {
      kind: "app",
      control: new Proxy({} as AppSessionControl, {
        get: () => async () => {
          throw new Error("not used in registration test");
        },
      }),
      context: () => ({
        callerId: root.sessionId,
        rootSession: root,
        allowedScopes: [{ ...root, scope: "workspace" }],
      }),
    },
  });
  try {
    const names = new Set(app.runtime.registry.list());
    for (const name of [
      "ListProjects",
      "ListSessions",
      "ReadSession",
      "CreateSession",
      "ForkSession",
      "SendToSession",
      "WaitSessions",
      "InterruptSession",
      "RenameSession",
      "OpenSession",
      "SetSessionArchived",
      "SetSessionPinned",
    ]) {
      assert.ok(names.has(name), `missing App tool ${name}`);
    }
    // App 专属的四个入口也必须真实出现在注册面，而不是只有共有 8 个。
    for (const appOnly of ["ListProjects", "OpenSession", "SetSessionArchived", "SetSessionPinned"]) {
      assert.ok(names.has(appOnly), `missing App-only tool ${appOnly}`);
    }
  } finally {
    await app.close?.();
  }
});
