// Provider 内置工具（GLM analyze_image / webReader）真实 Anthropic SSE 线协议回归。
// 不变式：服务端 server_tool_use / 裸 tool_result 经真实 AI SDK 流后变成原生
// mcp_tool_use / provider_tool_result；与结构块重复的 markdown 渲染不被重复展示；
// 会话能力标签只以调用上下文生成的 header 发送到配置的模型 endpoint。
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";

import type { ModelStreamEvent, ModelToolContract } from "@zcode/contracts";
import { runWithModelInvocationContext } from "@zcode/contracts";
import type { RegistryProviderConfig } from "@zcode/provider";

import { AiSdkModelAdapter } from "../src/model/runner.js";
import { withModelSessionFeaturesHeader } from "../src/model/model-request-headers.js";

const servers: Server[] = [];

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
});

interface Captured {
  body: Record<string, unknown>;
  headers: Record<string, string | string[] | undefined>;
}

async function listen(input: {
  contentType: string;
  body: string;
}): Promise<{ requests: Captured[]; url: string }> {
  const requests: Captured[] = [];
  const server = createServer(async (request: IncomingMessage, response) => {
    const text = await readBody(request);
    requests.push({
      body: text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {},
      headers: request.headers,
    });
    response.writeHead(200, { "content-type": input.contentType });
    response.end(input.body);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { requests, url: `http://127.0.0.1:${port}` };
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

function providerConfig(baseUrl: string): RegistryProviderConfig {
  return {
    access: { type: "api-key", apiKey: "test-key" },
    api: { type: "anthropic-messages", baseUrl },
  } as unknown as RegistryProviderConfig;
}

const MODEL_PROPERTIES = {
  requiresMfjsToolSchema: false,
  contextWindow: 200_000,
  inputFormat: {
    supportsText: true,
    supportsImage: false,
    supportsVideo: false,
    supportsAudio: false,
    supportsPdf: false,
  },
  outputFormat: { supportsText: true },
  supportsToolCall: true,
  supportsJsonSchemaOutput: true,
  supportsNativeWebSearch: false,
  supportsMidConversationSystem: true,
};

const OPTION_SPECS = {
  maxOutputTokens: { map: "{}", max: 32_000 },
  reasoningLevel: { map: "{}", values: ["none"] },
};

const residentTool: ModelToolContract = {
  description: "Read a file",
  inputSchema: { properties: { file_path: { type: "string" } }, type: "object" },
  name: "Read",
};

function createModel(input: { baseUrl: string; headers?: Record<string, string> }) {
  const adapter = new AiSdkModelAdapter({
    env: {},
    ...(input.headers ? { defaultHeaders: input.headers } : {}),
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
    providerConfig: providerConfig(input.baseUrl),
    providerId: "fixture-provider",
  });
}

function sse(frames: Array<Record<string, unknown>>): string {
  return frames
    .map((frame) => `event: ${String(frame.type)}\ndata: ${JSON.stringify(frame)}\n\n`)
    .join("");
}

const providerBuiltinStream = sse([
  {
    type: "message_start",
    message: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "fixture-model",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    },
  },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "**🌐 Analyzing image" },
  },
  { type: "content_block_stop", index: 0 },
  {
    type: "content_block_start",
    index: 1,
    content_block: { type: "server_tool_use", id: "srv_1", name: "analyze_image", input: {} },
  },
  {
    type: "content_block_delta",
    index: 1,
    delta: { type: "input_json_delta", partial_json: "{}" },
  },
  { type: "content_block_stop", index: 1 },
  { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } },
  {
    type: "content_block_delta",
    index: 2,
    delta: {
      type: "text_delta",
      text: "**Output:**\n**analyze_image_result_summary:**\nOrder Console",
    },
  },
  { type: "content_block_stop", index: 2 },
  {
    type: "content_block_start",
    index: 3,
    content_block: {
      type: "tool_result",
      tool_use_id: "srv_1",
      content: [{ type: "text", text: "Order Console" }],
    },
  },
  { type: "content_block_stop", index: 3 },
  { type: "content_block_start", index: 4, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 4, delta: { type: "text_delta", text: "Done." } },
  { type: "content_block_stop", index: 4 },
  {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 20 },
  },
  { type: "message_stop" },
]);

