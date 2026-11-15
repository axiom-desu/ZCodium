// 上游 3.18.2 F3 prompt 快照的 fork 专属回归：Q1 只接线了 legacy fork 复制与
// stable fork 原子 bundle，没有用真实 SQLite store 证明父子 system 字节一致。
//
// 这里补三类证据（同一份真实 SQLite + loopback 模型请求体）：
//   1. legacy fork（forkWorkspaceFromCheckpoint → forkConversationFromMessage）：child 快照 entry 与父相同，冷恢复后 system 逐字节一致；
//   2. stable fork（forkStableConversationAtMessage → commitForkBundle）：快照随 bundle 同事务落在 child，冷恢复后一致；
//   3. 换模型时不再套用旧快照（记录新快照），compaction 写 cleared 标记后重新记录；compaction 后立刻 fork 的 child 不带快照。
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, it } from "node:test";

import {
  SESSION_ENTRY_PROMPT_SNAPSHOT,
  createInMemorySessionEventStore,
  createSessionId,
  type MessageId,
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
  tempRoot = await mkdtemp(join(process.env.TMPDIR?.trim() || "/tmp", "zcode-fork-snapshot-"));
  // 临时 HOME/XDG：测试不读真实用户配置、缓存与历史。
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

/** 每轮：首请求发起一次 Read，之后文本结束；compact 请求返回 summary。 */
async function listen(workspace: string): Promise<{ requests: Captured[]; url: string }> {
  const requests: Captured[] = [];
  const server = createServer(async (request: IncomingMessage, response: ServerResponseLike) => {
    const text = await readBody(request);
    const body = text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {};
    requests.push({ body });
    const isCompactRequest = JSON.stringify(body).includes(
      "create a detailed summary of the conversation",
    );
    const isFirstTurnRequest = requests.length === 1;
    const reply = isCompactRequest
      ? anthropicReply(
          [{ text: "<summary>summary of the fork snapshot chat</summary>", type: "text" }],
          "end_turn",
        )
      : isFirstTurnRequest
        ? anthropicReply(
            [
              {
                id: "call_read_agents",
                input: { file_path: join(workspace, "AGENTS.md") },
                name: "Read",
                type: "tool_use",
              },
            ],
            "tool_use",
          )
        : anthropicReply([{ text: `done-${requests.length}`, type: "text" }], "end_turn");
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

function createLoopbackModel(baseUrl: string, modelId: string) {
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
    modelId,
    options: { maxOutputTokens: 1_000, reasoningLevel: "none" },
    providerConfig: {
      access: { apiKey: "test-key", type: "api-key" },
      api: { baseUrl, type: "anthropic-messages" },
    } as unknown as RegistryProviderConfig,
    providerId: "fixture-provider",
  });
}

function modelSelection(modelId = "fixture-model"): ModelSelection {
  return { modelId, providerId: "fixture-provider" } as unknown as ModelSelection;
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
      // 换模型场景：factory 按 session selection 造对应 modelId 的模型，等价真实 registry。
      modelFactory: ({ selection }) =>
        createLoopbackModel(input.baseUrl, selection.modelId ?? "fixture-model"),
      sessionStore: input.store,
    },
  );
}

async function promptSnapshotEntry(
  store: ReturnType<typeof createSqliteSessionStore>,
  sessionId: SessionId,
) {
  const entries = await store.sessionEntries({
    sessionID: sessionId,
    type: SESSION_ENTRY_PROMPT_SNAPSHOT,
  });
  return entries.at(-1)?.data as
    | { model?: { providerId: string; modelId: string }; system?: unknown[] }
    | { cleared: true }
    | undefined;
}

