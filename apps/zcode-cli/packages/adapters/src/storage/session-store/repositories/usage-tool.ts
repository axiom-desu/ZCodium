import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { ToolUsageRecord } from "@zcode/contracts";
import { pruneUsage } from "./usage-retention.js";
import { boolean, integer, nullableBoolean } from "./usage-values.js";

export async function upsertToolUsage(db: DatabaseSync, input: ToolUsageRecord): Promise<void> {
  db.prepare(
    `
      insert into tool_usage (
        id,
        session_id,
        turn_id,
        trace_id,
        tool_call_id,
        tool_name,
        side_effect_scope,
        read_only,
        destructive,
        approval_status,
        status,
        started_at,
        first_output_at,
        completed_at,
        duration_ms,
        time_to_first_output_ms,
        exit_code,
        output_bytes,
        stdout_bytes,
        stderr_bytes,
        truncated,
        retry_count,
        retryable,
        cancelled_by_user,
        error_type,
        error_code,
        error_message
      )
      values (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?
      )
      on conflict(id) do update set
        session_id = excluded.session_id,
        turn_id = coalesce(excluded.turn_id, tool_usage.turn_id),
        trace_id = coalesce(excluded.trace_id, tool_usage.trace_id),
        tool_call_id = excluded.tool_call_id,
        tool_name = case
          when excluded.tool_name = 'unknown' then tool_usage.tool_name
          else excluded.tool_name
        end,
        side_effect_scope = coalesce(excluded.side_effect_scope, tool_usage.side_effect_scope),
        read_only = coalesce(excluded.read_only, tool_usage.read_only),
        destructive = coalesce(excluded.destructive, tool_usage.destructive),
        approval_status = coalesce(excluded.approval_status, tool_usage.approval_status),
        status = case
          when tool_usage.status in ('completed', 'error', 'cancelled') and excluded.status = 'running'
            then tool_usage.status
          else excluded.status
        end,
        started_at = min(tool_usage.started_at, excluded.started_at),
        first_output_at = coalesce(tool_usage.first_output_at, excluded.first_output_at),
        completed_at = coalesce(excluded.completed_at, tool_usage.completed_at),
        duration_ms = coalesce(excluded.duration_ms, tool_usage.duration_ms),
        time_to_first_output_ms = coalesce(excluded.time_to_first_output_ms, tool_usage.time_to_first_output_ms),
        exit_code = coalesce(excluded.exit_code, tool_usage.exit_code),
        output_bytes = max(tool_usage.output_bytes, excluded.output_bytes),
        stdout_bytes = max(tool_usage.stdout_bytes, excluded.stdout_bytes),
        stderr_bytes = max(tool_usage.stderr_bytes, excluded.stderr_bytes),
        truncated = max(tool_usage.truncated, excluded.truncated),
        retry_count = excluded.retry_count,
        retryable = excluded.retryable,
        cancelled_by_user = excluded.cancelled_by_user,
        error_type = coalesce(excluded.error_type, tool_usage.error_type),
        error_code = coalesce(excluded.error_code, tool_usage.error_code),
        error_message = coalesce(excluded.error_message, tool_usage.error_message)
      `,
  ).run(...toolUsageValues(input));
  await pruneUsage(db);
}

function toolUsageValues(input: ToolUsageRecord): SQLInputValue[] {
  return [
    input.id,
    input.sessionID,
    input.turnID ?? null,
    input.traceID ?? null,
    input.toolCallID,
    input.toolName,
    input.sideEffectScope ?? null,
    nullableBoolean(input.readOnly),
    nullableBoolean(input.destructive),
    input.approvalStatus ?? null,
    input.status,
    input.startedAt,
    input.firstOutputAt ?? null,
    input.completedAt ?? null,
    input.durationMs ?? null,
    input.timeToFirstOutputMs ?? null,
    input.exitCode ?? null,
    integer(input.outputBytes),
    integer(input.stdoutBytes),
    integer(input.stderrBytes),
    boolean(input.truncated),
    integer(input.retryCount),
    boolean(input.retryable),
    boolean(input.cancelledByUser),
    input.errorType ?? null,
    input.errorCode ?? null,
    input.errorMessage ?? null,
  ];
}
