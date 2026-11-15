import { SessionControlError } from "@zcode/session-control/contracts";
import type {
  AccessGrant,
  CliScope,
  CliSessionRef,
  CliTrustedContext,
  SendToSessionResult,
} from "@zcode/session-control/contracts";
import type { Root } from "./models.js";
import type { ControlState } from "./models.js";
import { ref, track } from "./owners.js";
import { commandId, trace, validate } from "./receipts.js";

/**
 * 把一条 prompt 交给 root 的所有者执行。
 *
 * 已初始化（`root.prepared`）的独立根走 Core 原有 command FIFO：`executeTurn` 在同一同步片调用，
 * 没有 await 间隔，因此排队事实由 Core 自己产生，`queued` 只是对它的读投影，不是第二队列。
 * 首次输入走 `app.sendInput`，让原准入路径负责 model/mode/turn 建立。
 */
export async function submit(
  state: ControlState,
  ctx: CliTrustedContext,
  root: Root,
  prompt: string,
  requestId: string,
  grant: AccessGrant<CliScope>,
): Promise<SendToSessionResult<CliSessionRef>> {
  const session = ref(state, root.app.sessionId);
  // 回执带裸 sessionId，模型才能把整个 operation 原样放回 WaitSessions（规格 0.14）。
  const operation = {
    session,
    sessionId: session.sessionId,
    commandId: commandId(ctx, requestId),
  };
  const observed = state.observations.register(operation);
  const executionOptions = {
    inputId: operation.commandId,
    abortSignal: root.signal.signal,
    traceContext: trace(state, ctx, root.app.sessionId),
  };
  const watch = (completion: Promise<unknown>): void => {
    track(
      state,
      root,
      completion.then(
        () => {
          if (!["completed", "interrupted", "failed"].includes(observed.snapshot.status))
            state.observations.update(observed, "unknown", {
              reason: "Runtime completed without a correlated terminal event",
            });
        },
        (error: unknown) =>
          state.observations.update(
            observed,
            root.signal.signal.aborted ? "interrupted" : "failed",
            { reason: error instanceof Error ? error.message : String(error) },
          ),
      ),
    );
  };
  try {
    if (!root.owned && root.app.runtime.getActiveForegroundExecutionId()) root.prepared = true;
    if (root.preparation) await root.preparation;
    validate(state, ctx, grant);
    if (root.failure) throw new SessionControlError("unavailable", root.failure);
    if (root.prepared) {
      // 根因：sendInput(queueDelivery=queue) 只建 V4 deferred 项，独立 CLI 没有 V4 消费者。
      // 已初始化的独立根直接进入 Core 原有 command FIFO；同步调用之间无 await，无第二队列。
      const queued = root.app.runtime.hasActiveOrQueuedTurnWork();
      const completion = root.app.runtime.executeTurn(prompt, undefined, executionOptions);
      if (queued) state.observations.update(observed, "queued");
      watch(completion);
      return {
        session,
        operation,
        requestId,
        admission: "accepted",
        delivery: queued ? "queued" : "start_now",
      };
    }
    const prepare = (async () => {
      const admission = await root.app.sendInput(prompt, { ...executionOptions, requireIdle: true });
      if (admission.kind !== "started_turn") return admission;
      root.prepared = true;
      observed.turnId = admission.turnId;
      watch(admission.completion);
      return admission;
    })();
    root.preparation = prepare.then(
      () => undefined,
      () => undefined,
    );
    const admission = await prepare;
    if (admission.kind !== "started_turn") {
      state.observations.update(observed, "failed", { reason: "Initial execution was not admitted" });
      return {
        session,
        operation,
        requestId,
        admission: "rejected",
        delivery: "none",
        reason: "Initial execution was not admitted",
      };
    }
    return { requestId, session, operation, admission: "accepted", delivery: "start_now" };
  } catch (error) {
    // Bug 根因：这里原先把任意 admission 异常写进 root.failure，而 writable() 把该字段当成
    // 永久不可写。于是 provider 抖动、网络错误等可恢复失败会让刚建好的会话再也发不出消息。
    // admission 的不确定属于**这一个请求**：只把该 operation 记为 unknown 并保留原回执，
    // root 的可写性仍由关闭、runtime 损坏与 owner 代际失效决定（见 createSession / fork 的 catch
    // 与 close 路径）。调用方换新 requestId 即可重试。
    state.observations.update(observed, "unknown", {
      reason: error instanceof Error ? error.message : String(error),
    });
    observed.settle();
    return {
      session,
      operation,
      requestId,
      admission: "unknown",
      delivery: "unknown",
      reason: "Input admission failed without a conclusive receipt",
    };
  }
}
