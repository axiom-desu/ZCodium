import { createMessageId } from "../deps.js";
import { countContextPrefixMessages } from "../deps.js";
import type { Model } from "../deps.js";
import type { TraceContext } from "../deps.js";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import type { InstructionAnnouncement } from "../../context/types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { buildContextHistoryEntries } from "./context-history-entries.js";
import {
  applyInstructionAnnouncement,
  buildInstructionDeltaEntry,
  seedInstructionAnnouncementFromHistory,
} from "../helpers/instruction-announcement.js";
import {
  applyEnvironmentAnnouncement,
  buildEnvironmentUpdateEntry,
} from "../helpers/environment-announcement.js";
import { commitTurnRequestEntries } from "./turn-output-token-continuation.js";
import type { TurnRequestState } from "./turn-loop-state.js";
import { promptSnapshotFor } from "../helpers/prompt-snapshot.js";
import { supersedeContextComposition } from "../context-composition/state.js";

export function rebuildContextPrefix(
  runtime: AgentRuntimeInternal,
  options: { model?: Model; turnRequestEntries?: readonly RuntimeMessageEntry[] } = {},
): readonly RuntimeMessageEntry[] {
  // 前缀重建后下一个请求的组成必然不同：通知在 microtask 之后发出（bootstrap tracker 合并），
  // 届时下面的同步重建已经完成。
  supersedeContextComposition(runtime, "context_prefix");
  if (!runtime.contextBuilder || !runtime.contextInitialized) {
    // 首轮 context 初始化前，model/outputStyle/language 变更只能刷新同步预览，
    // 不能把 config-only fallback envInfo 写入 config.envInfo。否则真实 context source
    // 会以为 envInfo 已由外部显式提供，跳过平台和 git 探测。
    if (runtime.contextBuilder) {
      runtime.contextBuilder = runtime.createContextBuilderFromSnapshot(
        runtime.createConfigOnlyContextSnapshot(runtime.workingDirectory),
        runtime.memoryRoot,
        {
          memoryIndexContent: runtime.memoryIndexContent,
          model: options.model,
          persistEnvInfo: false,
        },
      );
    }
    return options.turnRequestEntries ?? runtime.messageHistory.borrowReadOnlyRuntimeEntries();
  }

  const contextSnapshot =
    runtime.contextSourceSnapshot ??
    runtime.createConfigOnlyContextSnapshot(runtime.workingDirectory);
  runtime.contextBuilder = runtime.createContextBuilderFromSnapshot(
    contextSnapshot,
    runtime.memoryRoot,
    { memoryIndexContent: runtime.memoryIndexContent, model: options.model },
  );
  const effectiveContextResult = runtime.contextBuilder.build();
  // 主会话的 prompt 快照适用于这个模型时，system 用快照记录的字节，不用当前代码的渲染结果。
  // 修复原因：system 原来每次按当前代码重建，升级或冷恢复后已发送的前缀字节改变，prompt cache 失效。
  const snapshot = promptSnapshotFor(runtime, options.model);
  const builtEntries = buildContextHistoryEntries(effectiveContextResult);
  // 快照只冻结 system 字节；前缀里的 meta user 公告（指令区块、skills）仍按当前构建结果重建，
  // 否则恢复后指令公告会整条消失（快照没有 attachment）。
  const contextEntries: RuntimeMessageEntry[] = snapshot
    ? [
        ...snapshot.system.map((message) => ({ message: structuredClone(message) })),
        ...builtEntries.filter((entry) => entry.kind === "attachment"),
      ]
    : builtEntries;
  const canonicalEntries = runtime.messageHistory.borrowReadOnlyRuntimeEntries();
  const canonicalConversationEntries = canonicalEntries.slice(
    countContextPrefixMessages(canonicalEntries),
  );

  runtime.latestContextBuildResult = effectiveContextResult;
  runtime.messageHistory.replaceMessages([...contextEntries, ...canonicalConversationEntries]);

  const turnEntries = options.turnRequestEntries;
  if (!turnEntries) return runtime.messageHistory.borrowReadOnlyRuntimeEntries();
  return [...contextEntries, ...turnEntries.slice(countContextPrefixMessages(turnEntries))];
}

/**
 * 指令文件的增量公告（上游 3.18.2 F1 的请求前公告）。
 * 已公告状态来自 runtime（恢复时从 session entry 载入）；只有内容或文件集合变化时才追加，
 * 不重发整份。正文与增量事实一起落库：写入成功后才算已宣告，失败时错误向上冒泡。
 */
export async function appendInstructionAnnouncement(
  runtime: AgentRuntimeInternal,
  state: TurnRequestState,
  traceContext: TraceContext,
): Promise<void> {
  // 旧会话（写入公告状态之前）在历史里已有完整公告：补一份状态，避免整份重发。
  seedInstructionAnnouncementFromHistory(runtime, state.entries);
  const entry = buildInstructionDeltaEntry(
    runtime,
    runtime.instructionRefreshReason ?? "session_start",
  );
  if (!entry || entry.kind !== "attachment") return;
  const instructions = entry.metadata.instructions as InstructionAnnouncement;
  await runtime.persistSyntheticUserNoticeForSession({
    messageID: createMessageId(),
    metadata: { runtimeMessage: { source: "context_prefix", instructions } },
    sessionId: runtime.sessionId,
    source: "context_prefix",
    text: entry.content,
    traceContext,
  });
  await applyInstructionAnnouncement(runtime, instructions, traceContext);
  commitTurnRequestEntries(runtime, state, [entry]);
}

/**
 * 环境变化的请求前公告（上游 3.18.2 environment announcement）。
 * 正文已在 system 首块里给出，所以第一个请求只记录基线；之后只追加变化行。
 * 没有变化时不写库、不改请求字节。
 */
export async function appendEnvironmentAnnouncement(
  runtime: AgentRuntimeInternal,
  state: TurnRequestState,
  traceContext: TraceContext,
): Promise<void> {
  const update = buildEnvironmentUpdateEntry(runtime);
  if (!update) return;
  if (update.entry?.kind === "attachment") {
    await runtime.persistSyntheticUserNoticeForSession({
      messageID: createMessageId(),
      metadata: { runtimeMessage: { source: "environment_announcement" } },
      sessionId: runtime.sessionId,
      source: "environment_announcement",
      text: update.entry.content,
      traceContext,
    });
    commitTurnRequestEntries(runtime, state, [update.entry]);
  }
  await applyEnvironmentAnnouncement(runtime, update.environment, traceContext);
}
