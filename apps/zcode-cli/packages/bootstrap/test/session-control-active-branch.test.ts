import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SqliteSessionStore } from "@zcode/adapters/storage";
import {
  createSessionEvent,
  SessionEventType,
  type MessageId,
  type PartId,
  type SessionEventStorePort,
  type SessionId,
} from "@zcode/contracts";
import { RewindScope, RewindStrategy } from "@zcode/contracts/rewind";
import type { CliScope, CliTrustedContext } from "@zcode/session-control/contracts";
import { createInMemorySessionEventStore } from "@zcode/contracts";
import type { ProviderRegistryModelSource } from "../src/app/provider-registry-model-runtime.js";
import type { ZCodeApp } from "../src/app/types.js";
import { createZCodeApp } from "../src/app/create-app.js";
import {
  createCliSessionControlBinding,
  createCliSessionControlRuntime,
} from "../src/cli-session-control/index.js";

function createEmptyRegistry(): ProviderRegistryModelSource {
  const view = { providers: [], models: [] } as unknown as ReturnType<
    ProviderRegistryModelSource["getView"]
  >;
  return {
    getModel: () => undefined,
    getProvider: () => undefined,
    getView: () => view,
    onDidChange: () => () => undefined,
    validateSelection: (selection) => ({
      code: "model-not-found",
      modelId: selection.modelId,
      ok: false,
      providerId: selection.providerId,
    }),
  };
}

function testEnv(directory: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: join(directory, "home"),
    XDG_CONFIG_HOME: join(directory, "xdg-config"),
    XDG_DATA_HOME: join(directory, "xdg-data"),
    ZCODE_DATA_BASE_DIR: join(directory, "data"),
    ZCODE_MAILBOX_ROOT: join(directory, "mailbox"),
  };
}

/**
 * ReadSession 必须只投影当前活动分支。
 *
 * 这里用真实 sqlite store + 真实 App/runtime + 真实 rewind 事件：回滚掉的旧分支留在持久层，
 * 但会话控制工具读到的消息必须被裁剪——否则模型会「看见」用户已经撤销的对话，并基于它继续
 * 干活。没有 rewind 账本的历史会话保持不变（另一条断言）。
 */
test("ReadSession returns the active branch, not the rewound history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-session-control-branch-"));
  const workspace = join(directory, "workspace");
  await mkdir(workspace, { recursive: true });
  await mkdir(join(directory, "home"), { recursive: true });
  const store = await SqliteSessionStore.openStartup({ dbPath: join(directory, "s.db") }, {});
  const eventStore: SessionEventStorePort = createInMemorySessionEventStore();
  let app: ZCodeApp | undefined;
  try {
    app = await createZCodeApp({
      env: testEnv(directory),
      sessionStore: store,
      eventStore,
      providerRegistry: createEmptyRegistry(),
      runtimeConfig: { workingDirectory: workspace },
      skipUserConfig: true,
    });
    const sessionId = app.sessionId;
    // 先让会话行落库（真实 runtime 入口，标题事件 seq 1），再补消息：
    // user → assistant → user，最后一条将被回滚。
    await app.runtime.ensureSessionPersistedForExternalActivity("hello");
    const firstId = "msg_user_1" as MessageId;
    await store.saveMessage({
      id: firstId,
      sessionID: sessionId,
      role: "user",
      time: { created: Date.now() },
      agent: "main",
    } as never);
    await store.savePart({
      id: "part_user_1" as PartId,
      sessionID: sessionId,
      messageID: firstId,
      type: "text",
      text: "hello",
    });
    const persisted = await store.messages({ sessionID: sessionId });
    assert.equal(persisted.length, 1);
    const first = persisted[0]!;

    const assistantId = "msg_assistant_1" as MessageId;
    await store.saveMessage({
      id: assistantId,
      sessionID: sessionId,
      role: "assistant",
      time: { created: Date.now(), completed: Date.now() },
      parentID: first.info.id,
      mode: "build",
      agent: "main",
      path: { cwd: workspace, root: workspace },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    } as never);
    await store.savePart({
      id: "part_assistant_1" as PartId,
      sessionID: sessionId,
      messageID: assistantId,
      type: "text",
      text: "answer on the old branch",
    });
    const rewoundId = "msg_user_rewound" as MessageId;
    await store.saveMessage({
      id: rewoundId,
      sessionID: sessionId,
      role: "user",
      time: { created: Date.now() },
      agent: "main",
    } as never);
    await store.savePart({
      id: "part_user_rewound" as PartId,
      sessionID: sessionId,
      messageID: rewoundId,
      type: "text",
      text: "rewound user message",
    });

    const scope: CliScope = { kind: "cli", workspacePath: workspace };
    const runtime = createCliSessionControlRuntime({
      workspace: scope,
      sessionStore: store,
      eventStore,
      createRootApp: async () => {
        throw new Error("this test never creates a new root");
      },
    });
    runtime.attachRoot(app, "new-independent-root");
    const binding = createCliSessionControlBinding(runtime.control, { sessionId, workspace: scope });
    const ctx: CliTrustedContext = binding.context();

    // 没有 rewind 账本：持久层的全部消息原样返回（与引入前一致）。
    const before = await runtime.control.readSession(ctx, { sessionId, view: "messages" });
    assert.equal(before.view, "messages");
    assert.deepEqual(
      before.view === "messages" ? before.messages.map((message) => message.id) : [],
      [String(first.info.id), assistantId, rewoundId],
    );

    // 记录「在 rewoundId 之前发生过一次会话回滚」：这是 Host 已有的 rewind 账本事件。
    await eventStore.append(
      createSessionEvent(
        SessionEventType.RewindTriggered,
        sessionId as SessionId,
        {
          rewindId: "rewind-1",
          scope: RewindScope.Conversation,
          strategy: RewindStrategy.ActiveChain,
          targetMessageId: rewoundId,
          branchCutAfterMessageId: assistantId,
          createdMessageId: "msg_rewind_notice",
        },
      ),
    );

    const after = await runtime.control.readSession(ctx, { sessionId, view: "messages" });
    assert.equal(after.view, "messages");
    assert.deepEqual(
      after.view === "messages" ? after.messages.map((message) => message.id) : [],
      [String(first.info.id), assistantId],
      "被回滚的分支不能再出现在工具结果里",
    );
    // 持久层没有被改写：裁剪只发生在读取投影上。
    assert.equal((await store.messages({ sessionID: sessionId })).length, 3);
    await runtime.close();
  } finally {
    await app?.close?.();
    await rm(directory, { force: true, recursive: true });
  }
});
