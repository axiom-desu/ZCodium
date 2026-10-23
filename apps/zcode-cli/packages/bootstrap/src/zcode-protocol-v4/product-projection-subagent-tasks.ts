import type { DynamicWorkflowRunProgressPayload, SessionEvent } from "@zcode/contracts";
import { resolveZCodeBackgroundTaskControlKind } from "@zcode/shared";
import type { ProjectionState } from "./product-projection-state.js";
import type {
  BackgroundWorkSummary,
  ConversationDelta,
  WorkflowRunProgressEnvelope,
} from "@zcode/shared/zcode-protocol-v4";
import { diffWorkflowRunsState, reduceWorkflowRunsState } from "@zcode/shared/zcode-protocol-v4";
import { ms, stringPayload } from "./product-projection-primitives.js";

export function resumedSubagentBackgroundWorkDelta(
  state: Pick<ProjectionState, "snapshot">,
  event: SessionEvent,
  payload: Record<string, unknown>,
  agentId: string,
  childSessionId: string | undefined,
): ConversationDelta | undefined {
  if (payload.background !== true || payload.resumed !== true || !childSessionId) {
    return undefined;
  }

  // SendMessage resume 直接进入 subagent port，不经过 Agent tool executor，
  // 因而不会产生 tracker 的 BackgroundTaskStarted。SubagentSpawned 已是单一启动事实，
  // 这里在同一次 V4 transaction 内补齐可取消 work，避免再引入第二个可失败事件。
  const previous = state.snapshot.backgroundWorks;
  const existing = previous.find((work) => work.workId === agentId);
  const title =
    stringPayload(payload, "description") ??
    stringPayload(payload, "prompt") ??
    existing?.title ??
    agentId;
  if (
    existing?.status === "running" &&
    existing.kind === "subagent" &&
    existing.title === title &&
    existing.childSessionId === childSessionId &&
    existing.cancellable === true
  ) {
    return undefined;
  }
  const next: BackgroundWorkSummary = {
    workId: agentId,
    kind: "subagent",
    title,
    status: "running",
    startedAt: ms(event),
    cancellable: true,
    anchorRowId: existing?.anchorRowId ?? null,
    childSessionId,
  };
  const backgroundWorks = existing
    ? previous.map((work) => (work.workId === agentId ? next : work))
    : [...previous, next];
  return { op: "state.updated", patch: { backgroundWorks } };
}

