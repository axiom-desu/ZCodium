import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SqliteSessionStore } from "@zcode/adapters/storage";
import type { SessionStorePort } from "@zcode/contracts";
import type { CliScope, CliTrustedContext } from "@zcode/session-control/contracts";
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

/** 临时 HOME/XDG/data 下的真实本地 App：真实 sqlite store、真实权限服务，无网络与真实用户目录。 */
async function createLocalApp(
  directory: string,
  workspace: string,
  sessionStore?: SessionStorePort,
): Promise<ZCodeApp> {
  return createZCodeApp({
    env: testEnv(directory),
    ...(sessionStore ? { sessionStore } : {}),
    providerRegistry: createEmptyRegistry(),
    runtimeConfig: { workingDirectory: workspace },
    skipUserConfig: true,
  });
}

test("standalone CLI wiring registers the eight session tools on the real runtime", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-session-control-register-"));
  try {
    const workspace = join(directory, "workspace");
    const standalone = await createZCodeApp({
      env: testEnv(directory),
      providerRegistry: createEmptyRegistry(),
      runtimeConfig: { workingDirectory: workspace },
      skipUserConfig: true,
      standaloneSessionControl: true,
    });
    const names = new Set(standalone.runtime.registry.list());
    for (const name of [
      "ListSessions",
      "ReadSession",
      "CreateSession",
      "ForkSession",
      "SendToSession",
      "WaitSessions",
      "InterruptSession",
      "RenameSession",
    ])
      assert.ok(names.has(name), `standalone app must register ${name}`);
    assert.equal(standalone.runtime.registry.getMetadata("SendToSession")?.readOnly, false);
    assert.equal(standalone.runtime.registry.getMetadata("ListSessions")?.readOnly, true);
    await standalone.close?.();

    // 非独立入口（桌面/远程 Host 会话）没有第二个会话控制面。
    const desktopLike = await createLocalApp(directory, workspace);
    const desktopNames = new Set(desktopLike.runtime.registry.list());
    assert.ok(!desktopNames.has("ListSessions"));
    assert.ok(!desktopNames.has("CreateSession"));
    await desktopLike.close?.();
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("the manager drives real create/send/rename/interrupt through the local owner", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-session-control-live-"));
  const workspace = join(directory, "workspace");
  await mkdir(workspace, { recursive: true });
  const store = await SqliteSessionStore.openStartup(
    { dbPath: join(directory, "sessions.db") },
    {},
  );
  const roots: ZCodeApp[] = [];
  try {
    const caller = await createLocalApp(directory, workspace, store);
    roots.push(caller);
    const scope: CliScope = { kind: "cli", workspacePath: workspace };
    const runtime = createCliSessionControlRuntime({
      workspace: scope,
      sessionStore: store,
      createRootApp: async (request) => {
        const app = await createZCodeApp({
          env: testEnv(directory),
          sessionStore: store,
          providerRegistry: createEmptyRegistry(),
          runtimeConfig: {
            workingDirectory: request.cwd,
            taskType: request.resume ? "fork" : "interactive",
            mode: "build",
          },
          skipUserConfig: true,
          resume: request.resume,
          sessionId: request.sessionId,
        });
        roots.push(app);
        return app;
      },
    });
    runtime.attachRoot(caller, "new-independent-root");
    const binding = createCliSessionControlBinding(runtime.control, {
      sessionId: caller.sessionId,
      workspace: scope,
    });
    const ctx: CliTrustedContext = binding.context();
    // 真实持久化路径：先让调用者会话落库，才能被本机会话库读到。
    await caller.runtime.ensureSessionPersistedForExternalActivity("hello");

    const listed = await runtime.control.listSessions(ctx, {});
    assert.ok(
      listed.sessions.some((item) => item.session.sessionId === caller.sessionId),
      "the caller root is listed from the real session store",
    );

    const summary = await runtime.control.readSession(ctx, {
      sessionId: caller.sessionId,
      view: "summary",
    });
    assert.equal(summary.view, "summary");
    assert.ok(summary.view === "summary" && summary.summary.availableActions.includes("renameSession"));

    const renamed = await runtime.control.renameSession(ctx, {
      sessionId: caller.sessionId,
      title: "Renamed by session control",
      requestId: "req-rename-1",
    });
    assert.equal(renamed.status, "applied");
    const stored = await store.getSession(caller.sessionId);
    assert.equal(stored?.title, "Renamed by session control");
    assert.equal(stored?.titleSource, "custom");
    // 幂等回执：同一 requestId 重放不重复写，返回同一结果。
    const replayed = await runtime.control.renameSession(ctx, {
      sessionId: caller.sessionId,
      title: "Renamed by session control",
      requestId: "req-rename-1",
    });
    assert.deepEqual(replayed, renamed);
    await assert.rejects(
      runtime.control.renameSession(ctx, {
        sessionId: caller.sessionId,
        title: "different body",
        requestId: "req-rename-1",
      }),
      (error: { code?: string }) => error.code === "conflict",
    );

    const interrupted = await runtime.control.interruptSession(ctx, {
      sessionId: caller.sessionId,
      expectedExecutionId: "exec-absent",
      requestId: "req-interrupt-1",
    });
    assert.equal(interrupted.status, "rejected");
    assert.ok(interrupted.reason);

    // 真实创建：没有配置模型，因此首条输入的准入没有结论；创建事实与引用仍必须落库。
    const created = await runtime.control.createSession(ctx, {
      prompt: "first prompt",
      requestId: "req-create-1",
    });
    assert.equal(created.creation, "created", String(created.reason));
    assert.ok(created.session, "created session keeps a stable reference");
    // 没有配置模型：准入仍由真实 owner 完成（started_turn），随后 turn 以 TurnError 结束。
    assert.equal(created.firstInput, "accepted");
    const createdRow = await store.getSession(created.session!.sessionId);
    assert.ok(createdRow, "the created session is persisted by the real store");
    const replayedCreate = await runtime.control.createSession(ctx, {
      prompt: "first prompt",
      requestId: "req-create-1",
    });
    assert.deepEqual(replayedCreate, created);
    assert.equal(roots.length, 2, "a replayed requestId does not create a second root");

    // 在新子根上等待该 operation：没有模型，turn 以 TurnError 结束——必须读到真实终态，
    // 而不是把「流正常结束」当成未知或成功。
    const waited = await runtime.control.waitSessions(ctx, {
      operations: [
        {
          sessionId: created.session!.sessionId,
          commandId: created.operation?.commandId ?? "missing",
        },
      ],
      mode: "all",
      timeoutMs: 5_000,
    });
    assert.equal(waited.status, "completed", JSON.stringify(waited.operations));
    assert.equal(waited.operations[0]?.status, "failed");
    assert.notEqual(waited.operations[0]?.revision, 0);

    // 目标会话已在真实 runtime 里执行过；等待自己之外的目标不会触发 self_wait。
    await assert.rejects(
      runtime.control.waitSessions(ctx, {
        operations: [{ sessionId: caller.sessionId, commandId: "cmd-self" }],
        mode: "any",
        timeoutMs: 0,
      }),
      (error: { code?: string }) => error.code === "self_wait",
    );
  } finally {
    for (const app of roots.reverse()) await app.close?.();
    store.close();
    await rm(directory, { force: true, recursive: true });
  }
});
