// 草稿预演：按所查模型模拟「下一个请求」，在 entries 的副本上走一遍请求准备，再用同一分类函数出数。
// 规格：.agents/specs/upstream-3.18-context-projection.md §2.1、§4。
//
// 不做：persistAnnouncements（会落库，并让 deferred 草稿升为 immediate 持久化）、写历史、发请求、
// 跑 hooks、环境与 Git 的 IO 探测、会消费一次性状态的提醒（todo、计划退出、Memory 更新、指令增量）。
// 与上游差异：本仓只在请求边界追加运行模式 / output style / ToolSearch 公告，预演按同一顺序模拟这三类。
import { countContextPrefixMessages } from "../deps.js";
import type { ContextBuildResult, Model, ModelToolContract, TraceContext } from "../deps.js";
import { systemReminderAttachmentEntry, type RuntimeMessageEntry } from "../../agent/message-history.js";
import { buildContextHistoryEntries } from "../methods/context-history-entries.js";
import { buildToolSearchAnnouncement } from "../../tool/search/exposure.js";
import {
  buildRuntimeModeReminderBody,
  buildRuntimeOutputStyleReminderBody,
} from "../helpers/runtime-reminders.js";
import { prepareRuntimeProviderRequest } from "../helpers/runtime-provider-request-messages.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { classifyContextComposition, type ContextCompositionBreakdown } from "./classifier.js";
import { collectContextCompositionItems } from "./items.js";

export async function previewContextComposition(
  runtime: AgentRuntimeInternal,
  input: { model: Model; traceContext: TraceContext },
): Promise<ContextCompositionBreakdown> {
  const { model, traceContext } = input;
  // 可接受的副作用：与技能面板同一条初始化路径（启动 MCP、建记忆目录、内存里装好前缀），都不落库。
  await runtime.ensureContextInitialized(traceContext, model);
  await runtime.initializeMcp(traceContext);
  const contextResult = buildPreviewContextResult(runtime, model);
  const tools = runtime.getTools(model);
  const canonical = runtime.messageHistory.borrowReadOnlyRuntimeEntries();
  const entries = simulateRequestEntries(runtime, {
    entries: [
      ...buildContextHistoryEntries(contextResult),
      ...canonical.slice(countContextPrefixMessages(canonical)),
    ],
    model,
    tools,
  });
  const prepared = prepareRuntimeProviderRequest(runtime, {
    model,
    tools,
    registry: runtime.getToolRegistry(),
    entries,
    applyCacheControl: true,
  });
  return classifyContextComposition({
    sections: contextResult.sections,
    messages: prepared.request.messages,
    sourceEntries: prepared.projection.sourceEntries,
    tools: prepared.request.tools,
    ...collectContextCompositionItems(runtime),
  });
}

/**
 * 按所查模型新建 context 前缀，不写回 runtime：不调 rebuildContextPrefix，
 * 不改 contextBuilder / latestContextBuildResult / 历史，也不把 envInfo 写回 config。
 */
function buildPreviewContextResult(
  runtime: AgentRuntimeInternal,
  model: Model,
): ContextBuildResult {
  const snapshot =
    runtime.contextSourceSnapshot ??
    runtime.createConfigOnlyContextSnapshot(runtime.workingDirectory);
  return runtime
    .createContextBuilderFromSnapshot(snapshot, runtime.memoryRoot, {
      memoryIndexContent: runtime.memoryIndexContent,
      model,
      persistEnvInfo: false,
    })
    .build();
}

/** 请求边界公告，顺序同 turn-loop.ts 的持久化提醒与 ToolSearch 公告。 */
function simulateRequestEntries(
  runtime: AgentRuntimeInternal,
  input: {
    entries: RuntimeMessageEntry[];
    model: Model;
    tools: readonly ModelToolContract[];
  },
): RuntimeMessageEntry[] {
  const { model, tools } = input;
  const entries = input.entries;
  const runtimeModeReminder = buildRuntimeModeReminderBody(
    entries,
    runtime.getMode(),
    runtime.getPlanEnabled(),
  );
  if (runtimeModeReminder)
    entries.push(systemReminderAttachmentEntry("runtime_mode", runtimeModeReminder));
  const outputStyleReminder = buildRuntimeOutputStyleReminderBody(runtime.config.outputStyle);
  if (outputStyleReminder)
    entries.push(systemReminderAttachmentEntry("output_style", outputStyleReminder));
  const toolSearch = buildToolSearchAnnouncement({
    model,
    mode: runtime.config.toolSearch?.mode,
    tools,
    registry: runtime.getToolRegistry(),
    entries,
  });
  if (toolSearch) entries.push(toolSearch);
  return entries;
}
