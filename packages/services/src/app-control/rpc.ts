import {
  appControlCancelMethod,
  appControlCancelParamsSchema,
  appControlProtocol,
  type AppControlAction,
} from "@zcode/session-control/contracts";
import { SessionControlError } from "@zcode/session-control/contracts";
import type { AppControlBinding, AppControlService } from "./contract.js";

interface ReverseClient {
  respond(id: string | number, result: unknown): Promise<void>;
  respondError(id: string | number, error: { code: number; message: string }): Promise<void>;
}

interface InboundRequest {
  id: string | number;
  method: string;
  params?: unknown;
}

/**
 * Host 侧反向 RPC：CLI 进程发来的 `appControl/*` 请求在这里落到唯一 App control 服务。
 *
 * 身份只由连接事实构造（`bind`），请求参数只提供意图与输入；`appControl/cancel`
 * 只取消同一个实际连接里在途调用的观察，不中断目标任务。
 */
export function createAppControlRequestHandler(options: {
  client: ReverseClient;
  service: () => AppControlService | undefined;
  bind: (request: {
    callerSessionId: string;
    callId: string;
    turnId?: string;
    signal: AbortSignal;
  }) => Promise<AppControlBinding>;
  onResponseError: (error: unknown) => void;
}): { handle(request: InboundRequest): boolean } {
  const pending = new Map<string, { controller: AbortController; binding?: AppControlBinding }>();
  let disposed = false;

  async function dispatch(
    action: AppControlAction,
    service: AppControlService,
    binding: AppControlBinding,
    input: unknown,
  ) {
    const context = await service.bind(binding);
    const endpoint = appControlProtocol[action];
    const parsed = endpoint.params.parse({
      callerSessionId: binding.callerSessionId,
      callId: binding.callId,
      ...(binding.turnId ? { turnId: binding.turnId } : {}),
      input,
    });
    // 每个分支的输入已在上面按该分支的 endpoint schema 解析；这里只做封闭分派。
    const value = parsed.input as never;
    switch (action) {
      case "listProjects":
        return service.control.listProjects(context, value);
      case "listSessions":
        return service.control.listSessions(context, value);
      case "readSession":
        return service.control.readSession(context, value);
      case "createSession":
        return service.control.createSession(context, value);
      case "forkSession":
        return service.control.forkSession(context, value);
      case "sendToSession":
        return service.control.sendToSession(context, value);
      case "waitSessions":
        return service.control.waitSessions(context, value);
      case "interruptSession":
        return service.control.interruptSession(context, value);
      case "renameSession":
        return service.control.renameSession(context, value);
      case "openSession":
        return service.control.openSession(context, value);
      case "setSessionArchived":
        return service.control.setSessionArchived(context, value);
      case "setSessionPinned":
        return service.control.setSessionPinned(context, value);
    }
  }

  return {
    handle(request) {
      if (disposed) return false;
      if (request.method === appControlCancelMethod) {
        const parsed = appControlCancelParamsSchema.safeParse(request.params);
        if (!parsed.success) {
          void options.client
            .respondError(request.id, { code: -32602, message: "Invalid appControl cancellation" })
            .catch(options.onResponseError);
          return true;
        }
        const key = JSON.stringify([parsed.data.callerSessionId, parsed.data.callId]);
        const call = pending.get(key);
        try {
          // 已绑定的调用还要复检连接代际；不能取消另一条连接的调用。
          call?.binding?.assertCurrent();
          call?.controller.abort();
        } catch (error) {
          options.onResponseError(error);
        }
        void options.client
          .respond(request.id, { cancelled: call !== undefined })
          .catch(options.onResponseError);
        return true;
      }
      const action = (Object.keys(appControlProtocol) as AppControlAction[]).find(
        (candidate) => appControlProtocol[candidate].method === request.method,
      );
      if (!action) return false;
      const endpoint = appControlProtocol[action];
      const parsed = endpoint.params.safeParse(request.params);
      if (!parsed.success) {
        void options.client
          .respondError(request.id, {
            code: -32602,
            message: "Invalid App control request params",
          })
          .catch(options.onResponseError);
        return true;
      }
      const service = options.service();
      if (!service) {
        void options.client
          .respond(request.id, {
            ok: false,
            error: { code: "unavailable", message: "App control is unavailable on this Host" },
          })
          .catch(options.onResponseError);
        return true;
      }
      const key = JSON.stringify([parsed.data.callerSessionId, parsed.data.callId]);
      if (pending.has(key)) {
        void options.client
          .respond(request.id, {
            ok: false,
            error: { code: "conflict", message: "The same call is already in flight" },
          })
          .catch(options.onResponseError);
        return true;
      }
      const controller = new AbortController();
      const entry: { controller: AbortController; binding?: AppControlBinding } = { controller };
      pending.set(key, entry);
      void (async () => {
        try {
          const binding = await options.bind({
            callerSessionId: parsed.data.callerSessionId,
            callId: parsed.data.callId,
            ...(parsed.data.turnId ? { turnId: parsed.data.turnId } : {}),
            signal: controller.signal,
          });
          entry.binding = binding;
          binding.assertCurrent();
          // 成功回执也走同一个封闭结果 schema：CLI 端只认 `{ok:true,result}`，
          // 直接回裸 result 会让真实成功路径在协议边界被拒。
          const result = endpoint.result.parse({
            ok: true,
            result: await dispatch(action, service, binding, parsed.data.input),
          });
          await options.client.respond(request.id, result);
        } catch (error) {
          const code = error instanceof SessionControlError ? error.code : ("unavailable" as const);
          const message =
            error instanceof SessionControlError ? error.message : "App control request failed";
          await options.client
            .respond(request.id, { ok: false, error: { code, message } })
            .catch(options.onResponseError);
        } finally {
          pending.delete(key);
        }
      })();
      return true;
    },
  };
}
