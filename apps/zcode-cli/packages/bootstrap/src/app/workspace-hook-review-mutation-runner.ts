import { SessionEventType, type WorkspaceHookBundleSnapshot } from "@zcode/contracts";
import type {
  WorkspaceHookReviewFlow,
  WorkspaceHookRuntimeAdmissionPort,
  WorkspaceHookSnapshotEvaluation,
  WorkspaceHookReviewTarget,
  WorkspaceHookTrustCoordinator,
} from "@zcode/core";
import { createWorkspaceHookTrustRecords } from "@zcode/core";
import type {
  WorkspaceHookReviewRequestPayload,
  WorkspaceHookTrustRevokeTarget,
} from "@zcode/shared/zcode-protocol-v4";
import type { WorkspaceHookReviewCommandResult } from "./workspace-hook-review-types.js";
import {
  buildWorkspaceHookReviewRequest,
  toWorkspaceHookReviewTarget,
} from "./workspace-hook-review-request.js";
import type { WorkspaceHookTrustStoreMutationPort } from "./workspace-hook-review-types.js";
import type { WorkspaceHookReviewHostPort } from "./workspace-hook-review-types.js";

interface WorkspaceHookMutationRunnerPorts {
  admission: WorkspaceHookRuntimeAdmissionPort;
  appVersion?: string;
  coordinator: WorkspaceHookTrustCoordinator;
  host: WorkspaceHookReviewHostPort;
  now: () => number;
  store: Promise<WorkspaceHookTrustStoreMutationPort>;
}

/** 持久信任写入只由 controller 的 mutation 队列串行调用，runner 不持有第二份 queue。 */
export async function applyWorkspaceHookPersistentTrust(
  ports: WorkspaceHookMutationRunnerPorts,
  reviewItemIds: readonly string[],
): Promise<{ grantedRecordCount?: number }> {
  const snapshot = ports.admission.getCurrentSnapshot();
  ports.coordinator.assertPersistentTrustMutationAllowed(snapshot.workspaceIdentity);
  const records = createWorkspaceHookTrustRecords({
    snapshot,
    reviewItemIds,
    grantedAt: new Date(ports.now()).toISOString(),
    ...(ports.appVersion ? { appVersion: ports.appVersion } : {}),
  });
  const file = await (await ports.store).grant(records);
  ports.coordinator.replacePersistentTrustRecords(file.records, {
    status: "ok",
  });
  return { grantedRecordCount: records.length };
}

/** pendingCount 与 admission 同源，mutation 完成后重发；投影据此清空提示条。 */
export async function emitWorkspaceHookAdmissionUpdated(
  ports: WorkspaceHookMutationRunnerPorts,
): Promise<void> {
  const snapshot = ports.admission.getCurrentSnapshot();
  const evaluation = ports.coordinator.evaluateSnapshot({ snapshot });
  const pendingCount = evaluation.items.filter(
    (item) => item.configuredEnabled && item.admissionClass === "pending",
  ).length;
  await ports.host.emit({
    type: SessionEventType.WorkspaceHookAdmissionUpdated,
    payload: {
      pendingCount,
      bundleDigest: snapshot.bundleDigest,
      ...(snapshot.workspaceIdentity ? { workspaceIdentity: snapshot.workspaceIdentity } : {}),
    },
  });
}

interface OpenReviewFlowPorts {
  coordinator: WorkspaceHookTrustCoordinator;
  openOrReuseFlow(
    snapshot: WorkspaceHookBundleSnapshot,
    evaluation: WorkspaceHookSnapshotEvaluation,
  ): Promise<WorkspaceHookReviewFlow>;
  superviseFlow(flow: WorkspaceHookReviewFlow): Promise<void>;
}

