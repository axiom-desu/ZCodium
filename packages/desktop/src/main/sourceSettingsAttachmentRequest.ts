/**
 * Source 设置 attachment 的 Main 入口校验与派发。
 *
 * 只做三件事：校验 payload/source id、绑定发起请求的当前窗口、调用既有
 * attachSourceSettings。这里不能接触 Agent、任务队列或任意 workspace scope；
 * 单独拆出是为了让窗口/来源校验可单测，而不是在 IPC 回调里堆不可测逻辑。
 */
interface SourceSettingsAttachmentDispatch<TWindow, TSender> {
  rawPayload: unknown;
  sender: TSender;
  findWindow(sender: TSender): TWindow | null;
  attach(win: TWindow, sourceServerId: string): { attachmentId: string };
}

export function parseSourceSettingsSourceServerId(rawPayload: unknown): string {
  const sourceServerId =
    typeof rawPayload === "string"
      ? rawPayload.trim()
      : rawPayload &&
          typeof rawPayload === "object" &&
          typeof (rawPayload as { sourceServerId?: unknown }).sourceServerId === "string"
        ? (rawPayload as { sourceServerId: string }).sourceServerId.trim()
        : "";
  if (!sourceServerId) {
    throw new Error("Invalid source-settings attachment payload");
  }
  return sourceServerId;
}

export function dispatchSourceSettingsAttachment<TWindow, TSender>(
  input: SourceSettingsAttachmentDispatch<TWindow, TSender>,
): { attachmentId: string } {
  const sourceServerId = parseSourceSettingsSourceServerId(input.rawPayload);
  const win = input.findWindow(input.sender);
  if (!win) throw new Error("未找到当前窗口，无法创建 Source 设置 attachment");
  return input.attach(win, sourceServerId);
}
