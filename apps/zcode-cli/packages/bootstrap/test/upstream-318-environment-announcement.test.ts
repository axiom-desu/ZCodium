// 上游 3.18.2 环境公告：system 的 # Environment 被 prompt 快照冻结后，附加目录变化
// 只能靠请求前的增量公告传达。这里用真实 SQLite + 真实 resume 验证冷热等价。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, it } from "node:test";

import {
  SESSION_ENTRY_ENVIRONMENT_ANNOUNCEMENT,
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
  tempRoot = await mkdtemp(join(process.env.TMPDIR?.trim() || "/tmp", "zcode-env-announce-"));
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

type CapturedRequest = { body: { messages?: unknown; system?: unknown } };

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

async function listen(): Promise<{ requests: CapturedRequest[]; url: string }> {
  const requests: CapturedRequest[] = [];
  const server = createServer(async (request, response) => {
    requests.push({ body: JSON.parse(await readBody(request)) as CapturedRequest["body"] });
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
  additionalDirectories?: readonly string[];
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
      ...(input.additionalDirectories
        ? { additionalDirectories: input.additionalDirectories }
        : {}),
    },
    {
      contextSourcePort: new NodeContextSourceAdapter({ env: process.env }),
      eventStore: createInMemorySessionEventStore(),
      modelFactory: () => createLoopbackModel(input.baseUrl),
      sessionStore: input.store,
    },
  );
}

it("冷恢复换附加目录：只追加一条 difference 公告，system 字节不变且不重复", async () => {
  const workspace = await mkdtemp(join(tempRoot, "workspace-"));
  const firstDir = join(workspace, "shared-a");
  const addedDir = join(workspace, "shared-b");
  await mkdir(firstDir, { recursive: true });
  await mkdir(addedDir, { recursive: true });
  await writeFile(join(workspace, "AGENTS.md"), "env announcement\n", "utf8");
  const dbPath = join(workspace, "session.sqlite");
  const { requests, url } = await listen();
  const sessionId = createSessionId("env-announce");
  const addedLabel = "Additional working directories added";

  const store = createSqliteSessionStore({ dbPath });
  try {
    const runtime = makeRuntime({
      additionalDirectories: [firstDir],
      baseUrl: url,
      sessionId,
      store,
      workspace,
    });
    await runtime.ensureSessionPersistedForExternalActivity("start");
    await runtime.executeTurn("first turn");
    await runtime.closeBrowserSession();
  } finally {
    store.close();
  }
  const firstSystem = requests[0]?.body.system;
  assert.ok(firstSystem, "首个请求没有 system");
  // 首个请求的 system 里就有完整环境块（并带 untrusted downloads 说明）。
  assert.match(JSON.stringify(firstSystem), /untrusted data/u);
  assert.doesNotMatch(JSON.stringify(requests[0]?.body.messages ?? []), /# Environment update/u);

  const reopened = createSqliteSessionStore({ dbPath });
  try {
    const runtime = makeRuntime({
      additionalDirectories: [firstDir, addedDir],
      baseUrl: url,
      sessionId,
      store: reopened,
      workspace,
    });
    await runtime.resumeFromStore();
    const entry = (
      await reopened.sessionEntries({
        sessionID: sessionId,
        type: SESSION_ENTRY_ENVIRONMENT_ANNOUNCEMENT,
      })
    ).at(-1)?.data as { full?: boolean } | undefined;
    assert.equal(entry?.full, true, "冷恢复没有读到环境公告基线");

    await runtime.executeTurn("second turn");
    const second = requests.at(-1)!;
    // prompt 快照冻结 system：恢复后 system 与首轮逐字节相同。
    assert.deepEqual(second.body.system, firstSystem);
    const secondMessages = JSON.stringify(second.body.messages ?? []);
    assert.match(secondMessages, /# Environment update/u);
    assert.ok(secondMessages.includes(addedDir), "增量公告没有列出新增目录");
    assert.ok(secondMessages.includes(`${addedLabel}:`), "增量公告没有 added 标签");

    // 第三轮没有新变化：不再追加第二条公告（历史里那一条仍在）。
    await runtime.executeTurn("third turn");
    const thirdMessages = JSON.stringify(requests.at(-1)!.body.messages ?? []);
    assert.equal(thirdMessages.split("# Environment update").length - 1, 1);
    await runtime.closeBrowserSession();
  } finally {
    reopened.close();
  }
});
