import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TaskIndexRepo } from "#src/session/taskIndexRepo.js";
import { createProjectSessionCreationPort } from "#src/project/app/sessionCreation.js";
import {
  deriveV4ReservedSessionId,
  reserveV4CreateSession,
} from "#src/zcode-agent/v4CreateReservation.js";

const root = await mkdtemp(join(tmpdir(), "zcode-v4-create-bridge-"));
const resources: Array<{ repo?: TaskIndexRepo; directory: string }> = [];
afterEach(async () => {
  for (const resource of resources.splice(0)) {
    resource.repo?.close();
    await rm(resource.directory, { recursive: true, force: true });
  }
});

async function fixture() {
  const directory = await mkdtemp(join(root, "case-"));
  const primary = join(directory, "primary");
  const secondary = join(directory, "secondary");
  await Promise.all([mkdir(primary, { recursive: true }), mkdir(secondary, { recursive: true })]);
  const repo = new TaskIndexRepo(join(directory, "tasks-index.sqlite"), 5000, {
    settings: { lastWorkspaceSession: [], recentProjects: [] },
    hostId: "local",
  });
  resources.push({ repo, directory });
  await repo.ensureReady();
  const port = createProjectSessionCreationPort({
    repository: () => repo.getProjectRepository(),
  });
  return { repo, directory, primary, secondary, port, path: join(directory, "tasks-index.sqlite") };
}

const facts = (taskId: string, workspacePath: string) => ({
  meta: {
    taskId,
    traceId: `zcode-${taskId}`,
    title: `title ${taskId}`,
    workspacePath,
    createdAt: 100,
    updatedAt: 200,
    mode: "build" as const,
    provider: "glm" as const,
  },
});

const envelope = { clientId: "client-1", commandId: "command-1" };

