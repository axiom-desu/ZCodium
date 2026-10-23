import {
  SessionEventType,
  type WorkspaceHookBundleSnapshot,
  type WorkspaceHookReasonCode,
} from "@zcode/contracts";
import {
  WorkspaceHookReviewFlowRegistry,
  type WorkspaceHookReviewFlow,
  type WorkspaceHookReviewTarget,
  type WorkspaceHookRuntimeAdmissionPort,
  type WorkspaceHookSnapshotEvaluation,
  type WorkspaceHookTrustCoordinator,
} from "@zcode/core";
import type {
  WorkspaceHookReviewDecision,
  WorkspaceHookReviewRequestPayload,
  WorkspaceHookTrustRevokeTarget,
} from "@zcode/shared/zcode-protocol-v4";
import { WorkspaceHookMutationError } from "@zcode/shared/workspace-hook-mutation";

export type * from "./workspace-hook-review-types.js";
import type {
  WorkspaceHookReviewCommandResult,
  WorkspaceHookReviewControllerOptions,
  WorkspaceHookReviewHostPort,
  WorkspaceHookReviewMutationPort,
  WorkspaceHookTrustStoreMutationPort,
} from "./workspace-hook-review-types.js";
import { resolveWorkspaceHookReviewDigests } from "./workspace-hook-review-request.js";
import { WorkspaceHookReviewDiagnostics } from "./workspace-hook-review-diagnostics.js";
import { superviseWorkspaceHookReviewFlow } from "./workspace-hook-review-supervisor.js";
import { applyWorkspaceHookRevoke } from "./workspace-hook-review-revoke.js";
import {
  applyWorkspaceHookPersistentTrust,
  emitWorkspaceHookAdmissionUpdated,
  buildWorkspaceHookReviewRequestPayload,
  requestWorkspaceHookReview,
  revokeCurrentWorkspaceHookTrust,
  getOrCreateWorkspaceHookSupervision,
  openOrReuseWorkspaceHookReviewFlow,
  openWorkspaceHookReviewFlowForNewPendingItems,
  refreshWorkspaceHookPendingFlow,
} from "./workspace-hook-review-mutation-runner.js";

export class WorkspaceHookReviewController {
  private readonly diagnostics: WorkspaceHookReviewDiagnostics;
  private readonly admission: WorkspaceHookRuntimeAdmissionPort;
  private readonly appVersion?: string;
  private readonly coordinator: WorkspaceHookTrustCoordinator;
  private readonly host: WorkspaceHookReviewHostPort;
  private readonly mutation: WorkspaceHookReviewMutationPort;
  private readonly sessionId: string;
  private readonly store: Promise<WorkspaceHookTrustStoreMutationPort>;
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly registry = new WorkspaceHookReviewFlowRegistry();
  /** flow → 监管 promise。WeakMap 使 flow 被回收后自动移除，不额外持有引用。 */
  private readonly supervisedFlows = new WeakMap<WorkspaceHookReviewFlow, Promise<void>>();
  private reviewFlowId?: string;
  private generation = 0;
  private mutationQueue: Promise<unknown> = Promise.resolve();

  constructor(options: WorkspaceHookReviewControllerOptions) {
    this.admission = options.admission;
    this.appVersion = options.appVersion;
    this.coordinator = options.coordinator;
    this.host = options.host;
    this.diagnostics = new WorkspaceHookReviewDiagnostics(options.logger);
    this.mutation = options.mutation;
    this.sessionId = options.sessionId;
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? (() => crypto.randomUUID());
  }

  /**
   * 见 workspace-hook-review-supervisor：任何新开 flow 都必须交由它监管。
   *
   * openOrReuseFlow 会复用仍 pending 的同一 flow
   * 对象，因此重复 requestReview 与 revoke 重开路径可能给同一个 flow 各挂一个 supervisor，
   * timeout 时重复 emit ReviewSettled。重复监管与缺监管同病：
   * 按 flow 对象单例化，重复请求直接复用已有的监管 promise。
   */
  private superviseFlow(flow: WorkspaceHookReviewFlow): Promise<void> {
    return getOrCreateWorkspaceHookSupervision(this.supervisedFlows, flow, () =>
      superviseWorkspaceHookReviewFlow({
        flow,
        diagnostics: this.diagnostics,
        host: this.host,
        registry: this.registry,
        sessionId: this.sessionId,
      }),
    );
  }

