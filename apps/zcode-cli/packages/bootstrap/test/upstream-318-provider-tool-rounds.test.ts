// 上游 3.18.2 F11 的真实 runtime 守卫：loopback Anthropic SSE（server_tool_use + 裸 tool_result）
// 经真实 adapter/runtime 切成多轮、落盘卡片与 tool part，冷恢复与 compact 分组不拆轮。
// 临时 HOME/XDG + 临时 SQLite，不读真实配置/历史，不连真实远端。
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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

const servers: Server[] = [];
const originalEnv: Record<string, string | undefined> = {};
let tempRoot: string;

before(async () => {
  tempRoot = await mkdtemp(join(process.env.TMPDIR?.trim() || "/tmp", "zcode-provider-rounds-"));
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

interface Captured {
  body: Record<string, unknown>;
}

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

function sse(frames: Array<Record<string, unknown>>): string {
  return frames
    .map((frame) => `event: ${String(frame.type)}\ndata: ${JSON.stringify(frame)}\n\n`)
    .join("");
}

const messageStart = {
  type: "message_start",
  message: {
    id: "msg_fixture",
    type: "message",
    role: "assistant",
    model: "fixture-model",
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 0 },
  },
};

function textFrame(index: number, text: string): Array<Record<string, unknown>> {
  return [
    { type: "content_block_start", index, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index },
  ];
}

function providerRoundReply(): string {
  return sse([
    messageStart,
    ...textFrame(0, "Let me look at this image."),
    ...textFrame(1, "**🌐 Analyzing image"),
    {
      type: "content_block_start",
      index: 2,
      content_block: { type: "server_tool_use", id: "srv_1", name: "analyze_image", input: {} },
    },
    {
      type: "content_block_delta",
      index: 2,
      delta: { type: "input_json_delta", partial_json: "{}" },
    },
    { type: "content_block_stop", index: 2 },
    ...textFrame(3, "**Output:**\n**analyze_image_result_summary:**\nOrder Console"),
    {
      type: "content_block_start",
      index: 4,
      content_block: {
        type: "tool_result",
        tool_use_id: "srv_1",
        content: [{ type: "text", text: "Order Console" }],
      },
    },
    { type: "content_block_stop", index: 4 },
    ...textFrame(5, "I found Order Console."),
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 20 },
    },
    { type: "message_stop" },
  ]);
}

function textReply(text: string): string {
  return sse([
    messageStart,
    ...textFrame(0, text),
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 5 },
    },
    { type: "message_stop" },
  ]);
}

async function listen(): Promise<{ requests: Captured[]; url: string }> {
  const requests: Captured[] = [];
  const server = createServer(async (request: IncomingMessage, response) => {
    const text = await readBody(request);
    const body = text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {};
    requests.push({ body });
    const isCompact = JSON.stringify(body).includes(
      "create a detailed summary of the conversation",
    );
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      isCompact
        ? textReply("<summary>summary of the provider round</summary>")
        : requests.length === 1
          ? providerRoundReply()
          : textReply(`done-${requests.length}`),
    );
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { requests, url: `http://127.0.0.1:${port}` };
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
  eventStore: ReturnType<typeof createInMemorySessionEventStore>;
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
      modelStreaming: "on",
      titleGeneration: { enabled: false },
      workingDirectory: input.workspace,
      workspacePath: input.workspace,
      userInstructions: { workingDirectory: input.workspace },
    },
    {
      contextSourcePort: new NodeContextSourceAdapter({ env: process.env }),
      eventStore: input.eventStore,
      modelFactory: () => model,
      sessionStore: input.store,
    },
  );
}

function bodyText(body: Record<string, unknown>): string {
  return JSON.stringify(body);
}

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

