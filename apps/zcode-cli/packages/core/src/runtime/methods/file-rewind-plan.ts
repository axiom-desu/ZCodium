import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import {
  getCurrentTraceContext,
  isFileSystemPortError,
  parseWorkspaceCheckpointArtifact,
} from "../deps.js";
import { throwIfTurnAborted } from "../helpers/index.js";
import type {
  CheckpointCreatedPayload,
  TraceContext,
  WorkspaceCheckpointArtifact,
} from "../deps.js";
import type {
  WorkspaceFileRewindIgnoredFile,
  WorkspaceFileRewindPreview,
  WorkspaceFileRewindSafeFile,
  WorkspaceFileRewindUnsafeFile,
  WorkspaceFileRewindUnsafeReason,
} from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import {
  isIgnoredShellTool,
  resolveCheckpointAfterContent,
  resolveTargetCheckpoints,
  type CheckpointTarget,
} from "./file-rewind-checkpoints.js";

export interface WorkspaceFileRewindTargetOptions extends CheckpointTarget {
  abortSignal?: AbortSignal;
  traceContext?: TraceContext;
}

export type PlannedFileState = {
  content: string | null;
  exists: boolean;
  hash: string | null;
};

type FileCheckpointOperation = {
  action: "restore" | "delete";
  afterContent: string | null;
  artifact: WorkspaceCheckpointArtifact;
  beforeContent: string | null;
  checkpoint: CheckpointCreatedPayload;
  path: string;
  toolName: string;
};

type WorkspaceFileRewindPlan = WorkspaceFileRewindPreview & {
  operations: FileCheckpointOperation[];
};

interface FileAggregate {
  action: "restore" | "delete";
  operationCount: number;
  path: string;
  toolNames: Set<string>;
  unsafe?: {
    currentHash?: string;
    expectedHash?: string;
    message?: string;
    reason: WorkspaceFileRewindUnsafeReason;
  };
}

interface IgnoredFileAggregate {
  operationCount: number;
  path: string;
  toolNames: Set<string>;
}

