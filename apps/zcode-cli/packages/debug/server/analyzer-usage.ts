import type {
  ContextUsageCategory,
  ContextUsageMessageBreakdown,
  ContextUsageSkillDetail,
  ContextUsageSnapshotView,
  ContextUsageToolDetail,
  TokenConfidence,
  TokenMethod,
} from "../src/shared.js";
import { isRecord, numberValue, stringValue } from "./sources.js";
import { arrayValue } from "./analyzer-values.js";
import type { DbObservation, LoadedObservation, LogRecord } from "./types.js";
import { compareIsoAsc, slug } from "./analyzer-values.js";

export function buildContextUsageSnapshots(
  traceId: string,
  sessions: Set<string>,
  observation: LoadedObservation,
): ContextUsageSnapshotView[] {
  const snapshots: ContextUsageSnapshotView[] = [];

  for (const log of observation.logs.records) {
    if (log.traceId !== traceId || !isContextUsageSnapshotLog(log)) continue;
    const context = log.context ?? {};
    const categories = arrayValue(context.categories)
      .filter(isRecord)
      .map((category, index) => usageCategoryFromRecord(category, index));
    const totalTokens =
      numberValue(context.totalTokens) ??
      categories.reduce((sum, category) => sum + category.tokens, 0);
    const totalChars =
      numberValue(context.totalChars) ??
      categories.reduce((sum, category) => sum + category.chars, 0);
    const categoriesWithPercent = categories.map((category) => ({
      ...category,
      percentTokens:
        numberValue(category.percentTokens) ??
        (totalTokens > 0 ? category.tokens / totalTokens : 0),
    }));

    snapshots.push({
      id: `log:${log.sourcePath}:${log.line}:context-usage`,
      at: log.timestamp,
      traceId: log.traceId,
      sessionId: log.sessionId,
      turnId: log.turnId,
      model: stringValue(context.model),
      totalChars,
      totalTokens,
      tokenMethod: tokenMethodValue(context.tokenMethod),
      confidence: tokenConfidenceValue(context.confidence),
      tokenizer: stringValue(context.tokenizer),
      categories: categoriesWithPercent,
      systemTools: arrayValue(context.systemTools).filter(isRecord).map(usageToolFromRecord),
      mcpTools: arrayValue(context.mcpTools).filter(isRecord).map(usageToolFromRecord),
      skills: arrayValue(context.skills).filter(isRecord).map(usageSkillFromRecord),
      messageBreakdown: arrayValue(context.messageBreakdown)
        .filter(isRecord)
        .map(usageMessageBreakdownFromRecord),
      warnings: arrayValue(context.warnings).filter(
        (warning): warning is string => typeof warning === "string",
      ),
    });
  }

  if (snapshots.length === 0) {
    snapshots.push(...contextUsageSnapshotsFromDb(traceId, sessions, observation.db.records[0]));
  }

  return snapshots.sort((left, right) => compareIsoAsc(left.at, right.at));
}

function contextUsageSnapshotsFromDb(
  traceId: string,
  sessions: Set<string>,
  db?: DbObservation,
): ContextUsageSnapshotView[] {
  if (!db || sessions.size === 0) return [];
  const snapshots: ContextUsageSnapshotView[] = [];

  for (const part of db.parts) {
    if (!sessions.has(part.sessionId) || part.type !== "step-finish") continue;
    const tokens = isRecord(part.data.tokens) ? part.data.tokens : undefined;
    if (!tokens) continue;
    const inputTokens = numberValue(tokens.input) ?? 0;
    if (inputTokens <= 0) continue;

    snapshots.push({
      id: `sqlite:${part.id}:context-usage`,
      at: part.createdAt,
      traceId,
      sessionId: part.sessionId,
      totalChars: 0,
      totalTokens: inputTokens,
      tokenMethod: "provider_usage",
      confidence: "low",
      categories: [
        {
          id: `sqlite-input:${part.id}`,
          name: "模型输入（SQLite 聚合）",
          source: "other",
          chars: 0,
          tokens: inputTokens,
          percentTokens: 1,
          tokenMethod: "provider_usage",
          confidence: "low",
        },
      ],
      systemTools: [],
      mcpTools: [],
      skills: [],
      messageBreakdown: [],
      warnings: [
        "SQLite step-finish 只保存聚合 input token，无法拆分系统提示、技能、工具和消息。",
        "要看真实上下文分块，需要用 dev 运行形态重新运行被测 CLI。",
      ],
    });
  }

  return snapshots;
}