it("legacy 与 stable fork 的 prompt 快照在真实 SQLite store 里跨 resume 字节一致", async () => {
  const workspace = await mkdtemp(join(tempRoot, "workspace-"));
  await writeFile(join(workspace, "AGENTS.md"), "fork snapshot v1\n", "utf8");
  const dbPath = join(workspace, "session.sqlite");
  const { requests, url } = await listen(workspace);
  const parentId = createSessionId("fork-snapshot-parent");
  const store = createSqliteSessionStore({ dbPath });
  const parent = makeRuntime({ baseUrl: url, sessionId: parentId, store, workspace });
  const forkedIds: SessionId[] = [];
  try {
    await parent.ensureSessionPersistedForExternalActivity("start");
    await parent.executeTurn("First turn.");
    assert.equal(requests.length, 2);
    const parentSystem = requests[0]!.body.system;
    const parentSnapshot = await promptSnapshotEntry(store, parentId);
    assert.ok(parentSnapshot && "system" in parentSnapshot);
    // 快照 entry 存进程内形状（content/cacheControl），请求体是线格式；两者只按请求体对比。
    assert.ok((parentSnapshot.system?.length ?? 0) > 0);
    const messages = await store.messages({ sessionID: parentId });
    const lastAssistant = messages.filter((message) => message.info.role === "assistant").at(-1);
    assert.ok(lastAssistant, "parent must have a completed assistant message");

    // ── 1. legacy fork：child entry 与父相同 ──
    const legacyFork = await parent.forkWorkspaceFromCheckpoint({
      targetMessageId: lastAssistant.info.id as MessageId,
    });
    const legacyId = legacyFork.forkedSessionId;
    forkedIds.push(legacyId);
    assert.deepEqual(await promptSnapshotEntry(store, legacyId), parentSnapshot);

    // 冷恢复 child：关掉父 runtime 内存态的影响，重新建 runtime 从 store 恢复。
    const legacyChild = makeRuntime({ baseUrl: url, sessionId: legacyId, store, workspace });
    forkedIds.push(legacyId);
    await legacyChild.resumeFromStore();
    await legacyChild.executeTurn("Child turn after legacy fork.");
    assert.deepEqual(requests.at(-1)!.body.system, parentSystem);

    // ── 2. stable fork：快照随 atomic bundle 落库，冷恢复后一致 ──
    const stableTarget = {
      productTurnId: `product-${lastAssistant.info.id}`,
      transcriptTurnId: String(lastAssistant.info.anchor?.turnId ?? "turn-1"),
      orderedMessageIds: [String(lastAssistant.info.id)],
      boundaryMessageId: String(lastAssistant.info.id),
    };
    const stableFork = await parent.forkStableConversationAtMessage({
      goalBoundary: { kind: "none" },
      modelSelection: modelSelection(),
      sourceCommandId: "cmd-stable-fork-snapshot",
      target: stableTarget,
    });
    const stableId = stableFork.forkedSessionId;
    forkedIds.push(stableId);
    // bundle 提交后立即读：不依赖 fork 成功后的“补写”才出现快照。
    assert.deepEqual(await promptSnapshotEntry(store, stableId), parentSnapshot);
    const stableChild = makeRuntime({ baseUrl: url, sessionId: stableId, store, workspace });
    await stableChild.resumeFromStore();
    await stableChild.executeTurn("Child turn after stable fork.");
    assert.deepEqual(requests.at(-1)!.body.system, parentSystem);

    // ── 3. 换模型：旧快照不套用，按新模型重新记录 ──
    legacyChild.setSessionModelSelection(modelSelection("fixture-model-2"));
    await legacyChild.executeTurn("Turn after model change.");
    const afterModelChange = await promptSnapshotEntry(store, legacyId);
    assert.ok(afterModelChange && "system" in afterModelChange);
    assert.equal(afterModelChange.model?.modelId, "fixture-model-2");
    // 旧快照（fixture-model）不被套用：同一请求已按新模型重新记录一份 system。
    assert.ok((afterModelChange.system?.length ?? 0) > 0);
    // 父会话快照没有被改写。
    assert.equal(
      ((await promptSnapshotEntry(store, parentId)) as { model?: { modelId?: string } }).model
        ?.modelId,
      "fixture-model",
    );

    // ── 4. compaction：总是写 cleared 标记；之后请求重新记录 ──
    await legacyChild.executeTurn("/compact");
    assert.deepEqual(await promptSnapshotEntry(store, legacyId), { cleared: true });

    // compaction 后立刻 fork：内存快照为空 → child 不伪造快照行。
    const compactedMessages = await store.messages({ sessionID: legacyId });
    const compactedAssistant = compactedMessages
      .filter((message) => message.info.role === "assistant")
      .at(-1);
    assert.ok(compactedAssistant);
    const clearedFork = await legacyChild.forkWorkspaceFromCheckpoint({
      targetMessageId: compactedAssistant.info.id as MessageId,
    });
    forkedIds.push(clearedFork.forkedSessionId);
    assert.equal(await promptSnapshotEntry(store, clearedFork.forkedSessionId), undefined);

    await legacyChild.executeTurn("Turn after compaction.");
    const reRecorded = await promptSnapshotEntry(store, legacyId);
    assert.ok(reRecorded && "system" in reRecorded);
    assert.equal(reRecorded.model?.modelId, "fixture-model-2");
    assert.ok((reRecorded.system?.length ?? 0) > 0);
    await legacyChild.closeBrowserSession();
    await stableChild.closeBrowserSession();
  } finally {
    await parent.closeBrowserSession();
    store.close();
  }
});
