// 上游 3.18.2 F4（context composition）的真实 runtime 与协议守卫（C7 片）。
// 真实 loopback 模型 + 真实 SQLite session store（临时目录）+ 真实 AgentRuntime；
// 协议侧用真实 tracker 与 handler，不 mock schema。
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, it } from "node:test";

import {
  createInMemorySessionEventStore,
  createSessionId,
  type ModelSelection,
  type SessionId,
} from "@zcode/contracts";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import { NodeContextSourceAdapter } from "@zcode/adapters/context";
import { AiSdkModelAdapter } from "@zcode/adapters/model";
import { AgentRuntime } from "@zcode/core";
import type { RegistryProviderConfig } from "@zcode/provider";
import { dispatchV4Request } from "../src/zcode-protocol/server-dispatch-v4.js";
import type { ProtocolRequestDispatchHost } from "../src/zcode-protocol/server-dispatch-types.js";
import { UNHANDLED_REQUEST } from "../src/zcode-protocol/server-dispatch-types.js";
import { getConversationContextComposition } from "../src/zcode-protocol/context-composition/index.js";
import {
  V4_METHODS,
  V4_NOTIFICATIONS,
  type V4ConversationContextCompositionResult,
} from "@zcode/shared/zcode-protocol-v4";
import { ContextCompositionRevisionTracker } from "../src/zcode-protocol/context-composition/tracker.js";

const servers: Server[] = [];
const originalEnv: Record<string, string | undefined> = {};
let tempRoot: string;

before(async () => {
  tempRoot = await mkdtemp(join(tmpdirRoot(), "zcode-context-composition-"));
  // 临时 HOME/XDG：不读真实用户的配置、缓存与历史。
  for (const key of [
    "HOME",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
  ]) {
    originalEnv[key] = process.env[key];
  }
  process.env.HOME = tempRoot;
  process.env.XDG_CONFIG_HOME = join(tempRoot, "config");
  process.env.XDG_CACHE_HOME = join(tempRoot, "cache");
  process.env.XDG_DATA_HOME = join(tempRoot, "data");
  process.env.XDG_STATE_HOME = join(tempRoot, "state");
});

after(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections?.();
          server.close(() => resolve());
        }),
    ),
  );
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (tempRoot) await rm(tempRoot, { force: true, recursive: true });
});

function tmpdirRoot(): string {
  return process.env.TMPDIR?.trim() || "/tmp";
}

type ServerResponseLike = {
  end: (chunk: string) => void;
  writeHead: (status: number, headers: Record<string, string>) => void;
};

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      text += chunk;
    });
    request.on("end", () => resolve(text));
    request.on("error", reject);
  });
}

function anthropicReply(
  content: Array<Record<string, unknown>>,
  stopReason: "tool_use" | "end_turn",
) {
  return {
    content,
    id: `msg_${Math.random().toString(36).slice(2)}`,
    model: "fixture-model",
    role: "assistant",
    stop_reason: stopReason,
    stop_sequence: null,
    type: "message",
    usage: { input_tokens: 50_000, output_tokens: 100 },
  };
}

