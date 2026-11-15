import { PROTOCOL_V4_LIMITS } from "@zcode/shared/zcode-protocol-v4";
import type {
  BotConfig,
  BotInboundAttachment,
  BotsConfigFile,
  ZCodeProtocolTrace,
} from "@zcode/shared";
import { topicResourceAuthorizationId, type BotsTopicArchive } from "./topicArchive.js";

/** 只由 Host 侧连接身份补齐：模型不能提交这些字段。 */
export interface TopicResourceRequest {
  taskId: string;
  inputId?: string;
  messageId: string;
  resourceIndex: number;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  signal?: AbortSignal;
  trace?: ZCodeProtocolTrace;
}

export interface TopicResourceTarget {
  botId: string;
  provider: BotConfig["provider"];
  chatId: string;
  providerMessageId: string;
}

export interface TopicResourceDependencies {
  archive: BotsTopicArchive;
  readConfig(): Promise<BotsConfigFile>;
  download(
    bot: BotConfig,
    attachment: BotInboundAttachment,
    target: TopicResourceTarget,
    signal: AbortSignal,
  ): Promise<{ attachment: BotInboundAttachment; data: Uint8Array }>;
}

export interface TopicResourceReadResult {
  attachment: BotInboundAttachment;
  data: Uint8Array;
}

/** 授权复核：bot 仍启用、provider/凭据/群未换代，且快照仍属本任务。 */
export async function authorizeTopicResource(
  request: TopicResourceRequest,
  deps: Pick<TopicResourceDependencies, "archive" | "readConfig">,
): Promise<{
  lookup: Awaited<ReturnType<BotsTopicArchive["lookup"]>>;
  bot: BotConfig;
  config: BotsConfigFile;
}> {
  const lookup = await deps.archive.lookup({
    taskId: request.taskId,
    workspacePath: request.workspacePath,
    ...(request.workspaceIdentity ? { workspaceIdentity: request.workspaceIdentity } : {}),
    ...(request.inputId ? { inputId: request.inputId } : {}),
    messageId: request.messageId,
    resourceIndex: request.resourceIndex,
  });
  const config = await deps.readConfig();
  const bot = config.bots.find((candidate) => candidate.id === lookup.snapshot.botId);
  if (
    !bot ||
    !bot.enabled ||
    (bot.provider !== "feishu" && bot.provider !== "lark") ||
    bot.provider !== lookup.snapshot.provider ||
    topicResourceAuthorizationId(bot, lookup.snapshot.chatId) !== lookup.snapshot.authorizationId
  ) {
    throw new Error("Topic resource authorization unavailable");
  }
  return { lookup, bot, config };
}

/**
 * 读取当前任务已接纳快照中的一条话题资源。
 *
 * 下载前后各复核一次：停用、换凭据或换群期间完成的下载不能继续交付字节，
 * 也不能把过期快照当成新授权。
 */
export async function readAuthorizedTopicResource(
  request: TopicResourceRequest,
  deps: TopicResourceDependencies,
): Promise<TopicResourceReadResult> {
  request.signal?.throwIfAborted();
  const initial = await authorizeTopicResource(request, deps);
  request.signal?.throwIfAborted();
  const target: TopicResourceTarget = {
    botId: initial.bot.id,
    provider: initial.bot.provider,
    chatId: initial.lookup.snapshot.chatId,
    providerMessageId: initial.lookup.message.providerMessageId,
  };
  const result = await deps.download(
    initial.bot,
    toInboundAttachment(initial.lookup.attachment),
    target,
    request.signal ?? new AbortController().signal,
  );
  request.signal?.throwIfAborted();
  if (result.data.byteLength > PROTOCOL_V4_LIMITS.attachmentMaxBytes) {
    throw new Error("Topic resource exceeds attachment size limit");
  }
  const final = await authorizeTopicResource(request, deps);
  if (
    final.lookup.snapshot.inputId !== initial.lookup.snapshot.inputId ||
    final.lookup.snapshot.generation !== initial.lookup.snapshot.generation ||
    final.lookup.snapshot.authorizationId !== initial.lookup.snapshot.authorizationId ||
    final.bot.credentialRef !== initial.bot.credentialRef
  ) {
    throw new Error("Topic resource authorization changed");
  }
  request.signal?.throwIfAborted();
  return {
    attachment: {
      ...result.attachment,
      id: initial.lookup.attachment.attachmentId,
      filename: initial.lookup.attachment.filename,
      mimeType: initial.lookup.attachment.mimeType,
    },
    data: result.data,
  };
}

/** 服务层参数投影：只搬运连接身份，不解释模型输入。 */
export function topicResourceRequestOf(params: TopicResourceRequest): TopicResourceRequest {
  return {
    taskId: params.taskId,
    ...(params.inputId ? { inputId: params.inputId } : {}),
    messageId: params.messageId,
    resourceIndex: params.resourceIndex,
    workspacePath: params.workspacePath,
    ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
    ...(params.remoteSessionId ? { remoteSessionId: params.remoteSessionId } : {}),
    ...(params.signal ? { signal: params.signal } : {}),
    ...(params.trace ? { trace: params.trace } : {}),
  };
}

function toInboundAttachment(
  attachment: import("@zcode/shared").BotTopicResourceAttachment,
): BotInboundAttachment {
  return {
    id: attachment.attachmentId,
    kind: attachment.kind,
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    ...(attachment.sizeBytes !== undefined ? { sizeBytes: attachment.sizeBytes } : {}),
    ...(attachment.providerFileId ? { providerFileId: attachment.providerFileId } : {}),
  };
}
