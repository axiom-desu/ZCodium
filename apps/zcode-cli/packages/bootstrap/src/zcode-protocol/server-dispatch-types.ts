// 协议分派层的共享契约：谁持有状态、谁只做分派。
// server 仍是唯一 owner（sessions、pending 反向请求、post-response outbox、
// operation AbortController 表都在它手里），分派模块只拿到显式端口。
import type {
  ZCodeProtocolNotification,
  ZCodeProtocolRequest,
  ZCodeProtocolRequestId,
} from "@zcode/shared";
import { ProtocolRequestError, type ZCodeProtocolAgentServerContext } from "./server-types.js";

export type ZCodeProtocolOutboundMessage = ZCodeProtocolNotification | ZCodeProtocolRequest;

export interface ZCodeProtocolPostResponseBatch {
  readonly messages: readonly ZCodeProtocolOutboundMessage[];
  commit(): boolean;
}

/**
 * subscribe/resync 的 initial frame 必须写在 response line 之后，且按 request id 隔离。
 * 分派模块只调用 setPostResponseBatch 交付，不自己保存 batch。
 */
export interface ProtocolRequestDispatchHost {
  readonly context: ZCodeProtocolAgentServerContext;
  requireV4Gateway(): NonNullable<ZCodeProtocolAgentServerContext["v4Gateway"]>;
  setPostResponseBatch(
    requestId: ZCodeProtocolRequestId,
    batch: ZCodeProtocolPostResponseBatch,
  ): void;
  /** 插件同步/安装类操作的取消登记表；owner 仍是 server 实例。 */
  readonly pluginOperationControllers: Map<string, AbortController>;
  /** workspace generateText 的取消登记表；owner 仍是 server 实例。 */
  readonly workspaceGenerateTextControllers: Map<string, AbortController>;
}

/** 分派未命中当前命名空间，交由下一层继续判定。 */
export const UNHANDLED_REQUEST = Symbol("zcode-protocol.unhandled-request");

export function requireV4Gateway(
  host: ProtocolRequestDispatchHost,
): NonNullable<ZCodeProtocolAgentServerContext["v4Gateway"]> {
  if (!host.context.v4Gateway) {
    throw new ProtocolRequestError(-32603, "v4 gateway is not initialized");
  }
  return host.context.v4Gateway;
}
