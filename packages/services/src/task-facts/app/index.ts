import {
  generateTraceId,
  resolveWorkspaceKey,
  ZCODE_AGENT_PROVIDER,
  type ZCodeTaskMeta,
} from "@zcode/shared";
import type { CliSessionFacts } from "#src/task-facts/domain/facts.js";
import type { TaskFactsContract, TaskFactChange } from "#src/task-facts/domain/contract.js";
import type {
  TaskFactSource,
  TaskFactStore,
  TaskFactTarget,
  TaskWorkspace,
} from "#src/task-facts/domain/ports.js";

function normalizeTitleSource(
  source: CliSessionFacts["titleSource"],
): "default" | "generated" | "custom" {
  if (source === "custom") return "custom";
  if (source === "default") return "default";
  // first_input 是旧 CLI 的一次性标题，产品语义等同 generated；不得冒充 custom。
  return "generated";
}

function metaFromFacts(target: TaskWorkspace, facts: CliSessionFacts): ZCodeTaskMeta {
  const meta: ZCodeTaskMeta = {
    taskId: facts.sessionId,
    traceId: generateTraceId(facts.sessionId),
    title: facts.title,
    workspacePath: target.workspacePath,
    workspaceIdentity: target.workspaceIdentity,
    createdAt: facts.createdAt,
    updatedAt: facts.updatedAt,
    mode: "build",
    provider: ZCODE_AGENT_PROVIDER,
    ...(facts.parentSessionId ? { forkedFromTaskId: facts.parentSessionId } : {}),
    // interrupted 不是 Host 持久状态值；只映射 error/completed，interrupted 仍写入 cli_last_outcome。
    ...(facts.lastOutcome ? { status: facts.lastOutcome === "error" ? "error" : "completed" } : {}),
  };
  return meta;
}

/** CLI 事实摄入与命令交接的唯一应用入口；无 SQLite/Agent 进程/计时器/第二份状态缓存。 */
export function createTaskFacts(options: {
  store: TaskFactStore;
  source: TaskFactSource;
  changed(change: TaskFactChange): void;
}): TaskFactsContract {
  const { store, source, changed } = options;
  // 仅保留在途请求的代际，不缓存会话状态。新帧到达即撤销旧请求的落库资格。
  const refreshes = new Map<string, symbol>();
  const key = (target: TaskFactTarget) =>
    JSON.stringify([resolveWorkspaceKey(target), target.taskId]);
  const mirror = async (
    target: TaskWorkspace,
    result: Awaited<ReturnType<TaskFactSource["reconcile"]>>,
    current: () => boolean,
    publish = true,
  ) => {
    for (const fact of result.sessions) {
      if (!current()) return;
      const task = {
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        taskId: fact.sessionId,
      };
      if (!fact.exists) {
        // CLI 明确回答“不存在”才标 orphan；snapshot 缺席不走这里。
        await store.markCliOrphan(task);
        continue;
      }
      const before = publish ? await store.getTaskMeta(task) : null;
      if (!current()) return;
      const meta = await store.applyCliFacts({
        meta: metaFromFacts(target, {
          sessionId: fact.sessionId,
          title: fact.title,
          titleSource: fact.titleSource,
          createdAt: fact.createdAt,
          updatedAt: fact.updatedAt,
          ...(fact.lastOutcome ? { lastOutcome: fact.lastOutcome } : {}),
        }),
        titleSource: normalizeTitleSource(fact.titleSource),
        ...(fact.lastOutcome ? { lastOutcome: fact.lastOutcome } : {}),
        deleted: fact.deleted,
      });
      if (
        publish &&
        current() &&
        (fact.deleted ||
          !before ||
          before.title !== meta.title ||
          before.updatedAt !== meta.updatedAt ||
          before.status !== meta.status)
      )
        changed({
          target: task,
          meta,
          reason: fact.deleted ? "task_deleted" : "task_title_changed",
        });
    }
  };
  const port: TaskFactsContract = {
    async ingest(target, facts) {
      refreshes.delete(key({ ...target, taskId: facts.sessionId }));
      return store.applyCliFacts({
        meta: metaFromFacts(target, facts),
        titleSource: normalizeTitleSource(facts.titleSource),
        ...(facts.lastOutcome ? { lastOutcome: facts.lastOutcome } : {}),
        ...(facts.deleted !== undefined ? { deleted: facts.deleted } : {}),
      });
    },
    async removed(target) {
      refreshes.delete(key(target));
      await store.applyCliDeletion(target);
      changed({ target, reason: "task_deleted" });
    },
    async refresh(target) {
      const id = key(target);
      const generation = Symbol();
      refreshes.set(id, generation);
      try {
        const result = await source.reconcile(target, [target.taskId]);
        await mirror(target, result, () => refreshes.get(id) === generation, false);
        return await store.getTaskMeta(target);
      } finally {
        if (refreshes.get(id) === generation) refreshes.delete(id);
      }
    },
    async mutate(target, intent) {
      await source.execute(target, intent);
      const meta = await port.refresh(target);
      changed({
        target,
        ...(meta ? { meta } : {}),
        reason: intent.type === "delete" ? "task_deleted" : "task_title_changed",
      });
      return meta;
    },
    async reconcile(target, presentSessionIds, stillCurrent) {
      const rows = (await store.listReconciliationRows(target)).filter(
        (row) => !presentSessionIds.has(row.meta.taskId) || (row.handoffPending & 3) !== 0,
      );
      for (let offset = 0; offset < rows.length && stillCurrent(); offset += 256) {
        const batch = rows.slice(offset, offset + 256);
        let result = await source.reconcile(
          target,
          batch.map((row) => row.meta.taskId),
        );
        if (!stillCurrent()) return;
        const changedIds: string[] = [];
        for (const fact of result.sessions) {
          if (!stillCurrent()) return;
          if (!fact.exists || fact.deleted) continue;
          const pending = batch.find((row) => row.meta.taskId === fact.sessionId)!;
          if ((pending.handoffPending & 3) === 0) continue;
          await source.execute(
            { ...target, taskId: fact.sessionId },
            (pending.handoffPending & 1) !== 0
              ? { type: "delete" }
              : { type: "rename", title: pending.meta.title },
          );
          changedIds.push(fact.sessionId);
        }
        if (changedIds.length && stillCurrent()) {
          const confirmed = await source.reconcile(target, changedIds);
          result = {
            sessions: [
              ...result.sessions.filter((fact) => !changedIds.includes(fact.sessionId)),
              ...confirmed.sessions,
            ],
          };
        }
        await mirror(target, result, stillCurrent);
      }
    },
  };
  return port;
}