// cancelBackgroundWork：后台任务生命周期（BackgroundTaskStarted/Updated/Completed）
// → 维护 snapshot.backgroundWorks（后台工作面读它渲染 + cancel 入口）。
// taskId≡workId 无需翻译；status 归一到 summary 的 4 值封闭枚举。
export function onBackgroundTaskLifecycle(
  state: Pick<ProjectionState, "snapshot">,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as {
    taskId?: string;
    toolName?: string;
    taskKind?: string;
    command?: string;
    description?: string;
    status?: string;
    cancellable?: boolean;
    blocked?: boolean;
    childSessionId?: string;
  };
  const workId = payload.taskId;
  if (!workId) return [];
  const prev = state.snapshot.backgroundWorks;
  const existing = prev.find((work) => work.workId === workId);
  const legacyKind = resolveZCodeBackgroundTaskControlKind(payload);
  // 新事件使用 runtime 的显式 taskKind；旧事件统一走 shared resolver，
  // 不能再在 reducer 内散落 Agent/Task/subagent 字符串分支。
  // "workflow" 是 workflow run（此前错标成 bash）；legacy resolver 里没有对应值，因为
  // legacy `Workflow` 工具刻意仍归 bash——两者是不同的东西，共用类别会让面板混在一起。
  const kind: BackgroundWorkSummary["kind"] =
    payload.taskKind === "subagent"
      ? "subagent"
      : payload.taskKind === "bash"
        ? "bash"
        : payload.taskKind === "workflow"
          ? "workflow"
          : legacyKind === "agent"
            ? "subagent"
            : legacyKind === "bash"
              ? "bash"
              : (existing?.kind ?? "bash");
  // 事件 status（running/completed/failed/timed_out/cancelled/spawn_error/lost）
  // → summary status（running/resultPending/failed/cancelled）。
  const rawStatus = payload.status ?? "running";
  const status: "running" | "resultPending" | "failed" | "cancelled" =
    rawStatus === "running"
      ? "running"
      : rawStatus === "cancelled"
        ? "cancelled"
        : rawStatus === "completed"
          ? "resultPending"
          : "failed";
  const title =
    payload.description?.trim() ||
    payload.command?.trim() ||
    existing?.title ||
    payload.toolName ||
    workId;
  const next: BackgroundWorkSummary = {
    workId,
    kind,
    title,
    status,
    startedAt: existing?.startedAt ?? ms(event),
    ...(status === "running" ? {} : { endedAt: ms(event) }),
    ...(typeof payload.cancellable === "boolean"
      ? { cancellable: payload.cancellable }
      : existing?.cancellable !== undefined
        ? { cancellable: existing.cancellable }
        : {}),
    ...(typeof payload.blocked === "boolean"
      ? { blocked: payload.blocked }
      : existing?.blocked !== undefined
        ? { blocked: existing.blocked }
        : {}),
    anchorRowId: existing?.anchorRowId ?? null,
    ...(payload.childSessionId
      ? { childSessionId: payload.childSessionId }
      : existing?.childSessionId
        ? { childSessionId: existing.childSessionId }
        : {}),
  };
  // 幂等：内容无变化不产 delta。
  if (
    existing &&
    existing.status === next.status &&
    existing.title === next.title &&
    existing.kind === next.kind &&
    existing.cancellable === next.cancellable &&
    existing.blocked === next.blocked &&
    existing.childSessionId === next.childSessionId
  ) {
    return [];
  }
  const backgroundWorks = existing
    ? prev.map((work) => (work.workId === workId ? next : work))
    : [...prev, next];
  return [{ op: "state.updated", patch: { backgroundWorks } }];
}

// ── dwf 实时运行态：DynamicWorkflowRunProgress → workflowRuns 状态键 ──
// 一条引擎 RunEvent 一条会话事件，归约成键级整体替换的权威态。走 reducer 而不是侧通道，
// 所以持久、可回放、冷恢复免费（先例：subagents 键）。
//
// 归约本体在 @zcode/shared 的 workflow-runs-reducer（与状态 schema 同居）：TUI 镜像要用
// 同一份归约，两处各写一份就是两个时钟。
// 留在这里的只有投影的非纯部分——从事件信封取载荷、把新旧状态之差发成键级增量。
export function onDynamicWorkflowRunProgress(
  state: Pick<ProjectionState, "snapshot">,
  event: SessionEvent,
): ConversationDelta[] {
  // 先转 contracts 的有界 payload、再赋给 shared 的结构化入参：这行赋值就是"两边形状不漂移"
  // 的编译期闸（shared 不得反向依赖 contracts，所以入参类型只能结构化定义）。
  const envelope: WorkflowRunProgressEnvelope = event.payload as DynamicWorkflowRunProgressPayload;
  const prior = state.snapshot.workflowRuns;
  const workflowRuns = reduceWorkflowRunsState(prior, envelope);
  // null = 语义无变化（无效事件或同一条事件重放）：不产 delta，revision 不抬。
  if (workflowRuns === null) return [];
  // 发**差**而不是整键：一条引擎事件只动一个节点，整键重发是每事件 O(N) 字节、一条 run
  // 全程 O(N²)（workflow-runs-delta.ts 的文件头讲了这笔账怎么变成节点上界和 UI 卡死的）。
  // `applyAll(prior, diff(prior, next))` 与 next **逐字节**一致是增量协议的契约，
  // 所以 applyEventInternal 把这串 delta 应用回去之后，state.snapshot.workflowRuns 仍是 next。
  return diffWorkflowRunsState(prior, workflowRuns);
}