/** revoke 之后没有 pending flow 时重开；无待审项则安全 no-op。 */
export async function openWorkspaceHookReviewFlowForNewPendingItems(
  ports: OpenReviewFlowPorts,
  snapshot: WorkspaceHookBundleSnapshot,
): Promise<WorkspaceHookReviewFlow | undefined> {
  const evaluation = ports.coordinator.evaluateSnapshot({
    snapshot,
  });
  const hasPending = evaluation.items.some((item) => item.admissionClass === "pending");
  if (!hasPending) return undefined;
  const flow = await ports.openOrReuseFlow(snapshot, evaluation);
  // 必须监管：否则该 flow 超时后静默死亡，面板永久失效（见 controller.superviseFlow 注释）。
  // 这里刻意不 await——revoke 命令不能被 10 分钟的审核 deadline 阻塞；
  // catch 兜底避免未处理拒绝，flow 终结本身不产生需要向调用方冒泡的错误。
  void ports.superviseFlow(flow).catch(() => undefined);
  return flow;
}

interface RefreshPendingFlowPorts {
  buildRequest(
    snapshot: WorkspaceHookBundleSnapshot,
    evaluation: WorkspaceHookSnapshotEvaluation,
    flow: { reviewFlowId: string; generation: number },
  ): WorkspaceHookReviewRequestPayload;
  closeWithoutDecision(target: WorkspaceHookReviewTarget): void;
  coordinator: WorkspaceHookTrustCoordinator;
  diagnostics: {
    requestCreated(request: WorkspaceHookReviewRequestPayload): void;
    superseded(request: WorkspaceHookReviewRequestPayload): void;
  };
  getCurrentFlow(sessionId: string): WorkspaceHookReviewFlow | undefined;
  host: WorkspaceHookReviewHostPort;
  openReviewFlowForNewPendingItems(
    snapshot: WorkspaceHookBundleSnapshot,
  ): Promise<WorkspaceHookReviewFlow | undefined>;
  sessionId: string;
  setGeneration(generation: number): void;
  supersede(
    target: WorkspaceHookReviewTarget,
    request: WorkspaceHookReviewRequestPayload,
  ): WorkspaceHookReviewFlow;
}

export async function refreshWorkspaceHookPendingFlow(
  ports: RefreshPendingFlowPorts,
  snapshot: WorkspaceHookBundleSnapshot,
): Promise<WorkspaceHookReviewFlow | undefined> {
  const current = ports.getCurrentFlow(ports.sessionId);
  if (!current || current.state.state !== "pending") {
    // 无 pending flow 时直接返回会让
    // 「授权 → review resolved → 撤销」之后，当前会话再没有任何重新授权入口，
    // 用户只能新建对话。
    //
    // revoke 的语义是 revoked → admission=pending，本就应重新征询，
    // 因此这里在确实产生了待审项时开启新 flow：不新增「直接授予信任」的旁路，
    // 授权仍只能经当前不可变 review 绑定的行内按钮完成。
    return await ports.openReviewFlowForNewPendingItems(snapshot);
  }
  const target = toWorkspaceHookReviewTarget(current.request);
  const evaluation = ports.coordinator.evaluateSnapshot({ snapshot });
  const replacement = ports.buildRequest(snapshot, evaluation, {
    reviewFlowId: current.request.reviewFlowId,
    generation: current.request.generation + 1,
  });
  const nextFlow = ports.supersede(target, replacement);
  ports.diagnostics.superseded(replacement);
  ports.setGeneration(replacement.generation);
  await ports.host.emit({
    type: SessionEventType.WorkspaceHookReviewSuperseded,
    payload: {
      interactionId: current.request.interactionId,
      supersededByInteractionId: replacement.interactionId,
    },
  });
  ports.diagnostics.requestCreated(replacement);
  await ports.host.emit({
    type: SessionEventType.WorkspaceHookReviewRequested,
    payload: { request: replacement },
  });
  if (replacement.summary.pendingCount === 0) {
    ports.closeWithoutDecision(toWorkspaceHookReviewTarget(replacement));
    await ports.host.emit({
      type: SessionEventType.WorkspaceHookReviewSettled,
      payload: {
        interactionId: replacement.interactionId,
        state: "resolved",
      },
    });
  }
  return nextFlow;
}

