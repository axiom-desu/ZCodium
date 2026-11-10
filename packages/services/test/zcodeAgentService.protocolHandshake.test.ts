import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Emitter } from "@zcode/rpc";
import {
  ZCODE_PROTOCOL_NAME,
  ZCODE_PROTOCOL_VERSION,
  zcodeProtocolMethods,
  zcodeProtocolNotifications,
  type ZCodeProtocolMessage,
  type ZCodeProtocolRequest,
} from "@zcode/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ZCodeProtocolClient } from "../src/zcode-agent/zcodeProtocolClient.js";

const WORKSPACE_PATH = "/workspace/app";
const PROCESS_MANAGER_MODULE = "../src/zcode-agent/zcodeAgentProcessManager.js";
const FAILED_STARTUP_STATE = {
  schemaVersion: 1 as const,
  attemptId: "attempt-protocol-handshake",
  sequence: 1,
  databaseId: "database-protocol-handshake",
  databaseKind: "session" as const,
  phase: "failed" as const,
  errorCode: "sql_failed" as const,
  elapsedMs: 1,
};

type ServiceModule = typeof import("../src/zcode-agent/zcodeAgentService.js");
type AgentService = ReturnType<ServiceModule["createZCodeAgentService"]>;
type CapabilitiesResponse = { result: unknown } | { error: { code: number; message: string } };

interface MemoryHarness {
  client: ZCodeProtocolClient;
  sent: ReturnType<typeof vi.fn>;
  emit: (message: ZCodeProtocolMessage) => void;
}

interface MemoryClientOptions {
  capabilities: (request: ZCodeProtocolRequest) => CapabilitiesResponse;
  requireStorageStartup?: boolean;
  beforeInitialize?: (harness: MemoryHarness) => void;
}

class MockProcessManagerBase {
  onRuntimeLifecycle() {
    return { dispose() {} };
  }
  onRuntimeRestarted() {
    return { dispose() {} };
  }
  markReady() {}
  disposeAll() {}
}

let createZCodeAgentService!: ServiceModule["createZCodeAgentService"];
let currentClient: ZCodeProtocolClient | undefined;
const createdClients: ZCodeProtocolClient[] = [];
const createdServices: AgentService[] = [];
const originalEnv = new Map<string, string | undefined>();
let restoreConsole: (() => void) | undefined;
let tempRoot: string | undefined;

function capabilitiesResult(result: unknown) {
  return (request: ZCodeProtocolRequest): CapabilitiesResponse =>
    request.method === zcodeProtocolMethods.runtimeCapabilities
      ? { result }
      : { error: { code: -32601, message: `Method not found: ${request.method}` } };
}

function capabilitiesError(code: number, message: string) {
  return (): CapabilitiesResponse => ({ error: { code, message } });
}

function createMemoryClient(options: MemoryClientOptions): MemoryHarness {
  const received = new Emitter<ZCodeProtocolMessage>();
  const closed = new Emitter<{ reason?: string }>();
  const sent = vi.fn(async (message: ZCodeProtocolMessage) => {
    if (!("method" in message) || !("id" in message)) return;
    received.fire({ id: message.id, ...options.capabilities(message) });
  });
  const client = new ZCodeProtocolClient(
    {
      kind: "memory",
      onMessage: received.event,
      onClose: closed.event,
      send: sent,
      dispose() {
        received.dispose();
        closed.dispose();
      },
    },
    { requireStorageStartup: options.requireStorageStartup ?? false },
  );
  return {
    client,
    sent,
    emit: (message) => received.fire(message),
  };
}

function createService(): AgentService {
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
  });
  createdServices.push(service);
  return service;
}

async function initializeWith(options: MemoryClientOptions) {
  const harness = createMemoryClient(options);
  createdClients.push(harness.client);
  currentClient = harness.client;
  options.beforeInitialize?.(harness);
  const service = createService();
  const result = await service.initialize({ workspacePath: WORKSPACE_PATH });
  return { result, harness, service };
}

function sentMethods(sent: ReturnType<typeof vi.fn>): string[] {
  return sent.mock.calls.flatMap(([message]) =>
    "method" in (message as ZCodeProtocolMessage) ? [(message as { method: string }).method] : [],
  );
}

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "zcode-agent-protocol-handshake-"));
  const fakeHome = join(tempRoot, "home");
  const env = {
    HOME: fakeHome,
    USERPROFILE: fakeHome,
    ZCODE_DATA_BASE_DIR: join(tempRoot, "data"),
    ZCODE_LOG_DIR: join(tempRoot, "logs"),
    ZCODE_DESKTOP_HOME_DIR: fakeHome,
    XDG_CONFIG_HOME: join(tempRoot, "config"),
    XDG_DATA_HOME: join(tempRoot, "xdg-data"),
    XDG_CACHE_HOME: join(tempRoot, "cache"),
  };
  await Promise.all([
    mkdir(env.HOME, { recursive: true }),
    mkdir(env.ZCODE_DATA_BASE_DIR, { recursive: true }),
    mkdir(env.ZCODE_LOG_DIR, { recursive: true }),
  ]);
  for (const [key, value] of Object.entries(env)) {
    originalEnv.set(key, process.env[key]);
    process.env[key] = value;
  }

  const consoleSpies = [
    vi.spyOn(console, "log"),
    vi.spyOn(console, "info"),
    vi.spyOn(console, "warn"),
    vi.spyOn(console, "error"),
    vi.spyOn(console, "debug"),
  ];
  for (const spy of consoleSpies) spy.mockImplementation(() => {});
  restoreConsole = () => {
    for (const spy of consoleSpies) spy.mockRestore();
  };

  vi.doMock(PROCESS_MANAGER_MODULE, () => ({
    ZCodeAgentProcessManager: class extends MockProcessManagerBase {
      async getClient() {
        if (!currentClient) throw new Error("test process manager has no client");
        return currentClient;
      }
    },
  }));
  ({ createZCodeAgentService } = await import("../src/zcode-agent/zcodeAgentService.js"));
});

