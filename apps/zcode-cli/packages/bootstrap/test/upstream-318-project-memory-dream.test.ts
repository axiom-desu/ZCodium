// 上游 3.18.2 Dream consolidation handler：真实 loopback 模型 + 真实 SQLite/文件系统。
// Dream 不是产品自动功能；这里直接 await handler，验证 gate、lock、受限执行与 memory_update。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat as statPath, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, it } from "node:test";

import {
  createInMemorySessionEventStore,
  createSessionId,
  type CreateSessionInput,
  type ModelSelection,
  type SessionId,
} from "@zcode/contracts";
import { NodeContextSourceAdapter } from "@zcode/adapters/context";
import { createNodeFileSystemAdapter } from "@zcode/adapters/fs";
import { AiSdkModelAdapter } from "@zcode/adapters/model";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import {
  AgentRuntime,
  consumePendingProjectMemoryUpdate,
  resolveProjectMemoryRoot,
  runProjectMemoryDream,
} from "@zcode/core";
import type { RegistryProviderConfig } from "@zcode/provider";

const servers: Server[] = [];
const originalEnv: Record<string, string | undefined> = {};
let tempRoot: string;

before(async () => {
  tempRoot = await mkdtemp(join(process.env.TMPDIR?.trim() || "/tmp", "zcode-memory-dream-"));
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

async function listen(handler: (body: Record<string, unknown>) => unknown): Promise<string> {
  const server = createServer(async (request, response) => {
    const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
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

function writeToolMessage(filePath: string, content: string) {
  return {
    content: [
      {
        id: "toolu_dream_write",
        input: { content, file_path: filePath },
        name: "Write",
        type: "tool_use",
      },
    ],
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
  modelIoDir: string;
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
      modelIoDir: input.modelIoDir,
      sessionStore: input.store,
    },
  );
}

async function seedSessions(input: {
  count: number;
  directory: string;
  store: ReturnType<typeof createSqliteSessionStore>;
}): Promise<SessionId[]> {
  const ids: SessionId[] = [];
  for (let index = 0; index < input.count; index += 1) {
    const id = createSessionId(`dream-transcript-${index}`);
    await input.store.createSession({
      directory: input.directory,
      id,
      path: input.directory,
      projectID: "proj" as CreateSessionInput["projectID"],
      slug: id,
      taskType: "interactive",
      title: id,
      version: "test",
    });
    ids.push(id);
  }
  return ids;
}

async function seedTranscripts(modelIoDir: string, sessionIds: readonly SessionId[]) {
  await mkdir(modelIoDir, { recursive: true });
  for (const sessionId of sessionIds) {
    await writeFile(join(modelIoDir, `model-io-${sessionId}.jsonl`), "{}\n", "utf8");
  }
}

it("可 await 的 Dream handler：gate 通过后受限执行 Write、保留 lock 并产生一次性 memory_update", async () => {
  const workspace = await mkdtemp(join(tempRoot, "workspace-dream-"));
  const cliStorageRoot = join(tempRoot, "cli-dream");
  const modelIoDir = join(cliStorageRoot, "rollout");
  const memoryRoot = resolveProjectMemoryRoot({ cliStorageRoot, workspacePath: workspace });
  await mkdir(memoryRoot, { recursive: true });
  await writeFile(join(memoryRoot, "MEMORY.md"), "- index\n", "utf8");
  const consolidatedPath = join(memoryRoot, "database-policy.md");

  const requests: string[] = [];
  let dreamTurns = 0;
  const baseUrl = await listen((body) => {
    requests.push(JSON.stringify(body));
    dreamTurns += 1;
    if (dreamTurns === 1) {
      return writeToolMessage(consolidatedPath, "Database tests use the real database.\n");
    }
    return textMessage("Consolidated one memory.");
  });

  const sessionId = createSessionId("dream-current");
  const store = createSqliteSessionStore({ dbPath: join(workspace, "session.sqlite") });
  try {
    const transcripts = await seedSessions({ count: 5, directory: workspace, store });
    await seedTranscripts(modelIoDir, transcripts);
    const runtime = makeRuntime({
      baseUrl,
      cliStorageRoot,
      modelIoDir,
      sessionId,
      store,
      workspace,
    });
    const internal = runtime as unknown as Parameters<typeof runProjectMemoryDream>[0];

    await runProjectMemoryDream(internal, { traceContext: { traceId: "trace-dream" } });

    assert.equal(dreamTurns, 2, "Dream 必须真实走通受限执行的第二次模型请求");
    assert.match(requests[0]!, /# Dream: Memory Consolidation/u);
    assert.match(requests[0]!, /Sessions since last consolidation \(5\)/u);
    // 第 5 个 session 之外的当前会话不进 prompt。
    assert.doesNotMatch(requests[0]!, /dream-current/u);
    assert.match(await readFile(consolidatedPath, "utf8"), /Database tests use the real database/u);

    const update = consumePendingProjectMemoryUpdate(internal);
    assert.ok(update, "Dream 文件触达必须产生 memory_update");
    assert.equal(update.metadata.source, "memory_update");
    assert.match(String(update.content), /consolidated 1 memory file/u);
    assert.match(String(update.content), /database-policy\.md/u);
    assert.equal(consumePendingProjectMemoryUpdate(internal), undefined, "memory_update 只消费一次");

    // 成功保留新 lock：12 小时内的下一次 handler 被 24h gate 直接挡掉，不再发模型请求。
    const lockMtime = (await statPath(join(memoryRoot, ".consolidate-lock"))).mtimeMs;
    await runProjectMemoryDream(internal, { traceContext: { traceId: "trace-dream-again" } });
    assert.equal(dreamTurns, 2, "24h gate 生效，不得再次发起模型请求");
    assert.equal(
      Math.round((await statPath(join(memoryRoot, ".consolidate-lock"))).mtimeMs),
      Math.round(lockMtime),
    );
    await runtime.closeBrowserSession();
  } finally {
    store.close();
  }
});

it("成功 Main turn 不自动触发 Dream（无 idle/定时/命令入口）", async () => {
  const workspace = await mkdtemp(join(tempRoot, "workspace-dream-auto-"));
  const cliStorageRoot = join(tempRoot, "cli-dream-auto");
  const modelIoDir = join(cliStorageRoot, "rollout");
  const memoryRoot = resolveProjectMemoryRoot({ cliStorageRoot, workspacePath: workspace });
  await mkdir(memoryRoot, { recursive: true });

  const requests: string[] = [];
  const baseUrl = await listen((body) => {
    requests.push(JSON.stringify(body));
    return textMessage("done");
  });

  const sessionId = createSessionId("dream-auto-current");
  const store = createSqliteSessionStore({ dbPath: join(workspace, "session.sqlite") });
  try {
    const transcripts = await seedSessions({ count: 5, directory: workspace, store });
    await seedTranscripts(modelIoDir, transcripts);
    const runtime = makeRuntime({
      baseUrl,
      cliStorageRoot,
      modelIoDir,
      sessionId,
      store,
      workspace,
    });
    await runtime.executeTurn("please apply the database policy");
    // 没有任何 Dream 请求：成功 turn 只调度 Extraction，而本测试已关闭 extractionEnabled。
    assert.equal(requests.length, 1);
    assert.doesNotMatch(requests[0]!, /# Dream: Memory Consolidation/u);
    assert.equal(
      await statPath(join(memoryRoot, ".consolidate-lock")).then(
        () => "lock-created",
        () => "no-lock",
      ),
      "no-lock",
    );
    await runtime.closeBrowserSession();
  } finally {
    store.close();
  }
});

it("transcript 数不足 5 个时 handler 不发起模型请求，也不产生 memory_update", async () => {
  const workspace = await mkdtemp(join(tempRoot, "workspace-dream-short-"));
  const cliStorageRoot = join(tempRoot, "cli-dream-short");
  const modelIoDir = join(cliStorageRoot, "rollout");
  const memoryRoot = resolveProjectMemoryRoot({ cliStorageRoot, workspacePath: workspace });
  await mkdir(memoryRoot, { recursive: true });

  let dreamTurns = 0;
  const baseUrl = await listen(() => {
    dreamTurns += 1;
    return textMessage("should not run");
  });

  const sessionId = createSessionId("dream-short-current");
  const store = createSqliteSessionStore({ dbPath: join(workspace, "session.sqlite") });
  try {
    const transcripts = await seedSessions({ count: 3, directory: workspace, store });
    await seedTranscripts(modelIoDir, transcripts);
    const runtime = makeRuntime({
      baseUrl,
      cliStorageRoot,
      modelIoDir,
      sessionId,
      store,
      workspace,
    });
    const internal = runtime as unknown as Parameters<typeof runProjectMemoryDream>[0];
    await runProjectMemoryDream(internal, { traceContext: { traceId: "trace-dream-short" } });
    assert.equal(dreamTurns, 0);
    assert.equal(consumePendingProjectMemoryUpdate(internal), undefined);
    await runtime.closeBrowserSession();
  } finally {
    store.close();
  }
});

it("remote workspace 与缺失 modelIoDir 时 handler 直接返回", async () => {
  const workspace = await mkdtemp(join(tempRoot, "workspace-dream-remote-"));
  const cliStorageRoot = join(tempRoot, "cli-dream-remote");
  const memoryRoot = resolveProjectMemoryRoot({ cliStorageRoot, workspacePath: workspace });
  await mkdir(memoryRoot, { recursive: true });

  let dreamTurns = 0;
  const baseUrl = await listen(() => {
    dreamTurns += 1;
    return textMessage("should not run");
  });

  const sessionId = createSessionId("dream-remote-current");
  const store = createSqliteSessionStore({ dbPath: join(workspace, "session.sqlite") });
  try {
    const transcripts = await seedSessions({ count: 5, directory: workspace, store });
    const runtime = new AgentRuntime(
      sessionId,
      {
        agentName: "zcode-agent",
        memory: {
          cliStorageRoot,
          enabled: true,
          extractionEnabled: false,
          use: true,
        },
        mode: "yolo",
        modelSelection: modelSelection(),
        modelStreaming: "off",
        titleGeneration: { enabled: false },
        userInstructions: { workingDirectory: workspace },
        workingDirectory: workspace,
        workspacePath: workspace,
      },
      {
        contextSourcePort: new NodeContextSourceAdapter({ env: process.env }),
        eventStore: createInMemorySessionEventStore(),
        fileSystemPort: createNodeFileSystemAdapter(),
        isRemoteWorkspace: () => true,
        modelFactory: () => createLoopbackModel(baseUrl),
        modelIoDir: join(cliStorageRoot, "rollout"),
        sessionStore: store,
      },
    );
    const internal = runtime as unknown as Parameters<typeof runProjectMemoryDream>[0];
    await seedTranscripts(join(cliStorageRoot, "rollout"), transcripts);
    await runProjectMemoryDream(internal, { traceContext: { traceId: "trace-dream-remote" } });
    assert.equal(dreamTurns, 0, "remote workspace 必须在读取 transcript 前返回");
    await runtime.closeBrowserSession();

    const localRuntime = makeRuntime({
      baseUrl,
      cliStorageRoot,
      // 缺失 modelIoDir 时不得 fallback 到固定目录或 SessionStore 时间。
      modelIoDir: "",
      sessionId,
      store,
      workspace,
    });
    const localInternal = localRuntime as unknown as Parameters<typeof runProjectMemoryDream>[0];
    (localInternal as unknown as { modelIoDir?: string }).modelIoDir = undefined;
    await runProjectMemoryDream(localInternal, { traceContext: { traceId: "trace-dream-no-transcripts" } });
    assert.equal(dreamTurns, 0, "没有 model-io 目录时 handler 直接返回");
    await localRuntime.closeBrowserSession();
  } finally {
    store.close();
  }
});
