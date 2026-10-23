import type { ModelStreamingPayload, SessionEvent } from "@zcode/contracts";
import { SessionEventType } from "@zcode/contracts";
import { ZCODE_FILE_STREAMING_TOOL_INPUT_PREVIEW_MIN_INTERVAL_MS } from "@zcode/shared";
import type { ProjectionState } from "./product-projection-state.js";
import {
  cloneSparseModelSelection,
  sameSparseModelSelection,
} from "./product-projection-model-facts.js";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import type {
  SessionConfigSeed,
  SessionSubagentsSeed,
  SessionUsageSeed,
} from "./product-projection-types.js";
import { isRunning, ms } from "./product-projection-primitives.js";

/** 仅供 publisher 的有界增量估算；返回 null 表示必须走候选快照精确校验。 */
export function establishedStreamingAppendImpl(
  state: ProjectionState,
  event: SessionEvent,
): string | null {
  if (event.type !== SessionEventType.ModelStreaming || !isRunning(state)) return null;
  const payload = event.payload as ModelStreamingPayload;
  if (payload.kind === "text_delta" && state.streamingTextRowId !== null) return payload.delta;
  if (payload.kind === "reasoning_delta" && state.streamingReasoningRowId !== null) {
    return payload.delta;
  }
  if (
    payload.kind === "tool_input_delta" &&
    state.toolRowIdByCallId.has(String(payload.toolCallId))
  ) {
    const previewState = state.fileToolInputPreviewByCallId.get(String(payload.toolCallId));
    if (previewState) {
      if (
        previewState.lastPublishedAt !== null &&
        ms(event) - previewState.lastPublishedAt <
          ZCODE_FILE_STREAMING_TOOL_INPUT_PREVIEW_MIN_INTERVAL_MS
      ) {
        return "";
      }
      // 上界估算必须包含窗口内累计 suffix；只算当前 delta 会低估下一份 wire snapshot。
      return `${previewState.pendingAppend}${payload.delta}`;
    }
    return payload.delta;
  }
  return null;
}

/**
 * config 种子注入。
 *
 * 初始快照 config 曾写死空 provider/model +
 * mode="build"，而 ModelSelected 只在 switchModelConfig 后补发、SessionCreated 刻意
 * 不产 delta——runtime 真值（启动默认模型/项目持久化 mode/历史会话上次选型）从头到尾
 * 进不了投影。后果：① 新会话模型选择器显示空；② 项目持久化 mode=yolo 时 UI 显示
 * build，点 yolo 命中 handler 同值 no-op（判的是 runtime 真值），UI 永远无法收敛——
 * 打破了「revision 不变 ⇔ 无状态变化」的 CAS 不变量。
 *
 * 为什么这么修：种子直改 snapshot.config，不产 delta、不递增 revision/seq——
 * draft「无可见 delta」裁决不被破坏；事件触碰过的区块跳过（重放序
 * 在种子之后时日志值优先）。幂等：可在 ensurePublisher / hydration 后重复调用。
 */
export function seedConfigImpl(
  state: Pick<
    ProjectionState,
    | "configModeTouchedByEvent"
    | "configModelTouchedByEvent"
    | "configThoughtLevelsTouchedByEvent"
    | "snapshot"
  >,
  seed: SessionConfigSeed,
): void {
  const config = { ...state.snapshot.config };
  let changed = false;
  if (!config.permissionGrant && seed.permissionGrant) {
    config.permissionGrant = seed.permissionGrant;
    changed = true;
  }
  if (!state.configModelTouchedByEvent) {
    if (
      Object.hasOwn(seed, "modelSelection") &&
      !sameSparseModelSelection(config.modelSelection, seed.modelSelection)
    ) {
      // 恢复的空选择也有明确语义，不能因为 falsy 而保留历史事件里的旧选型。
      config.modelSelection = seed.modelSelection
        ? cloneSparseModelSelection(seed.modelSelection)
        : undefined;
      changed = true;
    }
    if (seed.provider !== undefined && config.provider !== seed.provider) {
      config.provider = seed.provider;
      changed = true;
    }
    if (seed.model !== undefined && config.model !== seed.model) {
      config.model = seed.model;
      changed = true;
    }
    if (seed.thought !== undefined && config.thought !== seed.thought) {
      config.thought = seed.thought;
      changed = true;
    }
  }
  const seedThoughtLevels = seed.thoughtLevels;
  if (
    !state.configThoughtLevelsTouchedByEvent &&
    seedThoughtLevels !== undefined &&
    (config.thoughtLevels.length !== seedThoughtLevels.length ||
      config.thoughtLevels.some((value, index) => value !== seedThoughtLevels[index]))
  ) {
    config.thoughtLevels = [...seedThoughtLevels];
    changed = true;
  }
  if (!state.configModeTouchedByEvent && seed.mode && config.mode !== seed.mode) {
    config.mode = seed.mode;
    changed = true;
  }
  if (
    !state.configModeTouchedByEvent &&
    seed.planEnabled !== undefined &&
    config.planEnabled !== seed.planEnabled
  ) {
    config.planEnabled = seed.planEnabled;
    changed = true;
  }
  if (changed) {
    state.snapshot = { ...state.snapshot, config };
  }
}