afterEach(() => {
  try {
    for (const service of createdServices.splice(0)) service.disposeAll();
  } finally {
    for (const client of createdClients.splice(0)) client.dispose();
  }
  currentClient = undefined;
  vi.clearAllMocks();
});

afterAll(async () => {
  vi.doUnmock(PROCESS_MANAGER_MODULE);
  vi.resetModules();
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  originalEnv.clear();
  restoreConsole?.();
  restoreConsole = undefined;
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
});

describe("createZCodeAgentService.initialize 协议握手结果", () => {
  it("声明 v1 capabilities 时 available=true 且 protocolVerified=true", async () => {
    const { result, harness } = await initializeWith({
      capabilities: capabilitiesResult({
        protocol: { name: ZCODE_PROTOCOL_NAME, version: ZCODE_PROTOCOL_VERSION },
        independentPlanState: true,
      }),
    });

    expect(result).toMatchObject({
      available: true,
      protocolVerified: true,
      protocolName: ZCODE_PROTOCOL_NAME,
      protocolVersion: ZCODE_PROTOCOL_VERSION,
    });
    expect(sentMethods(harness.sent)).toEqual([zcodeProtocolMethods.runtimeCapabilities]);
    expect(harness.client.isDisposed).toBe(false);
  });

  it("声明 v3 capabilities 时不可用并返回 agent_protocol_mismatch", async () => {
    const { result, harness } = await initializeWith({
      capabilities: capabilitiesResult({
        protocol: { name: ZCODE_PROTOCOL_NAME, version: 3 },
        independentPlanState: true,
      }),
    });

    expect(result.available).toBe(false);
    expect(result.protocolVerified).toBe(false);
    expect(result.reasonCode).toBe("agent_protocol_mismatch");
    expect(result.reason).toContain("v3");
    expect(result.reason).toContain("v1");
    expect(harness.client.isDisposed).toBe(false);
  });

  it("capabilities 形状非法时返回 agent_response_invalid，而不是版本不匹配", async () => {
    const { result } = await initializeWith({
      capabilities: capabilitiesResult({ independentPlanState: "wrong" }),
    });

    expect(result.available).toBe(false);
    expect(result.protocolVerified).toBe(false);
    expect(result.reasonCode).toBe("agent_response_invalid");
    expect(result.reason).toContain("未声明协议版本");
    expect(result.reason).not.toContain("版本不匹配");
  });

  it.each([
    ["旧 Agent 未声明协议身份", { independentPlanState: true }],
    ["空 capabilities 响应", {}],
  ])("%s 时保持可用但 protocolVerified=false", async (_label, capabilities) => {
    const { result, harness } = await initializeWith({
      capabilities: capabilitiesResult(capabilities),
    });

    expect(result).toMatchObject({
      available: true,
      protocolVerified: false,
      protocolName: ZCODE_PROTOCOL_NAME,
      protocolVersion: ZCODE_PROTOCOL_VERSION,
    });
    expect(result.reasonCode).toBeUndefined();
    expect(harness.client.isDisposed).toBe(false);
  });

  it("capabilities 方法不支持时按可恢复的 unverified 处理", async () => {
    const { result, harness } = await initializeWith({
      capabilities: capabilitiesError(-32601, "Method not found"),
    });
    expect(result).toMatchObject({ available: true, protocolVerified: false });
    expect(result.reasonCode).toBeUndefined();
    expect(harness.client.isDisposed).toBe(false);
    expect(harness.client.pendingRequestCount).toBe(0);
  });

  it("storage gate 终态失败不可用，不能谎报为可恢复或版本不匹配", async () => {
    const { result, harness } = await initializeWith({
      capabilities: capabilitiesResult({
        protocol: { name: ZCODE_PROTOCOL_NAME, version: ZCODE_PROTOCOL_VERSION },
      }),
      requireStorageStartup: true,
      beforeInitialize: (harness) =>
        harness.emit({
          method: zcodeProtocolNotifications.storageStartup,
          params: FAILED_STARTUP_STATE,
        }),
    });
    expect(result).toMatchObject({ available: false, protocolVerified: false });
    expect(result.reason).toContain("SQLite startup failed");
    expect(result.reasonCode).toBeUndefined();
    expect(harness.client.pendingRequestCount).toBe(0);
    expect(harness.sent).not.toHaveBeenCalled();
  });
});
