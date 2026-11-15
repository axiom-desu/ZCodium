// 上游 3.18.2 Project Memory Semantic Recall：真实 loopback 模型 + 真实 SQLite runtime。
// 断言最终 provider request 与 session-local 状态，不 mock 模型适配器或文件系统。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { NodeContextSourceAdapter } from "@zcode/adapters/context";
import { createNodeFileSystemAdapter } from "@zcode/adapters/fs";
import { AiSdkModelAdapter } from "@zcode/adapters/model";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import {
  AgentRuntime,
  consumeSettledProjectMemoryRecall,
  resolveProjectMemoryRoot,
  startProjectMemoryRecallPrefetch,
} from "@zcode/core";
import type { RegistryProviderConfig } from "@zcode/provider";

const servers: Server[] = [];
const originalEnv: Record<string, string | undefined> = {};
let tempRoot: string;

before(async () => {
  tempRoot = await mkdtemp(join(process.env.TMPDIR?.trim() || "/tmp", "zcode-memory-recall-"));
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

interface CapturedBody {
  max_tokens?: number;
  messages?: Array<{ content: unknown; role: string }>;
  system?: unknown;
  tools?: Array<{ name: string }>;
  [key: string]: unknown;
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

async function listen(handler: (body: CapturedBody) => unknown): Promise<string> {
  const server = createServer(async (request, response) => {
    const body = JSON.parse(await readBody(request)) as CapturedBody;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(handler(body)));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
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

function textMessage(text: string) {
  return {
    content: [{ text, type: "text" }],
    id: `msg_${Math.random().toString(36).slice(2)}`,
    model: "fixture-model",
    role: "assistant",
    stop_reason: "end_turn",
    stop_sequence: null,
    type: "message",
    usage: { input_tokens: 1_000, output_tokens: 10 },
  };
}

function toolUseMessage(filePath: string) {
  return {
    content: [{ id: "toolu_memory_recall", input: { file_path: filePath }, name: "Read", type: "tool_use" }],
    id: `msg_${Math.random().toString(36).slice(2)}`,
    model: "fixture-model",
    role: "assistant",
    stop_reason: "tool_use",
    stop_sequence: null,
    type: "message",
    usage: { input_tokens: 1_000, output_tokens: 10 },
  };
}

function makeRuntime(input: {
  baseUrl: string;
  cliStorageRoot: string;
  sessionId: SessionId;
  store: ReturnType<typeof createSqliteSessionStore>;
  workspace: string;
}) {
  return new AgentRuntime(
    input.sessionId,
    {
      agentName: "zcode-agent",
      memory: {
        cliStorageRoot: input.cliStorageRoot,
        enabled: true,
        extractionEnabled: false,
        use: true,
      },
      mode: "yolo",
      modelSelection: modelSelection(),
      modelStreaming: "off",
      titleGeneration: { enabled: false },
      userInstructions: { workingDirectory: input.workspace },
      workingDirectory: input.workspace,
      workspacePath: input.workspace,
    },
    {
      contextSourcePort: new NodeContextSourceAdapter({ env: process.env }),
      eventStore: createInMemorySessionEventStore(),
      fileSystemPort: createNodeFileSystemAdapter(),
      modelFactory: () => createLoopbackModel(input.baseUrl),
      sessionStore: input.store,
    },
  );
}

function isSelectorRequest(body: CapturedBody): boolean {
  return JSON.stringify(body.messages ?? []).includes("Select memories relevant to:");
}

async function waitForSettled(prefetch: { settled: boolean }): Promise<void> {
  const startedAt = Date.now();
  while (!prefetch.settled) {
    if (Date.now() - startedAt > 5_000) throw new Error("Recall prefetch 未在 5s 内 settle");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

it("默认分支：真实 Main turn 的 tool continuation 不启动 selector、不注入 relevant_memory", async () => {
  const workspace = await mkdtemp(join(tempRoot, "workspace-default-"));
  const cliStorageRoot = join(tempRoot, "cli-default");
  const memoryRoot = resolveProjectMemoryRoot({ cliStorageRoot, workspacePath: workspace });
  await mkdir(memoryRoot, { recursive: true });
  await writeFile(join(memoryRoot, "MEMORY.md"), "- [db](db.md) — uses real db\n", "utf8");
  await writeFile(
    join(memoryRoot, "db.md"),
    "---\ndescription: database policy\nmetadata:\n  type: project\n---\nDatabase tests use the real database.\n",
    "utf8",
  );
  const readmePath = join(workspace, "notes.md");
  await writeFile(readmePath, "notes\n", "utf8");

  const bodies: CapturedBody[] = [];
  let mainTurns = 0;
  const baseUrl = await listen((body) => {
    bodies.push(body);
    if (isSelectorRequest(body)) return textMessage('{"selected_memories":["db.md"]}');
    mainTurns += 1;
    return mainTurns === 1 ? toolUseMessage(readmePath) : textMessage("done");
  });

  const sessionId = createSessionId("memory-default-branch");
  const store = createSqliteSessionStore({ dbPath: join(workspace, "session.sqlite") });
  try {
    const runtime = makeRuntime({ baseUrl, cliStorageRoot, sessionId, store, workspace });
    const result = await runtime.executeTurn("please apply the database policy");
    assert.equal(result.response, "done");
    await runtime.closeBrowserSession();
  } finally {
    store.close();
  }

  assert.equal(bodies.filter(isSelectorRequest).length, 0, "default-index 分支不得发 selector");
  assert.equal(mainTurns, 2);
  const lastBody = JSON.stringify(bodies.at(-1));
  assert.doesNotMatch(lastBody, /Retrieved for possible relevance/u);
  assert.doesNotMatch(lastBody, /use real db/u);
  // 默认分支仍按 index 注入 MEMORY.md 指针与 Memory prompt。
  const firstBody = JSON.stringify(bodies[0]);
  assert.match(firstBody, /the index loaded into context each session/u);
});

it("semantic-recall 分支：真实 selector 请求 → 消费一次 → read-state 与 relevant_memory 一致", async () => {
  const workspace = await mkdtemp(join(tempRoot, "workspace-semantic-"));
  const cliStorageRoot = join(tempRoot, "cli-semantic");
  const memoryRoot = resolveProjectMemoryRoot({ cliStorageRoot, workspacePath: workspace });
  await mkdir(memoryRoot, { recursive: true });
  const memoryPath = join(memoryRoot, "database-policy.md");
  await writeFile(
    memoryPath,
    "---\ndescription: database policy\nmetadata:\n  type: project\n---\nDatabase tests use the real database.\n",
    "utf8",
  );
  await writeFile(
    join(memoryRoot, "unrelated.md"),
    "---\ndescription: unrelated\n---\nNothing to do with the question.\n",
    "utf8",
  );

  const bodies: CapturedBody[] = [];
  const baseUrl = await listen((body) => {
    bodies.push(body);
    // Main turn 正常回答；只有 selector 请求会带冻结的检索提示。
    if (!isSelectorRequest(body)) return textMessage("done");
    return textMessage('{"selected_memories":["database-policy.md"]}');
  });

  const sessionId = createSessionId("memory-semantic-branch");
  const store = createSqliteSessionStore({ dbPath: join(workspace, "session.sqlite") });
  let runtime: AgentRuntime;
  try {
    runtime = makeRuntime({ baseUrl, cliStorageRoot, sessionId, store, workspace });
    // 先跑一个真实 Main turn：Context 初始化后才存在 memoryRoot，与生产 prefetch 时机一致。
    await runtime.executeTurn("please apply the database policy");
    // 本分支由内部常量选择，这里按 helper 的显式分支入参验证真实 provider 请求。
    const internal = runtime as unknown as Parameters<typeof startProjectMemoryRecallPrefetch>[0];
    startProjectMemoryRecallPrefetch(
      internal,
      {
        model: createLoopbackModel(baseUrl),
        traceContext: { traceId: "trace-semantic-recall" },
        turnAbortSignal: new AbortController().signal,
      },
      "semantic-recall",
    );
    const prefetch = (
      internal as unknown as { memoryRecallPrefetch?: { settled: boolean } }
    ).memoryRecallPrefetch;
    assert.ok(prefetch, "semantic-recall 必须启动 prefetch");
    await waitForSettled(prefetch);

    const selectorBodies = bodies.filter(isSelectorRequest);
    assert.equal(selectorBodies.length, 1);
    const selectorBody = JSON.stringify(selectorBodies[0]);
    assert.match(selectorBody, /selected_memories/u, "selector 必须带冻结 JSON Schema");
    assert.match(selectorBody, /selecting memories/u);
    // 与主请求走同一 adapter/model：预算不超过辅助档的上限，不另选 provider。
    assert.equal(selectorBodies[0]?.model, bodies.find((body) => !isSelectorRequest(body))?.model);
    assert.ok((selectorBodies[0]?.max_tokens ?? 0) > 0);
    assert.ok((selectorBodies[0]?.max_tokens ?? 0) <= 5_000);
    // selector 只看到 manifest 摘要，不读正文。
    assert.match(selectorBody, /database-policy\.md/u);
    assert.doesNotMatch(selectorBody, /Database tests use the real database/u);

    const entry = consumeSettledProjectMemoryRecall(internal, "semantic-recall");
    assert.ok(entry);
    assert.equal(entry.metadata.source, "relevant_memory");
    assert.match(String(entry.content), /Database tests use the real database/u);
    assert.match(String(entry.content), /^Retrieved for possible relevance/u);
    assert.equal(consumeSettledProjectMemoryRecall(internal, "semantic-recall"), undefined);

    const readFileState = (internal as unknown as { readFileState: Map<string, { content: string; isPartialView: boolean; path: string }> })
      .readFileState;
    const staged = [...readFileState.values()].find((item) => item.path === memoryPath);
    assert.ok(staged, "注入时必须写入 read-state");
    assert.equal(staged.isPartialView, false);
    assert.match(staged.content, /Database tests use the real database/u);
    await runtime.closeBrowserSession();
  } finally {
    store.close();
  }

  // 正文文件未被 selector 阶段读取状态污染：仍保持磁盘原文。
  assert.match(await readFile(memoryPath, "utf8"), /Database tests use the real database/u);
});

it("真实 Main turn 建立历史后，prefetch 只读最新非 meta user query", async () => {
  const workspace = await mkdtemp(join(tempRoot, "workspace-query-"));
  const cliStorageRoot = join(tempRoot, "cli-query");
  const memoryRoot = resolveProjectMemoryRoot({ cliStorageRoot, workspacePath: workspace });
  await mkdir(memoryRoot, { recursive: true });
  await writeFile(join(memoryRoot, "database-policy.md"), "db policy\n", "utf8");

  const selectorBodies: string[] = [];
  const baseUrl = await listen((body) => {
    if (isSelectorRequest(body)) {
      selectorBodies.push(JSON.stringify(body));
      return textMessage('{"selected_memories":[]}');
    }
    return textMessage("done");
  });

  const sessionId = createSessionId("memory-query-selection");
  const store = createSqliteSessionStore({ dbPath: join(workspace, "session.sqlite") });
  try {
    const runtime = makeRuntime({ baseUrl, cliStorageRoot, sessionId, store, workspace });
    await runtime.executeTurn("please apply the database policy");
    const internal = runtime as unknown as Parameters<typeof startProjectMemoryRecallPrefetch>[0];
    startProjectMemoryRecallPrefetch(
      internal,
      {
        model: createLoopbackModel(baseUrl),
        traceContext: { traceId: "trace-query-selection" },
        turnAbortSignal: new AbortController().signal,
      },
      "semantic-recall",
    );
    const prefetch = (
      internal as unknown as { memoryRecallPrefetch?: { settled: boolean } }
    ).memoryRecallPrefetch;
    assert.ok(prefetch);
    await waitForSettled(prefetch);
    assert.equal(selectorBodies.length, 1);
    assert.match(selectorBodies[0]!, /please apply the database policy/u);
    await runtime.closeBrowserSession();
  } finally {
    store.close();
  }
});