  /**
   * 软门禁:按需开审核 flow。
   *
   * 用户点击「去审核」时经 requestWorkspaceHookReview 命令调用。
   * 无 pending 项时为安全 no-op(返回 accepted)。
   * 已有活跃 flow 时幂等复用(openOrReuseFlow)。
   * 必须经 superviseFlow 监管——否则 flow 超时后会静默死亡、面板永久失效。
   */
  async requestReview(target: {
    workspaceIdentity: string;
    bundleDigest: string;
  }): Promise<WorkspaceHookReviewCommandResult> {
    return await requestWorkspaceHookReview(
      {
        admission: this.admission,
        coordinator: this.coordinator,
        openOrReuseFlow: (snapshot, evaluation) => this.openOrReuseFlow(snapshot, evaluation),
        superviseFlow: (flow) => this.superviseFlow(flow),
      },
      target,
    );
  }

  respond(
    target: WorkspaceHookReviewTarget,
    decision: WorkspaceHookReviewDecision,
  ): Promise<WorkspaceHookReviewCommandResult> {
    return this.enqueueMutation(async () => {
      const validation = this.registry.validate(target, decision);
      if (!validation.accepted) {
        this.diagnostics.responseRejected(validation.reasonCode);
        return validation;
      }
      const flow = this.registry.getCurrentFlow(this.sessionId);
      if (!flow) {
        return {
          accepted: false,
          reasonCode: "workspace_hooks_review_superseded" as const,
        };
      }
      const snapshot = this.admission.getCurrentSnapshot();
      // request 绑定打开时的 immutable snapshot bundle。今天
      // replaceSnapshot 只有 toggle 一个合法调用方（经 refreshPendingFlow supersede 旧
      // flow），等价校验靠这一隐式不变量；配置热监听 watcher 一旦成为第二
      // 个调用方且绕过 refreshPendingFlow，tombstone 缺失会让授权落到新 bundle 上。
      // 与 revokeCurrent 对齐显式校验，消除隐式依赖。
      if (
        target.workspaceIdentity !== snapshot.workspaceIdentity ||
        target.bundleDigest !== snapshot.bundleDigest
      ) {
        this.diagnostics.responseRejected("workspace_hooks_snapshot_mismatch");
        return {
          accepted: false,
          reasonCode: "workspace_hooks_snapshot_mismatch" as const,
        };
      }
      // grant 前显式检查 persistent Trust 的 policy 资格：applyDecision 内
      // assertPersistentTrustMutationAllowed 抛出的策略拒绝若落入下方 catch-all，
      // 会被一律报成 trust_store_corrupt（“信任存储损坏”），企业策略收紧时
      // 用户看到的是错误诊断；与 revoke 路径对齐：前置检查 + 精确 reasonCode。
      if (!this.coordinator.canMutatePersistentTrust(snapshot.workspaceIdentity)) {
        this.diagnostics.responseRejected("workspace_hooks_blocked_by_policy");
        return {
          accepted: false,
          reasonCode: "workspace_hooks_blocked_by_policy" as const,
        };
      }
      let applied: { grantedRecordCount?: number };
      try {
        applied = await this.applyPersistentTrust(validation.reviewItemIds);
      } catch {
        // 原始错误可能含路径或内容；本地诊断只记录固定失败阶段。
        this.diagnostics.trustStoreFailure();
        return {
          accepted: false,
          reasonCode: "workspace_hooks_trust_store_corrupt" as const,
        };
      }
      this.diagnostics.decisionAccepted(target, decision, {
        ...(applied.grantedRecordCount === undefined
          ? {}
          : { grantedRecordCount: applied.grantedRecordCount }),
        requestEnabledCount: flow.request.items.filter((item) => item.configuredEnabled).length,
      });
      const resolved = this.registry.resolve(target, decision);
      // applyDecision 与 registry.resolve 非原子——两者之间若
      // registry 的 deadline timer 恰好触发，flow 变为 timed_out，resolve 返回
      // superseded，于是「Trust 已落盘」却回报「审核已过期」。用户据此重试、排障者
      // 据此以为没写成功——同样属于错误归属倒错。
      //
      // 决策已经生效（持久 Trust 已落盘），故按 accepted 回报并照发
      // Settled，让前端收敛到已决状态；resolve 被拒仅说明 flow 已被别的终态占用，
      // 不代表授权失败。此处只多不错：不会把未授权说成已授权。
      if (!resolved.accepted) {
        // 保留观测：flow 已被别的终态占用（通常是 deadline 恰好触发）。
        this.diagnostics.responseRejected(resolved.reasonCode);
      }
      await this.host.emit({
        type: SessionEventType.WorkspaceHookReviewSettled,
        payload: { interactionId: target.interactionId, state: "resolved" },
      });
      // 软门禁:settle 后重新评估 pending 状态,通知投影层更新提示条
      await this.emitAdmissionUpdatedAfterMutation();
      // 行内逐条 Trust 不能让其他待审项一起失去操作入口。旧 generation settle 后，
      // 若仍有 pending 声明，立即发布下一 immutable generation；已信任行由 Settings
      // 刷新后消失，其他行继续可操作。
      await this.refreshPendingFlow(snapshot);
      return resolved.accepted
        ? resolved
        : {
            accepted: true as const,
            reviewItemIds: [...validation.reviewItemIds],
          };
    });
  }

