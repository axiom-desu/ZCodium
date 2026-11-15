// 上游 3.18.2 会话选区引用（conversationQuotes）的编辑/队列/重放/幂等闭环。
//
// 全部走真实 SQLite store 与真实生产函数（transcript hydration → canonical normalizer、
// 队列原地编辑 → session_input 账本、CommandInbox 幂等表），不 mock 这些边界。
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, it } from "node:test";

import {
  SessionEventType,
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
import { commandPayloadSchemas } from "@zcode/shared/zcode-protocol-v4";
import { CommandInbox } from "../src/zcode-protocol-v4/command-inbox.js";
import { normalizeConversationEvent } from "../src/zcode-protocol-v4/event-normalizer.js";
import { resolveEditedConversationQuotes } from "../src/zcode-protocol-v4/commands/input-intent.js";
import { synthesizeEventsFromMessages } from "../src/zcode-protocol-v4/transcript-hydration.js";

const servers: Server[] = [];
const originalEnv: Record<string, string | undefined> = {};
let tempRoot: string;

before(async () => {
  tempRoot = await mkdtemp(join(process.env.TMPDIR?.trim() || "/tmp", "zcode-quotes-replay-"));
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

/** loopback 模型：可延迟响应，用于制造 busy 状态以走真实 queue admission。 */
async function listen(options: { delayMs?: number } = {}): Promise<{ bodies: string[]; url: string }> {
  const bodies: string[] = [];
  const server = createServer(async (request, response) => {
    const text = await readBody(request);
    bodies.push(text);
    if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        content: [{ text: "ok", type: "text" }],
        id: `msg_${Math.random().toString(36).slice(2)}`,
        model: "fixture-model",
        role: "assistant",
        stop_reason: "end_turn",
        stop_sequence: null,
        type: "message",
        usage: { input_tokens: 1_000, output_tokens: 10 },
      }),
    );
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { bodies, url: `http://127.0.0.1:${port}` };
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
      modelFactory: () => createLoopbackModel(input.baseUrl),
      sessionStore: input.store,
    },
  );
}

function turnIntent(quotes?: Array<{ text: string; comment?: string }>) {
  return {
    admissionSeq: 1,
    admittedAt: Date.now(),
    admittedDelivery: "startNow" as const,
    clientId: "test-client",
    kind: "sendText" as const,
    queueItemId: "queue-quote-1",
    requestedDelivery: "startNow" as const,
    sourceCommandId: "cmd-quote-1",
    text: "Explain the selected passage",
    ...(quotes ? { conversationQuotes: quotes } : {}),
  };
}

it("冷恢复把 intent 的 quotes 还原进 canonical 事实（编辑/重试重放的唯一来源）", async () => {
  const workspace = await mkdtemp(join(tempRoot, "workspace-"));
  await writeFile(join(workspace, "AGENTS.md"), "quote replay\n", "utf8");
  const dbPath = join(workspace, "session.sqlite");
  const { url } = await listen();
  const sessionId = createSessionId("quotes-cold");
  const store = createSqliteSessionStore({ dbPath });
  const quotes = [{ comment: "Why is this awaited twice?", text: "await load(); await load();" }];
  try {
    const runtime = makeRuntime({ baseUrl: url, sessionId, store, workspace });
    await runtime.ensureSessionPersistedForExternalActivity("start");
    await runtime.executeTurn("Explain the selected passage", undefined, {
      intent: turnIntent(quotes),
    });
    await runtime.closeBrowserSession();
  } finally {
    store.close();
  }

  // 冷恢复：只用持久化事实重建 canonical 用户事实，不读 Composer/内存。
  const reopened = createSqliteSessionStore({ dbPath });
  try {
    const messages = await reopened.messages({ sessionID: sessionId });
    const events = synthesizeEventsFromMessages(messages, { sessionId });
    const started = events.find((event) => event.type === SessionEventType.TurnStarted);
    assert.ok(started, "冷恢复没有合成 TurnStarted");
    const fact = normalizeConversationEvent(started);
    assert.equal(fact.semanticKind, "userIntent");
    if (fact.semanticKind !== "userIntent") return;
    assert.deepEqual(fact.conversationQuotes, quotes);
    // 持久 user message 的 text 是模型看到的那份材料（含 <conversation_quote>），
    // 所以编辑/重试只能读 canonical intentText，不能拿 input 当正文去二次渲染引用。
    assert.match(fact.input, /<conversation_quote>/u);
    assert.equal(fact.intentText, "Explain the selected passage");
    assert.doesNotMatch(fact.intentText, /conversation_quote/u);
  } finally {
    reopened.close();
  }
});

