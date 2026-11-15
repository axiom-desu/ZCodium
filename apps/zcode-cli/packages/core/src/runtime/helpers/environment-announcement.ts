// ============================================================
// 环境公告状态（上游 3.18.2 environment announcement）
// ============================================================
// 唯一所有者是 runtime.environmentAnnouncement：模型已收到过的环境快照。
// 持久化在 session entry（每会话一行，覆盖写）。已发出的增量公告是 append-only 历史事实，
// 不参与“当前已知环境”判定。
//
// 与上游的差异（有意）：本仓首个请求的完整 `# Environment` 在 system 里（并被 prompt 快照冻结），
// 所以首次只记录基线，不把整块正文重复进对话历史；之后只发变化行。

import { SESSION_ENTRY_ENVIRONMENT_ANNOUNCEMENT } from "@zcode/contracts";
import {
  buildEnvironmentAnnouncement,
  environmentSnapshot,
  parseEnvironmentAnnouncement,
  type EnvironmentAnnouncement,
  type EnvironmentSnapshot,
} from "../../context/sections/env-info.js";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import { resolveGenUiOutputDirectory } from "./gen-ui-output.js";
import { traceContextToLogContext } from "../deps.js";
import type { TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";

/** 只有主会话（带 session store）持有环境公告；子 agent / 工作流 actor 不用。 */
function usesEnvironmentAnnouncement(runtime: AgentRuntimeInternal): boolean {
  return Boolean(runtime.sessionStore);
}

/** 模型可见环境：envInfo 在 Context 初始化后已写入 config，不在这里重新探测。 */
function currentEnvironmentSnapshot(
  runtime: AgentRuntimeInternal,
): EnvironmentSnapshot | undefined {
  const envInfo = runtime.contextSourceSnapshot?.envInfo ?? runtime.config.envInfo;
  if (!envInfo) return undefined;
  const snapshot = environmentSnapshot(envInfo, runtime.config.additionalDirectories ?? []);
  const visualizationDirectory = resolveGenUiOutputDirectory(runtime);
  return {
    ...snapshot,
    cwd: runtime.workingDirectory,
    desktopContext: runtime.config.presentationSurface === "zcode_desktop",
    ...(visualizationDirectory ? { visualizationDirectory } : {}),
  };
}

export async function loadEnvironmentAnnouncement(
  runtime: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<void> {
  runtime.environmentAnnouncement = undefined;
  if (!usesEnvironmentAnnouncement(runtime)) return;
  try {
    const entries = await runtime.sessionStore?.sessionEntries?.({
      sessionID: runtime.sessionId,
      type: SESSION_ENTRY_ENVIRONMENT_ANNOUNCEMENT,
    });
    runtime.environmentAnnouncement = parseEnvironmentAnnouncement(entries?.at(-1)?.data);
  } catch (error) {
    // 读取失败按没有基线处理：首个请求只记录基线，不阻断恢复，也不重复整块。
    runtime.logger?.warn("Environment announcement read failed", {
      ...traceContextToLogContext(traceContext),
      error: error instanceof Error ? error.message : String(error),
      event: "context.environment.announcement_read_failed",
      module: "core.runtime",
    });
  }
}

/**
 * 请求前的环境公告：与已公告快照比较，只追加变化。
 *
 * - 首次（没有基线）：正文已在 system 里，只记录 `{full:true}` 基线。
 * - 之后：platform/OS 变化整段重发，其余只发 `# Environment update` 增量。
 * - 没有变化：不产生 entry，也不写库（保持请求字节稳定）。
 */
export function buildEnvironmentUpdateEntry(runtime: AgentRuntimeInternal):
  | {
      /** 首个请求没有 entry（正文在 system 里），只记录基线。 */
      entry?: RuntimeMessageEntry;
      environment: EnvironmentAnnouncement;
    }
  | undefined {
  if (!usesEnvironmentAnnouncement(runtime)) return undefined;
  if (!announcesEnvironment(runtime)) return undefined;
  const current = currentEnvironmentSnapshot(runtime);
  if (!current) return undefined;
  const previous = runtime.environmentAnnouncement;
  if (!previous) {
    // system 首块已给出完整环境：只记录基线，不重复正文。
    return { environment: { full: true, snapshot: current } };
  }
  const announcement = buildEnvironmentAnnouncement(current, previous.snapshot, previous.full);
  if (!announcement) return undefined;
  return {
    entry: {
      kind: "attachment",
      content: announcement.content,
      metadata: { source: "environment_announcement" },
    },
    environment: announcement.environment,
  };
}

/** 环境段是本 runtime 实际发给模型的段（custom system prompt / workflow actor 没有它）。 */
function announcesEnvironment(runtime: AgentRuntimeInternal): boolean {
  return (
    runtime.latestContextBuildResult?.sections.some((section) => section.source === "env_info") ===
    true
  );
}

export async function applyEnvironmentAnnouncement(
  runtime: AgentRuntimeInternal,
  environment: EnvironmentAnnouncement,
  traceContext: TraceContext,
): Promise<void> {
  runtime.environmentAnnouncement = environment;
  await saveEnvironmentAnnouncement(runtime, traceContext);
}

async function saveEnvironmentAnnouncement(
  runtime: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<void> {
  const state = runtime.environmentAnnouncement;
  if (!usesEnvironmentAnnouncement(runtime) || !runtime.sessionStore?.saveSessionEntry || !state) {
    return;
  }
  const timestamp = Date.now();
  try {
    await runtime.sessionStore.saveSessionEntry({
      id: `${runtime.sessionId}:runtime-environment-announcement`,
      sessionID: runtime.sessionId,
      type: SESSION_ENTRY_ENVIRONMENT_ANNOUNCEMENT,
      touchSession: false,
      time: { created: timestamp, updated: timestamp },
      data: state,
    });
  } catch (error) {
    // 写入失败只记 warn：下一次请求会重新比较并再发同一条增量，不会丢内容。
    runtime.logger?.warn("Environment announcement write failed", {
      ...traceContextToLogContext(traceContext),
      error: error instanceof Error ? error.message : String(error),
      event: "context.environment.announcement_write_failed",
      module: "core.runtime",
    });
  }
}