  toggle(
    target: WorkspaceHookReviewTarget,
    reviewItemId: string,
    enabled: boolean,
  ): Promise<
    WorkspaceHookReviewCommandResult & {
      request?: WorkspaceHookReviewRequestPayload;
    }
  > {
    return this.enqueueMutation(async () => {
      const validation = this.registry.validate(target, {
        action: "trust_selected",
        reviewItemIds: [reviewItemId],
      });
      if (!validation.accepted) return validation;
      const currentSnapshot = this.admission.getCurrentSnapshot();
      const entry = currentSnapshot.hooks.find((item) => item.reviewItemId === reviewItemId);
      if (!entry?.editable) {
        return {
          accepted: false,
          reasonCode: "workspace_hooks_snapshot_mismatch" as const,
        };
      }
      let writeCommitted = false;
      let nextSnapshot: WorkspaceHookBundleSnapshot;
      try {
        nextSnapshot = await this.mutation.toggle(
          { snapshot: currentSnapshot, reviewItemId, enabled },
          () => {
            writeCommitted = true;
            this.admission.invalidate("workspace_hooks_config_rebuild_failed");
          },
        );
        this.admission.replaceSnapshot(nextSnapshot);
      } catch (error) {
        if (!writeCommitted) {
          // 裸 catch 曾把 mutation port 的全部失败一律报成
          // config_write_failed——包括发生在写盘之前的 snapshot mismatch（review 后
          // bundle 已变/discovery 读败）。用户据此重试"写"永远失败，也掩盖真实原因。
          // 按 WorkspaceHookMutationError.code 透传；diagnostics 补 cause 便于定位。
          const isMutationError =
            error instanceof WorkspaceHookMutationError ||
            (error instanceof Error && error.name === "WorkspaceHookMutationError");
          const mutationCode = isMutationError
            ? ((error as WorkspaceHookMutationError).code as WorkspaceHookReasonCode)
            : ("workspace_hooks_config_write_failed" as const);
          this.diagnostics.toggleFailure(mutationCode);
          return {
            accepted: false,
            reasonCode: mutationCode as WorkspaceHookReasonCode,
          };
        }
        this.diagnostics.toggleFailure("workspace_hooks_config_rebuild_failed");
        this.registry.fail(target, "workspace_hooks_config_rebuild_failed");
        await this.host.emit({
          type: SessionEventType.WorkspaceHookReviewSettled,
          payload: {
            interactionId: target.interactionId,
            state: "configuration_error",
            reasonCode: "workspace_hooks_config_rebuild_failed",
          },
        });
        return {
          accepted: false,
          reasonCode: "workspace_hooks_config_rebuild_failed" as const,
        };
      }

      const nextFlow = await this.refreshPendingFlow(nextSnapshot);
      // 软门禁:toggle 重建 bundle 后重新评估 pending 状态
      await this.emitAdmissionUpdatedAfterMutation();
      return {
        accepted: true,
        reviewItemIds: [reviewItemId],
        ...(nextFlow ? { request: nextFlow.request } : {}),
      };
    });
  }

  revoke(
    target: WorkspaceHookReviewTarget,
    reviewItemIds: readonly string[],
  ): Promise<WorkspaceHookReviewCommandResult> {
    return this.enqueueMutation(async () => {
      const validation = this.registry.validate(target, {
        action: "trust_selected",
        reviewItemIds: [...reviewItemIds],
      });
      if (!validation.accepted) return validation;
      const snapshot = this.admission.getCurrentSnapshot();
      const result = await applyWorkspaceHookRevoke({
        coordinator: this.coordinator,
        digests: resolveWorkspaceHookReviewDigests(snapshot, validation.reviewItemIds),
        reviewItemIds: validation.reviewItemIds,
        snapshot,
        store: this.store,
      });
      if (result.accepted) {
        this.diagnostics.revoked(validation.reviewItemIds.length);
        await this.refreshPendingFlow(snapshot);
        // 软门禁:revoke 后重新评估 pending 状态
        await this.emitAdmissionUpdatedAfterMutation();
      }
      return result;
    });
  }

