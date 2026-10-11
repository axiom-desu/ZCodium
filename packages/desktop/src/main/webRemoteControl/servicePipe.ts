import type { MessagePortLike, MessagePortPayload } from "@zcode/rpc";
import type { WebRemoteControlLogger } from "./logger.js";

/**
 * 手机 ↔ 桌面已有 Host 的**透明转发管道**（字节管道）。
 *
 * 为什么这里不做「终止代理」、不在 main 里建 ChannelClient/ChannelServer：
 *
 * 1. **服务端唯一在 Host 进程。** 真正的 service ChannelServer 由 Host 侧
 *    `packages/desktop/src/host/index.ts` 的 `exposeServicesOnMessagePort` 建在
 *    `attachment.port` 的对端（`port2`）上；main 不承载 task/session 业务状态
 *    （AGENTS.md 的进程边界）。过去在 main 又把同一个方向接了一个 `ChannelClient`，
 *    结果链路两端都是客户端、没有服务端：手机端 `ChannelClient` 永远收不到
 *    `Initialize`，`readSessionMessages` / `sendPrompt` 这类调用永远不 settle。
 * 2. **流控必须端到端。** `MessagePortProtocol` 会把
 *    `{__zcodeRpcControl:"connection-flow-v1"}` 流控消息分流掉；一旦插在 main 中间，
 *    手机与 Host 的 connection-flow 就被截断。所以流控消息在这里与二进制一样当普通
 *    payload 透传。
 * 3. **订阅状态属于两端。** `EventListen` / `EventFire` 的订阅由手机与 Host 各自持有，
 *    main 不能代替它们建立或销毁订阅。
 *
 * 所以本模块只做两件对称的事：
 * - `hostPort` 上收到的 Host → 手机消息，交给 `sendToMobile` 走既有的分片/重传/发射；
 * - `acceptMobileMessage` 收到的手机 → Host 消息，直接 `hostPort.postMessage`。
 */
export function createWebRemoteControlServicePipe(params: {
  /** 由调用方 `wrapElectronPort(attachment.port)` 传入；main 侧的 Host port 端。 */
  hostPort: MessagePortLike;
  /** Host → 手机：编码分片 + 重传入队 + 发射；返回是否确实交给了传输层。 */
  sendToMobile(payload: MessagePortPayload): boolean;
  attachmentId: string;
  logger: WebRemoteControlLogger;
}): { acceptMobileMessage(payload: MessagePortPayload): void; dispose(): void } {
  const { hostPort, sendToMobile, attachmentId, logger } = params;
  let disposed = false;
  // 「没发出去就 warn 一次」：手机暂时不在线时 Host 会持续吐消息，逐条 warn 会刷屏；
  // 只保留首次诊断，之后同向丢弃不再重复。帧本身仍在重传缓冲里，重连后会重放。
  let warnedUndelivered = false;

  const handleHostMessage = (event: { data: MessagePortPayload }): void => {
    if (disposed) return;
    if (sendToMobile(event.data)) return;
    if (warnedUndelivered) return;
    warnedUndelivered = true;
    logger.warn("[web-remote-control] host pipe message dropped: mobile not attached", {
      attachmentId,
    });
  };

  hostPort.addEventListener("message", handleHostMessage);

  return {
    acceptMobileMessage(payload: MessagePortPayload): void {
      if (disposed) return;
      hostPort.postMessage(payload);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      hostPort.removeEventListener("message", handleHostMessage);
    },
  };
}