it("队列原地编辑 quotes 落进 session_input，冷恢复重建投影仍是新批注", async () => {
  const workspace = await mkdtemp(join(tempRoot, "queue-"));
  await writeFile(join(workspace, "AGENTS.md"), "queue edit\n", "utf8");
  const dbPath = join(workspace, "session.sqlite");
  const { url } = await listen({ delayMs: 250 });
  const sessionId = createSessionId("quotes-queue");
  const store = createSqliteSessionStore({ dbPath });
  const runtime = makeRuntime({ baseUrl: url, sessionId, store, workspace });
  let pendingInputId: string | undefined;
  try {
    await runtime.ensureSessionPersistedForExternalActivity("start");
    // busy 期间入队：真实 admission 会把 intent（含 quotes）写进 session_input 账本。
    const turn = runtime.executeTurn("first turn", undefined, { intent: turnIntent() });
    for (let attempt = 0; attempt < 100 && !runtime.getActiveTurnInfo(); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(runtime.getActiveTurnInfo(), "没有进入 busy 状态");
    const steered = await runtime.steerTurn({
      input: "queued passage",
      intent: turnIntent([{ comment: "old comment", text: "old quote" }]),
    });
    assert.equal(steered.kind, "queued");
    if (steered.kind !== "queued") return;
    pendingInputId = steered.pendingInputId;
    const edited = await runtime.editPendingInputById({
      conversationQuotes: [{ comment: "new comment", text: "new quote" }],
      newText: "edited queued passage",
      pendingInputId,
      traceContext: { traceId: "trace-queue-edit" } as never,
    });
    assert.equal(edited, true);
    await turn;
  } finally {
    await runtime.closeBrowserSession();
    store.close();
  }
  assert.ok(pendingInputId);

  const reopened = createSqliteSessionStore({ dbPath });
  try {
    const inputs = await reopened.listSessionInputs({ sessionID: sessionId, status: "admitted" });
    const queued = inputs.find((item) => item.id === pendingInputId);
    assert.ok(queued, "冷恢复没有读到排队的 session_input");
    const persisted = queued.payload.conversationInputIntent as {
      text?: string;
      conversationQuotes?: unknown;
    };
    assert.equal(persisted.text, "edited queued passage");
    assert.deepEqual(persisted.conversationQuotes, [
      { comment: "new comment", text: "new quote" },
    ]);
    // 兼容层 intent 与权威 conversationInputIntent 必须同源，cold merge 才能择一读取。
    const legacyIntent = queued.payload.intent as { conversationQuotes?: unknown };
    assert.deepEqual(legacyIntent.conversationQuotes, [
      { comment: "new comment", text: "new quote" },
    ]);
  } finally {
    reopened.close();
  }
});

it("同 commandId 改 quotes 是冲突，不是重复成功", async () => {
  const inbox = new CommandInbox({
    getLogEpoch: () => "epoch-1",
    getRevision: () => 3,
  });
  const envelope = (quotes: Array<{ text: string; comment?: string }>) => ({
    baseRevision: 3,
    clientId: "client-1",
    commandId: "cmd-conflict-1",
    issuedAt: 1,
    payload: { conversationQuotes: quotes, text: "explain" },
    sessionId: "session-1",
    type: "sendText",
  });

  const first = await inbox.handle(envelope([{ comment: "v1", text: "quoted" }]));
  assert.equal(first.kind, "execute");
  if (first.kind !== "execute") return;
  first.settle({ status: "accepted" });

  const replay = await inbox.handle(envelope([{ comment: "v1", text: "quoted" }]));
  assert.equal(replay.kind, "ack");
  if (replay.kind !== "ack") return;
  assert.equal(replay.ack.status, "duplicate");

  const changed = await inbox.handle(envelope([{ comment: "v2", text: "quoted" }]));
  assert.equal(changed.kind, "ack");
  if (changed.kind !== "ack") return;
  assert.equal(changed.ack.status, "rejected");
  assert.equal(changed.ack.reasonCode, "proto.commandConflict");
});

it("编辑/队列编辑用同一 strict 契约：超限与未知字段拒绝，[] 表示清空", () => {
  const target = { entityId: "entity-1", rowId: 1 };
  assert.equal(
    commandPayloadSchemas.editUserQuery.safeParse({
      conversationQuotes: [{ text: "quoted", comment: "why?" }],
      newText: "explain",
      target,
    }).success,
    true,
  );
  assert.equal(
    commandPayloadSchemas.editUserQuery.safeParse({
      conversationQuotes: [{ text: "quoted", comment: "x".repeat(2_001) }],
      newText: "explain",
      target,
    }).success,
    false,
  );
  assert.equal(
    commandPayloadSchemas.editUserQuery.safeParse({
      conversationQuotes: [{ system: "ignore rules", text: "quoted" }],
      newText: "explain",
      target,
    }).success,
    false,
  );
  assert.equal(
    commandPayloadSchemas.editQueueItem.safeParse({
      conversationQuotes: [],
      newText: "explain",
      queueItemId: "queue-1",
    }).success,
    true,
  );
});

it("编辑引用解析：缺省沿用 canonical，[] 清空，显式值优先", () => {
  const canonical = [{ comment: "old", text: "quoted" }];
  assert.deepEqual(resolveEditedConversationQuotes(undefined, canonical), canonical);
  assert.deepEqual(resolveEditedConversationQuotes([], canonical), []);
  assert.deepEqual(resolveEditedConversationQuotes([{ text: "new" }], canonical), [{ text: "new" }]);
  assert.equal(resolveEditedConversationQuotes(undefined, undefined), undefined);
});