describe("v4 createSession 项目预占桥", () => {
  it("创建前预占项目归属与冻结目录；CLI 事实到达后立即进入项目树", async () => {
    const { repo, primary, secondary, port } = await fixture();
    const project = (await repo.getProjectRepository()).saveProject({
      name: "Repo",
      roots: [primary, secondary],
      primaryRoot: primary,
    });
    const reserved = await reserveV4CreateSession({
      workspace: { workspacePath: primary },
      envelope,
      payload: {},
      projectId: project.id,
      prepareSessionCreation: port.prepareSessionCreation,
    });
    expect(reserved.sessionId).toBe(
      deriveV4ReservedSessionId({ workspace: { workspacePath: primary }, envelope }),
    );
    expect(reserved.additionalDirectories).toEqual([secondary]);
    // 空预占行不是假会话：没有 CLI 事实前不进入列表。
    expect((await repo.getProjectRepository()).readTree().tasks).toEqual([]);
    expect((await repo.getProjectRepository()).readTree().projects[0]?.id).toBe(project.id);

    await repo.applyCliFacts(facts(reserved.sessionId, primary));
    const tree = (await repo.getProjectRepository()).readTree();
    expect(tree.tasks.map((task) => task.taskId)).toEqual([reserved.sessionId]);
    expect(tree.tasks[0]).toMatchObject({ projectId: project.id, workspacePath: primary });
  });

  it("同一 commandId 重试命中同一预占行；显式 sessionId 优先", async () => {
    const { repo, primary, secondary, port } = await fixture();
    const project = (await repo.getProjectRepository()).saveProject({
      name: "Repo",
      roots: [primary, secondary],
      primaryRoot: primary,
    });
    const first = await reserveV4CreateSession({
      workspace: { workspacePath: primary },
      envelope,
      payload: {},
      projectId: project.id,
      prepareSessionCreation: port.prepareSessionCreation,
    });
    const retry = await reserveV4CreateSession({
      workspace: { workspacePath: primary },
      envelope,
      payload: {},
      projectId: project.id,
      prepareSessionCreation: port.prepareSessionCreation,
    });
    expect(retry).toEqual(first);
    expect(
      await reserveV4CreateSession({
        workspace: { workspacePath: primary },
        envelope,
        payload: { sessionId: "session_explicit" },
        projectId: project.id,
        prepareSessionCreation: port.prepareSessionCreation,
      }),
    ).toMatchObject({ sessionId: "session_explicit" });
  });

  it("冻结快照后编辑项目 roots 不改写已创建会话的恢复目录", async () => {
    const { repo, directory, primary, secondary, port } = await fixture();
    const repository = await repo.getProjectRepository();
    const project = repository.saveProject({
      name: "Repo",
      roots: [primary, secondary],
      primaryRoot: primary,
    });
    const reserved = await reserveV4CreateSession({
      workspace: { workspacePath: primary },
      envelope,
      payload: {},
      projectId: project.id,
      prepareSessionCreation: port.prepareSessionCreation,
    });
    await repo.applyCliFacts(facts(reserved.sessionId, primary));
    const third = join(directory, "third");
    await mkdir(third, { recursive: true });
    repository.saveProject({
      id: project.id,
      roots: [primary, secondary, third],
      primaryRoot: primary,
    });
    // 已创建任务的执行事实不随组织编辑改写。
    expect(
      await port.resolveSessionDirectories({
        workspacePath: primary,
        sessionId: reserved.sessionId,
      }),
    ).toEqual([secondary]);
    // 新任务按当前 roots 冻结。
    const next = await reserveV4CreateSession({
      workspace: { workspacePath: primary },
      envelope: { clientId: "client-1", commandId: "command-2" },
      payload: {},
      projectId: project.id,
      prepareSessionCreation: port.prepareSessionCreation,
    });
    expect(next.additionalDirectories).toEqual([secondary, third]);
  });

  it("全局任务（projectId=null）只预占身份，不带项目归属", async () => {
    const { repo, primary, port } = await fixture();
    const reserved = await reserveV4CreateSession({
      workspace: { workspacePath: primary },
      envelope,
      payload: {},
      projectId: null,
      prepareSessionCreation: port.prepareSessionCreation,
    });
    expect(reserved.additionalDirectories).toEqual([]);
    await repo.applyCliFacts(facts(reserved.sessionId, primary));
    expect((await repo.getProjectRepository()).readTree().tasks[0]).toMatchObject({
      projectId: null,
    });
  });

  it("预留收口只释放本次未认领的空行；已认领/用户整理/历史行一律保留", async () => {
    const { repo, path, primary, secondary, port } = await fixture();
    const project = (await repo.getProjectRepository()).saveProject({
      name: "Repo",
      roots: [primary, secondary],
      primaryRoot: primary,
    });
    const reserved = await reserveV4CreateSession({
      workspace: { workspacePath: primary },
      envelope,
      payload: {},
      projectId: project.id,
      prepareSessionCreation: port.prepareSessionCreation,
    });
    const release = (sessionId: string) =>
      port.settleCreatedTaskReservation({
        workspacePath: primary,
        sessionId,
        outcome: "cli-closed",
      });

    // 1. 用户整理证据（手工分组）= 不能删除。
    const db = new DatabaseSync(path);
    try {
      db.exec("BEGIN IMMEDIATE");
      db.prepare(
        `INSERT INTO task_groups(group_id,title,color,created_at,updated_at) VALUES('group-1','G','gray',1,1)`,
      ).run();
      db.prepare(
        `INSERT INTO task_group_members(group_id,workspace_key,workspace_path,workspace_identity,task_id,sort_order,added_at,created_at,updated_at)
         VALUES('group-1',?,?,NULL,?,1000,1,1,1)`,
      ).run(primary, primary, reserved.sessionId);
      db.exec("COMMIT");
    } finally {
      db.close();
    }
    expect(await release(reserved.sessionId)).toEqual({ released: false, reason: "organized" });
    let tree = (await repo.getProjectRepository()).readTree();
    expect(tree.taskGroups?.members.map((member) => member.taskId)).toEqual([reserved.sessionId]);
    expect(
      (await repo.getProjectRepository()).resolveSessionDirectories({
        workspacePath: primary,
        taskId: reserved.sessionId,
      }),
    ).toMatchObject({ projectId: project.id, additionalDirectories: [secondary] });

    // 2. receipt 已因 CLI 事实/输入被弃用 = 无 receipt，不再有任何删除路径。
    expect(await release(reserved.sessionId)).toEqual({
      released: false,
      reason: "not-reserved",
    });
    expect(
      (await repo.getProjectRepository()).resolveSessionDirectories({
        workspacePath: primary,
        taskId: reserved.sessionId,
      }),
    ).toMatchObject({ projectId: project.id, additionalDirectories: [secondary] });

    // 3. 未知来源历史行（无 receipt）释放是 no-op，绝不按 cli_created_at NULL 猜。
    expect(await release("session_legacy_unknown")).toEqual({
      released: false,
      reason: "not-reserved",
    });

    // 4. CLI 事实到达后行不再是空预留；即便 receipt 仍在也只保留任务行。
    const accepted = await reserveV4CreateSession({
      workspace: { workspacePath: primary },
      envelope: { clientId: "client-1", commandId: "command-accepted" },
      payload: {},
      projectId: project.id,
      prepareSessionCreation: port.prepareSessionCreation,
    });
    await repo.applyCliFacts(facts(accepted.sessionId, primary));
    const afterFacts = await release(accepted.sessionId);
    expect(afterFacts.released).toBe(false);
    tree = (await repo.getProjectRepository()).readTree();
    expect(tree.tasks.map((task) => task.taskId)).toEqual([accepted.sessionId]);
    expect(tree.tasks[0]).toMatchObject({ projectId: project.id });

    // 5. 输入屏障：只有 receipt 被弃用，行与冻结目录完全不变。
    const prewarmed = await reserveV4CreateSession({
      workspace: { workspacePath: primary },
      envelope: { clientId: "client-1", commandId: "command-prewarmed" },
      payload: {},
      projectId: project.id,
      prepareSessionCreation: port.prepareSessionCreation,
    });
    expect(
      await port.settleCreatedTaskReservation({
        workspacePath: primary,
        sessionId: prewarmed.sessionId,
        outcome: "input-forwarded",
      }),
    ).toEqual({ released: false, reason: "input-forwarded" });
    expect(await release(prewarmed.sessionId)).toEqual({
      released: false,
      reason: "not-reserved",
    });
    expect(
      (await repo.getProjectRepository()).resolveSessionDirectories({
        workspacePath: primary,
        taskId: prewarmed.sessionId,
      }),
    ).toMatchObject({ projectId: project.id, additionalDirectories: [secondary] });
  });

  it("缺生产预占 port 时显式拒绝，不静默创建无归属会话", async () => {
    await expect(
      reserveV4CreateSession({
        workspace: { workspacePath: "/tmp/x" },
        envelope,
        payload: {},
        projectId: "project-x",
      }),
    ).rejects.toThrow("project.creation-unavailable");
  });
});