export async function buildWorkspaceFileRewindPlan(
  this: AgentRuntimeInternal,
  options: WorkspaceFileRewindTargetOptions,
): Promise<WorkspaceFileRewindPlan> {
  const traceContext = options.traceContext ?? getCurrentTraceContext() ?? this.rootTraceContext;
  if (!this.artifactStore || !this.fileSystemPort) {
    return {
      canApply: false,
      ignoredFiles: [],
      operations: [],
      safeFiles: [],
      unsafeFiles: [
        {
          operationCount: 1,
          path: "workspace",
          reason: !this.artifactStore ? "checkpoint_unreadable" : "file_read_failed",
          toolNames: [],
          message: !this.artifactStore
            ? "ArtifactStore is not configured."
            : "FileSystemPort is not configured.",
        },
      ],
    };
  }

  const events = await this.eventStore.getEvents(this.sessionId);
  const checkpoints = resolveTargetCheckpoints(events, {
    targetCheckpointId: options.targetCheckpointId,
    targetMessageId: options.targetMessageId,
    targetMessageIds: options.targetMessageIds,
  });
  if (checkpoints.length === 0) {
    return {
      canApply: false,
      ignoredFiles: [],
      operations: [],
      safeFiles: [],
      unsafeFiles: [],
    };
  }

  const artifacts: Array<{
    artifact: WorkspaceCheckpointArtifact;
    checkpoint: CheckpointCreatedPayload;
  }> = [];
  const unreadableFiles: WorkspaceFileRewindUnsafeFile[] = [];

  for (const checkpoint of checkpoints) {
    throwIfTurnAborted(options.abortSignal);
    try {
      const read = await this.artifactStore.readToolResultArtifact(
        {
          uri: checkpoint.snapshotRef,
          trace: traceContext,
        },
        { signal: options.abortSignal },
      );
      artifacts.push({
        artifact: parseWorkspaceCheckpointArtifact(JSON.parse(read.content)),
        checkpoint,
      });
    } catch (error) {
      unreadableFiles.push({
        operationCount: Math.max(1, checkpoint.fileCount ?? 1),
        path: `checkpoint:${checkpoint.checkpointId}`,
        reason: "checkpoint_unreadable",
        toolNames: [],
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const ignoredByPath = new Map<string, IgnoredFileAggregate>();
  const operations: FileCheckpointOperation[] = [];
  const unsupportedByPath = new Map<string, FileAggregate>();

  for (const { artifact, checkpoint } of artifacts) {
    if (isIgnoredShellTool(artifact.toolName)) {
      for (const file of artifact.files) {
        addIgnoredFile(
          ignoredByPath,
          resolveCheckpointFilePath(this.workspaceRoot, file.path),
          artifact.toolName,
        );
      }
      continue;
    }

    for (const file of artifact.files) {
      // Write/ApplyPatch checkpoint 会保留模型传入的工作区相对路径，而
      // FileSystemPort 只接受绝对路径。若不在计划阶段按 runtime workspace root
      // 解析，安全文件会被误报 file_read_failed，组合 rewind 只返回 blocked。
      const filePath = resolveCheckpointFilePath(this.workspaceRoot, file.path);
      const afterContent = resolveCheckpointAfterContent(file);
      if (afterContent === undefined) {
        markUnsafe(unsupportedByPath, {
          action: file.existedBefore && file.beforeContent !== null ? "restore" : "delete",
          path: filePath,
          reason: "unsupported_checkpoint",
          toolName: artifact.toolName,
        });
        continue;
      }

      operations.push({
        action: file.existedBefore && file.beforeContent !== null ? "restore" : "delete",
        afterContent,
        artifact,
        beforeContent: file.beforeContent,
        checkpoint,
        path: filePath,
        toolName: artifact.toolName,
      });
    }
  }

  const simulatedByPath = new Map<string, PlannedFileState>();
  const safeByPath = new Map<string, FileAggregate>();
  const unsafeByPath = new Map<string, FileAggregate>(unsupportedByPath);
  const applyOperations: FileCheckpointOperation[] = [];

  for (const operation of [...operations].reverse()) {
    throwIfTurnAborted(options.abortSignal);
    const aggregate = ensureFileAggregate(safeByPath, operation);
    aggregate.operationCount += 1;
    aggregate.toolNames.add(operation.toolName);
    aggregate.action = operation.action;

    if (unsafeByPath.has(operation.path)) {
      continue;
    }

    const currentState =
      simulatedByPath.get(operation.path) ??
      (await readCurrentFileState.call(this, operation.path, traceContext, options.abortSignal));
    if ("reason" in currentState) {
      markUnsafe(unsafeByPath, {
        action: operation.action,
        message: currentState.message,
        path: operation.path,
        reason: currentState.reason,
        toolName: operation.toolName,
      });
      continue;
    }

    const expectedHash = hashContent(operation.afterContent);
    if (currentState.hash !== expectedHash) {
      markUnsafe(unsafeByPath, {
        action: operation.action,
        currentHash: currentState.hash ?? "missing",
        expectedHash,
        path: operation.path,
        reason: "external_modified",
        toolName: operation.toolName,
      });
      continue;
    }

    simulatedByPath.set(operation.path, {
      content: operation.beforeContent,
      exists: operation.beforeContent !== null,
      hash: hashContent(operation.beforeContent),
    });
    applyOperations.push(operation);
  }

  for (const [path, unsafe] of unsafeByPath) {
    safeByPath.delete(path);
    unsafe.operationCount = Math.max(
      unsafe.operationCount,
      operations.filter((operation) => operation.path === path).length,
    );
  }

  const safeFiles = Array.from(safeByPath.values()).map(toSafeFile).sort(compareByPath);
  const unsafeFiles = [
    ...unreadableFiles,
    ...Array.from(unsafeByPath.values()).map(toUnsafeFile),
  ].sort(compareByPath);
  const ignoredFiles = Array.from(ignoredByPath.values()).map(toIgnoredFile).sort(compareByPath);

  return {
    canApply: safeFiles.length > 0 && unsafeFiles.length === 0,
    ignoredFiles,
    operations: unsafeFiles.length === 0 ? applyOperations : [],
    safeFiles,
    unsafeFiles,
  };
}

function resolveCheckpointFilePath(workspaceRoot: string, path: string): string {
  return isAbsolute(path) ? path : resolve(workspaceRoot, path);
}

export async function readCurrentFileState(
  this: AgentRuntimeInternal,
  path: string,
  traceContext: TraceContext,
  abortSignal: AbortSignal | undefined,
): Promise<PlannedFileState | { message?: string; reason: "file_read_failed" }> {
  try {
    const read = await this.fileSystemPort!.readTextFile(
      {
        path,
        trace: traceContext,
      },
      { signal: abortSignal },
    );
    return {
      content: read.content,
      exists: true,
      hash: hashContent(read.content),
    };
  } catch (error) {
    if (isFileSystemPortError(error) && error.code === "not_found") {
      return {
        content: null,
        exists: false,
        hash: hashContent(null),
      };
    }
    return {
      reason: "file_read_failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function hashContent(content: string | null): string {
  if (content === null) {
    return "missing";
  }
  return createHash("sha256").update(content).digest("hex");
}

function ensureFileAggregate(
  aggregates: Map<string, FileAggregate>,
  operation: FileCheckpointOperation,
): FileAggregate {
  const existing = aggregates.get(operation.path);
  if (existing) {
    return existing;
  }
  const aggregate: FileAggregate = {
    action: operation.action,
    operationCount: 0,
    path: operation.path,
    toolNames: new Set(),
  };
  aggregates.set(operation.path, aggregate);
  return aggregate;
}

function markUnsafe(
  aggregates: Map<string, FileAggregate>,
  input: {
    action: "restore" | "delete";
    currentHash?: string;
    expectedHash?: string;
    message?: string;
    path: string;
    reason: WorkspaceFileRewindUnsafeReason;
    toolName: string;
  },
): void {
  const existing = aggregates.get(input.path);
  if (existing) {
    existing.operationCount += 1;
    existing.toolNames.add(input.toolName);
    existing.unsafe = {
      currentHash: input.currentHash ?? existing.unsafe?.currentHash,
      expectedHash: input.expectedHash ?? existing.unsafe?.expectedHash,
      message: input.message ?? existing.unsafe?.message,
      reason: existing.unsafe?.reason ?? input.reason,
    };
    return;
  }

  aggregates.set(input.path, {
    action: input.action,
    operationCount: 1,
    path: input.path,
    toolNames: new Set([input.toolName]),
    unsafe: {
      currentHash: input.currentHash,
      expectedHash: input.expectedHash,
      message: input.message,
      reason: input.reason,
    },
  });
}

function addIgnoredFile(
  aggregates: Map<string, IgnoredFileAggregate>,
  path: string,
  toolName: string,
): void {
  const existing = aggregates.get(path);
  if (existing) {
    existing.operationCount += 1;
    existing.toolNames.add(toolName);
    return;
  }
  aggregates.set(path, {
    operationCount: 1,
    path,
    toolNames: new Set([toolName]),
  });
}

function toSafeFile(file: FileAggregate): WorkspaceFileRewindSafeFile {
  return {
    action: file.action,
    operationCount: file.operationCount,
    path: file.path,
    toolNames: Array.from(file.toolNames).sort(),
  };
}

function toUnsafeFile(file: FileAggregate): WorkspaceFileRewindUnsafeFile {
  return {
    operationCount: file.operationCount,
    path: file.path,
    reason: file.unsafe?.reason ?? "unsupported_checkpoint",
    toolNames: Array.from(file.toolNames).sort(),
    ...(file.unsafe?.message ? { message: file.unsafe.message } : {}),
    ...(file.unsafe?.expectedHash ? { expectedHash: file.unsafe.expectedHash } : {}),
    ...(file.unsafe?.currentHash ? { currentHash: file.unsafe.currentHash } : {}),
  };
}

function toIgnoredFile(file: IgnoredFileAggregate): WorkspaceFileRewindIgnoredFile {
  return {
    operationCount: file.operationCount,
    path: file.path,
    reason: "bash_ignored",
    toolNames: Array.from(file.toolNames).sort(),
  };
}

function compareByPath<T extends { path: string }>(left: T, right: T): number {
  return left.path.localeCompare(right.path);
}

export function toPreview(plan: WorkspaceFileRewindPlan): WorkspaceFileRewindPreview {
  return {
    canApply: plan.canApply,
    ignoredFiles: plan.ignoredFiles,
    safeFiles: plan.safeFiles,
    unsafeFiles: plan.unsafeFiles,
  };
}
