import { extractMarkdownArtifactImageRefs } from "@zcode/shared";
import type {
  AttachmentRef,
  V4AttachmentBeginResult,
  V4AttachmentChunkResult,
  V4AttachmentCommitResult,
  V4AttachmentPreviewSourceResult,
  V4AttachmentReadResult,
  V4ConversationAttachmentReadResult,
  V4ConversationAttachmentStatResult,
} from "@zcode/shared/zcode-protocol-v4";
import {
  PROTOCOL_V4_LIMITS,
  ZCODE_ATTACHMENT_FAULT_CODES,
  ZCodeAttachmentFaultError,
  v4AttachmentAbortParamsSchema,
  v4AttachmentBeginParamsSchema,
  v4AttachmentChunkParamsSchema,
  v4AttachmentCommitParamsSchema,
  v4AttachmentPreviewSourceParamsSchema,
  v4AttachmentPreviewSourceResultSchema,
  v4AttachmentReadParamsSchema,
  v4ConversationAttachmentReadParamsSchema,
  v4ConversationAttachmentReadResultSchema,
  v4ConversationAttachmentStatParamsSchema,
  v4ConversationAttachmentStatResultSchema,
} from "@zcode/shared/zcode-protocol-v4";
import { ConversationTopicPublisher } from "./conversation-topic-publisher.js";
import type { GatewayState } from "./v4-gateway-state.js";
import { artifactRefBelongsToSession, toShareStatFault } from "./v4-gateway-contract.js";

/** 本域实际使用的根状态窄面。 */
type AttachmentsDomainState = Pick<
  GatewayState,
  | "attachmentUploads"
  | "binaryReadCache"
  | "coldResume"
  | "configPublishers"
  | "controlReservations"
  | "createLogEpoch"
  | "detachedLiveSessions"
  | "disposed"
  | "flushStates"
  | "host"
  | "hydratedSessions"
  | "hydrationBuffers"
  | "hydrationInFlight"
  | "indexFanoutThrottle"
  | "indexPublishers"
  | "localTtft"
  | "now"
  | "pausedConnections"
  | "projectionEventCommitWaiters"
  | "publishers"
  | "rawSequenceStates"
  | "readyFlights"
>;
import * as hydration from "./v4-gateway-hydration.js";

/** begin 只 admission metadata，不解码/暂存 full payload。 */
export async function attachmentBegin(
  ctx: AttachmentsDomainState,
  rawParams: unknown,
): Promise<V4AttachmentBeginResult> {
  const params = v4AttachmentBeginParamsSchema.parse(rawParams);
  if (!ctx.host.putSessionAttachment) {
    throw new Error("fault.attachment.putUnsupported");
  }
  if (!ctx.host.sessionExists(params.sessionId)) {
    await ctx.coldResume.ensureResumed(params.sessionId);
  }
  return ctx.attachmentUploads.begin(params);
}

export async function attachmentChunk(
  ctx: AttachmentsDomainState,
  rawParams: unknown,
): Promise<V4AttachmentChunkResult> {
  return ctx.attachmentUploads.chunk(v4AttachmentChunkParamsSchema.parse(rawParams));
}

export function attachmentCommit(
  ctx: AttachmentsDomainState,
  rawParams: unknown,
): Promise<V4AttachmentCommitResult> {
  return ctx.attachmentUploads.commit(v4AttachmentCommitParamsSchema.parse(rawParams));
}

export async function attachmentAbort(
  ctx: AttachmentsDomainState,
  rawParams: unknown,
): Promise<void> {
  await ctx.attachmentUploads.abort(v4AttachmentAbortParamsSchema.parse(rawParams));
}

export async function attachmentRead(
  ctx: AttachmentsDomainState,
  rawParams: unknown,
): Promise<V4AttachmentReadResult> {
  const params = v4AttachmentReadParamsSchema.parse(rawParams);
  if (!ctx.host.readSessionAttachment) {
    throw new Error("fault.attachment.readUnsupported");
  }
  const existingReady = ctx.readyFlights.get(params.sessionId);
  const publisher = existingReady
    ? await existingReady
    : !ctx.host.sessionExists(params.sessionId)
      ? await hydration.ensureColdReadyPublisher(ctx, params.sessionId)
      : await hydration.hydratePublisher(ctx, params.sessionId);
  const resolution = resolveReadableMediaAttachment(
    ctx,
    publisher,
    params.sessionId,
    params.ref,
    params.target,
    params.attachmentIndex,
  );
  if (!resolution) {
    // renderer 传来的 ref 不能直接成为文件路径；必须先由当前 session
    // 的权威 user row 证明归属，避免跨 session 或任意路径读取。
    throw new Error("fault.attachment.previewRefNotAuthorized");
  }

  const payload = await ctx.binaryReadCache.readAttachment(
    params.sessionId,
    params.ref,
    resolution.attachment.mime,
    resolution.messageId,
    resolution.attachmentIndex,
  );
  if (params.offset > payload.bytes.byteLength) {
    throw new Error("fault.attachment.previewRangeInvalid");
  }
  const end = Math.min(payload.bytes.byteLength, params.offset + params.limit);
  const chunk = payload.bytes.subarray(params.offset, end);
  return {
    dataBase64: Buffer.from(chunk).toString("base64"),
    mediaType: payload.mediaType,
    totalBytes: payload.bytes.byteLength,
    nextOffset: end < payload.bytes.byteLength ? end : null,
  };
}

