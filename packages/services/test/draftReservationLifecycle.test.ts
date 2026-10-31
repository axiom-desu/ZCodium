import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDynamicWorkflowClientConfig,
  zcodeProtocolMethods,
  type CommandAck,
} from "@zcode/shared";
import { V4_METHODS } from "@zcode/shared/zcode-protocol-v4";
import { TaskIndexRepo } from "#src/session/taskIndexRepo.js";
import { createProjectSessionCreationPort } from "#src/project/app/sessionCreation.js";

/**
 * draft 创建预留的真实事件顺序（Host 命令路径 + 真实仓储）：
 * createSession 预占 → 输入屏障（转发输入前弃用 receipt）→ CLI 关闭回执后释放。
 * 这里不模拟 UI，也不直接调仓储 API：只有真实 Host port 才能证明「项目切换 dispose 不积累孤儿」，
 * 以及「CLI 已接受但 sessions-index 帧在途」时不会删掉已接受任务。
 */

const WORKSPACE = "/workspace/app";
const SECONDARY = "/workspace/lib";
const resources: Array<{ repo: TaskIndexRepo; directory: string }> = [];

afterEach(async () => {
  vi.resetModules();
  vi.restoreAllMocks();
  for (const { repo, directory } of resources.splice(0)) {
    repo.close();
    await rm(directory, { recursive: true, force: true });
  }
});

class MockProcessManagerBase {
  onRuntimeLifecycle() {
    return { dispose() {} };
  }
  onRuntimeRestarted() {
    return { dispose() {} };
  }
  markReady() {}
}

interface AckScript {
  createSession?: () => Partial<CommandAck>;
  deleteSession?: () => Partial<CommandAck>;
  sendText?: () => Partial<CommandAck>;
}

async function fixture(script: AckScript = {}) {
  const directory = await mkdtemp(join(tmpdir(), "zcode-draft-reservation-"));
  const path = join(directory, "tasks-index.sqlite");
  const repo = new TaskIndexRepo(path, 5000, {
    settings: { lastWorkspaceSession: [], recentProjects: [] },
    hostId: "local",
  });
  resources.push({ repo, directory });
  await repo.ensureReady();
  const repository = await repo.getProjectRepository();
  const port = createProjectSessionCreationPort({ repository: () => repo.getProjectRepository() });
  const forwarded: Array<{ type: string; sessionId: string | null; payload: unknown }> = [];
  const request = vi.fn(async (method: string, requestParams?: unknown) => {
    if (method === zcodeProtocolMethods.sessionCreate) {
      // legacy createSession：真实 CLI 会立即把会话记录落盘。
      const params = requestParams as { sessionId: string };
      return {
        session: { sessionId: params.sessionId },
        messages: [],
        settings: { model: { current: undefined } },
      };
    }
    if (method !== V4_METHODS.command) throw new Error(`Unexpected method ${method}`);
    const envelope = requestParams as {
      type: keyof AckScript;
      sessionId: string | null;
      payload: { sessionId?: string; firstInput?: unknown };
    };
    forwarded.push({
      type: envelope.type,
      sessionId: envelope.sessionId,
      payload: envelope.payload,
    });
    const ack = script[envelope.type]?.() ?? { status: "accepted" as const };
    return {
      commandId: (requestParams as { commandId: string }).commandId,
      revisionAtDecision: 0,
      ...ack,
    } as CommandAck;
  });
  const getClient = vi.fn(async () => ({
    request,
    transportKind: "stdio" as const,
    onNotification: () => ({ dispose() {} }),
    onRequest: () => ({ dispose() {} }),
    onClose: () => ({ dispose() {} }),
  }));
  vi.resetModules();
  vi.doMock("../src/zcode-agent/zcodeAgentProcessManager.js", () => ({
    ZCodeAgentProcessManager: class extends MockProcessManagerBase {
      getClient = getClient;
      disposeAll() {}
    },
  }));
  const { createZCodeAgentService } = await import("../src/zcode-agent/zcodeAgentService.js");
  const service = createZCodeAgentService({
    prepareSessionCreation: port.prepareSessionCreation,
    resolveSessionDirectories: port.resolveSessionDirectories,
    settleCreatedTaskReservation: port.settleCreatedTaskReservation,
    // 只提供「就绪」的模型视图：本用例只验证预留生命周期，不拉起真实 provider。
    modelSelectionReadinessSource: {
      getView: async () =>
        ({
          revision: 1,
          providers: [
            {
              providerId: "provider",
              providerName: "Provider",
              templateId: "template",
              config: {},
              models: [{ modelId: "model" }],
            },
          ],
        }) as never,
    },
    resolveDynamicWorkflowClientConfig: async () =>
      createDynamicWorkflowClientConfig("disabled", "remote"),
  });
  const project = repository.saveProject({
    name: "App",
    roots: [WORKSPACE, SECONDARY],
    primaryRoot: WORKSPACE,
  });
  return {
    repo,
    path,
    service,
    port,
    request,
    forwarded,
    project,
    // projectId 是 Host RPC 参数（不进 v4 payload）：预占归属只走这条既有通道。
    send: (envelope: Record<string, unknown>, projectId?: string | null) =>
      service.sendConversationCommandV4({
        workspacePath: WORKSPACE,
        ...(projectId !== undefined ? { projectId } : {}),
        envelope: envelope as never,
      }),
  };
}