it("provider 内置工具在真实 runtime 中切轮、落盘、冷恢复与 compact 不拆轮", async () => {
  const workspace = await mkdtemp(join(tempRoot, "workspace-"));
  const dbPath = join(workspace, "session.sqlite");
  const { requests, url } = await listen();
  const sessionId = createSessionId("provider-rounds-e2e");
  const eventStore = createInMemorySessionEventStore();
  let store = createSqliteSessionStore({ dbPath });
  let runtime = makeRuntime({ baseUrl: url, eventStore, sessionId, store, workspace });
  try {
    await runtime.ensureSessionPersistedForExternalActivity("start");
    await runtime.executeTurn("Analyze this screenshot.");

    // 第一轮只有一次模型请求；服务端多轮合成在一个响应里。
    assert.equal(requests.length, 1);
    // 卡片按 Scheduled → Started → Result 落事件。
    const events = await eventStore.getEvents(sessionId);
    const cardEvents = events.filter(
      (event) =>
        event.type === "tool_call_scheduled" ||
        event.type === "tool_call_started" ||
        event.type === "tool_call_result",
    );
    assert.deepEqual(
      cardEvents.map((event) => event.type),
      ["tool_call_scheduled", "tool_call_started", "tool_call_result"],
    );

    // 落盘：本轮正文 + provider tool part（标记）+ 最后一轮正文；顺序与流一致。
    const messages = await store.messages({ sessionID: sessionId });
    const assistant = [...messages].reverse().find((message) => message.info.role === "assistant");
    assert.ok(assistant);
    const providerPart = assistant.parts.find(
      (part) => part.type === "tool" && part.tool === "analyze_image",
    );
    assert.ok(providerPart, "provider tool part 必须落盘供冷恢复切轮");
    assert.equal((providerPart.metadata as Record<string, unknown>)?.providerExecuted, true);
    const partTypes = assistant.parts
      .filter((part) => part.type !== "step-start" && part.type !== "step-finish")
      .map((part) => (part.type === "tool" ? `tool:${part.tool}` : part.type));
    assert.deepEqual(partTypes, ["text", "tool:analyze_image", "text"]);

    // 第二个普通轮次，制造 compact 所需的两个 assistant 组。
    await runtime.executeTurn("Second turn.");
    assert.equal(requests.length, 2);
    const secondText = bodyText(requests[1]!.body);
    // 服务端渲染副本不进入 provider-visible 历史；真实调用与结果各一份。
    assert.doesNotMatch(secondText, /\*\*🌐|analyze_image_result_summary/u);
    assert.equal(countOccurrences(secondText, "analyze_image"), 1);
    assert.equal(countOccurrences(secondText, "Order Console"), 2);

    // 冷恢复：关库重开 + resume 后 provider 轮次仍是一轮 assistant+tool。
    await runtime.closeBrowserSession();
    store.close();
    store = createSqliteSessionStore({ dbPath });
    runtime = makeRuntime({ baseUrl: url, eventStore, sessionId, store, workspace });
    await runtime.resumeFromStore();
    await runtime.executeTurn("Turn after resume.");
    assert.equal(requests.length, 3);
    const resumed = bodyText(requests[2]!.body);
    assert.equal(countOccurrences(resumed, "analyze_image"), 1);
    assert.equal(countOccurrences(resumed, "Order Console"), 2);
    assert.doesNotMatch(resumed, /\*\*🌐|analyze_image_result_summary/u);

    // compact：摘要请求里始终是完整一轮（tool_use + tool_result），不出现孤儿结果。
    await runtime.executeTurn("Third turn before compact.");
    const beforeCompact = requests.length;
    await runtime.executeTurn("/compact");
    assert.ok(requests.length > beforeCompact);
    const compactRequest = bodyText(requests[beforeCompact]!.body);
    assert.equal(countOccurrences(compactRequest, "analyze_image"), 1);
    assert.equal(countOccurrences(compactRequest, "Order Console"), 2);
    assert.doesNotMatch(compactRequest, /\*\*🌐|analyze_image_result_summary/u);

    // compact 之后被摘要的轮次不再回到 provider 历史；保留的最近组没有孤儿 tool result。
    await runtime.executeTurn("Turn after compact.");
    const afterCompact = bodyText(requests[requests.length - 1]!.body);
    assert.doesNotMatch(afterCompact, /\*\*🌐|analyze_image_result_summary/u);
    assert.equal(
      afterCompact.includes("analyze_image") && afterCompact.includes("Order Console"),
      false,
    );
  } finally {
    await runtime.closeBrowserSession();
    store.close();
  }
});