export async function conversationAttachmentRead(
  ctx: AttachmentsDomainState,
  rawParams: unknown,
): Promise<V4ConversationAttachmentReadResult> {
  const params = v4ConversationAttachmentReadParamsSchema.parse(rawParams);
  if (!ctx.host.readSessionAttachment) {
    throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.readUnsupported);
  }
  const existingReady = ctx.readyFlights.get(params.sessionId);
  const publisher = existingReady
    ? await existingReady
    : !ctx.host.sessionExists(params.sessionId)
      ? await hydration.ensureColdReadyPublisher(ctx, params.sessionId)
      : await hydration.hydratePublisher(ctx, params.sessionId);
  const row = publisher
    .getSnapshot()
    .rows.window.find(
      (candidate) =>
        candidate.rowId === params.target.rowId && candidate.entityId === params.target.entityId,
    );
  if (row?.kind !== "userInput") {
    throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.shareReadNotAuthorized);
  }
  const attachment = row.attachments?.[params.attachmentIndex];
  if (!attachment || (attachment.ref !== params.ref && attachment.previewRef !== params.ref)) {
    throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.shareReadNotAuthorized);
  }
  const messageId = publisher.getMessageIdForRow(row.rowId) ?? undefined;
  let payload: { bytes: Uint8Array; mediaType: string };
  try {
    payload = await ctx.binaryReadCache.readAttachment(
      params.sessionId,
      params.ref,
      attachment.mime,
      messageId,
      params.attachmentIndex,
      true,
    );
  } catch (error) {
    throw toShareStatFault(error);
  }
  if (params.offset > payload.bytes.byteLength) {
    throw new Error("fault.attachment.previewRangeInvalid");
  }
  const end = Math.min(payload.bytes.byteLength, params.offset + params.limit);
  const chunk = payload.bytes.subarray(params.offset, end);
  return v4ConversationAttachmentReadResultSchema.parse({
    dataBase64: Buffer.from(chunk).toString("base64"),
    mediaType: payload.mediaType,
    totalBytes: payload.bytes.byteLength,
    nextOffset: end < payload.bytes.byteLength ? end : null,
  });
}

export async function conversationAttachmentStat(
  ctx: AttachmentsDomainState,
  rawParams: unknown,
): Promise<V4ConversationAttachmentStatResult> {
  const params = v4ConversationAttachmentStatParamsSchema.parse(rawParams);
  if (!ctx.host.statSessionAttachment) {
    throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.statUnsupported);
  }
  const existingReady = ctx.readyFlights.get(params.sessionId);
  const publisher = existingReady
    ? await existingReady
    : !ctx.host.sessionExists(params.sessionId)
      ? await hydration.ensureColdReadyPublisher(ctx, params.sessionId)
      : await hydration.hydratePublisher(ctx, params.sessionId);
  const row = publisher
    .getSnapshot()
    .rows.window.find(
      (candidate) =>
        candidate.rowId === params.target.rowId && candidate.entityId === params.target.entityId,
    );
  if (row?.kind !== "userInput") {
    throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.shareStatNotAuthorized);
  }
  const attachment = row.attachments?.[params.attachmentIndex];
  if (!attachment || (attachment.ref !== params.ref && attachment.previewRef !== params.ref)) {
    throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.shareStatNotAuthorized);
  }
  const messageId = publisher.getMessageIdForRow(row.rowId) ?? undefined;
  let result: { totalBytes: number; mediaType: string; mtimeMs?: number };
  try {
    result = await ctx.host.statSessionAttachment(params.sessionId, {
      ref: params.ref,
      mime: attachment.mime,
      ...(messageId ? { messageId } : {}),
      attachmentIndex: params.attachmentIndex,
    });
  } catch (error) {
    // 「附件确实不在了」是 share 预检唯一能确定判定为跳过的分类，必须以稳定码上抛；
    // 否则 service 只能猜错误文本。
    throw toShareStatFault(error);
  }
  // stat 结果曾被 30MiB 的 schema 上限卡住，超大附件在这里抛 ZodError，
  // 于是 share 预检把「已知容量超限」这个确定阻断降级成 deferred 并静默丢内容。
  // 上限放宽后仍需要一个显式出口：真的超过协议可表达范围时给出稳定码。
  if (result.totalBytes > PROTOCOL_V4_LIMITS.attachmentStatMaxBytes) {
    throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.shareStatTooLarge);
  }
  return v4ConversationAttachmentStatResultSchema.parse(result);
}

