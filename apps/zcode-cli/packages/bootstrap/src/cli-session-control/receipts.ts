import {
  createRootTraceContext,
  type SessionId,
  type TraceContext,
  type TraceId,
} from "@zcode/contracts";
import {
  SessionControlError,
  type AccessGrant,
  type CliScope,
  type CliTrustedContext,
} from "@zcode/session-control/contracts";
import { assertOpen, digest, scopeKey, type ControlState } from "./models.js";
import { owner } from "./owners.js";

/** fence 把 manager 代际与调用者根绑在一起：旧绑定在新代际里的回执不能复用。 */
export function fence(state: ControlState, ctx: CliTrustedContext): string {
  return digest([state.epoch, ctx.callerId, ctx.rootSession]);
}
export function validate(
  state: ControlState,
  ctx: CliTrustedContext,
  grant: AccessGrant<CliScope>,
): void {
  assertOpen(state);
  owner(state, ctx.rootSession);
  if (
    grant.fence !== fence(state, ctx) ||
    scopeKey(grant.scope) !== scopeKey(state.workspace) ||
    !ctx.allowedScopes.some((scope) => scopeKey(scope) === scopeKey(state.workspace))
  ) {
    throw new SessionControlError(
      "forbidden",
      "CLI authorization scope or owner generation changed",
    );
  }
}
/** 读本机会话库只要求调用者 fence 有效；写操作仍用 validate 校验 owner 与 workspace。 */
export function validateRead(
  state: ControlState,
  ctx: CliTrustedContext,
  grant: AccessGrant<CliScope>,
): void {
  if (!ctx.readAnyLocalSession) return validate(state, ctx, grant);
  assertOpen(state);
  owner(state, ctx.rootSession);
  if (grant.fence !== fence(state, ctx))
    throw new SessionControlError("forbidden", "CLI owner generation changed");
}
export function commandId(ctx: CliTrustedContext, requestId: string): string {
  return `cli-control-${digest([ctx.callerId, ctx.rootSession, requestId])}`;
}
export function trace(
  state: ControlState,
  ctx: CliTrustedContext,
  sessionId: SessionId,
): TraceContext {
  return createRootTraceContext({
    traceId: (ctx.traceId ?? state.roots.get(ctx.rootSession.sessionId)!.app.traceId) as TraceId,
    sessionId,
  });
}
/**
 * 幂等回执：同一 requestId 只执行一次，重试复用同一结果；请求体不同则 conflict。
 * 这不是第二份 accepted queue——登记同步发生、只保存结果承诺，执行仍由 Core 的准入决定。
 */
export function remember<T>(
  state: ControlState,
  ctx: CliTrustedContext,
  action: string,
  input: { requestId: string },
  run: () => Promise<T>,
): Promise<T> {
  const key = digest([ctx.callerId, ctx.rootSession, input.requestId]);
  const fingerprint = digest([action, input]);
  const previous = state.receipts.get(key);
  if (previous) {
    if (previous.fingerprint !== fingerprint)
      throw new SessionControlError("conflict", "requestId already belongs to a different request");
    return previous.result as Promise<T>;
  }
  if (state.receipts.size >= state.maxRequests)
    throw new SessionControlError(
      "unavailable",
      "CLI request capacity reached; existing receipts remain queryable",
    );
  // 同步登记在调用任何异步工厂之前，重入与重试只能复用同一请求。
  const result = Promise.resolve().then(run);
  state.receipts.set(key, { fingerprint, result });
  state.pendingMutations.add(result);
  const settle = () => {
    state.pendingMutations.delete(result);
  };
  void result.then(settle, settle);
  return result;
}
