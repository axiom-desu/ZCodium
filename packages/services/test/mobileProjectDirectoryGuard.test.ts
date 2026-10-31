import { describe, expect, it, vi } from "vitest";
import { guardReplayableTaskCreation } from "../../desktop/src/host/mobileProjectDirectoryAttachment.js";

const runtime = { identity: "actor", generation: 3, workspaceKey: "remote:server:a:/repo" };
const remoteTarget = {
  workspacePath: "/repo",
  workspaceIdentity: "remote:server:a:/repo",
  remoteSessionId: "session-a",
};

function setup(options: { supported?: boolean; localAdmission?: boolean } = {}) {
  let online = true;
  const assertTarget = vi.fn((params: { workspacePath: string; remoteSessionId?: string }) => {
    if (!online) throw new Error("project.stale-attachment");
    // 远端 replayable 客户端不能省略 identity/session 参数来逃逸到普通 create。
    if (params.remoteSessionId !== remoteTarget.remoteSessionId)
      throw new Error("project.stale-attachment");
  });
  const plainCreate = vi.fn(async () => ({ taskId: "plain" }) as never);
  const existingCreate = vi.fn(async () => ({ taskId: "existing" }) as never);
  const getClient = vi.fn();
  const agent = {
    getClient,
    getWorkspaceRuntimeIdentity: vi.fn(async () => runtime),
    acquireExistingRuntime: vi.fn(async () => ({
      runtimeIdentity: runtime,
      assertCurrent: vi.fn(),
      createSession: vi.fn(),
    })),
  };
  const guarded = guardReplayableTaskCreation({
    tasks: { createTask: plainCreate, createTaskExistingRuntime: existingCreate } as never,
    agent: agent as never,
    assertTarget: assertTarget as never,
    supported: options.supported ?? true,
    localAdmission: options.localAdmission,
  });
  return {
    guarded,
    assertTarget,
    plainCreate,
    existingCreate,
    agent,
    getClient,
    goOffline: () => {
      online = false;
    },
  };
}

describe("replayable attachment task guard", () => {
  it("rejects a peer without existing-runtime admission instead of falling back to plain create", async () => {
    const f = setup({ supported: false });
    await expect(f.guarded.createTask(remoteTarget as never)).rejects.toThrow(
      "project.existing-runtime-unavailable",
    );
    expect(f.plainCreate).not.toHaveBeenCalled();
    expect(f.existingCreate).not.toHaveBeenCalled();
    expect(f.getClient).not.toHaveBeenCalled();
  });

  it("rejects a client that omits the attachment identity before touching any service", async () => {
    const f = setup();
    await expect(f.guarded.createTask({ workspacePath: "/repo" } as never)).rejects.toThrow(
      "project.stale-attachment",
    );
    expect(f.agent.getWorkspaceRuntimeIdentity).not.toHaveBeenCalled();
    expect(f.existingCreate).not.toHaveBeenCalled();
    expect(f.plainCreate).not.toHaveBeenCalled();
    expect(f.getClient).not.toHaveBeenCalled();
  });

  it("resolves the expected runtime read-only and never starts a process", async () => {
    const f = setup();
    await expect(f.guarded.createTask(remoteTarget as never)).resolves.toEqual({
      taskId: "existing",
    });
    expect(f.existingCreate).toHaveBeenCalledExactlyOnceWith(remoteTarget, runtime);
    expect(f.plainCreate).not.toHaveBeenCalled();
    expect(f.agent.acquireExistingRuntime).not.toHaveBeenCalled();
    expect(f.getClient).not.toHaveBeenCalled();
    // 调用前、identity 读取后、投递后各同步复检一次 attachment。
    expect(f.assertTarget).toHaveBeenCalledTimes(3);
  });

  it("rejects a runtime that changed between lookup and delivery", async () => {
    const f = setup({ localAdmission: true });
    f.agent.acquireExistingRuntime.mockResolvedValue({
      runtimeIdentity: { ...runtime, generation: 4 },
      assertCurrent: vi.fn(),
      createSession: vi.fn(),
    } as never);
    await expect(f.guarded.createTask(remoteTarget as never)).rejects.toThrow(
      "project.stale-runtime",
    );
    expect(f.plainCreate).not.toHaveBeenCalled();
    expect(f.existingCreate).not.toHaveBeenCalled();
  });

  it("local admission uses the typed createTask path with the in-process admission", async () => {
    const f = setup({ localAdmission: true });
    await expect(f.guarded.createTask(remoteTarget as never)).resolves.toEqual({
      taskId: "plain",
    });
    expect(f.plainCreate).toHaveBeenCalledExactlyOnceWith(
      remoteTarget,
      expect.objectContaining({ runtimeIdentity: runtime }),
    );
    expect(f.existingCreate).not.toHaveBeenCalled();
    expect(f.getClient).not.toHaveBeenCalled();
  });

  it("does not deliver when the attachment is revoked while the guard awaits", async () => {
    const f = setup();
    f.agent.getWorkspaceRuntimeIdentity.mockImplementation(async () => {
      f.goOffline();
      return runtime;
    });
    await expect(f.guarded.createTask(remoteTarget as never)).rejects.toThrow(
      "project.stale-attachment",
    );
    expect(f.existingCreate).not.toHaveBeenCalled();
    expect(f.plainCreate).not.toHaveBeenCalled();
    expect(f.getClient).not.toHaveBeenCalled();
  });
});

describe("replayable attachment task guard result boundary", () => {
  it("does not redispatch or claim rollback after the accepted command loses its attachment", async () => {
    let online = true;
    const existingCreate = vi.fn(async () => {
      online = false;
      return { taskId: "accepted-before-revoke" } as never;
    });
    const guarded = guardReplayableTaskCreation({
      tasks: { createTask: vi.fn(), createTaskExistingRuntime: existingCreate } as never,
      agent: { getWorkspaceRuntimeIdentity: vi.fn(async () => runtime) } as never,
      supported: true,
      assertTarget: () => {
        if (!online) throw new Error("project.stale-attachment");
      },
    });
    await expect(guarded.createTask(remoteTarget as never)).rejects.toThrow(
      "project.stale-attachment",
    );
    // 命令已经交给原 owner 一次；断连后只作废结果，不重投，也不宣称回滚。
    expect(existingCreate).toHaveBeenCalledTimes(1);
  });
});
