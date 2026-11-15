import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAppControlService } from "#src/app-control/index.js";
import type { AppControlTaskRow } from "#src/app-control/index.js";
import { createExtensionsService, type ExtensionsService } from "./service.js";

/**
 * 真实 loopback + 真实 Host App 控制 facade 的扩展会话能力回归。
 *
 * 覆盖：授权请求不能超出声明、读会话、受控改名（mutation）、撤销中止在途 wait、
 * 撤销后 token 失效、未装配 App 控制的 Host 明确 host-unavailable。只用临时目录与回环地址。
 */
const WORKSPACE = "/tmp/zcode-ext-sessions-ws";
const NOW = 1_700_000_000_000;

interface Harness {
  service: ExtensionsService;
  starts: Array<{ endpoint: string; token: string; generation: number }>;
  renames: string[];
  setRunning(running: boolean): void;
  activate(grants?: string[]): Promise<void>;
  /** 让下一次 readSessionMessages 挂起，返回已开始会话与放行函数。 */
  blockNextRead(): { started: Promise<void>; release(): void };
  /** 让下一次 renameTask 先写入再挂起，返回已开始会话与放行函数。 */
  blockNextRename(): { started: Promise<void>; release(): void };
}

async function createHarness(options?: { withAppControl?: boolean }): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "zcode-ext-sessions-"));
  const pluginDir = join(root, "extensions");
  await mkdir(join(pluginDir, "sessions"), { recursive: true });
  await writeFile(
    join(pluginDir, "sessions", "extension.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "sessions",
      name: "Sessions Extension",
      version: "1.0.0",
      main: "extension.mjs",
      capabilities: [
        "sessions.listProjects",
        "sessions.listSessions",
        "sessions.readSession",
        "sessions.waitSessions",
        "sessions.renameSession",
      ],
      grants: ["sessions.write"],
      protocols: { sessions: 1 },
      slots: [],
    }),
  );
  await writeFile(join(pluginDir, "sessions", "extension.mjs"), "export function activate() {}\n");

  let running = false;
  let readBarrier: Promise<void> | null = null;
  let readStarted: (() => void) | null = null;
  let renameBarrier: Promise<void> | null = null;
  let renameStarted: (() => void) | null = null;
  const renames: string[] = [];
  const tasks: AppControlTaskRow[] = [
    {
      taskId: "sess_a",
      hostId: "local",
      workspacePath: WORKSPACE,
      projectId: "p1",
      title: "Session A",
      status: "completed",
      updatedAt: NOW,
    },
  ];
  const appControl = createAppControlService({
    sourceServerId: "local",
    projects: {
      async readTree() {
        return {
          projects: [{ id: "p1", hostId: "local", name: "Project One", deleted: false }],
          tasks,
        } as never;
      },
      async readProjects() {
        return [{ id: "p1", hostId: "local", name: "Project One", deleted: false }] as never;
      },
      async prepareSession() {
        return { workspacePath: WORKSPACE, additionalDirectories: [], projectId: "p1" } as never;
      },
    },
    tasks: {
      async getTaskMeta(params) {
        const task = tasks.find((item) => item.taskId === params.taskId);
        if (!task) return null;
        return {
          taskId: task.taskId,
          title: task.title,
          status: running ? "running" : (task.status ?? "completed"),
          updatedAt: task.updatedAt ?? NOW,
        };
      },
      async createTask() {
        return { taskId: "sess_new", workspacePath: WORKSPACE };
      },
      async sendPrompt() {},
      async stopGeneration() {
        return { applied: true };
      },
      async renameTask(params) {
        // 先落盘再挂起：验证「ACK 迟到被取消」不等于「变更未执行」。
        renames.push(params.title);
        renameStarted?.();
        renameStarted = null;
        if (renameBarrier) await renameBarrier;
      },
      async setTaskPinned() {},
      async archiveTask() {},
      async unarchiveTask() {},
    },
    agent: {
      async readSessionMessages() {
        readStarted?.();
        readStarted = null;
        if (readBarrier) await readBarrier;
        return [
          { id: "m1", role: "user", text: "hello" },
          { id: "m2", role: "assistant", text: "hi" },
        ];
      },
      async readLiveSession() {
        return { status: "idle" as const };
      },
    },
  });

  const starts: Harness["starts"] = [];
  const service = createExtensionsService({
    grantsFilePath: join(root, "extensions", "grants.json"),
    pluginDir,
    workspaceIdentity: () => `local:${WORKSPACE}`,
    processSupervisor: {
      async start(input) {
        starts.push({
          endpoint: input.endpoint,
          token: input.token,
          generation: input.generation,
        });
        return { pid: 1 };
      },
      async stop() {},
      async stopPlugin() {},
    },
    readSettings: async () => ({ locale: "en-US" }),
    readProjects: async () => [{ id: "p1", name: "Project One" }],
    ...(options?.withAppControl === false
      ? {}
      : { appControl: { service: appControl, sourceServerId: "local" } }),
  });
  return {
    service,
    starts,
    renames,
    setRunning(value: boolean) {
      running = value;
    },
    blockNextRead() {
      let release!: () => void;
      readBarrier = new Promise<void>((resolve) => {
        release = () => {
          readBarrier = null;
          resolve();
        };
      });
      const started = new Promise<void>((resolve) => {
        readStarted = resolve;
      });
      return { started, release };
    },
    blockNextRename() {
      let release!: () => void;
      renameBarrier = new Promise<void>((resolve) => {
        release = () => {
          renameBarrier = null;
          resolve();
        };
      });
      const started = new Promise<void>((resolve) => {
        renameStarted = resolve;
      });
      return { started, release };
    },
    async activate(grants = ["sessions.write"]) {
      await service.grant({ pluginId: "sessions", grants: grants as never });
      const snapshot = await service.start();
      if (snapshot.phase !== "ready") throw new Error(snapshot.error ?? "extension host not ready");
    },
  };
}

