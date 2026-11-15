import { createCliSessionControl } from "@zcode/session-control/cli";
import {
  SessionControlError,
  type AccessGrant,
  type CliScope,
  type CliSessionRef,
  type CliTrustedContext,
} from "@zcode/session-control/contracts";
import type { ZCodeApp } from "../app/types.js";
import { createControlState, scopeKey, assertOpen } from "./models.js";
import { attach, owner } from "./owners.js";
import { fence } from "./receipts.js";
import { createQueryPort } from "./reads.js";
import { createExecutionPort } from "./mutations.js";
import type { CliSessionControlRuntime, CliSessionControlRuntimeOptions } from "./contract.js";


const CLOSE_REASON = "CLI session control owner closed";

export function createCliSessionControlRuntime(
  options: CliSessionControlRuntimeOptions,
): CliSessionControlRuntime {
  const state = createControlState(options);
  const control = createCliSessionControl({
    access: {
      async authorize(ctx, request): Promise<AccessGrant<CliScope>> {
        assertOpen(state);
        owner(state, ctx.rootSession);
        // 读本机会话库不要求目标由本进程托管；仍要求调用者是本 manager 的根。
        if (
          ctx.readAnyLocalSession &&
          (request.action === "listSessions" || request.action === "readSession")
        )
          return { scope: request.scope, fence: fence(state, ctx) };
        if (scopeKey(request.scope) !== scopeKey(state.workspace))
          throw new SessionControlError(
            "forbidden",
            "This CLI owner is bound to a different workspace",
          );
        if (request.session) {
          const target = owner(state, request.session);
          if (!target.verified)
            throw new SessionControlError(
              "unavailable",
              "Session source is not verified as an independent CLI root",
            );
        }
        return { scope: state.workspace, fence: fence(state, ctx) };
      },
    },
    sessions: createQueryPort(state),
    execution: createExecutionPort(state),
    observations: {
      async open(ctx, operation, signal, grant) {
        if (grant.fence !== fence(state, ctx))
          throw new SessionControlError("forbidden", "CLI owner generation changed");
        assertOpen(state);
        owner(state, operation.session);
        return state.observations.open(operation, signal);
      },
    },
    deadlines: {
      create(timeoutMs) {
        let timer: ReturnType<typeof setTimeout>;
        const expired = new Promise<void>((resolveDeadline) => {
          timer = setTimeout(resolveDeadline, timeoutMs);
        });
        return { expired, close: () => clearTimeout(timer) };
      },
    },
  });

  async function closeRoot(root: ReturnType<typeof attach>): Promise<void> {
    if (!root.owned) return;
    root.app.runtime.beginShutdown();
    root.signal.abort(new Error(CLOSE_REASON));
    root.app.runtime.stopActiveForegroundExecution({ reason: CLOSE_REASON });
    // 一个清理步骤失败不能跳过 App 资源释放；所有失败由 close 汇总报告。
    const results = await Promise.allSettled([
      root.app.clearQueueItems(),
      root.app.runtime.cancelRunningRuntimeBackgroundTasks({ reason: "subagent_cancelled" }),
      Promise.allSettled(root.completions),
    ]);
    results.push(...(await Promise.allSettled([root.app.close?.()])));
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (errors.length) throw new AggregateError(errors, "CLI root cleanup failed");
  }

  let closePromise: Promise<void> | undefined;
  return {
    control,
    attachRoot(
      app: ZCodeApp,
      provenance: "new-independent-root" | "unverified-history",
    ) {
      assertOpen(state);
      const root = attach(state, app, false, provenance === "new-independent-root");
      // 新建主根首次活动由它自己的 App/TUI 驱动；一旦已有执行，后续用原 FIFO。
      root.prepared = app.runtime.hasActiveOrQueuedTurnWork();
    },
    close() {
      if (closePromise) return closePromise;
      state.closing = true;
      // 先同步中断，避免等待在途 admission 时错过退出；晚到新 app 由创建路径立即关闭。
      for (const root of state.roots.values())
        if (root.owned) {
          root.app.runtime.beginShutdown();
          root.signal.abort(new Error(CLOSE_REASON));
          root.app.runtime.stopActiveForegroundExecution({ reason: CLOSE_REASON });
        }
      closePromise = (async () => {
        await Promise.allSettled(state.pendingMutations);
        const results = await Promise.allSettled([...state.roots.values()].map(closeRoot));
        state.observations.close();
        for (const root of state.roots.values()) root.unsubscribe();
        const errors = results
          .filter((result): result is PromiseRejectedResult => result.status === "rejected")
          .map((result) => result.reason);
        if (errors.length) throw new AggregateError(errors, "CLI roots could not close cleanly");
      })();
      return closePromise;
    },
  };
}

/**
 * 启动装配的绑定：只有独立 CLI 根拿到它。上下文由装配构造，工具 JSON 无法提供
 * `callerId` / `allowedScopes` / `readAnyLocalSession`——那是权限面，不是模型输入。
 */
export function createCliSessionControlBinding(
  control: CliSessionControlRuntime["control"],
  input: { sessionId: string; workspace: CliScope },
): {
  kind: "cli";
  control: CliSessionControlRuntime["control"];
  context(): CliTrustedContext;
} {
  const rootSession: CliSessionRef = { ...input.workspace, sessionId: input.sessionId };
  return {
    kind: "cli",
    control,
    context: () => ({
      callerId: input.sessionId,
      rootSession,
      allowedScopes: [input.workspace],
      // 独立 CLI 的读取不要求 owner：list/read 可访问本机 CLI 会话库，写操作仍只看 allowedScopes。
      readAnyLocalSession: true,
    }),
  };
}
