// ============================================================
// S6 ToolSearch · 真实 Anthropic HTTP wire
// ============================================================
// 不变式：
//   1. 只把真实 tool_reference 编码进 tool_result，不能把 AI SDK providerOptions 当 wire；
//   2. defer_loading 只出现在 Native 开启且该工具已发现的 schema 上；
//   3. Anthropic beta 与已有 anthropic-beta 大小写无关合并去重，非 Anthropic 不带 beta。

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";

import type { ModelToolContract } from "@zcode/contracts";
import type { RegistryProviderConfig } from "@zcode/provider";

import { AiSdkModelAdapter } from "../src/model/runner.js";
import { toolSearchHeaders } from "../src/model/tool-search.js";
import { resolveToolSearchCapability } from "../src/model/tool-search.js";

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

async function listen(): Promise<{ requests: Captured[]; url: string }> {
  const requests: Captured[] = [];
  const server = createServer(async (request: IncomingMessage, response) => {
    const text = await readBody(request);
    requests.push({
      body: text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {},
      headers: request.headers,
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        content: [{ text: "ok", type: "text" }],
        id: "msg_1",
        model: "fixture-model",
        role: "assistant",
        stop_reason: "end_turn",
        stop_sequence: null,
        type: "message",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
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

function providerConfig(baseUrl: string, apiType: string): RegistryProviderConfig {
  return {
    access: { type: "api-key", apiKey: "test-key" },
    api: { type: apiType, baseUrl },
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

function createModel(input: {
  apiType: string;
  baseUrl: string;
  headers?: Record<string, string>;
}) {
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
    providerConfig: providerConfig(input.baseUrl, input.apiType),
    providerId: "fixture-provider",
  });
}

const discoveredTool: ModelToolContract = {
  description: "Manage the session task checklist",
  inputSchema: { properties: { todos: { type: "array" } }, type: "object" },
  name: "TodoWrite",
};

const residentTool: ModelToolContract = {
  description: "Read a file",
  inputSchema: { properties: { file_path: { type: "string" } }, type: "object" },
  name: "Read",
};

const toolSearchTool: ModelToolContract = {
  description: "Fetches full schema definitions for deferred tools so they can be called.",
  inputSchema: { properties: { query: { type: "string" } }, type: "object" },
  name: "ToolSearch",
};

function request(toolSearchEnabled?: boolean) {
  return {
    messages: [
      { content: "hi", role: "user" as const },
      {
        content: "",
        role: "assistant" as const,
        toolCalls: [{ id: "call-1", input: { query: "select:TodoWrite" }, name: "ToolSearch" }],
      },
      {
        content: [
          { text: "found", type: "text" as const },
          { toolName: "TodoWrite", type: "tool_reference" as const },
        ],
        role: "tool" as const,
        toolCallId: "call-1",
        toolName: "ToolSearch",
      },
    ],
    tools: [
      toolSearchTool,
      residentTool,
      { ...discoveredTool, deferLoading: true },
      { ...discoveredTool, name: "WebFetch" },
    ],
    ...(toolSearchEnabled === undefined ? {} : { toolSearchEnabled }),
  };
}

describe("ToolSearch capability", () => {
  it("只有 Anthropic Messages 支持协议；Coding Plan 凭据默认开启", () => {
    assert.deepEqual(resolveToolSearchCapability("anthropic-messages", { type: "api-key" }), {
      defaultEnabled: false,
      protocolSupported: true,
    });
    assert.deepEqual(
      resolveToolSearchCapability("anthropic-messages", { type: "zhipu-coding-plan-api-key" }),
      { defaultEnabled: true, protocolSupported: true },
    );
    assert.deepEqual(resolveToolSearchCapability("openai-responses", { type: "api-key" }), {
      defaultEnabled: false,
      protocolSupported: false,
    });
  });

  it("beta 与已有头大小写无关合并去重", () => {
    const headers = toolSearchHeaders(
      { "Anthropic-Beta": "fine-grained-tool-streaming-2025-05-14, advanced-tool-use-2025-11-20" },
      true,
    );
    assert.equal(
      headers?.["Anthropic-Beta"],
      "fine-grained-tool-streaming-2025-05-14,advanced-tool-use-2025-11-20",
    );
    assert.equal(toolSearchHeaders({ "anthropic-beta": "x" }, false)?.["anthropic-beta"], "x");
  });
});

describe("ToolSearch Anthropic wire", () => {
  it("开启时发送 tool_reference、defer_loading 与 beta 头", async () => {
    const { requests, url } = await listen();
    await createModel({ apiType: "anthropic-messages", baseUrl: url }).generateText(
      request(true) as never,
    );
    const captured = requests[0]!;
    const toolResult = (
      captured.body.messages as Array<{ content: Array<Record<string, unknown>>; role: string }>
    ).find(
      (message) => message.role === "user" && JSON.stringify(message).includes("tool_result"),
    )!;
    const resultBlock = toolResult.content.find((block) => block.type === "tool_result") as {
      content: Array<Record<string, unknown>>;
    };
    assert.deepEqual(resultBlock.content[1], {
      tool_name: "TodoWrite",
      type: "tool_reference",
    });
    const tools = captured.body.tools as Array<Record<string, unknown>>;
    // defer_loading 只出现在已发现的那一条 schema 上。
    assert.equal(tools.find((tool) => tool.name === "TodoWrite")?.defer_loading, true);
    assert.equal(tools.find((tool) => tool.name === "WebFetch")?.defer_loading, undefined);
    assert.equal(tools.find((tool) => tool.name === "Read")?.defer_loading, undefined);
    assert.match(String(captured.headers["anthropic-beta"]), /advanced-tool-use-2025-11-20/);
  });

  it("关闭时不发送 beta 与 defer_loading", async () => {
    const { requests, url } = await listen();
    await createModel({ apiType: "anthropic-messages", baseUrl: url }).generateText({
      ...request(false),
      messages: [{ content: "hi", role: "user" }],
      tools: [residentTool],
    } as never);
    const captured = requests[0]!;
    assert.equal(captured.headers["anthropic-beta"], undefined);
    const tools = captured.body.tools as Array<Record<string, unknown>>;
    assert.equal(
      tools.every((tool) => tool.defer_loading === undefined),
      true,
    );
  });

  it("引用出现在非 Anthropic 或未开启时被拒绝，不静默降级成文本", async () => {
    const { url } = await listen();
    await assert.rejects(async () =>
      createModel({ apiType: "openai-completions", baseUrl: `${url}/v1` }).generateText({
        ...request(false),
        messages: request(false).messages.slice(1),
      } as never),
    );
  });
});