function usageCategoryFromRecord(
  category: Record<string, unknown>,
  index: number,
): ContextUsageCategory {
  const name = stringValue(category.name) ?? `分类 ${index + 1}`;
  return {
    id: stringValue(category.id) ?? slug(`${index}-${name}`),
    name,
    source: contextUsageSourceValue(category.source),
    chars: numberValue(category.chars) ?? 0,
    tokens: numberValue(category.tokens) ?? 0,
    percentTokens: numberValue(category.percentTokens) ?? 0,
    tokenMethod: tokenMethodValue(category.tokenMethod),
    confidence: tokenConfidenceValue(category.confidence),
    tokenizer: stringValue(category.tokenizer),
  };
}

function usageToolFromRecord(tool: Record<string, unknown>): ContextUsageToolDetail {
  return {
    name: stringValue(tool.name) ?? "unknown",
    source: stringValue(tool.source) === "mcp_tool" ? "mcp_tool" : "system_tool",
    chars: numberValue(tool.chars),
    tokens: numberValue(tool.tokens) ?? 0,
    tokenMethod: tokenMethodValue(tool.tokenMethod),
    confidence: tokenConfidenceValue(tool.confidence),
    tokenizer: stringValue(tool.tokenizer),
    readOnly: typeof tool.readOnly === "boolean" ? tool.readOnly : undefined,
    serverName: stringValue(tool.serverName),
    sideEffectScope: stringValue(tool.sideEffectScope),
  };
}

function usageSkillFromRecord(skill: Record<string, unknown>): ContextUsageSkillDetail {
  return {
    name: stringValue(skill.name) ?? "unknown",
    source: stringValue(skill.source),
    scope: stringValue(skill.scope),
    path: stringValue(skill.path),
    chars: numberValue(skill.chars),
    tokens: numberValue(skill.tokens) ?? 0,
    tokenMethod: tokenMethodValue(skill.tokenMethod),
    confidence: tokenConfidenceValue(skill.confidence),
    tokenizer: stringValue(skill.tokenizer),
  };
}

function usageMessageBreakdownFromRecord(
  message: Record<string, unknown>,
): ContextUsageMessageBreakdown {
  return {
    role: stringValue(message.role) ?? "unknown",
    count: numberValue(message.count) ?? 0,
    chars: numberValue(message.chars) ?? 0,
    tokens: numberValue(message.tokens) ?? 0,
    tokenMethod: tokenMethodValue(message.tokenMethod),
    confidence: tokenConfidenceValue(message.confidence),
    tokenizer: stringValue(message.tokenizer),
  };
}

function isContextUsageSnapshotLog(log: LogRecord): boolean {
  return log.message === "Context usage snapshot" || log.event === "context_usage_snapshot";
}

function contextUsageSourceValue(value: unknown): ContextUsageCategory["source"] {
  switch (value) {
    case "system_prompt":
    case "meta_user_context":
    case "skills":
    case "tool_prompt":
    case "system_tool_schemas":
    case "mcp_tool_schemas":
    case "messages":
    case "other":
      return value;
    default:
      return "other";
  }
}

function tokenMethodValue(value: unknown): TokenMethod | undefined {
  switch (value) {
    case "estimated":
    case "provider_count":
    case "proportional_estimate":
    case "provider_usage":
      return value;
    default:
      return undefined;
  }
}

function tokenConfidenceValue(value: unknown): TokenConfidence | undefined {
  switch (value) {
    case "high":
    case "medium":
    case "low":
      return value;
    default:
      return undefined;
  }
}
