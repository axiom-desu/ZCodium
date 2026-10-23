import {
  SESSION_ENTRY_TARGET_COMPLETION_VERIFICATION,
  SessionEventType,
  createSessionId,
} from "@zcode/contracts";
import type { SessionId, StableForkGoalBoundaryMetadata } from "@zcode/contracts";
import { resolveWorkspaceRefFromId } from "./mapper.js";
import { hasSessionModelProvider } from "./workspace-model-runtime.js";
import {
  afterStateMutation,
  createSessionRecordForV4,
  ensureSessionModelAvailableForNextTurn,
} from "./server-operations.js";
import type { ZCodeProtocolSessionRecord } from "./server-types.js";
import type { V4CommandCoreHost } from "../zcode-protocol-v4/commands/types.js";
import {
  buildForkInitialInput,
  recordForkStartFailureBestEffort,
  registerCommittedForkBestEffort,
  resolveInputCommandForAdmission,
} from "./v4-bridge-fork.js";
import {
  cloneModelSelection,
  modelSelectionWithOptionFallback,
  stableForkMode,
} from "./v4-bridge-shared.js";
import type { V4AutoDrainPort, V4BridgeBasePorts } from "./v4-bridge-shared.js";

export function createCommandEntrySessionOps(
  ports: V4BridgeBasePorts & { autoDrain: V4AutoDrainPort },
): Pick<
  V4CommandCoreHost,
  | "ensureModelReady"
  | "ensureProviderAvailable"
  | "afterLegacyStateMutation"
  | "closeSession"
  | "createSessionRecord"
  | "createSelectionSideSession"
  | "forkStableConversation"
  | "forkConversationBeforeInput"
  | "recordForkStartFailure"
