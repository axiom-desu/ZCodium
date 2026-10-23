import type { SessionEvent } from "@zcode/contracts";
import type { ProjectionState } from "./product-projection-state.js";
import type {
  ConversationDelta,
  ConversationRow,
  RunningSubagentSummary,
  SubagentProjectionState,
  SubagentRow,
} from "@zcode/shared/zcode-protocol-v4";
import {
  findRow,
  findSubagentLifecycleRow,
  findSubagentRow,
  mapSubagentStatus,
  ms,
  rowBase,
  stringPayload,
  subagentAgentId,
  turnIdOf,
} from "./product-projection-primitives.js";
import { resumedSubagentBackgroundWorkDelta } from "./product-projection-subagent-tasks.js";

/**
 * Subagent row 与摘要投影在同一个 event transaction 内 materialize。
 * 旧 UI 在 spawn 后另查 session/subagents；7 个并发 child 中查询若恰好落在
 * 最后一个 session 持久化前，就会永久缓存 6，直到切换 Session 才重查。现在 renderer
 * 只消费这里随 row 一起提交的完整态，不再存在事件/查询双时钟。
 */
export function shouldMaterializeSubagentProjection(
  state: ProjectionState,
  reduced: readonly ConversationDelta[],
): boolean {
  // 性能问题根因：cold hydration 曾让 checkpoint 等无关事件也扫描全部历史 rows。
  // 这里只在尚未发布的 batch accumulator 内按 materializer 的真实输入准入；live 与
  // strict fallback 仍走原路径，batch 之后直接写权威 manifest 的 store seed 不受影响。
  if (!state.hydrationAccumulator) return true;

  for (const delta of reduced) {
    switch (delta.op) {
      case "row.appended":
      case "row.upserted":
        if (delta.row.kind === "subagent" || findRow(state, delta.row.rowId)?.kind === "subagent") {
          return true;
        }
        break;
      case "row.delta":
        if (findRow(state, delta.rowId)?.kind === "subagent") return true;
        break;
      case "row.removed":
        // 后缀删除可能同时移除 subagent row；不为判定再预扫描一次 rows。
        return true;
      case "state.updated":
        if (
          delta.patch.pendingInteractions !== undefined ||
          delta.patch.backgroundWorks !== undefined
        ) {
          return true;
        }
        break;
      case "pluginUi.resourceUpdated":
      case "pluginUi.resourceListChanged":
      case "pluginUi.instanceClosed":
      case "pluginUi.appToolCall":
      // 非行 op：只动 workflowRuns 状态键，与 subagent 行投影的输入没有交集。
      case "workflowRun.updated":
      case "workflowRun.removed":
        break;
      default: {
        const exhaustiveDelta: never = delta;
        return exhaustiveDelta;
      }
    }
  }
  return false;
}