async function listen(): Promise<{ count: () => number; url: string }> {
  let requests = 0;
  const server = createServer(async (request: IncomingMessage, response: ServerResponseLike) => {
    await readBody(request);
    requests += 1;
    const reply =
      requests === 1
        ? anthropicReply(
            [
              {
                id: "call_read_agents",
                input: { file_path: join(tempRoot, "AGENTS.md") },
                name: "Read",
                type: "tool_use",
              },
            ],
            "tool_use",
          )
        : anthropicReply([{ text: `done-${requests}`, type: "text" }], "end_turn");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(reply));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { count: () => requests, url: `http://127.0.0.1:${port}` };
}

const MODEL_PROPERTIES = {
  contextWindow: 200_000,
  inputFormat: {
    supportsAudio: false,
    supportsImage: false,
    supportsPdf: false,
    supportsText: true,
    supportsVideo: false,
  },
  outputFormat: { supportsText: true },
  requiresMfjsToolSchema: false,
  supportsJsonSchemaOutput: true,
  supportsMidConversationSystem: true,
  supportsNativeWebSearch: false,
  supportsToolCall: true,
};

const OPTION_SPECS = {
  maxOutputTokens: { map: "{}", max: 32_000 },
  reasoningLevel: { map: "{}", values: ["none"] },
};

function createLoopbackModel(baseUrl: string) {
  const adapter = new AiSdkModelAdapter({
    env: {},
    retry: { maxRetries: 0 },
    streamIdleTimeoutMs: 5_000,
  });
  return adapter.createModel({
    modelConfig: {
      optionSpecs: OPTION_SPECS,
      properties: MODEL_PROPERTIES,
    } as unknown as Parameters<AiSdkModelAdapter["createModel"]>[0]["modelConfig"],
    modelId: "fixture-model",
    options: { maxOutputTokens: 1_000, reasoningLevel: "none" },
    providerConfig: {
      access: { apiKey: "test-key", type: "api-key" },
      api: { baseUrl, type: "anthropic-messages" },
    } as unknown as RegistryProviderConfig,
    providerId: "fixture-provider",
  });
}

function modelSelection(): ModelSelection {
  return { modelId: "fixture-model", providerId: "fixture-provider" } as unknown as ModelSelection;
}

function makeRuntime(input: {
  baseUrl: string;
  sessionId: SessionId;
  store: ReturnType<typeof createSqliteSessionStore>;
  workspace: string;
}) {
  const model = createLoopbackModel(input.baseUrl);
  return new AgentRuntime(
    input.sessionId,
    {
      agentName: "zcode-agent",
      memory: { enabled: false },
      mode: "yolo",
      modelSelection: modelSelection(),
      modelStreaming: "off",
      titleGeneration: { enabled: false },
      workingDirectory: input.workspace,
      workspacePath: input.workspace,
      userInstructions: { workingDirectory: input.workspace },
    },
    {
      contextSourcePort: new NodeContextSourceAdapter({ env: process.env }),
      eventStore: createInMemorySessionEventStore(),
      modelFactory: () => model,
      sessionStore: input.store,
    },
  );
}

function categoryTokens(
  composition: { categories: Array<{ id: string; tokens: number }> },
  id: string,
): number {
  return composition.categories.find((category) => category.id === id)?.tokens ?? 0;
}

it("真实 runtime：冷状态预演 → 请求相位 → 换模型/compact 失效后回到预演", async () => {
  const workspace = await mkdtemp(join(tempRoot, "workspace-"));
  await writeFile(join(workspace, "AGENTS.md"), "composition instructions\n", "utf8");
  const dbPath = join(workspace, "session.sqlite");
  const { count, url } = await listen();
  const store = createSqliteSessionStore({ dbPath });
  const runtime = makeRuntime({
    baseUrl: url,
    sessionId: createSessionId("context-composition-e2e"),
    store,
    workspace,
  });
  try {
    await runtime.ensureSessionPersistedForExternalActivity("start");

    // 冷状态：还没发过请求，没有记录组成 → 按会话当前模型预演，且不落库。
    const cold = await runtime.getContextComposition();
    assert.ok(cold);
    assert.equal(cold.phase, "draft-preview");
    assert.equal(cold.model.providerId, "fixture-provider");
    assert.equal(cold.model.modelId, "fixture-model");
    assert.equal(cold.model.contextWindow, 200_000);
    assert.ok(cold.estimatedTokens > 0);
    // 系统提示词与内置工具在预演里真实非 0（不是空壳 compose）。
    assert.ok(categoryTokens(cold, "system_prompt") > 0);
    assert.ok(categoryTokens(cold, "system_tool_schemas") > 0);
    assert.equal(count(), 0);

    await runtime.executeTurn("First turn.");
    assert.equal(count(), 2);

    // 请求相位：最近一次请求的组成，带服务商 usage（同一次分解的对象身份配对）。
    const requested = await runtime.getContextComposition();
    assert.ok(requested);
    assert.equal(requested.phase, "request");
    assert.equal(requested.providerInputTokens, 50_000);
    assert.equal(requested.providerContextTokens, 50_100);
    assert.equal(requested.freeTokens, 200_000 - requested.estimatedTokens);

    // 换模型 / compact / 前缀重建都让最近一次请求组成失效 → 查询改为预演。
    runtime.markContextCompositionChanged();
    const afterModel = await runtime.getContextComposition();
    assert.ok(afterModel);
    assert.equal(afterModel.phase, "draft-preview");

    await runtime.executeTurn("Second turn.");
    const requestedAgain = await runtime.getContextComposition();
    assert.equal(requestedAgain?.phase, "request");
    await runtime.executeTurn("/compact");
    const afterCompact = await runtime.getContextComposition();
    assert.ok(afterCompact);
    assert.equal(afterCompact.phase, "draft-preview");

    // 查询别的模型（同一工厂）同样不复用本模型的请求组成。
    await runtime.executeTurn("Third turn.");
    const otherModel = await runtime.getContextComposition({
      modelSelection: {
        providerId: "fixture-provider",
        modelId: "other-model",
      } as unknown as ModelSelection,
    });
    assert.ok(otherModel);
    // 模型工厂在本测试里固定返回同一 fixture 模型；关键是「与记录的 provider/model 不同」
    // 必须走预演，而不是复用上一份请求组成。
    assert.equal(otherModel.phase, "draft-preview");

    // 关停后查询直接 null（不冷启动、不预演）。
    await runtime.closeBrowserSession();
    assert.equal(await runtime.getContextComposition(), null);
  } finally {
    store.close();
  }
});

it("修订 tracker：同轮合并成一条通知、每会话递增、跨会话独立", async () => {
  const events: Array<{ method: string; params: unknown }> = [];
  const tracker = new ContextCompositionRevisionTracker((event) =>
    events.push({ method: "changed", params: event }),
  );
  assert.equal(tracker.revision("session-a"), 0);
  // 同一轮事件循环内多次变化：修订号只加一、只发一条通知。
  tracker.markChanged("session-a");
  tracker.markChanged("session-a");
  tracker.markChanged("session-b");
  assert.equal(tracker.revision("session-a"), 1);
  assert.equal(tracker.revision("session-b"), 1);
  await Promise.resolve();
  assert.equal(events.length, 2);
  assert.deepEqual(
    events.map((event) => event.params).sort((left, right) =>
      String((left as { sessionId: string }).sessionId).localeCompare(
        (right as { sessionId: string }).sessionId,
      ),
    ),
    [
      { sessionId: "session-a", revision: 1 },
      { sessionId: "session-b", revision: 1 },
    ],
  );
  // 下一轮再次变化：继续递增。
  tracker.markChanged("session-a");
  await Promise.resolve();
  assert.equal(tracker.revision("session-a"), 2);
  assert.equal(tracker.revision("session-b"), 1);
});

it("handler：会话不在内存回 null；修订号在测量之前读", async () => {
  const notified: unknown[] = [];
  const context = {
    notify: (notification: unknown) => notified.push(notification),
    sessions: new Map<string, unknown>(),
  } as unknown as Parameters<typeof getConversationContextComposition>[0];

  // existing-only：没有 record 时不冷启动，直接 null。
  assert.deepEqual(
    await getConversationContextComposition(context, { sessionId: "missing" }),
    { composition: null },
  );

  const tracker = new ContextCompositionRevisionTracker(() => {});
  // 让会话已有一次修订（模拟此前的请求），测量期间再触发一次。
  tracker.markChanged("session-1");
  await Promise.resolve();
  const measurement = {
    phase: "request" as const,
    measuredAt: 1,
    model: { providerId: "p", modelId: "m", contextWindow: 100 },
    tokenMethod: "estimated" as const,
    estimatedTokens: 10,
    freeTokens: 90,
    categories: [{ id: "system_prompt" as const, tokens: 10, chars: 40 }],
  };
  const sessions = new Map<string, unknown>([
    [
      "session-1",
      {
        traceContext: { traceId: "t" },
        app: {
          runtime: {
            getContextComposition: async () => {
              // 测量期间又有变化：查询返回的仍是测量前读到的修订号。
              tracker.markChanged("session-1");
              return measurement;
            },
          },
        },
      },
    ],
  ]);
  Object.assign(context, { sessions, contextCompositionTracker: tracker });

  const result = await getConversationContextComposition(context, { sessionId: "session-1" });
  assert.ok(result.composition);
  assert.equal(result.composition.sessionId, "session-1");
  assert.equal(result.composition.revision, 1);
  assert.equal(tracker.revision("session-1"), 2);
});

it("v4 分派：contextComposition 命中真实 handler，修订变化经同一 tracker 发通知", async () => {
  const notifications: Array<{ method: string; params: unknown }> = [];
  const sessions = new Map<string, unknown>();
  const context = {
    notify: (notification: { method: string; params: unknown }) => notifications.push(notification),
    requestClient: async () => {
      throw new Error("context composition query must not call the client");
    },
    sessions,
    v4Interactions: { hasPendingForSession: () => false },
  };
  const host = {
    context,
    pluginOperationControllers: new Map(),
    workspaceGenerateTextControllers: new Map(),
    requireV4Gateway: () => {
      throw new Error("context composition query must not use the v4 gateway");
    },
    setPostResponseBatch: () => {},
  } as unknown as ProtocolRequestDispatchHost;

  // 会话不在内存：分派命中（不是 UNHANDLED），existing-only 返回 null。
  const missing = await dispatchV4Request(host, {
    id: 1,
    method: V4_METHODS.conversationContextComposition,
    params: { sessionId: "ghost" },
  } as never);
  assert.notEqual(missing, UNHANDLED_REQUEST);
  assert.deepEqual(missing, { composition: null });

  // 有会话：真实 handler 补 sessionId/revision；tracker 通知经 context.notify 发出。
  sessions.set("session-1", {
    traceContext: { traceId: "t" },
    app: {
      runtime: {
        getContextComposition: async () => ({
          phase: "draft-preview" as const,
          measuredAt: 5,
          model: { providerId: "p", modelId: "m", contextWindow: null },
          tokenMethod: "estimated" as const,
          estimatedTokens: 3,
          freeTokens: null,
          categories: [{ id: "system_prompt" as const, tokens: 3, chars: 12 }],
        }),
      },
    },
  });
  // record 建立时接线（真实路径在 createRecord 里调用同一个函数）。
  const { subscribeSessionContextComposition } = await import(
    "../src/zcode-protocol/context-composition/tracker.js"
  );
  subscribeSessionContextComposition(context as never, "session-1", {
    subscribeContextCompositionChanged: (listener: () => void) => {
      listener();
      return () => {};
    },
  } as never);

  const result = (await dispatchV4Request(host, {
    id: 2,
    method: V4_METHODS.conversationContextComposition,
    params: { sessionId: "session-1" },
  } as never)) as V4ConversationContextCompositionResult;
  assert.ok(result.composition);
  assert.equal(result.composition.sessionId, "session-1");
  assert.equal(result.composition.revision, 1);
  await Promise.resolve();
  assert.deepEqual(notifications, [
    {
      method: V4_NOTIFICATIONS.conversationContextCompositionChanged,
      params: { sessionId: "session-1", revision: 1 },
    },
  ]);
});
