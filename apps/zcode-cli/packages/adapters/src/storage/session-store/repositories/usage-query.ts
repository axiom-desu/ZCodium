import type { DatabaseSync } from "node:sqlite";
import type {
  AppUsageDayModelRow,
  AppUsageDayRow,
  AppUsageModelRow,
  AppUsageQueryInput,
  AppUsageQueryResult,
  AppUsageToolRow,
  TaskUsageQueryInput,
  TaskUsageQueryResult,
} from "@zcode/contracts";
import { inputSideTokensFromStoredUsage, taskUsageInputBaselineSource } from "./usage-values.js";

export async function queryAppUsage(
  db: DatabaseSync,
  input: AppUsageQueryInput,
): Promise<AppUsageQueryResult> {
  const { since, until, tzOffsetMs } = input;
  const DAY_MS = 86_400_000;

  const totals = db
    .prepare(
      `select
         coalesce(sum(computed_total_tokens), 0) as totalTokens,
         coalesce(sum(input_tokens), 0) as inputTokens,
         coalesce(sum(output_tokens), 0) as outputTokens,
         coalesce(sum(reasoning_tokens), 0) as reasoningTokens,
         coalesce(sum(cache_creation_input_tokens), 0) as cacheCreationTokens,
         coalesce(sum(cache_read_input_tokens), 0) as cacheReadTokens,
         count(*) as modelRequestCount,
         coalesce(sum(case when status = 'error' then 1 else 0 end), 0) as modelErrorCount,
         avg(time_to_first_token_ms) as avgTimeToFirstTokenMs
       from model_usage
       where started_at >= ? and started_at <= ?`,
    )
    .get(since, until) as Record<string, number | null>;

  const turnTotals = db
    .prepare(
      `select
         count(distinct session_id) as totalSessions,
         count(*) as totalTurns,
         avg(case when status = 'completed' then duration_ms else null end) as avgTurnDurationMs
       from turn_usage
       where started_at >= ? and started_at <= ?`,
    )
    .get(since, until) as Record<string, number | null>;
  const longestSession = db
    .prepare(
      `select coalesce(max(sessionDurationMs), 0) as longestSessionMs
       from (
         select coalesce(sum(case when status = 'completed' then duration_ms else 0 end), 0)
           as sessionDurationMs
         from turn_usage
         where started_at >= ? and started_at <= ?
         group by session_id
       )`,
    )
    .get(since, until) as Record<string, number | null>;

  const toolTotals = db
    .prepare(
      `select
         count(*) as toolCallCount,
         coalesce(sum(case when status = 'error' then 1 else 0 end), 0) as toolErrorCount
       from tool_usage
       where started_at >= ? and started_at <= ?`,
    )
    .get(since, until) as Record<string, number>;

  const models = db
    .prepare(
      `select
         model_id as modelId,
         coalesce(sum(computed_total_tokens), 0) as totalTokens,
         coalesce(sum(input_tokens), 0) as inputTokens,
         coalesce(sum(output_tokens), 0) as outputTokens,
         count(*) as requestCount
       from model_usage
       where started_at >= ? and started_at <= ?
       group by model_id
       order by totalTokens desc`,
    )
    .all(since, until) as unknown as AppUsageModelRow[];

  const tools = db
    .prepare(
      `select
         tool_name as toolName,
         count(*) as callCount,
         coalesce(sum(case when status = 'error' then 1 else 0 end), 0) as errorCount,
         avg(duration_ms) as avgDurationMs
       from tool_usage
       where started_at >= ? and started_at <= ?
       group by tool_name
       order by callCount desc`,
    )
    .all(since, until) as unknown as AppUsageToolRow[];

  const days = db
    .prepare(
      `select
         cast((started_at + ?) / ? as integer) as dayIndex,
         coalesce(sum(computed_total_tokens), 0) as totalTokens
       from model_usage
       where started_at >= ? and started_at <= ?
       group by dayIndex`,
    )
    .all(tzOffsetMs, DAY_MS, since, until) as Array<{ dayIndex: number; totalTokens: number }>;

  const turnDays = db
    .prepare(
      `select cast((started_at + ?) / ? as integer) as dayIndex, count(*) as turnCount
       from turn_usage
       where started_at >= ? and started_at <= ?
       group by dayIndex`,
    )
    .all(tzOffsetMs, DAY_MS, since, until) as Array<{ dayIndex: number; turnCount: number }>;

  const toolDays = db
    .prepare(
      `select cast((started_at + ?) / ? as integer) as dayIndex, count(*) as toolCallCount
       from tool_usage
       where started_at >= ? and started_at <= ?
       group by dayIndex`,
    )
    .all(tzOffsetMs, DAY_MS, since, until) as Array<{ dayIndex: number; toolCallCount: number }>;

  // 合并三类按日统计到同一 dayIndex
  const dayMap = new Map<number, AppUsageDayRow>();
  for (const row of days) {
    dayMap.set(row.dayIndex, {
      dayIndex: row.dayIndex,
      totalTokens: Number(row.totalTokens),
      turnCount: 0,
      toolCallCount: 0,
    });
  }
  for (const row of turnDays) {
    const existing = dayMap.get(row.dayIndex) ?? {
      dayIndex: row.dayIndex,
      totalTokens: 0,
      turnCount: 0,
      toolCallCount: 0,
    };
    existing.turnCount = Number(row.turnCount);
    dayMap.set(row.dayIndex, existing);
  }
  for (const row of toolDays) {
    const existing = dayMap.get(row.dayIndex) ?? {
      dayIndex: row.dayIndex,
      totalTokens: 0,
      turnCount: 0,
      toolCallCount: 0,
    };
    existing.toolCallCount = Number(row.toolCallCount);
    dayMap.set(row.dayIndex, existing);
  }

  const dayModels = db
    .prepare(
      `select
         cast((started_at + ?) / ? as integer) as dayIndex,
         model_id as modelId,
         coalesce(sum(computed_total_tokens), 0) as totalTokens
       from model_usage
       where started_at >= ? and started_at <= ?
       group by dayIndex, model_id`,
    )
    .all(tzOffsetMs, DAY_MS, since, until) as unknown as AppUsageDayModelRow[];

  return {
    totals: {
      totalTokens: Number(totals.totalTokens ?? 0),
      inputTokens: Number(totals.inputTokens ?? 0),
      outputTokens: Number(totals.outputTokens ?? 0),
      reasoningTokens: Number(totals.reasoningTokens ?? 0),
      cacheCreationTokens: Number(totals.cacheCreationTokens ?? 0),
      cacheReadTokens: Number(totals.cacheReadTokens ?? 0),
      modelRequestCount: Number(totals.modelRequestCount ?? 0),
      modelErrorCount: Number(totals.modelErrorCount ?? 0),
      avgTimeToFirstTokenMs:
        totals.avgTimeToFirstTokenMs == null ? null : Number(totals.avgTimeToFirstTokenMs),
    },
    turnTotals: {
      totalSessions: Number(turnTotals.totalSessions ?? 0),
      totalTurns: Number(turnTotals.totalTurns ?? 0),
      avgTurnDurationMs:
        turnTotals.avgTurnDurationMs == null ? null : Number(turnTotals.avgTurnDurationMs),
      longestSessionMs: Number(longestSession.longestSessionMs ?? 0),
    },
    toolTotals: {
      toolCallCount: Number(toolTotals.toolCallCount ?? 0),
      toolErrorCount: Number(toolTotals.toolErrorCount ?? 0),
    },
    models: models.map((m) => ({
      modelId: m.modelId ?? null,
      totalTokens: Number(m.totalTokens),
      inputTokens: Number(m.inputTokens),
      outputTokens: Number(m.outputTokens),
      requestCount: Number(m.requestCount),
    })),
    tools: tools.map((t) => ({
      toolName: t.toolName,
      callCount: Number(t.callCount),
      errorCount: Number(t.errorCount),
      avgDurationMs: t.avgDurationMs == null ? null : Number(t.avgDurationMs),
    })),
    days: [...dayMap.values()].sort((a, b) => a.dayIndex - b.dayIndex),
    dayModels: dayModels.map((d) => ({
      dayIndex: Number(d.dayIndex),
      modelId: d.modelId ?? null,
      totalTokens: Number(d.totalTokens),
    })),
  };
}

