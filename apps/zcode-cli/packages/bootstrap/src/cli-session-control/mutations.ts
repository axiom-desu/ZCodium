import { realpath } from "node:fs/promises";
import {
  SessionEventType,
  createSessionId,
  type MessageWithParts,
  type TurnCompletePayload,
} from "@zcode/contracts";
import {
  SessionControlError,
  type AccessGrant,
  type CliCreateSessionInput,
  type CliForkSessionInput,
  type CliInterruptSessionInput,
  type CliRenameSessionInput,
  type CliScope,
  type CliSessionExecutionPort,
  type CliSessionRef,
  type CliTrustedContext,
  type CreateSessionResult,
  type ForkSessionResult,
  type MutationResult,
} from "@zcode/session-control/contracts";
import { resolveStableForkTargetFromTranscript } from "../zcode-protocol-v4/stable-fork-target.js";
import type { ControlState } from "./models.js";
import { attach, ref, reserveRoot, writable } from "./owners.js";
import { commandId, remember, trace, validate } from "./receipts.js";
import { submit } from "./submit.js";

/**
 * 执行端口：创建/派生/发送/中断/重命名。
 * 所有 mutation 都先经 remember 的幂等回执，再走既有 owner（runtime 队列、stable fork 事务、
 * title 写入）——这里不新增执行通道，也不重试 mutation。
 */