  revokeCurrent(target: WorkspaceHookTrustRevokeTarget): Promise<WorkspaceHookReviewCommandResult> {
    return this.enqueueMutation(
      async () =>
        await revokeCurrentWorkspaceHookTrust(
          {
            admission: this.admission,
            applyRevoke: (input) =>
              applyWorkspaceHookRevoke({
                coordinator: input.coordinator,
                digests: input.digests,
                reviewItemIds: input.reviewItemIds,
                snapshot: input.snapshot,
                store: input.store,
              }),
            coordinator: this.coordinator,
            diagnostics: this.diagnostics,
            emitAdmissionUpdated: () => this.emitAdmissionUpdatedAfterMutation(),
            host: this.host,
            refreshPendingFlow: (snapshot) => this.refreshPendingFlow(snapshot),
            sessionId: this.sessionId,
            store: this.store,
          },
          target,
        ),
    );
  }

  private async refreshPendingFlow(
    snapshot: WorkspaceHookBundleSnapshot,
  ): Promise<WorkspaceHookReviewFlow | undefined> {
    return await refreshWorkspaceHookPendingFlow(
      {
        buildRequest: (snapshotInput, evaluation, flow) =>
          buildWorkspaceHookReviewRequestPayload(
            {
              createId: this.createId,
              host: this.host,
              now: this.now,
              sessionId: this.sessionId,
            },
            snapshotInput,
            evaluation,
            flow,
          ),
        closeWithoutDecision: (target) => this.registry.closeWithoutDecision(target),
        coordinator: this.coordinator,
        diagnostics: this.diagnostics,
        getCurrentFlow: (sessionId) => this.registry.getCurrentFlow(sessionId),
        host: this.host,
        openReviewFlowForNewPendingItems: (snapshotInput) =>
          this.openReviewFlowForNewPendingItems(snapshotInput),
        sessionId: this.sessionId,
        setGeneration: (generation) => {
          this.generation = generation;
        },
        supersede: (target, replacement) => this.registry.supersede(target, replacement),
      },
      snapshot,
    );
  }

  /**
   * revoke 之后当前会话没有 pending flow 时，重新开启审核。
   *
   * 只在真的存在待审项时开启。开关只控制运行，信任只控制准入；因此当前审核
   * 快照中的 configured-disabled 声明也必须保留行内信任入口。开启走
   * openOrReuseFlow，与首次征询同一条路径，因此 generation / reviewFlowId /
   * interactionId 的既有语义不变。
   */
  private async openReviewFlowForNewPendingItems(
    snapshot: WorkspaceHookBundleSnapshot,
  ): Promise<WorkspaceHookReviewFlow | undefined> {
    return await openWorkspaceHookReviewFlowForNewPendingItems(
      {
        coordinator: this.coordinator,
        openOrReuseFlow: (snapshotInput, evaluation) =>
          this.openOrReuseFlow(snapshotInput, evaluation),
        superviseFlow: (flow) => this.superviseFlow(flow),
      },
      snapshot,
    );
  }

  private async openOrReuseFlow(
    snapshot: WorkspaceHookBundleSnapshot,
    evaluation: WorkspaceHookSnapshotEvaluation,
  ): Promise<WorkspaceHookReviewFlow> {
    return await openOrReuseWorkspaceHookReviewFlow(
      {
        createId: this.createId,
        diagnostics: this.diagnostics,
        getCurrentFlow: (sessionId) => this.registry.getCurrentFlow(sessionId),
        getGeneration: () => this.generation,
        getReviewFlowId: () => this.reviewFlowId,
        host: this.host,
        now: this.now,
        open: (request) => this.registry.open(request),
        sessionId: this.sessionId,
        setGeneration: (generation) => {
          this.generation = generation;
        },
        setReviewFlowId: (reviewFlowId) => {
          this.reviewFlowId = reviewFlowId;
        },
      },
      snapshot,
      evaluation,
    );
  }

  private async applyPersistentTrust(
    reviewItemIds: readonly string[],
  ): Promise<{ grantedRecordCount?: number }> {
    return await applyWorkspaceHookPersistentTrust(this.mutationRunnerPorts(), reviewItemIds);
  }

  private mutationRunnerPorts() {
    return {
      admission: this.admission,
      appVersion: this.appVersion,
      coordinator: this.coordinator,
      host: this.host,
      now: this.now,
      store: this.store,
    };
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * 软门禁:mutation 完成后重新评估 pending 状态并发射 AdmissionUpdated。
   *
   * 口径与 admission 一致:configuredEnabled && admissionClass === "pending"。
   * pendingCount === 0 也要发,投影据此清空提示条。
   * 通过 admission 的 invalidate → 触发 evaluateDispatch 内的 refreshEvaluation;
   * 这里直接用 coordinator 重新评估快照,与 admission.emitAdmissionState 同源。
   */
  private async emitAdmissionUpdatedAfterMutation(): Promise<void> {
    await emitWorkspaceHookAdmissionUpdated(this.mutationRunnerPorts());
  }
}
