import {
  RewindScope,
  RewindStrategy,
  SessionEventType,
  getCurrentTraceContext,
  traceContextToLogContext,
} from "../deps.js";
import { throwIfTurnAborted } from "../helpers/index.js";
import type { TraceContext } from "../deps.js";
import type { WorkspaceFileRewindApplyResult } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import {
  buildWorkspaceFileRewindPlan,
  readCurrentFileState,
  toPreview,
  type PlannedFileState,
  type WorkspaceFileRewindTargetOptions,
} from "./file-rewind-plan.js";

type FileRewindJournalEntry = {
  path: string;
  state: PlannedFileState;
};

export async function applyWorkspaceFileRewind(
  this: AgentRuntimeInternal,
  options: WorkspaceFileRewindTargetOptions & {
    /** 组合 rewind 的提交闸：文件全部写成功后、workspace event 发布前提交 branch cut。 */
    commitAfterApply?: () => Promise<void>;
  } = {},
): Promise<WorkspaceFileRewindApplyResult> {
  const traceContext = options.traceContext ?? getCurrentTraceContext() ?? this.rootTraceContext;
  const plan = await buildWorkspaceFileRewindPlan.call(this, {
    ...options,
    traceContext,
  });
  if (!plan.canApply) {
    return {
      applied: false,
      preview: toPreview(plan),
      response: "File rewind was not applied because at least one file is unsafe.",
    };
  }

  if (!this.fileSystemPort) {
    return {
      applied: false,
      preview: toPreview({
        ...plan,
        canApply: false,
        unsafeFiles: [
          ...plan.unsafeFiles,
          {
            operationCount: 1,
            path: "workspace",
            reason: "file_read_failed",
            toolNames: [],
            message: "FileSystemPort is not configured.",
          },
        ],
      }),
      response: "File rewind was not applied because the file-system adapter is unavailable.",
    };
  }

  const restoredFiles: Array<{ action: "delete" | "restore"; path: string }> = [];
  const journal: FileRewindJournalEntry[] = [];
  try {
    for (const operation of plan.operations) {
      throwIfTurnAborted(options.abortSignal);
      const state = await readCurrentFileState.call(
        this,
        operation.path,
        traceContext,
        options.abortSignal,
      );
      if ("reason" in state) {
        throw new Error(state.message ?? `Failed to journal ${operation.path}`);
      }
      journal.push({ path: operation.path, state });
      if (operation.action === "delete" || operation.beforeContent === null) {
        await this.fileSystemPort.removeFile(
          {
            path: operation.path,
            missingOk: true,
            trace: traceContext,
          },
          { signal: options.abortSignal },
        );
        restoredFiles.push({ action: "delete", path: operation.path });
        continue;
      }

      await this.fileSystemPort.writeTextFile(
        {
          path: operation.path,
          content: operation.beforeContent,
          createParents: true,
          atomic: true,
          trace: traceContext,
        },
        { signal: options.abortSignal },
      );
      restoredFiles.push({ action: "restore", path: operation.path });
    }
    await options.commitAfterApply?.();
  } catch (error) {
    // 多文件 rewind 过去在第 N 次写失败时会留下半回滚 workspace。
    // journal 按写入逆序恢复命令执行前内容；补偿失败升级为不可恢复错误。
    try {
      await compensateFileRewindJournal.call(this, journal, traceContext);
    } catch (compensationError) {
      throw new AggregateError(
        [error, compensationError],
        "Workspace file rewind failed and compensation was incomplete",
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      applied: false,
      preview: {
        ...toPreview(plan),
        canApply: false,
        unsafeFiles: [
          ...plan.unsafeFiles,
          {
            operationCount: Math.max(1, journal.length),
            path: journal.at(-1)?.path ?? "workspace",
            reason: "file_read_failed",
            toolNames: [],
            message,
          },
        ],
      },
      response: "File rewind was not applied because the write failed; prior files were restored.",
    };
  }

  const lastOperation = plan.operations.at(-1);
  const targetMessageId = options.targetMessageId ?? options.targetMessageIds?.[0];
  const rewindId = `rewind_${crypto.randomUUID()}`;
  const event = this.createEvent(
    SessionEventType.RewindTriggered,
    {
      rewindId,
      scope: RewindScope.Workspace,
      strategy: RewindStrategy.ActiveChain,
      targetMessageId,
      targetCheckpointId: lastOperation?.checkpoint.checkpointId,
      restoredSnapshotRef: lastOperation?.checkpoint.snapshotRef,
      reason: "file_summary_rewind",
    },
    traceContext,
  );
  await this.appendEvent(event, traceContext);

  this.logger?.info("Workspace file summary rewind applied", {
    ...traceContextToLogContext(traceContext),
    event: "rewind.file_summary.completed",
    fileCount: plan.safeFiles.length,
    module: "core.runtime",
    operationCount: plan.operations.length,
    restoredFileCount: restoredFiles.length,
    status: "completed",
    targetCheckpointId: lastOperation?.checkpoint.checkpointId,
    targetMessageId,
  });

  return {
    applied: true,
    preview: toPreview(plan),
    response: `Rewound ${plan.safeFiles.length} file${plan.safeFiles.length === 1 ? "" : "s"} from summary checkpoints.`,
  };
}

async function compensateFileRewindJournal(
  this: AgentRuntimeInternal,
  journal: FileRewindJournalEntry[],
  traceContext: TraceContext,
): Promise<void> {
  for (const entry of [...journal].reverse()) {
    if (!entry.state.exists || entry.state.content === null) {
      await this.fileSystemPort!.removeFile({
        path: entry.path,
        missingOk: true,
        trace: traceContext,
      });
      continue;
    }
    await this.fileSystemPort!.writeTextFile({
      path: entry.path,
      content: entry.state.content,
      createParents: true,
      atomic: true,
      trace: traceContext,
    });
  }
}
