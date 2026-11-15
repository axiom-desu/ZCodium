import { randomUUID } from "node:crypto";
import { HostResponseTypes } from "@zcode/shared";
import type {
  ExtensionHostStartPayload,
  ExtensionHostStartResultPayload,
  ExtensionHostStopPayload,
  ExtensionHostStopResultPayload,
} from "@zcode/shared/extension-host";

/**
 * Host ↔ Main 的扩展进程生命周期桥。
 *
 * Host 只请求「按窗口与代际拉起/停止进程」，授权、能力与槽位不经过 Main。
 * 请求与响应按 requestId 配对；Host 退出时未完成请求立即失败，不靠超时收尾。
 */
interface ExtensionHostRequestBridge {
  start(input: Omit<ExtensionHostStartPayload, "requestId">): Promise<{ pid: number }>;
  stop(input: Omit<ExtensionHostStopPayload, "requestId">): Promise<boolean>;
  acceptStart(result: ExtensionHostStartResultPayload): void;
  acceptStop(result: ExtensionHostStopResultPayload): void;
  dispose(): void;
}

type Pending =
  | { kind: "start"; resolve(value: { pid: number }): void; reject(error: Error): void }
  | { kind: "stop"; resolve(value: boolean): void; reject(error: Error): void };

export function createExtensionHostRequestBridge(deps: {
  send(
    message:
      | (ExtensionHostStartPayload & { type: typeof HostResponseTypes.ExtensionHostStartRequest })
      | (ExtensionHostStopPayload & { type: typeof HostResponseTypes.ExtensionHostStopRequest }),
  ): void;
  createRequestId?: () => string;
}): ExtensionHostRequestBridge {
  const pending = new Map<string, Pending>();
  let closed = false;

  function register(requestId: string, entry: Pending): void {
    pending.set(requestId, entry);
  }

  return {
    start(input) {
      if (closed) return Promise.reject(new Error("Extension host bridge closed"));
      const requestId = (deps.createRequestId ?? randomUUID)();
      return new Promise((resolve, reject) => {
        register(requestId, { kind: "start", resolve, reject });
        try {
          deps.send({
            type: HostResponseTypes.ExtensionHostStartRequest,
            requestId,
            ...input,
          });
        } catch (error) {
          pending.delete(requestId);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    stop(input) {
      if (closed) return Promise.reject(new Error("Extension host bridge closed"));
      const requestId = (deps.createRequestId ?? randomUUID)();
      return new Promise((resolve, reject) => {
        register(requestId, { kind: "stop", resolve, reject });
        try {
          deps.send({
            type: HostResponseTypes.ExtensionHostStopRequest,
            requestId,
            ...input,
          });
        } catch (error) {
          pending.delete(requestId);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    acceptStart(result) {
      const entry = pending.get(result.requestId);
      if (!entry || entry.kind !== "start") return;
      pending.delete(result.requestId);
      if (result.ok) entry.resolve({ pid: result.pid });
      else entry.reject(new Error(result.error));
    },
    acceptStop(result) {
      const entry = pending.get(result.requestId);
      if (!entry || entry.kind !== "stop") return;
      pending.delete(result.requestId);
      if (result.ok) entry.resolve(result.stopped);
      else entry.reject(new Error(result.error));
    },
    dispose() {
      closed = true;
      for (const entry of pending.values()) entry.reject(new Error("Extension host bridge closed"));
      pending.clear();
    },
  };
}
