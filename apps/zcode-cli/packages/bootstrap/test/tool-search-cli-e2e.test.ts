// S6 真实 TS CLI 回环 E2E：ToolSearch -> DeferredToolCall -> 目标结果 -> 下一请求，
// 并覆盖 SQLite close/reopen、manual compact 与 rewind。模型走真实 Anthropic Messages
// loopback，不 mock 请求体；只使用临时工作区/数据库。
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, it } from "node:test";

import {
  createInMemorySessionEventStore,
  createSessionId,
  type MessageId,
  type ModelSelection,
  type SessionEvent,
  type SessionId,
  type TraceContext,
} from "@zcode/contracts";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import { AiSdkModelAdapter } from "@zcode/adapters/model";
import { AgentRuntime } from "@zcode/core";
import type { RegistryProviderConfig } from "@zcode/provider";

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

function anthropicText(text: string) {
  return {
    content: [{ text, type: "text" }],
    id: `msg_${Math.random().toString(36).slice(2)}`,
    model: "fixture-model",
    role: "assistant",
    stop_reason: "end_turn",
    stop_sequence: null,
    type: "message",
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

function anthropicToolUse(id: string, name: string, input: Record<string, unknown>) {
  return {
    content: [{ id, input, name, type: "tool_use" }],
    id: `msg_${id}`,
    model: "fixture-model",
    role: "assistant",
    stop_reason: "tool_use",
    stop_sequence: null,
    type: "message",
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

async function listen(): Promise<{ requests: Captured[]; url: string }> {
  const requests: Captured[] = [];
  const server = createServer(async (request: IncomingMessage, response) => {
    const text = await readBody(request);
    const body = text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {};
    requests.push({ body });
    const index = requests.length;
    const isCompactRequest = JSON.stringify(body).includes(
      "create a detailed summary of the conversation",
    );
    const reply = isCompactRequest
      ? anthropicText("<summary>summary of the tool search conversation</summary>")
      : index === 1
        ? anthropicToolUse("call_search", "ToolSearch", {
            max_results: 5,
            query: "select:TodoWrite",
          })
        : index === 2
          ? anthropicToolUse("call_target", "DeferredToolCall", {
              input: {
                todos: [{ content: "E2E deferred target", priority: "medium", status: "pending" }],
              },
              name: "TodoWrite",
            })
          : anthropicText(`done-${index}`);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(reply));
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
      toolSearch: { mode: "local" },
      workingDirectory: input.workspace,
      workspacePath: input.workspace,
    },
    {
      eventStore: createInMemorySessionEventStore(),
      modelFactory: () => model,
      sessionStore: input.store,
    },
  );
}

function toolNames(body: Record<string, unknown>): string[] {
  const tools = body.tools;
  if (!Array.isArray(tools)) return [];
  return tools.map((tool) => String((tool as { name?: unknown }).name ?? ""));
}

function bodyText(body: Record<string, unknown>): string {
  return JSON.stringify(body);
}

it("真实 loopback 驱动 ToolSearch、目标结果、冷恢复、compact 与 rewind", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "zcode-toolsearch-cli-"));
  const dbPath = join(workspace, "session.sqlite");
  const { requests, url } = await listen();
  const sessionId = createSessionId("toolsearch-cli-e2e");
  let store = createSqliteSessionStore({ dbPath });
  let runtime = makeRuntime({ baseUrl: url, sessionId, store, workspace });
  try {
    await runtime.ensureSessionPersistedForExternalActivity("start");
    await runtime.executeTurn("Use the deferred tool through ToolSearch.");
    assert.equal(requests.length, 3);
    // 首次请求：Local 只发常驻 + 控制入口，目标 schema 不进 tools。
    assert.equal(toolNames(requests[0]!.body).includes("TodoWrite"), false);
    assert.ok(toolNames(requests[0]!.body).includes("ToolSearch"));
    assert.ok(toolNames(requests[0]!.body).includes("DeferredToolCall"));
    // 搜索后：目标 schema 在真实结果位置展开，仍不进入 tools。
    assert.equal(toolNames(requests[1]!.body).includes("TodoWrite"), false);
    assert.match(bodyText(requests[1]!.body), /<functions>/u);
    assert.match(bodyText(requests[1]!.body), /TodoWrite/u);
    assert.match(bodyText(requests[1]!.body), /Loaded: TodoWrite/u);
    // 目标结果后的下一请求携带真实目标结果，包装名只出现在模型协议出口。
    assert.match(bodyText(requests[2]!.body), /E2E deferred target/u);
    assert.match(bodyText(requests[2]!.body), /DeferredToolCall/u);

    const firstTurnParts = (await store.messages({ sessionID: sessionId })).flatMap(
      (message) => message.parts,
    );
    const searchPart = firstTurnParts.find(
      (part) => part.type === "tool" && part.callID === "call_search",
    );
    assert.ok(searchPart);
    assert.deepEqual(searchPart.state.metadata?.modelContent, [
      { type: "tool_reference", toolName: "TodoWrite" },
    ]);
    const targetPart = firstTurnParts.find(
      (part) => part.type === "tool" && part.callID === "call_target",
    );
    assert.ok(targetPart);
    assert.equal(targetPart.tool, "TodoWrite");
    assert.deepEqual(targetPart.state.input, {
      todos: [{ content: "E2E deferred target", priority: "medium", status: "pending" }],
    });
    assert.equal(targetPart.metadata?.modelCallWrapper, "DeferredToolCall");
    assert.equal(targetPart.state.status, "completed");

    await runtime.executeTurn("Continue after the target result.");
    assert.equal(requests.length, 4);
    assert.match(bodyText(requests[3]!.body), /E2E deferred target/u);
    assert.match(bodyText(requests[3]!.body), /DeferredToolCall/u);

    await runtime.closeBrowserSession();
    store.close();
    store = createSqliteSessionStore({ dbPath });
    runtime = makeRuntime({ baseUrl: url, sessionId, store, workspace });
    await runtime.resumeFromStore();
    await runtime.executeTurn("/compact");
    // compact 先走 streaming；loopback 返回普通 JSON 时 runCompactSummaryModelRequest
    // 会按既有恢复路径做一次 HTTP fallback，因此这里允许一次额外请求。
    const compactRequestCount = requests.length;
    assert.ok(compactRequestCount >= 5);
    const messagesAfterCompact = await store.messages({ sessionID: sessionId });
    const boundary = messagesAfterCompact
      .flatMap((message) => message.parts)
      .find((part) => part.type === "compaction" && part.compactBoundary);
    assert.ok(boundary && boundary.type === "compaction");
    assert.deepEqual(boundary.compactBoundary?.preCompactDiscoveredTools, ["TodoWrite"]);

    await runtime.executeTurn("After compact, call the promoted tool directly.");
    const afterCompactRequest = requests[compactRequestCount];
    assert.ok(afterCompactRequest);
    assert.ok(toolNames(afterCompactRequest.body).includes("TodoWrite"));

    const afterCompactMessages = await store.messages({ sessionID: sessionId });
    const rewindTarget = afterCompactMessages.find(
      (message) =>
        message.info.role === "user" &&
        message.parts.some((part) => part.type === "text" && part.text.includes("After compact")),
    );
    assert.ok(rewindTarget);
    const events: SessionEvent[] = [];
    const traceContext = {
      spanId: "rewind",
      traceId: "rewind",
      turnId: "rewind",
    } as unknown as TraceContext;
    await runtime.rewindConversationToMessage({
      events,
      targetMessageId: rewindTarget.info.id as MessageId,
      traceContext,
    });
    await runtime.executeTurn("After rewind, keep the effective compact checkpoint.");
    const afterRewindRequest = requests[compactRequestCount + 1];
    assert.ok(afterRewindRequest);
    // 有效 compact 检查点跨 rewind 保留，Local 继续提升目标工具。
    assert.ok(toolNames(afterRewindRequest.body).includes("TodoWrite"));
    assert.match(bodyText(afterRewindRequest.body), /summary of the tool search conversation/u);
  } finally {
    await runtime.closeBrowserSession();
    store.close();
    await rm(workspace, { force: true, recursive: true });
  }
});