export function materializeSubagentProjection(
  state: ProjectionState,
  reduced: readonly ConversationDelta[],
): ConversationDelta[] {
  const previous: SubagentProjectionState = state.snapshot.subagents ?? {
    revision: 0,
    childSessionIds: [],
    running: [],
    endedTotal: 0,
  };
  const previousRunningById = new Map(previous.running.map((item) => [item.childSessionId, item]));
  const latestRowByChildId = new Map<string, SubagentRow>();
  const collectSubagentRow = (row: SubagentRow | null): void => {
    if (row?.childSessionId && !state.invalidSubagentChildSessionIds.has(row.childSessionId)) {
      latestRowByChildId.set(row.childSessionId, row);
    }
  };
  // 性能问题根因：旧实现先复制完整 rows 数组，再扫描所有普通 conversation rows。
  // subagentRowIdByAgentId 已是 reducer 查找用的派生索引；这里按 rowId 去重，并通过
  // rowIndexById 恢复当前时间线顺序；row.removed 应用后会清理已失效的 alias。
  const currentRowIds = new Set(state.subagentRowIdByAgentId.values());
  for (const delta of reduced) {
    if (delta.op === "row.upserted") {
      if (delta.row.kind === "subagent" || findRow(state, delta.row.rowId)?.kind === "subagent") {
        currentRowIds.add(delta.row.rowId);
      }
    } else if (delta.op === "row.delta" && findRow(state, delta.rowId)?.kind === "subagent") {
      currentRowIds.add(delta.rowId);
    }
  }
  const currentRows: Array<{ rowIndex: number; row: ConversationRow }> = [];
  for (const rowId of currentRowIds) {
    const rowIndex = state.rowIndexById.get(rowId);
    const row = rowIndex === undefined ? undefined : state.snapshot.rows.window[rowIndex];
    if (rowIndex !== undefined && row !== undefined) currentRows.push({ rowIndex, row });
  }
  currentRows.sort((left, right) => left.rowIndex - right.rowIndex);
  for (const { row } of currentRows) {
    collectSubagentRow(prospectiveSubagentRow(row, reduced, 0));
  }
  for (let index = 0; index < reduced.length; index += 1) {
    const delta = reduced[index]!;
    if (delta.op !== "row.appended") continue;
    collectSubagentRow(prospectiveSubagentRow(delta.row, reduced, index + 1));
  }

  let pendingInteractions = state.snapshot.pendingInteractions;
  let backgroundWorks = state.snapshot.backgroundWorks;
  for (const delta of reduced) {
    if (delta.op !== "state.updated") continue;
    if (delta.patch.pendingInteractions !== undefined) {
      pendingInteractions = delta.patch.pendingInteractions;
    }
    if (delta.patch.backgroundWorks !== undefined) {
      backgroundWorks = delta.patch.backgroundWorks;
    }
  }
  const waitingChildIds = new Set<string>();
  // workspace-hook-trust 新增的 hook review 交互 payload 没有 origin 字段，跳过守卫避免误读。
  for (const interaction of pendingInteractions) {
    if (!("origin" in interaction.payload)) continue;
    const origin = interaction.payload.origin;
    if (origin?.kind === "subagent") waitingChildIds.add(origin.childSessionId);
  }
  const blockedChildIds = new Set(
    backgroundWorks.flatMap((work) =>
      work.kind === "subagent" && work.status === "running" && work.blocked && work.childSessionId
        ? [work.childSessionId]
        : [],
    ),
  );

  const childSessionIds = [...latestRowByChildId.keys()];
  const running: RunningSubagentSummary[] = [];
  for (const [childSessionId, row] of latestRowByChildId) {
    if (row.status !== "running") continue;
    const previousItem = previousRunningById.get(childSessionId);
    const title = previousItem?.title || row.summaryText.trim() || row.subagentType;
    running.push({
      childSessionId,
      agentId: row.entityId,
      ...(row.parentToolCallId ? { toolCallId: row.parentToolCallId } : {}),
      subagentType: row.subagentType,
      title,
      status: waitingChildIds.has(childSessionId)
        ? "waiting"
        : blockedChildIds.has(childSessionId)
          ? "blocked"
          : "running",
      ...(row.startedAt !== undefined ? { startedAt: row.startedAt } : {}),
    });
  }
  running.sort(
    (left, right) =>
      (right.startedAt ?? 0) - (left.startedAt ?? 0) ||
      right.childSessionId.localeCompare(left.childSessionId),
  );
  const endedTotal = childSessionIds.length - running.length;
  const semanticState = { childSessionIds, running, endedTotal };
  if (
    JSON.stringify(semanticState) ===
    JSON.stringify({
      childSessionIds: previous.childSessionIds,
      running: previous.running,
      endedTotal: previous.endedTotal,
    })
  ) {
    return [];
  }
  return [
    {
      op: "state.updated",
      patch: {
        subagents: {
          revision: previous.revision + 1,
          ...semanticState,
        },
      },
    },
  ];
}

function prospectiveSubagentRow(
  row: ConversationRow,
  reduced: readonly ConversationDelta[],
  startIndex: number,
): SubagentRow | null {
  let prospective: ConversationRow | null = row;
  for (let index = startIndex; index < reduced.length && prospective; index += 1) {
    const delta = reduced[index]!;
    switch (delta.op) {
      case "row.appended":
      case "state.updated":
      case "pluginUi.resourceUpdated":
      case "pluginUi.resourceListChanged":
      case "pluginUi.instanceClosed":
      case "pluginUi.appToolCall":
      // 非行 op：改不了这一行的 prospective 形态。
      case "workflowRun.updated":
      case "workflowRun.removed":
        break;
      case "row.upserted":
        if (delta.row.rowId === prospective.rowId) prospective = delta.row;
        break;
      case "row.delta":
        if (
          delta.rowId === prospective.rowId &&
          delta.path === "summaryText" &&
          prospective.kind === "subagent"
        ) {
          prospective = {
            ...prospective,
            summaryText: prospective.summaryText + delta.append,
          };
        }
        break;
      case "row.removed":
        if (prospective.rowId >= delta.fromRowId) prospective = null;
        break;
      default: {
        const exhaustiveDelta: never = delta;
        return exhaustiveDelta;
      }
    }
  }
  return prospective?.kind === "subagent" ? prospective : null;
}

// ── subagent 行镜像──
// schema/UI 已有 subagent row，但旧 reducer 未消费 Subagent* 事件；
// cold hydration 即使合成事件也无法恢复下钻行。这里让 live/cold 共用同一状态机。