interface BuildReviewRequestPorts {
  createId: () => string;
  host: WorkspaceHookReviewHostPort;
  now: () => number;
  sessionId: string;
}

export function buildWorkspaceHookReviewRequestPayload(
  ports: BuildReviewRequestPorts,
  snapshot: WorkspaceHookBundleSnapshot,
  evaluation: WorkspaceHookSnapshotEvaluation,
  flow: { reviewFlowId: string; generation: number },
): WorkspaceHookReviewRequestPayload {
  return buildWorkspaceHookReviewRequest({
    snapshot,
    evaluation,
    ...flow,
    sessionId: ports.sessionId,
    host: ports.host,
    now: ports.now,
    createId: ports.createId,
  });
}

interface OpenOrReuseFlowPorts extends BuildReviewRequestPorts {
  diagnostics: {
    requestCreated(request: WorkspaceHookReviewRequestPayload): void;
  };
  getGeneration(): number;
  getReviewFlowId(): string | undefined;
  open(request: WorkspaceHookReviewRequestPayload): WorkspaceHookReviewFlow;
  setGeneration(generation: number): void;
  setReviewFlowId(reviewFlowId: string): void;
  getCurrentFlow(sessionId: string): WorkspaceHookReviewFlow | undefined;
}

export async function openOrReuseWorkspaceHookReviewFlow(
  ports: OpenOrReuseFlowPorts,
  snapshot: WorkspaceHookBundleSnapshot,
  evaluation: WorkspaceHookSnapshotEvaluation,
): Promise<WorkspaceHookReviewFlow> {
  const current = ports.getCurrentFlow(ports.sessionId);
  if (
    current?.state.state === "pending" &&
    current.request.bundleDigest === snapshot.bundleDigest
  ) {
    return current;
  }
  const reviewFlowId = ports.getReviewFlowId() ?? `workspace-hook-review:${ports.createId()}`;
  ports.setReviewFlowId(reviewFlowId);
  const request = buildWorkspaceHookReviewRequestPayload(ports, snapshot, evaluation, {
    reviewFlowId,
    generation: ports.getGeneration() + 1,
  });
  ports.setGeneration(request.generation);
  const flow = ports.open(request);
  ports.diagnostics.requestCreated(request);
  await ports.host.emit({
    type: SessionEventType.WorkspaceHookReviewRequested,
    payload: { request },
  });
  return flow;
}

interface RequestReviewPorts {
  admission: WorkspaceHookRuntimeAdmissionPort;
  coordinator: WorkspaceHookTrustCoordinator;
  openOrReuseFlow(
    snapshot: WorkspaceHookBundleSnapshot,
    evaluation: WorkspaceHookSnapshotEvaluation,
  ): Promise<WorkspaceHookReviewFlow>;
  superviseFlow(flow: WorkspaceHookReviewFlow): Promise<void>;
}

/** 软门禁：按需开审核 flow；无 pending 项时为安全 no-op。 */
export async function requestWorkspaceHookReview(
  ports: RequestReviewPorts,
  target: { workspaceIdentity: string; bundleDigest: string },
): Promise<WorkspaceHookReviewCommandResult> {
  const snapshot = ports.admission.getCurrentSnapshot();
  if (
    target.workspaceIdentity !== snapshot.workspaceIdentity ||
    target.bundleDigest !== snapshot.bundleDigest
  ) {
    return {
      accepted: false,
      reasonCode: "workspace_hooks_snapshot_mismatch" as const,
    };
  }
  const evaluation = ports.coordinator.evaluateSnapshot({ snapshot });
  // 旧实现只把 configuredEnabled=true 的 pending 当成可审核项，导致
  // Settings 把未信任开关锁定后形成死锁——disabled Hook 不会运行、不会触发 Banner，
  // 也永远无法预先建立 Trust。配置 gate 与 Trust 正交；review request 本就携带全部
  // snapshot items，因此按 admissionClass 判断即可，disabled item 信任后仍不会运行。
  const hasPending = evaluation.items.some((item) => item.admissionClass === "pending");
  if (!hasPending) {
    if (evaluation.items.some((item) => item.trustState === "blocked_policy")) {
      return {
        accepted: false,
        reasonCode: "workspace_hooks_blocked_by_policy" as const,
      };
    }
    if (evaluation.storeStatus === "corrupt") {
      return {
        accepted: false,
        reasonCode: "workspace_hooks_trust_store_corrupt" as const,
      };
    }
    // 无待审项:安全 no-op
    return { accepted: true, reviewItemIds: [] };
  }
  const flow = await ports.openOrReuseFlow(snapshot, evaluation);
  void ports.superviseFlow(flow).catch(() => undefined);
  return { accepted: true, reviewItemIds: [] };
}

