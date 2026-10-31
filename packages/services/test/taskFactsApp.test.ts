import { describe, expect, it } from "vitest";
import { createTaskFacts } from "#src/task-facts/app/index.js";
import type { TaskFactStore } from "#src/task-facts/domain/ports.js";

function fakeStore() {
  const rows = new Map<string, { title: string; deleted: boolean }>();
  const orphans = new Set<string>();
  const applied: string[] = [];
  const store: TaskFactStore = {
    async applyCliFacts(facts) {
      rows.set(facts.meta.taskId, { title: facts.meta.title, deleted: facts.deleted === true });
      applied.push(facts.meta.taskId);
      return facts.meta;
    },
    async applyCliDeletion(target) {
      rows.set(target.taskId, { title: rows.get(target.taskId)?.title ?? "", deleted: true });
    },
    async markCliOrphan(target) {
      orphans.add(target.taskId);
    },
    async listReconciliationRows() {
      return [...rows].map(([taskId, row]) => ({
        meta: {
          taskId,
          traceId: taskId,
          title: row.title,
          workspacePath: "/repo",
          createdAt: 1,
          updatedAt: 2,
          mode: "build" as const,
        },
        handoffPending: 0,
      }));
    },
    async getTaskMeta(target) {
      const row = rows.get(target.taskId);
      return row
        ? {
            taskId: target.taskId,
            traceId: target.taskId,
            title: row.title,
            workspacePath: "/repo",
            createdAt: 1,
            updatedAt: 2,
            mode: "build" as const,
          }
        : null;
    },
  };
  return { store, rows, orphans, applied };
}

describe("task-facts app", () => {
  it("ingests only real CLI fields and writes a CLI deletion as explicit removal", async () => {
    const { store, rows, applied } = fakeStore();
    const changes: string[] = [];
    const facts = createTaskFacts({
      store,
      source: {
        async reconcile() {
          throw new Error("not used");
        },
        async execute() {
          throw new Error("not used");
        },
      },
      changed: (change) => changes.push(change.reason),
    });
    await facts.ingest(
      { workspacePath: "/repo" },
      {
        sessionId: "task-1",
        title: "Hello",
        titleSource: "first_input",
        createdAt: 1,
        updatedAt: 2,
      },
    );
    expect(rows.get("task-1")).toMatchObject({ title: "Hello", deleted: false });
    await facts.removed({ workspacePath: "/repo", taskId: "task-1" });
    expect(rows.get("task-1")).toMatchObject({ deleted: true });
    expect(applied).toEqual(["task-1"]);
    expect(changes).toEqual(["task_deleted"]);
  });

  it("treats reconcile absence as orphan and explicit deleted as deletion", async () => {
    const { store, rows, orphans } = fakeStore();
    const facts = createTaskFacts({
      store,
      source: {
        async reconcile() {
          return {
            sessions: [
              { sessionId: "missing", exists: false as const, deleted: false as const },
              {
                sessionId: "deleted",
                exists: true as const,
                deleted: true,
                title: "gone",
                titleSource: "default" as const,
                createdAt: 1,
                updatedAt: 2,
              },
            ],
          };
        },
        async execute() {
          throw new Error("not used");
        },
      },
      changed: () => undefined,
    });
    await facts.refresh({
      workspacePath: "/repo",
      workspaceIdentity: undefined,
      taskId: "missing",
    });
    expect(orphans.has("missing")).toBe(true);
    await facts.ingest(
      { workspacePath: "/repo" },
      { sessionId: "deleted", title: "old", createdAt: 1, updatedAt: 2 },
    );
    await facts.refresh({ workspacePath: "/repo", taskId: "deleted" });
    expect(rows.get("deleted")).toMatchObject({ deleted: true });
  });
});