function createSession(commandId: string, payload: Record<string, unknown> = {}) {
  return {
    commandId,
    clientId: "client-draft",
    sessionId: null,
    type: "createSession",
    payload: { workspaceId: WORKSPACE, ...payload },
    issuedAt: 1,
  };
}

function command(type: string, sessionId: string, payload: Record<string, unknown> = {}) {
  return {
    commandId: `command-${type}-${sessionId}`,
    clientId: "client-draft",
    sessionId,
    type,
    payload,
    issuedAt: 1,
  };
}

function inspect(path: string) {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout = 5000");
  return {
    rows: () =>
      db.prepare("SELECT * FROM tasks ORDER BY task_id").all() as Array<Record<string, unknown>>,
    receipts: () =>
      db
        .prepare(
          "SELECT workspace_key,task_id,project_id,execution_directories FROM task_creation_reservations",
        )
        .all() as Array<Record<string, unknown>>,
    close: () => db.close(),
  };
}

describe("draft 创建预留的 owner receipt 生命周期", () => {
  it("项目 A→B 切换：A 的预热 dispose 释放自己的空预留，不积累孤儿", async () => {
    const { repo, path, project, send, forwarded } = await fixture();
    // 同 cwd 的另一项目：owner key 必须按项目隔离，两个预占各自独立可释放。
    const projectB = (await repo.getProjectRepository()).saveProject({
      name: "App (2)",
      roots: [WORKSPACE],
      primaryRoot: WORKSPACE,
    });

    await send(createSession("create-a"), project.id);
    // 第二个项目（共享 cwd 的另一归属）也必须各自预占，不能复用 A 的会话。
    await send(createSession("create-b"), projectB.id);
    const forwardedCreate = forwarded.find((entry) => entry.type === "createSession");
    const reservedA = (forwardedCreate!.payload as { sessionId: string }).sessionId;

    const before = inspect(path);
    expect(before.receipts()).toEqual([
      expect.objectContaining({
        workspace_key: WORKSPACE,
        task_id: reservedA,
        project_id: project.id,
        execution_directories: JSON.stringify([SECONDARY]),
      }),
      expect.anything(),
    ]);
    before.close();

    // 项目切换 = 旧预热 dispose：只发 deleteSession，CLI 关闭回执后释放 A 的预留。
    await send(command("deleteSession", reservedA));
    const after = inspect(path);
    expect(after.receipts().map((row) => row.task_id)).not.toContain(reservedA);
    expect(after.rows().map((row) => row.task_id)).not.toContain(reservedA);
    after.close();
  });

  it("已转发输入：deleteSession 后仍保留项目归属与冻结目录（CLI 帧在途也不是空预留）", async () => {
    const { path, project, send, forwarded } = await fixture();
    await send(createSession("create-1"), project.id);
    const reserved = (
      forwarded.find((entry) => entry.type === "createSession")!.payload as { sessionId: string }
    ).sessionId;

    // 首条输入被 CLI 接受，但 sessions-index 帧尚未 ingest：任务行仍是 created_at=0。
    await send(command("sendText", reserved, { text: "hello" }));
    const afterInput = inspect(path);
    expect(afterInput.receipts()).toEqual([]);
    expect(afterInput.rows()).toEqual([
      expect.objectContaining({
        task_id: reserved,
        created_at: 0,
        cli_created_at: null,
        project_id: project.id,
        execution_directories: JSON.stringify([SECONDARY]),
      }),
    ]);
    afterInput.close();

    // 用户立刻删除该任务：这是已接受任务的删除路径，绝不能当预留释放。
    await send(command("deleteSession", reserved));
    const afterDelete = inspect(path);
    expect(afterDelete.rows()).toEqual([
      expect.objectContaining({
        task_id: reserved,
        project_id: project.id,
        execution_directories: JSON.stringify([SECONDARY]),
        deleted: 0,
      }),
    ]);
    afterDelete.close();
  });

  it("createSession 被 CLI 拒绝：预占行立即释放，取消/失败不积累", async () => {
    const { path, send, forwarded, service } = await fixture({
      createSession: () => ({ status: "rejected", reasonCode: "proto.invalidPayload" }),
    });
    try {
      await send(createSession("create-rejected"), null);
      const reserved = (
        forwarded.find((entry) => entry.type === "createSession")!.payload as { sessionId: string }
      ).sessionId;
      const db = inspect(path);
      expect(db.rows()).toEqual([]);
      expect(db.receipts()).toEqual([]);
      db.close();
      expect(reserved).toMatch(/^session_/);
    } finally {
      service.disposeAll();
    }
  });

  it("legacy createSession 是即时持久会话：receipt 立即弃用，deleteSession 不释放任务行", async () => {
    const { path, project, service } = await fixture();
    try {
      await service.createSession({
        workspacePath: WORKSPACE,
        sessionId: "session_legacy_create",
        projectId: project.id,
        persistence: "immediate",
      });
      // 预占 + 立即认领：只丢 receipt，行与冻结目录留下。
      expect(inspect(path).receipts()).toEqual([]);
      await service.sendConversationCommandV4({
        workspacePath: WORKSPACE,
        envelope: command("deleteSession", "session_legacy_create") as never,
      });
      const db = inspect(path);
      expect(db.rows()).toEqual([
        expect.objectContaining({
          task_id: "session_legacy_create",
          project_id: project.id,
          execution_directories: JSON.stringify([SECONDARY]),
        }),
      ]);
      db.close();
    } finally {
      service.disposeAll();
    }
  });

  it("createSession 自带 firstInput：receipt 立即弃用，会话按普通任务保留", async () => {
    const { path, project, send, forwarded, service } = await fixture();
    try {
      await send(
        {
          ...createSession("create-first-input"),
          payload: { workspaceId: WORKSPACE, firstInput: { text: "hello" } },
        },
        project.id,
      );
      const reserved = (
        forwarded.find((entry) => entry.type === "createSession")!.payload as { sessionId: string }
      ).sessionId;
      // 自带输入 = 立即持久化：只丢 receipt，行与冻结目录留给 CLI 事实。
      await send(command("deleteSession", reserved));
      const db = inspect(path);
      expect(db.receipts()).toEqual([]);
      expect(db.rows()).toEqual([
        expect.objectContaining({
          task_id: reserved,
          project_id: project.id,
          execution_directories: JSON.stringify([SECONDARY]),
        }),
      ]);
      db.close();
    } finally {
      service.disposeAll();
    }
  });
});
