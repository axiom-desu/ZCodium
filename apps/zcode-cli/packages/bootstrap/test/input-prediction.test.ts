// 上游 3.18.2 input prediction（ghost hint）的 loopback 与协议守卫。
// 规格：.agents/specs/upstream-3.18-input-prediction.md。
// 真实 loopback 模型 + 真实 SQLite session store + 真实 AgentRuntime；协议侧用真实 dispatch。
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, it } from "node:test";

import {
  createInMemorySessionEventStore,
  createSessionId,
  type MessageId,
  type MessageWithParts,
  type ModelSelection,
  type PartId,
  type SessionId,
} from "@zcode/contracts";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import { NodeContextSourceAdapter } from "@zcode/adapters/context";
import { AiSdkModelAdapter } from "@zcode/adapters/model";
import { AgentRuntime, type InputPredictionModelCall } from "@zcode/core";
import type { RegistryProviderConfig } from "@zcode/provider";
import { V4_METHODS } from "@zcode/shared/zcode-protocol-v4";
import { dispatchV4Request } from "../src/zcode-protocol/server-dispatch-v4.js";
import type {
  ProtocolRequestDispatchHost,
  ZCodeProtocolPostResponseBatch,
} from "../src/zcode-protocol/server-dispatch-types.js";
import { UNHANDLED_REQUEST } from "../src/zcode-protocol/server-dispatch-types.js";
import type {
  ZCodeProtocolAgentServerContext,
  ZCodeProtocolSessionRecord,
} from "../src/zcode-protocol/server-types.js";
import {
  ConversationInputPredictionHandler,
  type InputPredictionSessionMaterial,
} from "../src/zcode-protocol/input-prediction-handler.js";

const servers: Server[] = [];
const originalEnv: Record<string, string | undefined> = {};
let tempRoot: string;