> {
  const context = ports.context;
  const autoDrainV4QueueIfReady = ports.autoDrain.autoDrainV4QueueIfReady;
  return {
    ensureModelReady: (record) =>
      ensureSessionModelAvailableForNextTurn(context, record as ZCodeProtocolSessionRecord),
    // 切模型前确认目标 Provider 已存在于当前 Environment Registry。普通模型命令只提交
    // Selection；Provider 事实始终由 Worker 自己的 Registry 解释。
    ensureProviderAvailable: async (sessionId, providerId) => {
      const record = context.sessions.get(sessionId);
      if (!record) return { available: false, reason: "session_not_found" };
      if (!hasSessionModelProvider(context, record, providerId)) {
        return { available: false, reason: "provider_not_in_registry" };
      }
      return { available: true };
    },
    afterLegacyStateMutation: async (record, reason) => {
      await afterStateMutation(context, record as ZCodeProtocolSessionRecord, reason);
      await autoDrainV4QueueIfReady(record as ZCodeProtocolSessionRecord);
    },
    // deleteSession 的执行面：内联旧 closeSession op 的 4 步（不 import 旧 op——
    // 语义与 server-operations.ts closeSession 对齐，随会话注册表归 v4 后收编）。
    closeSession: async (sessionId) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        // handler 已校验存在性；此处只兜并发竞态（重复删除幂等成功）。
        return;
      }
      // 顺序不可交换：先把「已删除」持久事实落库（coalesce 首时间，重复调用幂等），
      // 再释放 runtime 与摘除注册表。反过来一旦进程在两者之间重启，持久行仍是未删除，
      // 已宣告的 session.removed 会在冷启动后被重新 list 出来（会话复活）。
      // 能力缺失直接失败（ACK failed）：静默降级成「只关闭」会让用户以为已删除，而列表项下次冷启动又回来。
      const store = context.deps.sessionStore;
      if (!store?.softDeleteSession) throw new Error("Session soft deletion is unavailable");
      await store.softDeleteSession(record.app.sessionId as SessionId);
      record.unsubscribe?.();
      await record.app.close?.();
      // v4 通道：会话关闭同时清 publisher / 订阅调度；重开会话走 snapshot 冷启动。
      // disposeSession 必须在注册表删除之前调用——
      // gateway 靠 getSessionWorkspaceId（读 context.sessions）定位 workspace 才能把
      // session.removed 推给 sessions-index 订阅者；先 delete 再 dispose 时 workspaceId
      // 恒为 null，删除会话后侧栏列表项永不消失（e2e conversation-session-v4-sidebar 抓出）。
      // 这里是完成持久软删除的唯一执行面：只有它显式传 `deleted: true`，
      // 普通 session/close、create 失败 cleanup 都不能发布 session.removed。
      context.v4Gateway?.disposeSession(sessionId, { deleted: true });
      context.sessions.delete(sessionId);
    },
    // createSession 的执行面：record 建立/事件接线/catalog 同步/失败自清理全在旧
    // createSession op 内（半初始化 record 的回收顺序修过 bug，不重复实现）。
    // 语义决策（draft persistence / firstInput 走原生 prompt turn）在原生 handler。
    createSessionRecord: async ({ workspaceId, mcpServers, dynamicWorkflowEnabled }) => {
      // workspaceId 双形态（Workspace Identity 约束）：
      // - 本地工作区 = workspacePath（identity 缺省时的 fallback）；
      // - 远程 pane（跨 workspace 分屏）= 远程 identity
      //   （remote:ssh/wsl/docker:...:<path>，UI buildRemoteWorkspaceIdentity 构造）。
      //   经统一解析工具还原真实 workspacePath 作 workingDirectory——CLI 本就跑在
      //   远端机器上，path 即本机路径；identity 原样保留进 workspace ref
      //   （workspaceKey = identity，sessions-index topic / 隔离语义不变）。
      // shared parser 统一兼容 WSL legacy 与显式 user identity；非远程格式继续按
      // 本地 workspacePath 处理。
      const created = await createSessionRecordForV4(context, {
        workspace: resolveWorkspaceRefFromId(workspaceId),
        // 一律 deferred（draft 不进 sqlite）；提升时机归原生 prompt-turn。
        persistence: "deferred",
        // MCP 是 runtime 创建期配置；v4 createSession 必须与 legacy
        // session/create 等价透传，否则创建的 session 永远不会启动这些工具。
        mcpServers,
        // 动态工作流灰度门同为 runtime 创建期配置：
        // v4 createSession 必须与 legacy session/create 等价透传，否则无界面创建的会话
        // 会绕过 Host 的灰度判定，只剩进程级缺省。
        ...(dynamicWorkflowEnabled === true ? { dynamicWorkflowEnabled: true } : {}),
      });
      return { sessionId: created.sessionId };
    },
    createSelectionSideSession: async (sessionId, options) => {
      const record = context.sessions.get(sessionId);
      if (!record) throw new Error("proto.sessionNotFound");
      const modelSelection = cloneModelSelection(
        options.modelSelection ?? record.app.runtime.getSessionModelSelection(),
      );
      const fork = await record.app.runtime.createSelectionSideConversation({
        modelSelection,
        sourceCommandId: options.sourceCommandId,
        revisionAtDecision: options.revisionAtDecision,
        traceContext: record.traceContext,
      });
      await registerCommittedForkBestEffort(context, record, fork, {
        commandId: options.sourceCommandId,
        runtimeConfig: {
          mode: record.app.getMode(),
          model: modelSelection ? `${modelSelection.providerId}/${modelSelection.modelId}` : "",
          ...(modelSelection?.options?.reasoningLevel
            ? { thoughtLevel: modelSelection.options.reasoningLevel }
            : {}),
          followupMode: context.v4Gateway?.getSessionFollowupMode(sessionId) ?? "queue",
        },
        inheritLatestTarget: false,
      });
      return { sessionId: String(fork.forkedSessionId) };
    },
    // running stable fork：只走 core transcript copy，再注册 child record。父 runtime、queue、
    // background/continuation inbox 与 shared workspace 均不读取、不停止、不复制。
    forkStableConversation: async (sessionId, options) => {
      const { goalBoundary, revisionAtDecision, sourceCommandId, target } = options;
      const record = context.sessions.get(sessionId);
      if (!record) throw new Error("proto.sessionNotFound");
      const store = context.deps.sessionStore;
      if (!store) throw new Error("fault.command.stableForkStoreUnavailable");
      const messages = await store.messages({ sessionID: sessionId as SessionId });
      const boundary = messages.find(
        (message) => String(message.info.id) === target.boundaryMessageId,
      );
      if (boundary?.info.role !== "assistant") {
        throw new Error("guard.forkTargetAmbiguous");
      }
      const modelSelection = modelSelectionWithOptionFallback(
        boundary.info.providerId && boundary.info.modelId
          ? {
              providerId: boundary.info.providerId,
              modelId: boundary.info.modelId,
              ...(boundary.info.reasoningLevel
                ? { options: { reasoningLevel: boundary.info.reasoningLevel } }
                : {}),
            }
          : undefined,
        cloneModelSelection(record.app.runtime.getSessionModelSelection()),
      );
      const fork = await record.app.runtime.forkStableConversationAtMessage({
        modelSelection,
        target,
        goalBoundary,
        sourceCommandId,
        revisionAtDecision,
        traceContext: record.traceContext,
      });
      await registerCommittedForkBestEffort(context, record, fork, {
        commandId: sourceCommandId,
        runtimeConfig: {
          mode: stableForkMode(boundary.info.mode, record.app.getMode()),
          model: modelSelection ? `${modelSelection.providerId}/${modelSelection.modelId}` : "",
          ...(modelSelection?.options?.reasoningLevel
            ? { thoughtLevel: modelSelection.options.reasoningLevel }
            : {}),
        },
        // core 已按 copied message/verifier 边界复制 goal；禁止再用 parent 当前 target 覆盖。
        inheritLatestTarget: false,
      });
      return { forkedSessionId: String(fork.forkedSessionId) };
    },
    forkConversationBeforeInput: async (sessionId, { editTarget, envelope, admission }) => {
      const record = context.sessions.get(sessionId);
      if (!record) throw new Error("proto.sessionNotFound");
      const store = context.deps.sessionStore;
      if (!store) throw new Error("fault.command.stableForkStoreUnavailable");
      const messages = await store.messages({
        sessionID: sessionId as SessionId,
      });
      const targetMessage = messages.find(
        (message) => String(message.info.id) === editTarget.transcriptMessageId,
      );
      if (targetMessage?.info.role !== "user") {
        throw new Error("guard.latestQueryEditOnly");
      }
      const modelSelection = modelSelectionWithOptionFallback(
        cloneModelSelection(targetMessage.info.modelSelection),
        cloneModelSelection(record.app.runtime.getSessionModelSelection()),
      );
      const events = await record.eventStore.getEvents(sessionId as SessionId);
      const targetStarted = events.find(
        (event) =>
          event.type === SessionEventType.TurnStarted &&
          String((event.payload as { messageId?: unknown }).messageId ?? "") ===
            editTarget.transcriptMessageId,
      );
      const priorTargetChange = targetStarted
        ? events
            .filter(
              (event) =>
                event.sequenceNumber < targetStarted.sequenceNumber &&
                event.type === SessionEventType.TargetChanged,
            )
            .at(-1)
        : undefined;
      const forkedSessionId = String(createSessionId());
      const input = resolveInputCommandForAdmission(
        envelope,
        forkedSessionId,
        (sourceSessionId, target, action) =>
          context.v4Gateway?.resolveRowActionTarget(sourceSessionId, target, action) ?? null,
      );
      if (!input) throw new Error("fault.command.forkInputAdmissionMissing");
      const initialInput = buildForkInitialInput(envelope, forkedSessionId, admission, input);
      let goalBoundary: StableForkGoalBoundaryMetadata | null = priorTargetChange
        ? (() => {
            const target = (priorTargetChange.payload as { target?: unknown }).target;
            return target
              ? {
                  kind: "snapshot" as const,
                  target: target as Extract<
                    StableForkGoalBoundaryMetadata,
                    { kind: "snapshot" }
                  >["target"],
                  verificationEntryIds: [],
                }
              : { kind: "none" as const };
          })()
        : null;
      if (goalBoundary?.kind === "snapshot" && store.sessionEntries && targetStarted) {
        const targetId = goalBoundary.target.targetID;
        const boundaryTime = targetStarted.timestamp.getTime();
        const entries = await store.sessionEntries({
          sessionID: sessionId as SessionId,
          type: SESSION_ENTRY_TARGET_COMPLETION_VERIFICATION,
        });
        goalBoundary = {
          ...goalBoundary,
          verificationEntryIds: entries.flatMap((entry) => {
            const data = entry.data as { payload?: { targetId?: unknown } };
            return entry.time.updated <= boundaryTime && data.payload?.targetId === targetId
              ? [entry.id]
              : [];
          }),
        };
      }
      if (!goalBoundary) {
        const targetIndex = messages.indexOf(targetMessage);
        const previousAssistant = messages
          .slice(0, targetIndex)
          .reverse()
          .find((message) => message.info.role === "assistant");
        goalBoundary = previousAssistant?.info.anchor?.goalBoundary ?? null;
        if (!previousAssistant) goalBoundary = { kind: "none" };
      }
      if (!goalBoundary) {
        throw new Error("guard.forkTargetAmbiguous");
      }
      const fork = await record.app.runtime.forkConversationBeforeMessage({
        modelSelection,
        forkedSessionId: forkedSessionId as SessionId,
        targetMessageId: targetMessage.info.id,
        targetProductTurnId: editTarget.productTurnId,
        targetTranscriptTurnId: String(
          targetMessage.info.anchor?.turnId ?? editTarget.productTurnId,
        ),
        sourceCommandId: envelope.commandId,
        initialInput,
        commandFact: {
          parentSessionId: sessionId,
          sourceCommandId: envelope.commandId,
          ack: {
            commandId: envelope.commandId,
            status: "accepted",
            revisionAtDecision: envelope.baseRevision ?? 0,
            result: {
              type: "editUserQuery",
              disposition: "fork",
              sessionId: forkedSessionId,
            },
          },
          metadata: {
            parentSessionId: sessionId,
            sourceCommandId: envelope.commandId,
            editTarget,
          },
        },
        // 严格取 TurnStarted 之前的 TargetChanged 或上一稳定 assistant anchor；禁止
        // 把 parent 当前（可能正由被编辑 goal 写入）的 target 冒充 input 前状态。
        goalBoundary,
        traceContext: record.traceContext,
      });
      await registerCommittedForkBestEffort(context, record, fork, {
        commandId: envelope.commandId,
        runtimeConfig: {
          mode: record.app.getMode(),
          model: modelSelection ? `${modelSelection.providerId}/${modelSelection.modelId}` : "",
          ...(modelSelection?.options?.reasoningLevel
            ? { thoughtLevel: modelSelection.options.reasoningLevel }
            : {}),
        },
        inheritLatestTarget: false,
      });
      return { forkedSessionId: String(fork.forkedSessionId) };
    },
    recordForkStartFailure: async (sessionId, envelope, error) => {
      await recordForkStartFailureBestEffort(context, sessionId, envelope, error, {
        parentSessionId: String(envelope.sessionId ?? ""),
      });
    },
  };
}
