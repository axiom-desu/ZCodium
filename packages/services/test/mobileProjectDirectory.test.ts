import { expect, it, vi } from "vitest";
import { createMobileProjectDirectoryService } from "../src/mobile-project-directory/service.js";

it("read-only roots remain visible; only exact Source identity/session can create, with one existing-runtime command", async () => {
  let online = true;
  let generation = 7;
  const runtime = { identity: "actor", generation: 1, workspaceKey: "remote:server:a:/repo" };
  const create = vi.fn(async () => ({ taskId: "task" }) as never);
  const project = {
    id: "p",
    hostId: "remote:server:a",
    name: "A",
    roots: [{ rootPath: "/repo" }, { rootPath: "/unbound" }],
  };
  const readProjects = vi.fn(async () => [project] as never);
  const service = createMobileProjectDirectoryService({
    assertCurrent: () => {},
    owners: () => [
      {
        hostId: "remote:server:a",
        projects: { readProjects } as never,
        agent: { getWorkspaceRuntimeIdentity: vi.fn(async () => runtime) } as never,
        tasks: { createTaskExistingRuntime: create } as never,
        target: (rootPath) =>
          rootPath === "/repo"
            ? {
                workspacePath: rootPath,
                workspaceIdentity: runtime.workspaceKey,
                remoteSessionId: "session-a",
                generation,
              }
            : undefined,
        assertCurrent: () => {
          if (!online) throw new Error("offline");
        },
      },
    ],
  });
  const roots = await service.readProjects();
  expect(roots.map((r) => r.enabled)).toEqual([true, false]);
  await expect(service.createTask(roots[1]!)).rejects.toThrow();
  await expect(
    service.createTask({ ...roots[0]!, workspaceIdentity: "remote:server:b:/repo" }),
  ).rejects.toThrow();
  await service.createTask(roots[0]!);
  expect(create).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      projectId: "p",
      workspacePath: "/repo",
      workspaceIdentity: runtime.workspaceKey,
      remoteSessionId: "session-a",
    }),
    runtime,
  );
  generation++;
  await expect(service.createTask(roots[0]!)).rejects.toThrow("stale-attachment");
  await expect(
    service.createTask({ ...roots[0]!, remoteSessionId: "other-session" }),
  ).rejects.toThrow("stale-attachment");
  online = false;
  await expect(service.createTask(roots[0]!)).rejects.toThrow();
  expect(create).toHaveBeenCalledTimes(1);
});