export function createExecutionPort(state: ControlState): CliSessionExecutionPort {
  async function createSession(
    ctx: CliTrustedContext,
    input: CliCreateSessionInput,
    grant: AccessGrant<CliScope>,
  ): Promise<CreateSessionResult<CliSessionRef>> {
    validate(state, ctx, grant);
    return remember(state, ctx, "createSession", input, async () => {
      validate(state, ctx, grant);
      reserveRoot(state);
      const sessionId = createSessionId();
      let app: Awaited<ReturnType<ControlState["createRootApp"]>> | undefined;
      try {
        // 唯一合法 cwd 就是绑定的 workspace；用 realpath 复验，符号链接/尾斜杠不能换到别处。
        const cwd = await realpath(state.workspace.workspacePath);
        if (cwd !== state.workspace.workspacePath)
          throw new SessionControlError(
            "forbidden",
            "Creation workspace is not the canonical bound workspace",
          );
        app = await state.createRootApp({
          sessionId,
          cwd,
          resume: false,
          ...(input.model ? { model: input.model } : {}),
          traceContext: trace(state, ctx, sessionId),
        });
        if (app.sessionId !== sessionId) {
          await app.close?.();
          throw new SessionControlError("conflict", "Factory returned a different session");
        }
        const root = attach(state, app, true);
        const target = root;
        // 新根采用独立安全模式；不从 actor 继承 yolo 或审批。
        await app.setMode("build");
        await app.runtime.ensureSessionPersistedForExternalActivity(input.prompt, {
          traceContext: trace(state, ctx, sessionId),
        });
        validate(state, ctx, grant);
        const first = await submit(state, ctx, target, input.prompt, input.requestId, grant);
        return {
          requestId: input.requestId,
          creation: "created",
          firstInput: first.admission,
          delivery: first.delivery,
          session: first.session,
          operation: first.operation,
          ...(first.reason ? { reason: first.reason } : {}),
        };
      } catch (error) {
        const root = state.roots.get(sessionId);
        if (root) root.failure = error instanceof Error ? error.message : String(error);
        // 创建后持久化失败可能已写入 session；保留稳定引用与回执，禁止重试再建。
        return {
          requestId: input.requestId,
          creation: app ? "created" : "unknown",
          firstInput: "unknown",
          delivery: "unknown",
          session: ref(state, sessionId),
          reason: error instanceof Error ? error.message : String(error),
        };
      } finally {
        state.rootReservations -= 1;
      }
    });
  }

  async function forkSession(
    ctx: CliTrustedContext,
    input: CliForkSessionInput,
    grant: AccessGrant<CliScope>,
  ): Promise<ForkSessionResult<CliSessionRef>> {
    validate(state, ctx, grant);
    // 规格 0.14：每个回执都要带请求身份，收成一个构造器，避免逐处重复三行。
    const rejected = (reason: string) =>
      ({ requestId: input.requestId, status: "rejected", reason }) as const;
    return remember(state, ctx, "forkSession", input, async () => {
      const source = writable(state, input.session);
      const leaseId = commandId(ctx, input.requestId);
      const lease = source.app.runtime.acquireForegroundPromotionLease({
        leaseId,
        mode: "idle-only",
        promotedInputId: leaseId,
      });
      if (lease.kind !== "acquired")
        return rejected("Fork requires an idle owner to validate independent permissions");
      try {
        const stored = await state.sessionStore.getSession(source.app.sessionId);
        // 现有 stable fork 原子 bundle 会复制 permission；build 不会清掉 allow/deny/ask。
        // 无安全清除参数前只允许无持久权限规则、无后台写者的 idle 来源，绝不在 adapter 改库。
        if (
          !stored ||
          source.app.runtime.hasRunningBackgroundTasks() ||
          Object.keys(stored.permission ?? {}).some((key) => key !== "mode") ||
          (stored.permission?.mode && stored.permission.mode !== "build")
        )
          return rejected(
            "Stable fork cannot copy session permission rules into an independent root",
          );
        const messages = await state.sessionStore.messages({ sessionID: source.app.sessionId });
        const boundary = messages.find((message) => message.info.id === input.atMessage);
        if (
          !boundary ||
          boundary.info.role !== "assistant" ||
          boundary.info.error ||
          !boundary.info.anchor?.turnId
        )
          return rejected("Message has no verifiable stable assistant boundary");
        if (boundary.info.mode !== "build")
          return rejected(
            "Stable fork cannot copy historical permission mode into an independent root",
          );
        const turnId = boundary.info.anchor.turnId;
        const events = await source.app.runtime.getSessionEventStore().getEvents(source.app.sessionId);
        const complete = events.find(
          (event) =>
            event.turnId === turnId &&
            event.type === SessionEventType.TurnComplete &&
            (event.payload as TurnCompletePayload).resultType === "success",
        );
        const laterAssistant = messages
          .slice(messages.indexOf(boundary as MessageWithParts) + 1)
          .some(
            (message) => message.info.role === "assistant" && message.info.anchor?.turnId === turnId,
          );
        if (!complete || laterAssistant)
          return rejected("Target turn is not a completed stable assistant boundary");
        const resolution = await resolveStableForkTargetFromTranscript({
          candidate: {
            productTurnId: boundary.info.anchor.productTurnId ?? turnId,
            transcriptTurnId: turnId,
            boundaryMessageId: input.atMessage,
            startMessageId: boundary.info.parentID,
          },
          messages,
          store: state.sessionStore,
        });
        if (!resolution.ok) return rejected(resolution.reasonCode);
        validate(state, ctx, grant);
        reserveRoot(state);
        const childId = createSessionId();
        let committed = false;
        try {
          await source.app.runtime.forkStableConversationAtMessage({
            forkedSessionId: childId,
            target: resolution.target,
            goalBoundary: resolution.goalBoundary,
            sourceCommandId: commandId(ctx, input.requestId),
            traceContext: trace(state, ctx, source.app.sessionId),
          });
          committed = true;
          const app = await state.createRootApp({
            sessionId: childId,
            cwd: state.workspace.workspacePath,
            resume: true,
            traceContext: trace(state, ctx, childId),
          });
          if (app.sessionId !== childId) {
            await app.close?.();
            throw new SessionControlError("conflict", "Factory returned a different fork session");
          }
          const child = attach(state, app, true);
          await app.resume({ traceContext: trace(state, ctx, childId) });
          // 历史模型属于 fork 点；权限模式不沿 actor/fork 的旧 yolo 扩散。
          await app.setMode("build");
          child.prepared = true;
          return {
            requestId: input.requestId,
            status: "created" as const,
            session: ref(state, childId),
          };
        } catch (error) {
          const child = state.roots.get(childId);
          if (child) child.failure = error instanceof Error ? error.message : String(error);
          return {
            requestId: input.requestId,
            status: committed ? ("created" as const) : ("unknown" as const),
            session: ref(state, childId),
            reason: error instanceof Error ? error.message : String(error),
          };
        } finally {
          state.rootReservations -= 1;
        }
      } finally {
        source.app.runtime.releaseForegroundPromotionLease(leaseId);
      }
    });
  }

  async function sendToSession(
    ctx: CliTrustedContext,
    input: { session: CliSessionRef; prompt: string; requestId: string },
    grant: AccessGrant<CliScope>,
  ) {
    validate(state, ctx, grant);
    return remember(state, ctx, "sendToSession", input, async () => {
      validate(state, ctx, grant);
      return submit(state, ctx, writable(state, input.session), input.prompt, input.requestId, grant);
    });
  }

  async function interruptSession(
    ctx: CliTrustedContext,
    input: CliInterruptSessionInput,
    grant: AccessGrant<CliScope>,
  ): Promise<MutationResult> {
    validate(state, ctx, grant);
    return remember<MutationResult>(state, ctx, "interruptSession", input, async () => {
      validate(state, ctx, grant);
      const result = writable(state, input.session).app.runtime.stopActiveForegroundExecution({
        expectedForegroundExecutionId: input.expectedExecutionId,
        reason: "CLI session control interrupt",
      });
      return result.kind === "stopped"
        ? { requestId: input.requestId, status: "applied" as const }
        : {
            requestId: input.requestId,
            status: "rejected" as const,
            reason: result.kind === "mismatch" ? "Execution changed" : "No active execution",
          };
    });
  }

  async function renameSession(
    ctx: CliTrustedContext,
    input: CliRenameSessionInput,
    grant: AccessGrant<CliScope>,
  ): Promise<MutationResult> {
    validate(state, ctx, grant);
    return remember<MutationResult>(state, ctx, "renameSession", input, async () => {
      validate(state, ctx, grant);
      const root = writable(state, input.session);
      await root.app.setCustomSessionTitle({
        title: input.title,
        traceContext: trace(state, ctx, root.app.sessionId),
      });
      return { requestId: input.requestId, status: "applied" as const };
    });
  }

  return {
    createSession,
    forkSession,
    sendToSession,
    interruptSession,
    renameSession,
  };
}