export async function queryTaskUsage(
  db: DatabaseSync,
  input: TaskUsageQueryInput,
): Promise<TaskUsageQueryResult> {
  const rows = db
    .prepare(
      `select
         id,
         query_source as querySource,
         status,
         input_tokens as inputTokens,
         output_tokens as outputTokens,
         reasoning_tokens as reasoningTokens,
         cache_creation_input_tokens as cacheCreationTokens,
         cache_read_input_tokens as cacheReadTokens,
         computed_total_tokens as computedTotalTokens,
         provider_total_tokens as providerTotalTokens
       from model_usage
       where session_id = ?
       order by started_at asc, id asc`,
    )
    .all(input.sessionID) as Array<{
    cacheCreationTokens: number;
    cacheReadTokens: number;
    computedTotalTokens: number;
    inputTokens: number;
    outputTokens: number;
    providerTotalTokens: number | null;
    querySource: string;
    reasoningTokens: number;
    status: string;
  }>;

  let totalTokens = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;
  let modelErrorCount = 0;
  const inputBaselineBySource: Record<string, number> = {};

  for (const row of rows) {
    const rawTotalTokens = Number(row.providerTotalTokens ?? row.computedTotalTokens ?? 0);
    const inputSideTokens = inputSideTokensFromStoredUsage(row);
    const source = taskUsageInputBaselineSource(row.querySource);
    const incrementalInputTokens =
      source === undefined
        ? inputSideTokens
        : Math.max(0, inputSideTokens - (inputBaselineBySource[source] ?? 0));
    if (source !== undefined) {
      // 压缩会让后续 context input 变小；累计消耗不能因此回扣历史，
      // 但 baseline 必须降到压缩后的值，后续新增轮次才能继续按增量计算。
      inputBaselineBySource[source] = inputSideTokens;
    }

    const nonInputTokens = Math.max(0, rawTotalTokens - inputSideTokens);
    const rowOutputTokens = Number(row.outputTokens ?? 0);
    const rowReasoningTokens = Number(row.reasoningTokens ?? 0);
    totalTokens += incrementalInputTokens + nonInputTokens;
    inputTokens += incrementalInputTokens;
    outputTokens += rowOutputTokens;
    reasoningTokens += rowReasoningTokens;
    if (source === undefined) {
      cacheCreationTokens += Number(row.cacheCreationTokens ?? 0);
      cacheReadTokens += Number(row.cacheReadTokens ?? 0);
    }
    if (row.status === "error") {
      modelErrorCount += 1;
    }
  }

  return {
    sessionID: input.sessionID,
    totalTokens,
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheCreationTokens,
    cacheReadTokens,
    modelRequestCount: rows.length,
    modelErrorCount,
    inputBaselineBySource,
  };
}