function streamRequest() {
  return {
    messages: [{ content: "analyze this screenshot", role: "user" as const }],
    tools: [residentTool],
  };
}

async function collectStream(model: ReturnType<typeof createModel>): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const event of model.streamText(streamRequest() as never)) {
    events.push(event);
  }
  return events;
}

describe("provider builtin tool wire compat", () => {
  it("真实 SSE：server_tool_use/tool_result 变原生块，重复 markdown 不进入正文", async () => {
    const { url } = await listen({ body: providerBuiltinStream, contentType: "text/event-stream" });
    const events = await collectStream(createModel({ baseUrl: url }));

    const toolCall = events.find(
      (event): event is Extract<ModelStreamEvent, { type: "tool_call" }> =>
        event.type === "tool_call",
    );
    assert.ok(toolCall, "AI SDK 应收到原生 mcp_tool_use 代码块");
    assert.equal(toolCall.toolCall.id, "srv_1");
    assert.equal(toolCall.toolCall.name, "analyze_image");
    assert.equal(toolCall.toolCall.providerExecuted, true);

    const providerResult = events.find(
      (event): event is Extract<ModelStreamEvent, { type: "provider_tool_result" }> =>
        event.type === "provider_tool_result",
    );
    assert.ok(providerResult, "配对的裸 tool_result 应变成 provider_tool_result");
    assert.equal(providerResult.toolCallId, "srv_1");
    assert.equal(providerResult.isError, false);
    assert.match(JSON.stringify(providerResult.output), /Order Console/);

    const text = events
      .filter(
        (event): event is Extract<ModelStreamEvent, { type: "text_delta" }> =>
          event.type === "text_delta",
      )
      .map((event) => event.text)
      .join("");
    assert.equal(text, "Done.");
    assert.doesNotMatch(text, /\*\*🌐|analyze_image_result_summary/);
  });

  it("未配对的裸 tool_result 整块丢弃，不让 SDK 整轮失败", async () => {
    const orphan = sse([
      {
        type: "message_start",
        message: {
          id: "msg_2",
          type: "message",
          role: "assistant",
          model: "fixture-model",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_result",
          tool_use_id: "missing",
          content: [{ type: "text", text: "orphan" }],
        },
      },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "ok" } },
      { type: "content_block_stop", index: 1 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 1 },
      },
      { type: "message_stop" },
    ]);
    const { url } = await listen({ body: orphan, contentType: "text/event-stream" });
    const events = await collectStream(createModel({ baseUrl: url }));
    assert.equal(events.some((event) => event.type === "provider_tool_result"), false);
    const text = events
      .filter(
        (event): event is Extract<ModelStreamEvent, { type: "text_delta" }> =>
          event.type === "text_delta",
      )
      .map((event) => event.text)
      .join("");
    assert.equal(text, "ok");
  });
});

describe("session features header", () => {
  const jsonBody = JSON.stringify({
    content: [{ text: "ok", type: "text" }],
    id: "msg_3",
    model: "fixture-model",
    role: "assistant",
    stop_reason: "end_turn",
    stop_sequence: null,
    type: "message",
    usage: { input_tokens: 1, output_tokens: 1 },
  });

  it("只把调用上下文标签发到配置的模型 endpoint", async () => {
    const { requests, url } = await listen({ body: jsonBody, contentType: "application/json" });
    const model = createModel({ baseUrl: url });
    await runWithModelInvocationContext(
      { modelRequestSessionFeatures: ["workflow_auto", "tool_search_called"] },
      () => model.generateText(streamRequest() as never),
    );
    assert.equal(
      requests[0]!.headers["x-zcode-session-features"],
      "tool_search_called,workflow_auto",
    );
  });

  it("无标签不发头；非法标签整头省略；静态 provider 头被调用上下文覆盖", () => {
    assert.deepEqual(withModelSessionFeaturesHeader({ a: "b" }, []), { a: "b" });
    assert.deepEqual(withModelSessionFeaturesHeader({ a: "b" }, undefined), { a: "b" });
    assert.deepEqual(withModelSessionFeaturesHeader({ a: "b" }, ["Bad Value"]), { a: "b" });
    assert.deepEqual(
      withModelSessionFeaturesHeader({ "x-zcode-session-features": "stale" }, ["browser_use"]),
      { "x-zcode-session-features": "browser_use" },
    );
  });
});