export function onSubagentSpawned(
  state: ProjectionState,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as Record<string, unknown>;
  const agentId = subagentAgentId(payload, event);
  const existing = findSubagentLifecycleRow(state, agentId, payload, event);
  if (existing) state.subagentRowIdByAgentId.set(agentId, existing.rowId);
  const childSessionId = stringPayload(payload, "childSessionId");
  const parentToolCallId = stringPayload(payload, "parentToolCallId");
  const resumedBackgroundWork = resumedSubagentBackgroundWorkDelta(
    state,
    event,
    payload,
    agentId,
    childSessionId,
  );
  if (
    existing?.status === "running" &&
    (!childSessionId || childSessionId === existing.childSessionId) &&
    (!parentToolCallId || parentToolCallId === existing.parentToolCallId) &&
    (payload.background !== true || existing.backgrounded === true)
  ) {
    return resumedBackgroundWork ? [resumedBackgroundWork] : [];
  }
  if (existing) {
    const row: SubagentRow = {
      ...existing,
      status: "running",
      summaryText:
        stringPayload(payload, "description") ??
        stringPayload(payload, "prompt") ??
        existing.summaryText,
      // resume 事件携带的是 SendMessage call id，但 parentToolCallId 是 row 的创建锚点；
      // 已存在的锚点不能作为生命周期字段被覆盖，否则 UI 无法再关联原 Agent 行。
      ...(!existing.parentToolCallId && parentToolCallId ? { parentToolCallId } : {}),
      ...(childSessionId ? { childSessionId } : {}),
      ...(payload.background === true ? { backgrounded: true as const } : {}),
      ...(payload.background === true ? { workId: agentId } : {}),
      startedAt: ms(event),
    };
    delete row.endedAt;
    return [{ op: "row.upserted", row }, ...(resumedBackgroundWork ? [resumedBackgroundWork] : [])];
  }
  const row: SubagentRow = {
    ...rowBase(state, event, turnIdOf(state, event), agentId),
    kind: "subagent",
    ...(stringPayload(payload, "parentToolCallId")
      ? { parentToolCallId: stringPayload(payload, "parentToolCallId") }
      : {}),
    subagentType: stringPayload(payload, "agentType") ?? "subagent",
    status: "running",
    summaryText:
      stringPayload(payload, "description") ??
      stringPayload(payload, "summaryText") ??
      stringPayload(payload, "prompt") ??
      "",
    ...(stringPayload(payload, "childSessionId")
      ? { childSessionId: stringPayload(payload, "childSessionId") }
      : {}),
    ...(payload.background === true ? { backgrounded: true as const } : {}),
    ...(payload.background === true ? { workId: agentId } : {}),
    startedAt: ms(event),
  };
  state.subagentRowIdByAgentId.set(agentId, row.rowId);
  return [{ op: "row.appended", row }, ...(resumedBackgroundWork ? [resumedBackgroundWork] : [])];
}

export function onSubagentMessage(
  state: ProjectionState,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as Record<string, unknown>;
  const row = findSubagentRow(state, subagentAgentId(payload, event));
  const append =
    stringPayload(payload, "summaryText") ??
    stringPayload(payload, "text") ??
    stringPayload(payload, "message");
  if (!row || !append) return [];
  return [{ op: "row.delta", rowId: row.rowId, path: "summaryText", append }];
}

export function onSubagentStopped(
  state: ProjectionState,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as Record<string, unknown>;
  const agentId = subagentAgentId(payload, event);
  const existing = findSubagentLifecycleRow(state, agentId, payload, event);
  const parentToolCallId = stringPayload(payload, "parentToolCallId");
  const status = mapSubagentStatus(stringPayload(payload, "status"));
  const summaryText =
    stringPayload(payload, "summaryText") ??
    stringPayload(payload, "result") ??
    stringPayload(payload, "error") ??
    stringPayload(payload, "description") ??
    existing?.summaryText ??
    "";
  const row: SubagentRow = existing
    ? {
        ...existing,
        status,
        summaryText,
        endedAt: ms(event),
        // resumed child 的终态同样属于原 Agent row，只在旧 row 缺失锚点时补齐。
        ...(!existing.parentToolCallId && parentToolCallId ? { parentToolCallId } : {}),
        ...(stringPayload(payload, "childSessionId")
          ? { childSessionId: stringPayload(payload, "childSessionId") }
          : {}),
      }
    : {
        ...rowBase(state, event, turnIdOf(state, event), agentId),
        kind: "subagent",
        ...(stringPayload(payload, "parentToolCallId")
          ? {
              parentToolCallId: stringPayload(payload, "parentToolCallId"),
            }
          : {}),
        subagentType: stringPayload(payload, "agentType") ?? "subagent",
        status,
        summaryText,
        ...(stringPayload(payload, "childSessionId")
          ? { childSessionId: stringPayload(payload, "childSessionId") }
          : {}),
        ...(payload.background === true ? { backgrounded: true as const } : {}),
        ...(payload.background === true ? { workId: agentId } : {}),
        endedAt: ms(event),
      };
  state.subagentRowIdByAgentId.set(agentId, row.rowId);
  return [{ op: existing ? "row.upserted" : "row.appended", row }];
}
