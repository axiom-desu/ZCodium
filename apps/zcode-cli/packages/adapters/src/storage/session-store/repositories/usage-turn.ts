import type { DatabaseSync } from "node:sqlite";
import type { TurnUsageRecord } from "@zcode/contracts";
import { pruneUsage } from "./usage-retention.js";
import { integer, boolean } from "./usage-values.js";

export async function upsertTurnUsage(db: DatabaseSync, input: TurnUsageRecord): Promise<void> {
  db.prepare(
    `
      insert into turn_usage (
        session_id,
        turn_id,
        trace_id,
        user_message_id,
        status,
        started_at,
        first_model_start_at,
        first_token_at,
        completed_at,
        duration_ms,
        time_to_first_token_ms,
        model_request_count,
        model_retry_count,
        tool_call_count,
        tool_error_count,
        input_tokens,
        output_tokens,
        reasoning_tokens,
        cache_creation_input_tokens,
        cache_read_input_tokens,
        computed_total_tokens,
        retryable,
        cancelled_by_user,
        context_exceeded,
        error_type,
        error_code
      )
      values (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?
      )
      on conflict(session_id, turn_id) do update set
        trace_id = coalesce(excluded.trace_id, turn_usage.trace_id),
        user_message_id = coalesce(excluded.user_message_id, turn_usage.user_message_id),
        status = excluded.status,
        started_at = min(turn_usage.started_at, excluded.started_at),
        first_model_start_at = coalesce(turn_usage.first_model_start_at, excluded.first_model_start_at),
        first_token_at = coalesce(turn_usage.first_token_at, excluded.first_token_at),
        completed_at = coalesce(excluded.completed_at, turn_usage.completed_at),
        duration_ms = coalesce(excluded.duration_ms, turn_usage.duration_ms),
        time_to_first_token_ms = coalesce(excluded.time_to_first_token_ms, turn_usage.time_to_first_token_ms),
        model_request_count = excluded.model_request_count,
        model_retry_count = excluded.model_retry_count,
        tool_call_count = excluded.tool_call_count,
        tool_error_count = excluded.tool_error_count,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        reasoning_tokens = excluded.reasoning_tokens,
        cache_creation_input_tokens = excluded.cache_creation_input_tokens,
        cache_read_input_tokens = excluded.cache_read_input_tokens,
        computed_total_tokens = excluded.computed_total_tokens,
        retryable = excluded.retryable,
        cancelled_by_user = excluded.cancelled_by_user,
        context_exceeded = excluded.context_exceeded,
        error_type = coalesce(excluded.error_type, turn_usage.error_type),
        error_code = coalesce(excluded.error_code, turn_usage.error_code)
      `,
  ).run(
    input.sessionID,
    input.turnID,
    input.traceID ?? null,
    input.userMessageID ?? null,
    input.status,
    input.startedAt,
    input.firstModelStartAt ?? null,
    input.firstTokenAt ?? null,
    input.completedAt ?? null,
    input.durationMs ?? null,
    input.timeToFirstTokenMs ?? null,
    integer(input.modelRequestCount),
    integer(input.modelRetryCount),
    integer(input.toolCallCount),
    integer(input.toolErrorCount),
    integer(input.inputTokens),
    integer(input.outputTokens),
    integer(input.reasoningTokens),
    integer(input.cacheCreationInputTokens),
    integer(input.cacheReadInputTokens),
    integer(input.computedTotalTokens),
    boolean(input.retryable),
    boolean(input.cancelledByUser),
    boolean(input.contextExceeded),
    input.errorType ?? null,
    input.errorCode ?? null,
  );
  await pruneUsage(db);
}
