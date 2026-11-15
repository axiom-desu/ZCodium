import type { Model, TraceContext } from "../deps.js";
import {
  canStartMemoryRecall,
  createMemoryRecallState,
  filterMemorySelections,
  findLatestMemoryRecallQuery,
  formatRelevantMemoryAttachment,
  getMemoryRecallManifest,
  isMemoryRecallQueryEligible,
  readRecalledMemories,
  recordRecalledMemories,
  runMemorySelector,
  type MemoryManifestEntry,
  type MemoryRecallState,
  type RecalledMemory,
} from "../../memory/recall/index.js";
import {
  createReadFileStateKey,
  createReadFileStatePathKey,
  normalizeReadFileStateMtimeMs,
} from "../../tool/read-file-state.js";
import type { ReadFileStateMap } from "../../tool/types.js";
import type { ProjectMemoryRetrievalBranch } from "../../memory/project-memory-retrieval-branch.js";
import { ACTIVE_PROJECT_MEMORY_RETRIEVAL_BRANCH } from "../../memory/project-memory-retrieval-branch.js";
import type { AgentRuntimeInternal } from "../internal.js";
import {
  systemReminderAttachmentEntry,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";

interface PrefetchedMemory {
  entry: MemoryManifestEntry;
  memory: RecalledMemory;
}

export interface ProjectMemoryRecallPrefetch {
  abortController: AbortController;
  consumed: boolean;
  detachTurnAbort: () => void;
  memories: PrefetchedMemory[];
  settled: boolean;
}

/**
 * turn 开始时的 selector prefetch：与模型请求同一条证据链，但绝不阻塞首轮请求。
 * 结果只在完整真实 tool-result batch 之后由 consumeSettledProjectMemoryRecall 消费一次。
 */
export function startProjectMemoryRecallPrefetch(
  runtime: AgentRuntimeInternal,
  input: { model: Model; traceContext: TraceContext; turnAbortSignal: AbortSignal },
  retrievalBranch: ProjectMemoryRetrievalBranch,
): void {
  if (retrievalBranch !== "semantic-recall") return;
  if (runtime.memoryRecallPrefetch) return;
  if (!runtime.memoryRoot || !runtime.fileSystemPort) return;
  // Selector 必须得到严格 JSON Schema；禁止因能力不足另选一个隐式 Provider/Model。
  if (!input.model.properties.supportsJsonSchemaOutput) return;
  if (!canStartMemoryRecall(runtime.memoryRecallState)) return;

  const query = findLatestMemoryRecallQuery(runtime.messageHistory.borrowReadOnlyRuntimeEntries());
  if (!isMemoryRecallQueryEligible(query)) return;
  const recallState = runtime.memoryRecallState;
  if (hasRecalledEveryManifestEntry(recallState)) return;

  const abortController = new AbortController();
  const prefetch: ProjectMemoryRecallPrefetch = {
    abortController,
    consumed: false,
    detachTurnAbort: forwardTurnAbort(input.turnAbortSignal, abortController),
    memories: [],
    settled: false,
  };
  runtime.memoryRecallPrefetch = prefetch;

  const readFileStateSnapshot: ReadFileStateMap = new Map(runtime.readFileState);
  const recalledPathsSnapshot = new Set(recallState.recalledPaths);
  void runtime.trackResidencyBlockingWork(
    prefetchProjectMemories(runtime, {
      abortSignal: abortController.signal,
      model: input.model,
      query,
      readFileStateSnapshot,
      recalledPathsSnapshot,
      rootDir: runtime.memoryRoot,
      state: recallState,
      traceContext: input.traceContext,
    })
      .then((memories) => {
        prefetch.memories = memories;
      })
      .catch(() => {
        prefetch.memories = [];
      })
      .finally(() => {
        prefetch.settled = true;
        prefetch.detachTurnAbort();
      }),
  );
}

/** 产品分支入口：只有 Core 的唯一常量决定是否真的启动 Recall。 */
export function startActiveProjectMemoryRecallPrefetch(
  runtime: AgentRuntimeInternal,
  input: { model: Model; traceContext: TraceContext; turnAbortSignal: AbortSignal },
): void {
  startProjectMemoryRecallPrefetch(runtime, input, ACTIVE_PROJECT_MEMORY_RETRIEVAL_BRANCH);
}

/**
 * 只在完整真实 tool-result batch 之后的边界调用；未 settled 的 prefetch 不等待。
 * 返回的 attachment 由调用方提交到本 turn 的请求 entries（同一次请求只出现一次）。
 */
export function consumeSettledProjectMemoryRecall(
  runtime: AgentRuntimeInternal,
  retrievalBranch: ProjectMemoryRetrievalBranch,
): RuntimeMessageEntry | undefined {
  if (retrievalBranch !== "semantic-recall") return undefined;
  const prefetch = runtime.memoryRecallPrefetch;
  if (!prefetch || !prefetch.settled || prefetch.consumed) return undefined;
  prefetch.consumed = true;

  const eligibleEntries = filterMemorySelections({
    manifest: runtime.memoryRecallState.manifest ?? prefetch.memories.map(({ entry }) => entry),
    readFileState: runtime.readFileState,
    recalledPaths: runtime.memoryRecallState.recalledPaths,
    selectedFilenames: prefetch.memories.map(({ entry }) => entry.filename),
  });
  const memories = matchPrefetchedMemories(prefetch.memories, eligibleEntries);
  if (memories.length === 0) return undefined;

  // 修复原因：Recall 正文对模型等价于一次读取，必须在实际注入时同步既有 read-state，供后续 Edit/Write 使用。
  const readAt = new Date();
  for (const memory of memories) {
    runtime.readFileState.set(
      createReadFileStateKey(memory.filePath, undefined, memory.limit),
      {
        content: memory.content,
        isPartialView: false,
        limit: memory.limit,
        mtimeMs: normalizeReadFileStateMtimeMs(memory.mtimeMs),
        offset: undefined,
        path: memory.filePath,
        readAt,
        revisionId: memory.revisionId,
        sizeBytes: memory.sizeBytes,
      },
    );
  }
  recordRecalledMemories(runtime.memoryRecallState, memories);
  return systemReminderAttachmentEntry(
    "relevant_memory",
    formatRelevantMemoryAttachment(memories),
  );
}

export function disposeProjectMemoryRecallPrefetch(runtime: AgentRuntimeInternal): void {
  const prefetch = runtime.memoryRecallPrefetch;
  if (!prefetch) return;
  runtime.memoryRecallPrefetch = undefined;
  prefetch.detachTurnAbort();
  if (!prefetch.abortController.signal.aborted) {
    prefetch.abortController.abort();
  }
}

export function resetProjectMemoryRecall(runtime: AgentRuntimeInternal): void {
  disposeProjectMemoryRecallPrefetch(runtime);
  runtime.memoryRecallState = createMemoryRecallState();
}

export function invalidateProjectMemoryRecallPaths(
  runtime: AgentRuntimeInternal,
  paths: readonly string[],
): void {
  if (paths.length === 0) return;
  // Dream 修改文件时，已完成但尚未消费的 prefetch 仍持有旧正文；先丢弃它，
  // 避免后续 tool batch 把更新前的内容重新注入 provider context。
  disposeProjectMemoryRecallPrefetch(runtime);
  const touchedPathKeys = new Set(paths.map((path) => createReadFileStatePathKey(path)));

  for (const [key, entry] of runtime.readFileState) {
    if (touchedPathKeys.has(createReadFileStatePathKey(entry.path))) {
      runtime.readFileState.delete(key);
    }
  }
  for (const recalledPath of runtime.memoryRecallState.recalledPaths) {
    if (touchedPathKeys.has(createReadFileStatePathKey(recalledPath))) {
      runtime.memoryRecallState.recalledPaths.delete(recalledPath);
    }
  }

  runtime.memoryRecallState.manifest = undefined;
  runtime.memoryRecallState.selectorMessages = undefined;
}

async function prefetchProjectMemories(
  runtime: AgentRuntimeInternal,
  input: {
    abortSignal: AbortSignal;
    model: Model;
    query: string;
    readFileStateSnapshot: ReadFileStateMap;
    recalledPathsSnapshot: ReadonlySet<string>;
    rootDir: string;
    state: MemoryRecallState;
    traceContext: TraceContext;
  },
): Promise<PrefetchedMemory[]> {
  try {
    const fileSystem = runtime.fileSystemPort!;
    const manifest = await getMemoryRecallManifest({
      fileSystem,
      rootDir: input.rootDir,
      signal: input.abortSignal,
      state: input.state,
    });
    if (manifest.every((entry) => input.recalledPathsSnapshot.has(entry.filePath))) return [];

    const selection = await runMemorySelector({
      abortSignal: input.abortSignal,
      model: input.model,
      query: input.query,
      state: input.state,
    });
    const entries = filterMemorySelections({
      manifest,
      readFileState: input.readFileStateSnapshot,
      recalledPaths: input.recalledPathsSnapshot,
      selectedFilenames: selection.selectedMemories,
    });
    const memories = await readRecalledMemories({
      entries,
      fileSystem,
      nowMs: runtime.now().getTime(),
      signal: input.abortSignal,
    });
    runtime.logger?.debug("Project memory recall prefetched", {
      event: "memory.recall.prefetched",
      module: "core.runtime",
      selected: entries.length,
      recalled: memories.length,
      status: "completed",
      ...traceFields(input.traceContext),
    });
    const entryByPath = new Map(entries.map((entry) => [entry.filePath, entry]));
    return memories.flatMap((memory) => {
      const entry = entryByPath.get(memory.filePath);
      return entry ? [{ entry, memory }] : [];
    });
  } catch (error) {
    // selector/读取失败与 abort 都只产生空结果：不重试、不 fallback 到关键词，也不阻塞主 turn。
    runtime.logger?.debug("Project memory recall prefetch skipped", {
      event: "memory.recall.prefetch.skipped",
      module: "core.runtime",
      reason: input.abortSignal.aborted
        ? "abort_signal"
        : error instanceof Error
          ? error.message
          : String(error),
      status: "cancelled",
      ...traceFields(input.traceContext),
    });
    return [];
  }
}

function traceFields(traceContext: TraceContext): Record<string, unknown> {
  return {
    traceId: traceContext.traceId,
    sessionId: traceContext.sessionId,
  };
}

function hasRecalledEveryManifestEntry(state: MemoryRecallState): boolean {
  return (
    state.manifest !== undefined &&
    state.manifest.length > 0 &&
    state.manifest.every((entry) => state.recalledPaths.has(entry.filePath))
  );
}

function matchPrefetchedMemories(
  prefetched: readonly PrefetchedMemory[],
  eligibleEntries: readonly MemoryManifestEntry[],
): RecalledMemory[] {
  const byFilename = new Map<string, RecalledMemory[]>();
  for (const { entry, memory } of prefetched) {
    const queued = byFilename.get(entry.filename) ?? [];
    queued.push(memory);
    byFilename.set(entry.filename, queued);
  }
  return eligibleEntries.flatMap((entry) => {
    const memory = byFilename.get(entry.filename)?.shift();
    return memory ? [memory] : [];
  });
}

function forwardTurnAbort(
  turnAbortSignal: AbortSignal,
  abortController: AbortController,
): () => void {
  const abort = () => {
    if (!abortController.signal.aborted) abortController.abort(turnAbortSignal.reason);
  };
  if (turnAbortSignal.aborted) {
    abort();
    return () => {};
  }
  turnAbortSignal.addEventListener("abort", abort, { once: true });
  return () => turnAbortSignal.removeEventListener("abort", abort);
}
