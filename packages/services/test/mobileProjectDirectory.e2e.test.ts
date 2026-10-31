import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { expect, it, vi } from "vitest";
import { ChannelServer, Emitter, ProxyChannel, VSBuffer } from "@zcode/rpc";
import {
  buildServerRemoteWorkspaceIdentity,
  encodeWebRemoteControlRpcFrames,
  WebRemoteControlRpcAssembler,
  zcodeProtocolMethods,
  zcodeSessionStateSnapshotSchema,
  ZCODE_PROTOCOL_NAME,
  ZCODE_PROTOCOL_VERSION,
} from "@zcode/shared";
import { IMobileProjectDirectoryService } from "../src/mobile-project-directory/contract.js";
import { createMobileProjectDirectoryService } from "../src/mobile-project-directory/service.js";
import { createProjectService } from "../src/project/app/index.js";
import { createProjectSessionCreationPort } from "../src/project/app/sessionCreation.js";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";
import { setDataBaseDir } from "../src/paths.js";
import { LanRemoteControlEndpoint } from "../../desktop/src/main/webRemoteControl/lanEndpoint.js";
import { guardReplayableTaskCreation } from "../../desktop/src/host/mobileProjectDirectoryAttachment.js";

it("real mobile entry + LAN + HostRPC + ProjectService/temp SQLite creates once on an existing actor", async () => {
  const temp = await mkdtemp(join(tmpdir(), "s9-directory-e2e-"));
  const primary = join(temp, "repo");
  const extra = join(temp, "extra");
  const unbound = join(temp, "unbound");
  await Promise.all(
    [primary, extra, unbound, join(temp, "mobile")].map((p) => mkdir(p, { recursive: true })),
  );
  setDataBaseDir(temp);
  let alive = true;
  let starts = 0;
  let creates = 0;
  const deliveries: unknown[] = [];
  const actor = {
    get isDisposed() {
      return !alive;
    },
    onNotification: () => ({ dispose() {} }),
    onRequest: () => ({ dispose() {} }),
    onClose: () => ({ dispose() {} }),
    async request(method: string, params: Record<string, unknown>) {
      if (method !== zcodeProtocolMethods.sessionCreate) return params;
      creates++;
      deliveries.push(params);
      return zcodeSessionStateSnapshotSchema.parse({
        protocol: { name: ZCODE_PROTOCOL_NAME, version: ZCODE_PROTOCOL_VERSION },
        session: {
          sessionId: params.sessionId,
          workspace: { workspacePath: primary, workspaceKey: primary },
          sessionKind: "interactive",
          title: "Existing actor task",
          mode: "build",
          status: "idle",
          createdAt: 1,
          updatedAt: 2,
        },
        settings: {
          model: { available: [] },
          thoughtLevel: { enabled: false, available: [] },
          mode: { current: "build" },
        },
        projection: {
          sessionId: params.sessionId,
          status: "idle",
          mode: "build",
          turnCount: 0,
          totalTokenCount: 0,
          contextUsed: 0,
          contextWindow: 200000,
          pendingPermissions: [],
          activeToolCalls: [],
          backgroundJobs: [],
        },
        runtime: { eventSeq: 0, stateRevision: 0, pendingRequestIds: [] },
        messages: [],
      });
    },
  };
  vi.doMock("../src/zcode-agent/zcodeAgentProcessManager.js", () => ({
    ZCodeAgentProcessManager: class {
      onRuntimeLifecycle() {
        return { dispose() {} };
      }
      onRuntimeRestarted() {
        return { dispose() {} };
      }
      markReady() {}
      async getClient() {
        starts++;
        return actor;
      }
      getExistingClient(p: { workspacePath: string; workspaceIdentity?: string }) {
        return alive && starts && p.workspacePath === primary && !p.workspaceIdentity
          ? actor
          : undefined;
      }
      async getRuntimeIdentity(p: { workspacePath: string }) {
        if (!alive || !starts || p.workspacePath !== primary)
          throw new Error("runtime unavailable");
        return { identity: "existing-actor", generation: 1, workspaceKey: primary };
      }
      disposeAll() {}
    },
  }));
  const { createZCodeAgentService } = await import("../src/zcode-agent/zcodeAgentService.js");
  const { createZCodeTaskServiceAdapter } =
    await import("../src/zcode-agent/zcodeTaskServiceAdapter.js");
  const repo = new TaskIndexRepo(join(temp, "tasks.sqlite"), 5000, {
    settings: { lastWorkspaceSession: [], recentProjects: [] },
    hostId: "local",
  });
  await repo.ensureReady();
  const projects = createProjectService({
    repository: () => repo.getProjectRepository(),
    workspaceDirectory: temp,
    ownerHostId: "local",
  });
  const project = await projects.saveProject({
    name: "Fixture project",
    roots: [primary, extra],
    primaryRoot: primary,
  });
  await projects.saveProject({ name: "Unbound project", roots: [unbound], primaryRoot: unbound });
  const sourceRepo = new TaskIndexRepo(join(temp, "source.sqlite"), 5000, {
    settings: { lastWorkspaceSession: [], recentProjects: [] },
    hostId: "remote:server:b",
  });
  await sourceRepo.ensureReady();
  const sourceProjects = createProjectService({
    repository: () => sourceRepo.getProjectRepository(),
    workspaceDirectory: temp,
    ownerHostId: "remote:server:b",
  });
  await sourceProjects.saveProject({
    name: "Other Source same path",
    roots: [primary],
    primaryRoot: primary,
  });
  const reservation = createProjectSessionCreationPort({
    repository: () => repo.getProjectRepository(),
  });
  const agent = createZCodeAgentService({
    prepareSessionCreation: reservation.prepareSessionCreation,
    modelSelectionReadinessSource: {
      getView: async () =>
        ({ revision: 1, providers: [{ providerId: "p", models: [{ modelId: "m" }] }] }) as never,
    },
  });
  const emitter = new Emitter<unknown>();
  let blockMcp = false;
  let mcpEntered = false;
  let releaseMcp: (() => void) | undefined;
  const tasks = createZCodeTaskServiceAdapter({
    cuaProductMcpServerResolver: {
      resolveMcpServers: async (servers: unknown[]) => {
        mcpEntered = true;
        if (blockMcp)
          await new Promise<void>((done) => {
            releaseMcp = done;
          });
        return servers;
      },
    } as never,
    zcodeAgentService: agent,
    taskIndexRepo: repo,
    taskIndexSyncer: {
      onSessionTerminalEvent: () => ({ dispose() {} }),
      onSessionReadyEvent: () => ({ dispose() {} }),
      ensureSessionSubscription() {},
      getWorkspaceEmitter: () => emitter,
      emitWorkspaceTaskListChanged() {},
      disposeAll() {},
    } as never,
  });
  await agent.initialize({ workspacePath: primary });
  expect(starts).toBe(1);
  let online = true;
  const assertCurrent = () => {
    if (!online) throw new Error("project.stale-attachment");
  };
  const guarded = guardReplayableTaskCreation({
    tasks,
    agent,
    supported: true,
    localAdmission: true,
    assertTarget: assertCurrent,
  });
  const directory = createMobileProjectDirectoryService({
    assertCurrent,
    owners: () => [
      {
        hostId: "local",
        projects,
        agent,
        tasks: guarded,
        assertCurrent,
        target: (rootPath) => ({ workspacePath: rootPath, generation: 1 }),
      },
      {
        hostId: "remote:server:b",
        projects: sourceProjects,
        agent,
        tasks: guarded,
        assertCurrent,
        target: (rootPath) => ({
          workspacePath: rootPath,
          workspaceIdentity: buildServerRemoteWorkspaceIdentity({
            serverId: "b",
            workspacePath: rootPath,
          }),
          remoteSessionId: "source-b-session",
          generation: 2,
        }),
      },
    ],
  });
  let server: ChannelServer | undefined;
  let incoming: Emitter<VSBuffer> | undefined;
  let assembler: WebRemoteControlRpcAssembler | undefined;
  let streamId = "";
  let seq = 0;
  const previousMobile = process.env.ZCODE_WEB_REMOTE_MOBILE_DIR;
  process.env.ZCODE_WEB_REMOTE_MOBILE_DIR = join(temp, "mobile");
  const browserBundle = await build({
    entryPoints: [resolve("packages/web/src/mobile/main.tsx")],
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
    jsx: "automatic",
    loader: { ".css": "empty" },
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env": "{}" },
  });
  await writeFile(join(temp, "mobile/mobile.js"), browserBundle.outputFiles[0]!.contents);
  await writeFile(
    join(temp, "mobile/mobile.html"),
    (await readFile(resolve("packages/web/mobile.html"), "utf8")).replace(
      "/src/mobile/main.tsx",
      "/mobile.js",
    ),
  );
  const workspace = { workspaceKey: primary, workspacePath: primary, kind: "local" as const };
  const endpoint = new LanRemoteControlEndpoint({
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    deviceMid: "s9-fixture",
    deviceName: "fixture",
    appVersion: "test",
    handleMobilePayload(_sid, payload) {
      if (payload.zcode_type === "bootstrap-request")
        device.sendPayload({
          zcode_type: "bootstrap-response",
          requestId: payload.requestId,
          success: true,
          result: {
            windowControlSessionId: "fixture",
            desktopAppVersion: "test",
            workspaces: [workspace],
            tasks: [],
          },
        });
      if (payload.zcode_type === "workspace-bridge-open") {
        server?.dispose();
        incoming?.dispose();
        incoming = new Emitter<VSBuffer>();
        streamId = payload.bridgeSessionId;
        seq = 0;
        assembler = new WebRemoteControlRpcAssembler({ streamId });
        server = new ChannelServer(
          {
            onMessage: incoming.event,
            send: (buffer) => {
              const frames = encodeWebRemoteControlRpcFrames(
                { __zcodeBytes: Buffer.from(buffer.buffer).toString("base64") },
                { streamId, seq: ++seq },
              );
              for (const frame of frames) device.sendPayload({ zcode_type: "rpc-frame", frame });
            },
          },
          "host",
          1000,
          true,
          { mobileProjectDirectory: true },
        );
        server.registerChannel(
          IMobileProjectDirectoryService.channelName,
          ProxyChannel.fromService(directory),
        );
        device.sendPayload({
          zcode_type: "workspace-bridge-ready",
          requestId: payload.requestId,
          bridgeSessionId: streamId,
          bridgeGeneration: payload.bridgeGeneration,
          bridge: { ...workspace, bridgeSessionId: streamId, entryKind: "home" },
        });
        server.ready();
      }
      if (payload.zcode_type === "rpc-frame" && payload.frame.kind === "message") {
        for (const event of assembler?.push(payload.frame) ?? [])
          if (event.kind === "message") {
            incoming?.fire(
              VSBuffer.wrap(
                Buffer.from((event.message as { __zcodeBytes: string }).__zcodeBytes, "base64"),
              ),
            );
            device.sendPayload({
              zcode_type: "rpc-frame",
              frame: { streamId, seq: event.seq, kind: "ack", ackSeq: event.seq },
            });
          }
      }
    },
  });
  const passHash = createHash("sha256").update(randomBytes(32)).digest("base64");
  const device = endpoint.registerDevice(
    { mode: "register", passHash },
    {
      onStateChange() {},
      onPayload() {},
      onRegisteredAuth() {},
      onError() {},
      onInvalidPersistedAuth() {},
      onMobileDisconnected() {},
    },
  );
  let context;
  try {
    const info = await endpoint.start();
    context = await chromium.launchPersistentContext(join(temp, "profile"), {
      channel: "chromium",
      headless: true,
      executablePath: process.env.ZCODE_TEST_CHROMIUM_EXECUTABLE || undefined,
      viewport: { width: 390, height: 844 },
      args: ["--no-proxy-server"],
    });
    await context.route("**/*", (route) =>
      new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort(),
    );
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(
      `http://127.0.0.1:${info.port}/?sid=${encodeURIComponent(device.deviceSid)}&hash=${encodeURIComponent(passHash)}&mid=s9&name=fixture`,
    );
    const section = page.getByRole("region", { name: "项目目录 / Project directory" });
    await section.waitFor();
    const unboundRow = section.getByRole("listitem").filter({ hasText: "Unbound project" });
    expect(await unboundRow.getByRole("button").isDisabled()).toBe(true);
    expect(await unboundRow.textContent()).toContain("请在桌面端打开 / Open on desktop");
    await unboundRow.getByRole("button").evaluate((button: HTMLButtonElement) => button.click());
    expect(creates).toBe(0);
    expect(starts).toBe(1);
    const otherSource = section.getByRole("listitem").filter({ hasText: "Other Source same path" });
    expect(await otherSource.getByRole("button").isDisabled()).toBe(true);
    const row = section
      .getByRole("listitem")
      .filter({ hasText: primary })
      .filter({ hasText: "Fixture project" });
    await row.getByRole("button").click();
    await vi.waitFor(() => expect(creates).toBe(1));
    await vi.waitFor(async () =>
      expect((await repo.getProjectRepository()).readTree().tasks).toHaveLength(1),
    );
    expect(starts).toBe(1);
    expect(deliveries).toEqual([expect.objectContaining({ additionalDirectories: [extra] })]);
    const tree = (await repo.getProjectRepository()).readTree();
    expect(tree.tasks[0]).toMatchObject({ projectId: project.id, workspacePath: primary });
    const roots = await directory.readProjects();
    const enabled = roots.find((r) => r.enabled)!;
    await expect(guarded.createTask({ workspacePath: unbound })).rejects.toThrow();
    await expect(
      directory.createTask({
        ...enabled,
        runtimeIdentity: { ...enabled.runtimeIdentity!, generation: 99 },
      }),
    ).rejects.toThrow();
    await expect(
      directory.createTask({
        ...enabled,
        workspaceIdentity: buildServerRemoteWorkspaceIdentity({
          serverId: "b",
          workspacePath: primary,
        }),
      }),
    ).rejects.toThrow();
    blockMcp = true;
    const midAwait = guarded.createTask({
      workspacePath: primary,
      projectId: project.id,
      mcpServers: [{ name: "fixture" }] as never,
    });
    await vi.waitFor(() => expect(mcpEntered).toBe(true));
    alive = false;
    releaseMcp?.();
    await expect(midAwait).rejects.toThrow();
    await expect(directory.createTask(enabled)).rejects.toThrow();
    expect(starts).toBe(1);
    expect(creates).toBe(1);
    online = false;
    await expect(directory.readProjects()).rejects.toThrow();
    expect(errors).toEqual([]);
  } finally {
    await context?.close();
    await endpoint.stop();
    server?.dispose();
    incoming?.dispose();
    agent.disposeAll();
    repo.close();
    sourceRepo.close();
    emitter.dispose();
    if (previousMobile === undefined) delete process.env.ZCODE_WEB_REMOTE_MOBILE_DIR;
    else process.env.ZCODE_WEB_REMOTE_MOBILE_DIR = previousMobile;
    await rm(temp, { recursive: true, force: true });
  }
}, 60_000);
