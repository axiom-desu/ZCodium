import { join } from "node:path";

import { traceContextToLogContext } from "../deps.js";
import type { ResolvedUserInstructions } from "@zcode/contracts";
import type { Model, TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";

// compaction 提交后重读指令文件与 Memory 索引（上游 3.18.2 F1）。
// 只读不改 runtime 的读取与"提交后采用"分开：读取失败沿用原内容，提交失败不产生公告。

interface InstructionSourcesReread {
  userInstructions: ResolvedUserInstructions | undefined;
  /** MEMORY.md 索引重读结果；只有 runtime 原来持有索引时才重读。 */
  memoryIndexContent?: string;
}

/**
 * compaction 提交后重读指令文件与 Memory 索引，只读不改 runtime（上游 3.18.2 F1）。
 * 修复原因：原来 compaction 沿用 runtime 启动时读到的内容；会话中途改过的 AGENTS.md / MEMORY.md
 * 在 compact 之后仍以旧内容宣告，模型一直看不到新内容。
 * 没有 context port（子 agent）时不重读；读取失败返回 undefined，沿用原内容；取消时抛出。
 */
export async function rereadInstructionSources(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
  signal?: AbortSignal,
): Promise<InstructionSourcesReread | undefined> {
  const port = this.config.subagentContext ? undefined : this.contextSourcePort;
  const snapshot = this.contextSourceSnapshot;
  if (!port || !snapshot) return undefined;
  const userInstructions = this.config.userInstructions;
  try {
    const resolved = await port.resolveContextSources(
      {
        workingDirectory: snapshot.workingDirectory,
        currentDate: snapshot.currentDate,
        // 传入快照里的 envInfo 与 projectContext，端口不再探测环境与 Git。
        envInfo: snapshot.envInfo,
        projectContext: snapshot.projectContext,
        userInstructions: userInstructions
          ? {
              ...userInstructions,
              workingDirectory: userInstructions.workingDirectory ?? snapshot.workingDirectory,
            }
          : undefined,
        trace: traceContext,
      },
      { signal },
    );
    return {
      userInstructions: resolved.userInstructions,
      ...(this.memoryIndexContent !== undefined
        ? { memoryIndexContent: await rereadMemoryIndexContent(this) }
        : {}),
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    this.logger?.warn("Instruction re-read after compaction failed", {
      ...traceContextToLogContext(traceContext),
      error: error instanceof Error ? error.message : String(error),
      event: "context.instructions.reread_failed",
      module: "core.runtime",
    });
    return undefined;
  }
}

/** 只读 MEMORY.md 索引，不写 readFileState；读不出来时沿用 runtime 持有的内容。 */
async function rereadMemoryIndexContent(
  runtime: AgentRuntimeInternal,
): Promise<string | undefined> {
  const fileSystemPort = runtime.fileSystemPort;
  if (!fileSystemPort || !runtime.memoryRoot) return runtime.memoryIndexContent;
  try {
    const read = await fileSystemPort.readTextFile({ path: join(runtime.memoryRoot, "MEMORY.md") });
    return read.content;
  } catch {
    return runtime.memoryIndexContent;
  }
}

/**
 * compaction 提交后采用重读的内容，并把下一次增量公告的原因改成 compaction。
 * 不改历史里的 system 前缀，也不改工作目录、环境与 Git 上下文。
 */
export function applyRereadInstructionSources(
  this: AgentRuntimeInternal,
  reread: InstructionSourcesReread,
  model: Model | undefined,
): void {
  const snapshot = this.contextSourceSnapshot;
  if (!snapshot) return;
  this.contextSourceSnapshot = { ...snapshot, userInstructions: reread.userInstructions };
  if (reread.memoryIndexContent !== undefined) {
    this.memoryIndexContent = reread.memoryIndexContent;
  }
  this.contextBuilder = this.createContextBuilderFromSnapshot(
    this.contextSourceSnapshot,
    this.memoryRoot,
    { memoryIndexContent: this.memoryIndexContent, model },
  );
  this.latestContextBuildResult = this.contextBuilder.build();
  this.instructionRefreshReason = "compaction";
}