/**
 * 导入分享上下文的来源只读种子。
 *
 * shared_context 是 provider-only message，不应物化为用户气泡；来源标记通过
 * snapshot additive 字段下发，供 Desktop 在打开新会话后显示持久提示。该字段
 * 不属于 conversation rows，也不递增 revision/seq，避免伪造一轮对话。
 */
export function seedSharedContextImportImpl(
  state: Pick<ProjectionState, "snapshot">,
  source: ConversationSnapshot["sharedContextImport"] | null | undefined,
): void {
  const title = source?.title.trim();
  if (!title) return;
  const next = { ...source, title };
  // contextId/status 相同不代表来源相同；冷恢复的新归档摘要不能被旧 seed 吞掉。
  if (JSON.stringify(state.snapshot.sharedContextImport) === JSON.stringify(next)) return;
  state.snapshot = { ...state.snapshot, sharedContextImport: next };
}

export function seedUsageImpl(
  state: Pick<ProjectionState, "contextWindowState" | "snapshot">,
  seed: SessionUsageSeed,
): void {
  const current = state.snapshot.usage;
  const currentContextWindow = current.contextWindow;
  if (currentContextWindow) {
    state.contextWindowState.usedTokens = currentContextWindow.usedTokens;
  }
  // 未知容量也有内部用量事实；迟到的恢复种子不能覆盖真实 ModelComplete/Compact 水位。
  if (state.contextWindowState.usedTokens > 0) {
    return;
  }
  const seededContextWindow = seed.contextWindow;
  if (!Number.isFinite(seededContextWindow.usedTokens) || seededContextWindow.usedTokens <= 0) {
    return;
  }
  const cumulative = {
    inputTokens: seed.cumulative?.inputTokens ?? current.cumulative.inputTokens,
    outputTokens: seed.cumulative?.outputTokens ?? current.cumulative.outputTokens,
    cacheReadTokens: seed.cumulative?.cacheReadTokens ?? current.cumulative.cacheReadTokens,
    cacheWriteTokens: seed.cumulative?.cacheWriteTokens ?? current.cumulative.cacheWriteTokens,
  };
  if (state.contextWindowState.touchedByEvent) {
    // 同类守卫：显式 ModelSelected.contextWindow（含 null）是日志权威容量，
    // hydration seed 只能补回更准确的 token 事实，不得覆盖 maxTokens 或重新显示 null。
    state.contextWindowState.usedTokens = seededContextWindow.usedTokens;
    state.snapshot = {
      ...state.snapshot,
      usage: {
        contextWindow: currentContextWindow
          ? {
              ...currentContextWindow,
              usedTokens: seededContextWindow.usedTokens,
            }
          : null,
        cumulative,
      },
    };
    return;
  }
  if (
    seededContextWindow.maxTokens !== null &&
    (!Number.isFinite(seededContextWindow.maxTokens) || seededContextWindow.maxTokens <= 0)
  ) {
    return;
  }

  // 合成历史事件只有零用量占位；种子补真实水位，未知容量不妨碍内部保留 token。
  state.contextWindowState.usedTokens = seededContextWindow.usedTokens;
  state.contextWindowState.maxTokens = seededContextWindow.maxTokens;
  state.snapshot = {
    ...state.snapshot,
    usage: {
      contextWindow:
        seededContextWindow.maxTokens === null
          ? null
          : { ...seededContextWindow, maxTokens: seededContextWindow.maxTokens },
      cumulative,
    },
  };
}

/**
 * 冷恢复的 subagent store 校验种子。transcript 可以恢复可见 row，但只有 session
 * store 能证明 child 已持久化为 subagent_child；因此在 candidate publisher 发布前
 * 用该种子整体替换 manifest，旧版本遗留的幽灵 child 不得进入 UI 权威态。
 */
export function seedSubagentsImpl(
  state: Pick<ProjectionState, "invalidSubagentChildSessionIds" | "snapshot">,
  seed: SessionSubagentsSeed,
): void {
  const childSessionIds = [...new Set(seed.childSessionIds)];
  const allowed = new Set(childSessionIds);
  state.invalidSubagentChildSessionIds = new Set(
    state.snapshot.rows.window.flatMap((row) =>
      row.kind === "subagent" && row.childSessionId && !allowed.has(row.childSessionId)
        ? [row.childSessionId]
        : [],
    ),
  );
  const running = seed.running.filter((item) => allowed.has(item.childSessionId));
  state.snapshot = {
    ...state.snapshot,
    subagents: {
      // 非空 cold manifest 必须至少从 1 开始；renderer 用 0 区分尚未建立权威态，
      // 否则旧 session 的 stateRevision=0 会让 child tab 失效同步被永久跳过。
      revision: Math.max(childSessionIds.length > 0 ? 1 : 0, Math.floor(seed.revision)),
      childSessionIds,
      running,
      endedTotal: Math.max(0, childSessionIds.length - running.length),
    },
  };
}
