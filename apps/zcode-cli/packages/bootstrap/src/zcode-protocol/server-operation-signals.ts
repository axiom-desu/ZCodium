// 可取消的协议 operation：插件同步/安装与 workspace generateText。
// Map 本体仍由 server 持有（取消与 shutdown 都经它 abort），这里只提供
// 登记/释放/中止的确定性顺序，避免把两个 Map 的语义混成一份抽象。
import type { ZCodeProtocolRequest } from "@zcode/shared";
import {
  zcodePluginsCancelOperationParamsSchema,
  zcodeWorkspaceCancelGenerateTextParamsSchema,
} from "@zcode/shared";
import { ProtocolRequestError, parseParams } from "./server-types.js";

function getOperationId(params: unknown): string | undefined {
  if (!params || typeof params !== "object") return undefined;
  const operationId = (params as { operationId?: unknown }).operationId;
  return typeof operationId === "string" && operationId.trim().length > 0
    ? operationId.trim()
    : undefined;
}

export async function withPluginOperationSignal<T>(
  controllers: Map<string, AbortController>,
  request: ZCodeProtocolRequest,
  run: (signal?: AbortSignal) => Promise<T>,
): Promise<T> {
  const operationId = getOperationId(request.params);
  if (!operationId) return await run();

  const controller = new AbortController();
  controllers.set(operationId, controller);
  try {
    return await run(controller.signal);
  } finally {
    if (controllers.get(operationId) === controller) {
      controllers.delete(operationId);
    }
  }
}

export function cancelPluginOperation(
  controllers: Map<string, AbortController>,
  rawParams: unknown,
) {
  const params = parseParams(zcodePluginsCancelOperationParamsSchema, rawParams);
  const controller = controllers.get(params.operationId);
  if (!controller) return { operationId: params.operationId, cancelled: false };
  // 插件同步的可取消能力必须保留在 V4 server；仅按 operationId 中止对应链路。
  controller.abort();
  controllers.delete(params.operationId);
  return { operationId: params.operationId, cancelled: true };
}

export async function withWorkspaceGenerateTextSignal<T>(
  controllers: Map<string, AbortController>,
  request: ZCodeProtocolRequest,
  run: (signal?: AbortSignal) => Promise<T>,
): Promise<T> {
  const operationId = getOperationId(request.params);
  if (!operationId) return await run();

  if (controllers.has(operationId)) {
    // 重复 operationId 会覆盖首个请求的 AbortController，导致首个请求失去取消能力。
    // 活跃 operationId 必须保持唯一；请求结束后 finally 会释放，之后才允许复用。
    throw new ProtocolRequestError(
      -32600,
      `Workspace generate operation is already active: ${operationId}`,
    );
  }

  const controller = new AbortController();
  controllers.set(operationId, controller);
  try {
    return await run(controller.signal);
  } finally {
    if (controllers.get(operationId) === controller) {
      controllers.delete(operationId);
    }
  }
}

export function cancelWorkspaceGenerateText(
  controllers: Map<string, AbortController>,
  rawParams: unknown,
) {
  const params = parseParams(zcodeWorkspaceCancelGenerateTextParamsSchema, rawParams);
  const controller = controllers.get(params.operationId);
  if (!controller) return { operationId: params.operationId, cancelled: false };
  controller.abort(new DOMException("Workspace model request cancelled", "AbortError"));
  controllers.delete(params.operationId);
  return { operationId: params.operationId, cancelled: true };
}
