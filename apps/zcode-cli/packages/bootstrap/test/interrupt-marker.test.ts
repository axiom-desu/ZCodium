// 上游 3.18.2 中断标记：用户停止/外部故障后模型看到的标记、被取消工具的固定文字、冷恢复身份（C7 片）。
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
import {
  AgentRuntime,
  createExternalTurnFaultError,
  createMessageHistory,
  hydrateMessageHistoryFromSession,
} from "@zcode/core";
import type { RegistryProviderConfig } from "@zcode/provider";

const servers: Server[] = [];
const originalEnv: Record<string, string | undefined> = {};
let tempRoot: string;

before(async () => {
  tempRoot = await mkdtemp(join(tmpdirRoot(), "zcode-interrupt-marker-"));
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

/** 永不回包的 loopback：本轮只会因取消/外部故障结束。 */
async function listenHanging(): Promise<string> {
  const server = createServer((_request: IncomingMessage, _response) => {
    // 故意不结束响应，等 abort。
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
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
    streamIdleTimeoutMs: 30_000,
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
    },
    {
      contextSourcePort: new NodeContextSourceAdapter({ env: process.env }),
      eventStore: createInMemorySessionEventStore(),
      modelFactory: () => model,
      sessionStore: input.store,
    },
  );
}

it("外部故障中止本轮后：落一条普通 user 中断标记，冷恢复保持同一身份", async () => {
  const workspace = await mkdtemp(join(tempRoot, "workspace-"));
  const store = createSqliteSessionStore({ dbPath: join(workspace, "session.sqlite") });
  const sessionId = createSessionId("interrupt-marker-e2e");
  const runtime = makeRuntime({
    baseUrl: await listenHanging(),
    sessionId,
    store,
    workspace,
  });
  const controller = new AbortController();
  try {
    await runtime.ensureSessionPersistedForExternalActivity("start");
    const turn = runtime.executeTurn("Please do the thing.", undefined, {
      abortSignal: controller.signal,
    });
    // 让本轮真正进入模型请求，再以宿主外部故障中止。
    setTimeout(() => controller.abort(createExternalTurnFaultError("test_abort")), 100);
    await assert.rejects(turn);

    const messages = await store.messages({ sessionID: sessionId });
    const marker = messages.find(
      (message) => message.info.semantics?.source === "interrupt_marker",
    );
    assert.ok(marker, "expected a persisted interrupt marker message");
    assert.equal(marker.info.role, "user");
    assert.equal(marker.info.synthetic, true);
    assert.equal(marker.info.semantics?.origin, "agent_runtime");
    assert.equal(marker.info.semantics?.kind, "system_reminder");
    const text = marker.parts
      .filter((part) => part.type === "text")
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("");
    assert.equal(text, "[Request interrupted by user]");

    // 冷恢复：同一条 synthetic text part 必须还原成 interrupt_marker，而不是新的真实用户输入。
    const history = createMessageHistory();
    await hydrateMessageHistoryFromSession({ history, messages });
    const hydratedMarker = history
      .borrowReadOnlyRuntimeEntries()
      .find((entry) => entry.metadata?.source === "interrupt_marker");
    assert.ok(hydratedMarker, "expected cold hydration to restore the marker identity");
    assert.equal(hydratedMarker.kind ?? "message", "message");
    assert.equal(
      hydratedMarker.kind === "attachment"
        ? hydratedMarker.content
        : String(hydratedMarker.message.content),
      "[Request interrupted by user]",
    );
    // 标记作为普通 user 消息参与下一轮请求（不是历史前缀，也不是 reminder）。
    assert.ok(
      runtime.messageHistory
        .borrowReadOnlyRuntimeEntries()
        .some((entry) => entry.metadata?.source === "interrupt_marker"),
    );
  } finally {
    await runtime.closeBrowserSession();
    store.close();
  }
});
