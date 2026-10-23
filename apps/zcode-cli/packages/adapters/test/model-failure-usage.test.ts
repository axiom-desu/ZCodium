import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";

import {
  ModelErrorCode,
  type ModelNetworkStatusEvent,
  type ModelStatusSink,
} from "@zcode/contracts";
import type { RegistryProviderConfig } from "@zcode/provider";

import { AiSdkModelAdapterError } from "../src/model/errors.js";
import { AiSdkModelAdapter } from "../src/model/runner.js";

// 真实回环 HTTP：模型侧失败分类与失败 usage 必须看真实请求/响应，
// 而不是 mock runtime。每个用例只连 127.0.0.1 上的临时 server。

interface Captured {
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
  path: string;
}

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

async function listen(
  respond: (
    request: Captured,
    index: number,
  ) => { body: string; contentType?: string; status?: number },
): Promise<{ requests: Captured[]; url: string }> {
  const requests: Captured[] = [];
  const server = createServer(async (request: IncomingMessage, response) => {
    const text = await readBody(request);
    const captured: Captured = {
      body: text.length > 0 ? JSON.parse(text) : undefined,
      headers: request.headers,
      path: request.url ?? "",
    };
    requests.push(captured);
    const reply = respond(captured, requests.length - 1);
    response.writeHead(reply.status ?? 200, {
      "content-type": reply.contentType ?? "application/json",
    });
    response.end(reply.body);
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
  statusEvents?: ModelNetworkStatusEvent[];
}) {
  const statusSink: ModelStatusSink | undefined = input.statusEvents
    ? { publish: (event) => void input.statusEvents?.push(event) }
    : undefined;
  const adapter = new AiSdkModelAdapter({
    env: {},
    ...(statusSink ? { statusSink } : {}),
    retry: { maxRetries: 2 },
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

const MESSAGES = [{ role: "user" as const, content: "hi" }];

function anthropicJson(body: string, status = 200) {
  return { body, status };
}

function anthropicSse(events: unknown[]): string {
  return events
    .map(
      (event) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`,
    )
    .join("");
}

describe("model failure usage · 真实 HTTP 分类", () => {
  it("非流式空输出 + 上下文超窗 → 上下文错误，失败事件带一次 usage", async () => {
    const { requests, url } = await listen(() =>
      anthropicJson(
        JSON.stringify({
          content: [],
          id: "msg_1",
          model: "fixture-model",
          role: "assistant",
          stop_reason: "model_context_window_exceeded",
          stop_sequence: null,
          type: "message",
          usage: {
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            input_tokens: 120_000,
            output_tokens: 0,
          },
        }),
      ),
    );
    const statusEvents: ModelNetworkStatusEvent[] = [];
    const model = createModel({ apiType: "anthropic-messages", baseUrl: url, statusEvents });

    await assert.rejects(model.generateText({ messages: MESSAGES }), (error: unknown) => {
      assert.ok(error instanceof AiSdkModelAdapterError, `unexpected error ${String(error)}`);
      assert.equal(error.code, ModelErrorCode.ModelContextExceeded);
      // provider 真实报告的用量随失败保留，不补 0。
      assert.equal(error.usage?.inputTokens, 120_000);
      return true;
    });
    // 不是空响应重试：只有 1 次物理请求。
    assert.equal(requests.length, 1);
    const failed = statusEvents.filter((event) => event.type === "model_request_failed");
    assert.equal(failed.length, 1);
    assert.equal(failed[0]?.usage?.inputTokens, 120_000);
    assert.equal(failed[0]?.reason, "context_exceeded");
    assert.equal(failed[0]?.retryable, false);
    // 失败不发布成功完成事件。
    assert.equal(
      statusEvents.filter((event) => event.type === "model_request_completed").length,
      0,
    );
  });

  it("流式空输出 + 上下文超窗 → 失败终态一次，不 yield finish", async () => {
    const stream = anthropicSse([
      { message: { usage: { input_tokens: 90_000, output_tokens: 0 } }, type: "message_start" },
      {
        delta: { stop_reason: "model_context_window_exceeded" },
        type: "message_delta",
        usage: { output_tokens: 0 },
      },
      { type: "message_stop" },
    ]);
    const { requests, url } = await listen(() => ({
      body: stream,
      contentType: "text/event-stream",
    }));
    const statusEvents: ModelNetworkStatusEvent[] = [];
    const model = createModel({ apiType: "anthropic-messages", baseUrl: url, statusEvents });

    const events: string[] = [];
    await assert.rejects(async () => {
      for await (const event of model.streamText({ messages: MESSAGES })) events.push(event.type);
    }, AiSdkModelAdapterError);
    assert.equal(events.includes("finish"), false);
    assert.equal(requests.length, 1);
    const failed = statusEvents.filter((event) => event.type === "model_request_failed");
    assert.equal(failed.length, 1);
    assert.equal(failed[0]?.usage?.inputTokens, 90_000);
    assert.equal(failed[0]?.reason, "context_exceeded");
  });

  it("partial 输出 + 上下文超窗保留上游语义（不转成失败）", async () => {
    const stream = anthropicSse([
      { message: { usage: { input_tokens: 5, output_tokens: 0 } }, type: "message_start" },
      {
        content_block: { text: "", type: "text" },
        index: 0,
        type: "content_block_start",
      },
      {
        delta: { text: "partial", type: "text_delta" },
        index: 0,
        type: "content_block_delta",
      },
      { index: 0, type: "content_block_stop" },
      {
        delta: { stop_reason: "model_context_window_exceeded" },
        type: "message_delta",
        usage: { output_tokens: 3 },
      },
      { type: "message_stop" },
    ]);
    const { url } = await listen(() => ({ body: stream, contentType: "text/event-stream" }));
    const statusEvents: ModelNetworkStatusEvent[] = [];
    const model = createModel({ apiType: "anthropic-messages", baseUrl: url, statusEvents });

    const types: string[] = [];
    for await (const event of model.streamText({ messages: MESSAGES })) types.push(event.type);
    assert.ok(types.includes("text_delta"));
    assert.ok(types.includes("finish"));
    assert.equal(statusEvents.filter((event) => event.type === "model_request_failed").length, 0);
  });

  it("拒绝/内容过滤不会被当成空响应重试", async () => {
    const stream = anthropicSse([
      { message: { usage: { input_tokens: 11, output_tokens: 0 } }, type: "message_start" },
      {
        delta: { stop_reason: "refusal" },
        type: "message_delta",
        usage: { output_tokens: 0 },
      },
      { type: "message_stop" },
    ]);
    const { requests, url } = await listen(() => ({
      body: stream,
      contentType: "text/event-stream",
    }));
    const statusEvents: ModelNetworkStatusEvent[] = [];
    const model = createModel({ apiType: "anthropic-messages", baseUrl: url, statusEvents });

    const types: string[] = [];
    for await (const event of model.streamText({ messages: MESSAGES })) types.push(event.type);
    // 一次物理请求：refusal 不走空响应退避。
    assert.equal(requests.length, 1);
    const retries = statusEvents.filter((event) => event.type === "model_retry_scheduled");
    assert.equal(retries.length, 0);
  });
});