describe("extension sessions facade over loopback", () => {
  it("reads sessions and applies a controlled rename through the real App control facade", async () => {
    const harness = await createHarness();
    try {
      await harness.activate();
      const list = await call(harness, "sessions.listSessions", {});
      expect(list).toMatchObject({ ok: true });
      if (!list.ok) return;
      expect(sessionsOf(list.result).map((session) => session.title)).toEqual(["Session A"]);

      const read = await call(harness, "sessions.readSession", {
        sessionId: "sess_a",
        view: "messages",
      });
      expect(read).toMatchObject({ ok: true });
      if (!read.ok) return;
      expect(read.result).toMatchObject({ view: "messages" });
      expect(JSON.stringify(read.result)).toContain("hi");

      const renamed = await call(harness, "sessions.renameSession", {
        sessionId: "sess_a",
        title: "Session A renamed",
        requestId: "req-rename-1",
      });
      expect(renamed).toEqual({
        ok: true,
        result: { status: "applied", requestId: "req-rename-1" },
      });
      expect(harness.renames).toEqual(["Session A renamed"]);
    } finally {
      await harness.service.dispose();
    }
  });

  it("rejects a grant request that does not match the declared grants", async () => {
    const harness = await createHarness();
    try {
      // 清单声明 sessions.write；请求 projects.read 或 read 档位都不能隐式放宽/收窄已声明权限。
      await expect(
        harness.service.grant({ pluginId: "sessions", grants: ["projects.read"] }),
      ).rejects.toThrow(/stale-approval/);
      await expect(
        harness.service.grant({ pluginId: "sessions", grants: ["sessions.read"] }),
      ).rejects.toThrow(/stale-approval/);
      const snapshot = await harness.service.getSnapshot();
      expect(snapshot.plugins[0]?.status).toBe("needs-consent");
      expect(snapshot.generation).toBe(0);
      expect(harness.starts).toEqual([]);
    } finally {
      await harness.service.dispose();
    }
  });

  it("denies session capabilities when the Host did not assemble App control", async () => {
    const harness = await createHarness({ withAppControl: false });
    try {
      await harness.activate();
      const response = await call(harness, "sessions.listSessions", {});
      expect(response).toMatchObject({ ok: false, code: "host-unavailable" });
    } finally {
      await harness.service.dispose();
    }
  });

  it("aborts an in-flight session read on revoke and drops the late result", async () => {
    const harness = await createHarness();
    try {
      await harness.activate();
      const gate = harness.blockNextRead();
      const pending = call(harness, "sessions.readSession", {
        sessionId: "sess_a",
        view: "messages",
      });
      pending.catch(() => {});
      await gate.started;
      const revoked = await harness.service.revoke("sessions");
      expect(revoked.plugins[0]?.status).toBe("needs-consent");
      // 迟到的成功结果不能在撤销后交给插件。
      gate.release();
      expect(await pending).toMatchObject({ ok: false, code: "canceled" });
      expect(await call(harness, "sessions.listSessions", {})).toMatchObject({
        ok: false,
        code: "unauthorized",
      });
    } finally {
      await harness.service.dispose();
    }
  });

  it("rejects non-canonical input and stale generations before the App facade", async () => {
    const harness = await createHarness();
    try {
      await harness.activate();
      // canonical schema 是 strictObject：多带字段不能靠 unknown→cast 混过去。
      const invalid = await call(harness, "sessions.renameSession", {
        sessionId: "sess_a",
        title: "Renamed",
        requestId: "req-1",
        bypass: true,
      });
      expect(invalid).toMatchObject({ ok: false, code: "invalid-input" });
      const active = harness.starts.at(-1)!;
      const stale = await call(
        harness,
        "sessions.listSessions",
        {},
        { generation: active.generation + 1 },
      );
      expect(stale).toMatchObject({ ok: false, code: "stale-generation" });
      expect(harness.renames).toEqual([]);
    } finally {
      await harness.service.dispose();
    }
  });

  it("does not claim a mutation was not applied when its ACK is dropped by revoke", async () => {
    const harness = await createHarness();
    try {
      await harness.activate();
      const gate = harness.blockNextRename();
      const pending = call(harness, "sessions.renameSession", {
        sessionId: "sess_a",
        title: "Renamed before ack",
        requestId: "req-late",
      });
      pending.catch(() => {});
      await gate.started;
      const revoked = await harness.service.revoke("sessions");
      expect(revoked.plugins[0]?.status).toBe("needs-consent");
      gate.release();
      expect(await pending).toMatchObject({ ok: false, code: "canceled" });
      // canceled 只表示 ACK 未交付；后端已经执行，不能反向宣称「未执行」。
      expect(harness.renames).toEqual(["Renamed before ack"]);
    } finally {
      await harness.service.dispose();
    }
  });
});

async function call(
  harness: Harness,
  capabilityId: string,
  input: unknown,
  overrides: { generation?: number } = {},
): Promise<
  { ok: true; result: unknown } | { ok: false; code: string; message: string; status?: number }
> {
  const active = harness.starts.at(-1);
  if (!active) throw new Error("extension host has no published endpoint");
  const response = await fetch(`${active.endpoint}/capability`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${active.token}`,
    },
    body: JSON.stringify({
      v: 1,
      generation: overrides.generation ?? active.generation,
      workspaceIdentity: `local:${WORKSPACE}`,
      pluginId: "sessions",
      capabilityId,
      input,
      requestId: "req-1",
    }),
  });
  if (response.status === 401) {
    return { ok: false, code: "unauthorized", message: "Invalid host token.", status: 401 };
  }
  return (await response.json()) as
    | { ok: true; result: unknown }
    | { ok: false; code: string; message: string };
}

function sessionsOf(result: unknown): Array<{ title?: string }> {
  return (result as { sessions?: Array<{ title?: string }> }).sessions ?? [];
}