before(async () => {
  tempRoot = await mkdtemp(join(process.env.TMPDIR?.trim() || "/tmp", "zcode-input-prediction-"));
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

const PREDICTION_JSON =
  '{"candidates":[{"text":"提交代码","confidence":0.9},{"text":"再跑一遍","confidence":0.4}]}';

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

function anthropicReply(text: string) {
  return {
    content: [{ text, type: "text" }],
    id: `msg_${Math.random().toString(36).slice(2)}`,
    model: "fixture-model",
    role: "assistant",
    stop_reason: "end_turn",
    stop_sequence: null,
    type: "message",
    usage: { input_tokens: 100, output_tokens: 10 },
  };
}

async function listen(options: { delayMs?: number } = {}): Promise<{
  count: () => number;
  predictionCount: () => number;
  unfinishedResponseCloses: () => number;
  url: string;
}> {
  let requests = 0;
  let predictions = 0;
  let unfinishedCloses = 0;
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    response.on("close", () => {
      if (!response.writableFinished) unfinishedCloses += 1;
    });
    requests += 1;
    const body = await readBody(request);
    if (options.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      if (response.destroyed) return;
    }
    if (body.includes("输入预测器") || body.includes("输入补全器")) {
      predictions += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(anthropicReply(PREDICTION_JSON)));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(anthropicReply(`reply-${requests}`)));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    count: () => requests,
    predictionCount: () => predictions,
    unfinishedResponseCloses: () => unfinishedCloses,
    url: `http://127.0.0.1:${port}`,
  };
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

function makeRuntime(input: { baseUrl: string; sessionId: SessionId; workspace: string }) {
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

function makeRecord(
  runtime: AgentRuntime,
  selection: ModelSelection | undefined = modelSelection(),
): ZCodeProtocolSessionRecord {
  const app = {
    runtime,
    generateWorkspaceText: (request: Parameters<AgentRuntime["generateWorkspaceText"]>[0], options?: Parameters<AgentRuntime["generateWorkspaceText"]>[1]) =>
      runtime.generateWorkspaceText(request, options),
  };
  return {
    app,
    memoryEnabled: false,
    nativeSearchEnhancementsEnabled: false,
    modelContextBudgetStrategy: "balanced",
    createdAt: Date.now(),
    eventStore: createInMemorySessionEventStore(),
    persistence: "persisted",
    protocolEventSequences: new Map(),
    protocolToolInputTransmissions: new Map(),
    stateRevision: 0,
    traceContext: { sessionId: runtime.sessionId, traceId: "trace-input-prediction" },
    updatedAt: Date.now(),
    workspace: { workspacePath: runtime.workingDirectory },
    ...(selection ? { restoredModelSelection: selection } : {}),
  } as unknown as ZCodeProtocolSessionRecord;
}

function makeHost(
  sessions: Map<string, ZCodeProtocolSessionRecord>,
  sessionStore: ReturnType<typeof createSqliteSessionStore>,
): ProtocolRequestDispatchHost {
  const context = {
    deps: { sessionStore },
    sessions,
    notify: () => undefined,
    v4Interactions: {},
  } as unknown as ZCodeProtocolAgentServerContext;
  return {
    context,
    requireV4Gateway: () => {
      throw new Error("v4 gateway is not used by input prediction");
    },
    setPostResponseBatch: (_requestId: string, _batch: ZCodeProtocolPostResponseBatch) => undefined,
    pluginOperationControllers: new Map(),
    workspaceGenerateTextControllers: new Map(),
  };
}

async function dispatchPrediction(
  host: ProtocolRequestDispatchHost,
  params: Record<string, unknown>,
): Promise<unknown> {
  return dispatchV4Request(host, {
    id: 1,
    method: V4_METHODS.conversationInputPrediction,
    params,
  } as never);
}

it("真实 runtime/loopback：预测调用一次模型，且不写会话消息、不改 stateRevision", async () => {
  const workspace = await mkdtemp(join(tempRoot, "workspace-"));
  const dbPath = join(workspace, "session.sqlite");
  const { predictionCount, url } = await listen();
  const store = createSqliteSessionStore({ dbPath });
  const sessionId = createSessionId("input-prediction-e2e");
  const runtime = makeRuntime({ baseUrl: url, sessionId, workspace });
  const record = makeRecord(runtime);
  const sessions = new Map<string, ZCodeProtocolSessionRecord>([[sessionId, record]]);
  const host = makeHost(sessions, store);
  try {
    await store.createSession({
      id: sessionId,
      projectID: workspace as never,
      slug: "input-prediction",
      directory: workspace,
      title: "input prediction",
      version: "test",
    });
    await runtime.ensureSessionPersistedForExternalActivity("start");
    await seedTurn(store, sessionId, "第一轮用户输入", "第一轮回复");
    await seedTurn(store, sessionId, "第二轮用户输入", "第二轮回复");
    const before = await store.messages({ sessionID: sessionId });
    const beforeUpdatedAt = record.updatedAt;
    assert.equal(before.length, 4);

    const first = await dispatchPrediction(host, { sessionId, revision: 0, requestId: "r1" });
    assert.deepEqual(first, {
      decision: "show",
      candidates: [
        { text: "提交代码", confidence: 0.9 },
        { text: "再跑一遍", confidence: 0.4 },
      ],
      topConfidence: 0.9,
      requestId: "r1",
    });
    assert.equal(predictionCount(), 1);
    // 只读：不生成 accepted 消息，session 修订号不动。
    const afterMessages = await store.messages({ sessionID: sessionId });
    assert.equal(afterMessages.length, before.length);
    assert.equal(
      afterMessages.some((message) => textOf(message).includes("提交代码")),
      false,
    );
    assert.equal(record.stateRevision, 0);
    assert.equal(record.updatedAt, beforeUpdatedAt);

    // 同 (session, revision, draft) 命中缓存：模型不再调用，requestId 仍回显。
    const cached = await dispatchPrediction(host, { sessionId, revision: 0, requestId: "r2" });
    assert.deepEqual(cached, { ...(first as Record<string, unknown>), requestId: "r2" });
    assert.equal(predictionCount(), 1);

    // 新 revision（例如手机发送/切换后）不命中旧缓存，重新打模型。
    await dispatchPrediction(host, { sessionId, revision: 1, requestId: "r3" });
    assert.equal(predictionCount(), 2);
  } finally {
    store.close?.();
  }
});

async function seedTurn(
  store: ReturnType<typeof createSqliteSessionStore>,
  sessionId: SessionId,
  userText: string,
  assistantText: string,
): Promise<void> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const userId = `msg_user_${suffix}` as MessageId;
  const assistantId = `msg_assistant_${suffix}` as MessageId;
  await store.saveMessage({
    id: userId,
    sessionID: sessionId,
    role: "user",
    time: { created: Date.now() },
    agent: "main",
  } as never);
  await store.savePart({
    id: `part_user_${suffix}` as PartId,
    sessionID: sessionId,
    messageID: userId,
    type: "text",
    text: userText,
  });
  await store.saveMessage({
    id: assistantId,
    sessionID: sessionId,
    role: "assistant",
    time: { created: Date.now(), completed: Date.now() },
    parentID: userId,
    mode: "build",
    agent: "main",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  } as never);
  await store.savePart({
    id: `part_assistant_${suffix}` as PartId,
    sessionID: sessionId,
    messageID: assistantId,
    type: "text",
    text: assistantText,
  });
}

it("真实 cancel dispatch 关闭 loopback 模型 HTTP 响应，且关闭时响应未完成", async () => {
  const workspace = await mkdtemp(join(tempRoot, "workspace-cancel-"));
  const store = createSqliteSessionStore({ dbPath: join(workspace, "session.sqlite") });
  const modelServer = await listen({ delayMs: 5_000 });
  const sessionId = createSessionId("input-prediction-cancel-e2e");
  const runtime = makeRuntime({ baseUrl: modelServer.url, sessionId, workspace });
  const record = makeRecord(runtime);
  const host = makeHost(new Map([[sessionId, record]]), store);
  try {
    await store.createSession({
      id: sessionId,
      projectID: workspace as never,
      slug: "input-prediction-cancel",
      directory: workspace,
      title: "input prediction cancel",
      version: "test",
    });
    await runtime.ensureSessionPersistedForExternalActivity("start");
    await seedTurn(store, sessionId, "本地测试输入一", "本地测试回复一");
    await seedTurn(store, sessionId, "本地测试输入二", "本地测试回复二");

    const prediction = dispatchPrediction(host, {
      sessionId,
      revision: 8,
      requestId: "http-cancel",
    });
    const deadline = Date.now() + 5_000;
    while (modelServer.count() === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (modelServer.count() === 0) {
      const outcome = await prediction;
      assert.fail(`real runtime did not reach loopback model: ${JSON.stringify(outcome)}`);
    }
    assert.equal(modelServer.count(), 1, "real runtime must connect to the loopback model");
    await dispatchV4Request(host, {
      id: 2,
      method: V4_METHODS.conversationInputPredictionCancel,
      params: { sessionId, requestId: "http-cancel" },
    } as never);
    assert.equal(
      (await prediction as { decision: string }).decision,
      "cancelled",
      "cancel dispatch must settle the pending protocol request",
    );
    const closeDeadline = Date.now() + 5_000;
    while (modelServer.unfinishedResponseCloses() === 0 && Date.now() < closeDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(
      modelServer.unfinishedResponseCloses(),
      1,
      "real HTTP response must close before writableFinished, proving transport cancellation",
    );
  } finally {
    store.close?.();
  }
});

it("会话不在内存或没有模型选择时不发起模型调用", async () => {
  const store = createSqliteSessionStore({ dbPath: join(tempRoot, "missing.sqlite") });
  const missingHost = makeHost(new Map(), store);
  const missing = await dispatchPrediction(missingHost, { sessionId: "nope", revision: 0 });
  assert.deepEqual(missing, {
    decision: "suppress_no_context",
    candidates: [],
    topConfidence: 0,
  });
  store.close?.();
});

it("handler：同会话新请求中止旧请求；dispose 中止全部在途", async () => {
  const pending = new Map<string, (value: { text: string }) => void>();
  const signals: AbortSignal[] = [];
  const callModel: InputPredictionModelCall = async (messages, options) => {
    signals.push(options.abortSignal);
    return new Promise((resolve) => {
      pending.set(messages[1]!.content, resolve);
    });
  };
  const material: InputPredictionSessionMaterial = {
    turns: [
      { userText: "修 lint", assistantText: "好了" },
      { userText: "跑单测", assistantText: "通过" },
    ],
    callModel,
  };
  const handler = new ConversationInputPredictionHandler({ loadSession: async () => material });
  const stale = handler.handle({ sessionId: "s", revision: 1, requestId: "old" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const fresh = handler.handle({
    sessionId: "s",
    revision: 1,
    draft: "提交",
    requestId: "new",
  });
  assert.deepEqual(await stale, {
    decision: "cancelled",
    candidates: [],
    topConfidence: 0,
    requestId: "old",
  });
  assert.equal(signals[0]?.aborted, true);
  handler.cancel({ sessionId: "s", requestId: "new" });
  assert.equal(signals[1]?.aborted, true);
  assert.deepEqual(await fresh, {
    decision: "cancelled",
    candidates: [],
    topConfidence: 0,
    requestId: "new",
  });

  const disposable = handler.handle({ sessionId: "s", revision: 2, requestId: "dispose" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  handler.dispose();
  assert.equal(signals[2]?.aborted, true);
  await disposable;
});

it("handler：模型返回前会话 record 换代 → cancelled，旧结果不写给新会话", async () => {
  let resolveModel: ((value: { text: string }) => void) | undefined;
  const material: InputPredictionSessionMaterial = {
    turns: [
      { userText: "a", assistantText: "b" },
      { userText: "c", assistantText: "d" },
    ],
    callModel: () => new Promise((resolve) => (resolveModel = resolve)),
    generationToken: "record-1",
  };
  let current = "record-1";
  const handler = new ConversationInputPredictionHandler({
    loadSession: async () => material,
    isCurrentSession: (_sessionId, token) => token === current,
  });
  const pending = handler.handle({ sessionId: "s", revision: 0, requestId: "r" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  current = "record-2";
  resolveModel?.({ text: PREDICTION_JSON });
  assert.deepEqual(await pending, {
    decision: "cancelled",
    candidates: [],
    topConfidence: 0,
    requestId: "r",
  });
});

it("handler：缓存命中也校验 session generation，换代后重新预测而不复播旧结果", async () => {
  let generation = "record-1";
  let calls = 0;
  const handler = new ConversationInputPredictionHandler({
    loadSession: async () => ({
      turns: [
        { userText: "a", assistantText: "b" },
        { userText: "c", assistantText: "d" },
      ],
      generationToken: generation,
      callModel: async () => {
        calls += 1;
        return { text: PREDICTION_JSON };
      },
    }),
    isCurrentSession: (_sessionId, token) => token === generation,
  });
  const request = { sessionId: "s", revision: 0, draft: "提交" };
  const first = await handler.handle(request);
  assert.equal(first.decision, "show");
  assert.equal(calls, 1);
  generation = "record-2";
  const afterReplacement = await handler.handle(request);
  assert.equal(afterReplacement.decision, "show");
  assert.equal(calls, 2, "a prior generation cache entry must not be replayed");
});

it("handler：无模型/模型失败 → unavailable，日志不含草稿内容", async () => {
  const warnings: unknown[] = [];
  const logger = {
    warn: (_message: string, fields: unknown) => warnings.push(fields),
  } as unknown as NonNullable<
    ConstructorParameters<typeof ConversationInputPredictionHandler>[0]["logger"]
  >;
  const noModel = new ConversationInputPredictionHandler({
    loadSession: async () => ({
      turns: [
        { userText: "a", assistantText: "b" },
        { userText: "c", assistantText: "d" },
      ],
      callModel: null,
    }),
  });
  assert.equal((await noModel.handle({ sessionId: "s", revision: 0 })).decision, "unavailable");

  const failing = new ConversationInputPredictionHandler({
    loadSession: async () => ({
      turns: [
        { userText: "a", assistantText: "b" },
        { userText: "c", assistantText: "d" },
      ],
      callModel: async () => {
        throw new Error("network down");
      },
    }),
    logger,
  });
  const result = await failing.handle({ sessionId: "s", revision: 0, draft: "秘密草稿" });
  assert.equal(result.decision, "unavailable");
  assert.equal(JSON.stringify(warnings).includes("秘密草稿"), false);
  // unavailable 不缓存：下一次仍会走模型。
  assert.equal((await failing.handle({ sessionId: "s", revision: 0, draft: "秘密草稿" })).decision, "unavailable");
});

it("dispatch 不把输入预测当成未实现方法", async () => {
  const store = createSqliteSessionStore({ dbPath: join(tempRoot, "dispatch.sqlite") });
  const host = makeHost(new Map(), store);
  const result = await dispatchPrediction(host, { sessionId: "none", revision: 0 });
  assert.notEqual(result, UNHANDLED_REQUEST);
  store.close?.();
});

function textOf(message: MessageWithParts): string {
  return message.parts.map((part) => (part.type === "text" ? part.text : "")).join("");
}
