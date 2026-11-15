// 上游 3.18.2 F1/F2/F3 的真实 runtime 守卫：指令文件区块与增量公告、total_tokens 预算、
// prompt 快照字节冻结。真实 loopback 模型 + 真实 SQLite session store（临时目录）+ 真实
// AgentRuntime，不 mock 请求体，也不读真实 HOME/XDG/配置。
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
  tempRoot = await mkdtemp(join(tmpdirRoot(), "zcode-context-sync-"));
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

function tmpdirRoot(): string {
  return process.env.TMPDIR?.trim() || "/tmp";
}

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

/** 每次模型请求都回固定的 context usage：input 50_000 + output 100 = 50_100。 */
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

async function listen(workspace: string): Promise<{ requests: Captured[]; url: string }> {
  const requests: Captured[] = [];
  const server = createServer(async (request: IncomingMessage, response: ServerResponseLike) => {
    const text = await readBody(request);
    const body = text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {};
    requests.push({ body });
    const isCompactRequest = JSON.stringify(body).includes(
      "create a detailed summary of the conversation",
    );
    const reply = isCompactRequest
      ? anthropicReply([{ text: "<summary>summary of the context sync chat</summary>", type: "text" }], "end_turn")
      : requests.length === 1
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

type ServerResponseLike = {
  end: (chunk: string) => void;
  writeHead: (status: number, headers: Record<string, string>) => void;
};

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
      workingDirectory: input.workspace,
      workspacePath: input.workspace,
      // 真实 Node context source：AGENTS.md 由端口读取，不在测试里手写镜像。
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

function bodyText(body: Record<string, unknown>): string {
  return JSON.stringify(body);
}

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

const PREAMBLE =
  "Codebase and user instructions are shown below. Be sure to adhere to these instructions.";

it("指令公告、total_tokens 预算与 prompt 快照在真实 runtime 里跨恢复/compaction 保持", async () => {
  const workspace = await mkdtemp(join(tempRoot, "workspace-"));
  await writeFile(join(workspace, "AGENTS.md"), "v1 instructions\n", "utf8");
  const dbPath = join(workspace, "session.sqlite");
  const { requests, url } = await listen(workspace);
  const sessionId = createSessionId("context-sync-e2e");
  let store = createSqliteSessionStore({ dbPath });
  let runtime = makeRuntime({ baseUrl: url, sessionId, store, workspace });
  try {
    await runtime.ensureSessionPersistedForExternalActivity("start");
    await runtime.executeTurn("First turn.");
    // 首轮两个请求：轮首（真实用户输入）与完整工具批次之后。
    assert.equal(requests.length, 2);

    // F1：首次公告是 preamble + 带类型的区块；workspace 指令按 project instructions 宣告。
    const first = bodyText(requests[0]!.body);
    assert.match(first, new RegExp(PREAMBLE.slice(0, 60)));
    assert.match(first, /Codebase and user instructions are shown below\./u);
    assert.match(
      first,
      new RegExp(`Contents of ${escapeRegExp(join(workspace, "AGENTS.md"))} \\(project instructions, checked into the codebase\\):`, "u"),
    );
    assert.match(first, /v1 instructions/u);

    // F2：system 末尾固定行 + 轮首提醒为满额。
    assert.match(first, /<total_tokens>15000000 tokens left<\/total_tokens>/u);
    assert.equal(
      countOccurrences(first, "<total_tokens>15000000 tokens left</total_tokens>"),
      2,
    );
    // 工具批次之后按最近一条 assistant usage（50_000 + 100）扣减，不重新起算。
    const secondRequest = bodyText(requests[1]!.body);
    assert.match(secondRequest, /<total_tokens>14949900 tokens left<\/total_tokens>/u);

    // F3：主会话前缀的 system 被记录成 session entry。
    const snapshotEntries = await store.sessionEntries({
      sessionID: sessionId,
      type: "runtime/prompt_snapshot",
    });
    assert.equal(snapshotEntries.length, 1);
    const snapshotData = snapshotEntries[0]!.data as { model?: { modelId?: string }; system?: unknown[] };
    assert.equal(snapshotData.model?.modelId, "fixture-model");
    assert.ok((snapshotData.system?.length ?? 0) > 0);
    // 快照记录的 system 字节就是首次请求发出的那段：固定预算行在其中。
    const recordedSystemText = JSON.stringify(snapshotData.system);
    assert.match(recordedSystemText, /<total_tokens>15000000 tokens left<\/total_tokens>/u);
    const firstSystem = requests[0]!.body.system;

    // 指令公告状态也落了 session entry。
    const announcementEntries = await store.sessionEntries({
      sessionID: sessionId,
      type: "runtime/instruction_announcement",
    });
    assert.equal(announcementEntries.length, 1);
    const announcement = announcementEntries[0]!.data as {
      content?: string;
      files?: Array<{ path: string; type: string; hash: string }>;
    };
    assert.match(announcement.content ?? "", /v1 instructions/u);
    assert.deepEqual(
      announcement.files?.map((file) => file.path),
      [join(workspace, "AGENTS.md")],
    );

    // F3 冷恢复：关库重开 + resume 后 system 字节不变，且不重复整份公告。
    await runtime.closeBrowserSession();
    store.close();
    store = createSqliteSessionStore({ dbPath });
    runtime = makeRuntime({ baseUrl: url, sessionId, store, workspace });
    await runtime.resumeFromStore();
    await runtime.executeTurn("Turn after resume.");
    assert.equal(requests.length, 3);
    const resumed = requests[2]!.body;
    // system 与恢复前的请求逐字节相同，而不是按当前代码重新渲染（F3 冷恢复）。
    assert.deepEqual(resumed.system, firstSystem);
    const resumedText = bodyText(resumed);
    // 不重复整份公告：AGENTS.md 只出现一次（前缀里的已公告正文），没有增量。
    assert.equal(
      countOccurrences(resumedText, `Contents of ${join(workspace, "AGENTS.md")}`),
      1,
    );
    assert.doesNotMatch(resumedText, /Instruction files were re-read/u);
    // 恢复后轮首重新起算：提醒回到满额（预算不持久化）。
    assert.match(resumedText, /<total_tokens>15000000 tokens left<\/total_tokens>/u);

    // F1 变更公告：会话中途改 AGENTS.md，compaction 重读后只追加增量、不重发整份，
    // 已公告的旧正文继续留在前缀里（冻结字节）。
    await writeFile(join(workspace, "AGENTS.md"), "v2 instructions\n", "utf8");
    await runtime.executeTurn("/compact");
    const afterCompact = requests.length;
    // F3 compaction：快照被清成 cleared 标记（不能由内存副本决定是否写库）。
    const clearedEntries = await store.sessionEntries({
      sessionID: sessionId,
      type: "runtime/prompt_snapshot",
    });
    assert.deepEqual(clearedEntries.at(-1)?.data, { cleared: true });

    await runtime.executeTurn("Turn after compaction.");
    assert.ok(requests.length > afterCompact);
    const postCompactText = bodyText(requests[afterCompact]!.body);
    assert.match(postCompactText, /Instruction files were re-read after the conversation was compacted/u);
    assert.match(postCompactText, /v2 instructions/u);
    assert.match(postCompactText, /v1 instructions/u);
    assert.equal(
      countOccurrences(postCompactText, `Contents of ${join(workspace, "AGENTS.md")}`),
      2,
    );
    // 增量已落 session entry：文件 hash 换成新内容，下次请求不再重复公告。
    const updatedAnnouncement = (
      await store.sessionEntries({
        sessionID: sessionId,
        type: "runtime/instruction_announcement",
      })
    ).at(-1)?.data as { files?: Array<{ path: string; hash: string }> };
    assert.equal(updatedAnnouncement.files?.length, 1);
    assert.notEqual(updatedAnnouncement.files?.[0]?.hash, announcement.files?.[0]?.hash ?? "");
    // compaction 之后重新记录 system 快照（否则旧 system 会被当成新快照记下来）。
    const reRecorded = await store.sessionEntries({
      sessionID: sessionId,
      type: "runtime/prompt_snapshot",
    });
    const reRecordedData = reRecorded.at(-1)?.data as { system?: unknown[] } | undefined;
    assert.ok((reRecordedData?.system?.length ?? 0) > 0);

    await runtime.executeTurn("Another turn after the delta.");
    const settledText = bodyText(requests[requests.length - 1]!.body);
    // 增量不会被重复追加。
    assert.equal(
      countOccurrences(settledText, "Instruction files were re-read"),
      1,
    );
  } finally {
    await runtime.closeBrowserSession();
    store.close();
  }
});

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