/** 同一 flow 只监管一次；WeakMap 归 controller，runner 不持有第二份 flow 状态。 */
export function getOrCreateWorkspaceHookSupervision(
  supervisedFlows: WeakMap<WorkspaceHookReviewFlow, Promise<void>>,
  flow: WorkspaceHookReviewFlow,
  create: () => Promise<void>,
): Promise<void> {
  const existing = supervisedFlows.get(flow);
  if (existing) return existing;
  const supervision = create();
  supervisedFlows.set(flow, supervision);
  return supervision;
}

interface RevokeCurrentPorts {
  admission: WorkspaceHookRuntimeAdmissionPort;
  applyRevoke(input: {
    coordinator: WorkspaceHookTrustCoordinator;
    digests: string[];
    reviewItemIds: string[];
    snapshot: WorkspaceHookBundleSnapshot;
    store: Promise<WorkspaceHookTrustStoreMutationPort>;
  }): Promise<WorkspaceHookReviewCommandResult>;
  coordinator: WorkspaceHookTrustCoordinator;
  diagnostics: { revoked(count: number): void };
  emitAdmissionUpdated(): Promise<void>;
  host: WorkspaceHookReviewHostPort;
  refreshPendingFlow(snapshot: WorkspaceHookBundleSnapshot): Promise<unknown>;
  sessionId: string;
  store: Promise<WorkspaceHookTrustStoreMutationPort>;
}

export async function revokeCurrentWorkspaceHookTrust(
  ports: RevokeCurrentPorts,
  target: WorkspaceHookTrustRevokeTarget,
): Promise<WorkspaceHookReviewCommandResult> {
  const snapshot = ports.admission.getCurrentSnapshot();
  if (
    target.sessionId !== ports.sessionId ||
    target.remoteSessionId !== ports.host.remoteSessionId ||
    target.workspaceIdentity !== snapshot.workspaceIdentity ||
    target.bundleDigest !== snapshot.bundleDigest
  ) {
    return {
      accepted: false,
      reasonCode: "workspace_hooks_snapshot_mismatch" as const,
    };
  }
  const digests = [...new Set(target.hookDeclarationDigests)];
  const entries = snapshot.hooks.filter((entry) => digests.includes(entry.hookDeclarationDigest));
  if (
    digests.length === 0 ||
    new Set(entries.map((entry) => entry.hookDeclarationDigest)).size !== digests.length
  ) {
    return {
      accepted: false,
      reasonCode: "workspace_hooks_snapshot_mismatch" as const,
    };
  }
  const result = await ports.applyRevoke({
    coordinator: ports.coordinator,
    digests,
    reviewItemIds: entries.map((entry) => entry.reviewItemId),
    snapshot,
    store: ports.store,
  });
  if (result.accepted) {
    ports.diagnostics.revoked(digests.length);
    await ports.refreshPendingFlow(snapshot);
    // 软门禁:revokeCurrent 后重新评估 pending 状态
    await ports.emitAdmissionUpdated();
  }
  return result;
}
