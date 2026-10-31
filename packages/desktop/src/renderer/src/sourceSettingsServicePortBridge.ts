import { InternalChannels } from "@zcode/shared";

interface SourceSettingsServicePortRegistration {
  attachmentId: string;
  port: MessagePort;
  sourceServerId: string;
}

/**
 * source-settings attachment 的 renderer 侧解析。
 * MessagePort 不能经 contextBridge 传递；preload 只做 window.postMessage transfer，
 * 这里只接受当前窗口、带 attachmentId/sourceServerId 的真实端口。
 */
export function parseSourceSettingsServicePortMessage(
  event: MessageEvent,
): SourceSettingsServicePortRegistration | null {
  if (
    typeof event.data !== "object" ||
    event.data === null ||
    !("type" in event.data) ||
    event.data.type !== InternalChannels.SourceSettingsServicePort
  ) {
    return null;
  }
  const port = event.ports[0];
  const attachmentId = typeof event.data.attachmentId === "string" ? event.data.attachmentId : null;
  const sourceServerId =
    typeof event.data.sourceServerId === "string" ? event.data.sourceServerId : null;
  if (!port || !attachmentId || !sourceServerId) return null;
  return { attachmentId, port, sourceServerId };
}