export async function attachmentPreviewSource(
  ctx: AttachmentsDomainState,
  rawParams: unknown,
): Promise<V4AttachmentPreviewSourceResult> {
  const params = v4AttachmentPreviewSourceParamsSchema.parse(rawParams);
  const existingReady = ctx.readyFlights.get(params.sessionId);
  const publisher = existingReady
    ? await existingReady
    : !ctx.host.sessionExists(params.sessionId)
      ? await hydration.ensureColdReadyPublisher(ctx, params.sessionId)
      : await hydration.hydratePublisher(ctx, params.sessionId);
  const resolution = resolveReadableMediaAttachment(
    ctx,
    publisher,
    params.sessionId,
    params.ref,
    params.target,
    params.attachmentIndex,
  );
  if (!resolution) {
    throw new Error("fault.attachment.previewRefNotAuthorized");
  }
  if (
    params.clientMode !== "desktop-continuous" ||
    !resolution.attachment.mime.startsWith("video/") ||
    !ctx.host.resolveSessionAttachmentPreviewSource
  ) {
    return { kind: "chunked" };
  }
  const result = await ctx.host.resolveSessionAttachmentPreviewSource(params.sessionId, {
    ref: params.ref,
    mime: resolution.attachment.mime,
    ...(resolution.messageId ? { messageId: resolution.messageId } : {}),
    ...(resolution.attachmentIndex !== undefined
      ? { attachmentIndex: resolution.attachmentIndex }
      : {}),
  });
  return v4AttachmentPreviewSourceResultSchema.parse(result);
}

function resolveReadableMediaAttachment(
  ctx: AttachmentsDomainState,
  publisher: ConversationTopicPublisher,
  sessionId: string,
  ref: string,
  target?: { rowId: number; entityId: string },
  attachmentIndex?: number,
): { attachment: AttachmentRef; messageId?: string; attachmentIndex?: number } | null {
  const isPreviewable = (attachment: AttachmentRef) => {
    const mime = attachment.mime.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    return mime.startsWith("image/") || mime.startsWith("video/") || mime === "application/pdf";
  };
  const matchesRef = (attachment: AttachmentRef) =>
    attachment.ref === ref || attachment.previewRef === ref;
  if (target && attachmentIndex !== undefined) {
    const row = publisher
      .getSnapshot()
      .rows.window.find(
        (candidate) => candidate.rowId === target.rowId && candidate.entityId === target.entityId,
      );
    if (row?.kind !== "userInput") return null;
    const attachment = row.attachments?.[attachmentIndex];
    if (!attachment || !isPreviewable(attachment) || !matchesRef(attachment)) {
      return null;
    }
    // 热态 renderer 可能还持有 original ref，而 hydrate 后的权威 row 已补
    // previewRef；两者属于同一个 row/index，授权不能因投影时序不同而误判为跨行读取。
    const messageId = publisher.getMessageIdForRow(row.rowId);
    return {
      attachment,
      attachmentIndex,
      ...(messageId ? { messageId } : {}),
    };
  }

  // 旧 renderer 没有 row target，无法按消息定位持久 artifact；一旦
  // previewRef 存在就只能授权该 durable ref，不能重新放行可变的原始路径。
  for (const row of publisher.getSnapshot().rows.window) {
    if (row.kind === "userInput") {
      for (const attachment of row.attachments ?? []) {
        if (!isPreviewable(attachment)) continue;
        if ((attachment.previewRef ?? attachment.ref) === ref) return { attachment };
      }
    }
    if (
      row.kind === "assistantText" &&
      artifactRefBelongsToSession(ref, sessionId) &&
      extractMarkdownArtifactImageRefs(row.text).includes(ref)
    ) {
      // assistant Markdown 可以引用工具产出的 session artifact，
      // 但旧授权只查看 userInput.attachments，导致合法图片到 UI 后被 harden
      // 拦截。仍以当前 session 的权威投影做精确 ref 授权，绝不接受 renderer
      // 自报的任意 artifact/path。Markdown 是模型可控文本，所以 URI authority
      // 还必须与当前请求 session 精确匹配；仅“当前投影里出现过”不能证明它有权
      // 读取另一个 session 的 artifact。
      return {
        attachment: {
          ref,
          fileName: "assistant-image",
          mime: "image/*",
          bytes: 0,
        },
      };
    }
  }
  return null;
}
