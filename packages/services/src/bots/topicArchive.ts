import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWritePrivateTextFile, withFileLock } from "@zcode/shared/node";
import {
  BOT_TOPIC_ARCHIVE_FILE,
  BOT_TOPIC_ARCHIVE_MAX_INPUTS,
  BOT_TOPIC_ARCHIVE_TTL_MS,
  BOT_TOPIC_RESOURCE_INDEX_FILENAME,
  BOT_TOPIC_RESOURCE_MAX_PER_MESSAGE,
  botsTopicArchiveFileSchema,
  type BotConfig,
  type BotInboundMessage,
  type BotTopicInputSnapshot,
  type BotTopicResourceAttachment,
  type BotTopicSnapshotMessage,
  type BotsTopicArchiveFile,
  type ZCodePromptAttachment,
} from "@zcode/shared";
import { createHash } from "node:crypto";
import { getAppConfigDir } from "../paths.js";

interface TopicArchiveAdmitInput {
  workspacePath: string;
  workspaceIdentity?: string;
  /** CLI 会话 id；模型只能通过工具 context.sessionId 间接使用，不能自报。 */
  taskId: string;
  /** 本次接纳的输入 id；与后续 session/send 的 inputId 同一取值。 */
  inputId: string;
  bot: BotConfig;
  message: BotInboundMessage;
  now?: number;
}

interface TopicArchiveLookup {
  /** 读取前取到的快照，用于事后代际复核。 */
  snapshot: BotTopicInputSnapshot;
  message: BotTopicSnapshotMessage;
  attachment: BotTopicResourceAttachment;
}

/** 身份 key 与全仓一致：identity?.trim() || path，用于 workspace 隔离。 */
function topicArchiveWorkspaceKey(input: {
  workspacePath: string;
  workspaceIdentity?: string;
}): string {
  return input.workspaceIdentity?.trim() || input.workspacePath;
}

/**
 * 话题资源接纳归档的唯一 owner。
 *
 * 只有 bot 入站真实接纳（admission=accepted）才写入；写入走单文件锁 + 原子替换，
 * 缩容/过期只在 admit 内做（单一写路径），读取永远不修补文件。
 */
export class BotsTopicArchive {
  private readonly filePath: string;

  constructor(options?: { filePath?: string }) {
    this.filePath = options?.filePath ?? join(getAppConfigDir(), BOT_TOPIC_ARCHIVE_FILE);
  }

  async admit(input: TopicArchiveAdmitInput): Promise<BotTopicInputSnapshot> {
    const now = input.now ?? Date.now();
    const workspaceKey = topicArchiveWorkspaceKey(input);
    const provider = input.bot.provider;
    // 最小完整片只支持现有 Feishu/Lark 资源能力；其他 provider 不写入可读档案，
    // 避免工具在下载阶段才发现能力缺失。
    if (provider !== "feishu" && provider !== "lark") {
      throw new Error("Topic resource provider is not supported for archiving");
    }
    const chatId = input.message.actor.chatId;
    if (!chatId) throw new Error("Topic resource chat scope is unavailable");
    const providerMessageId = input.message.actor.providerMessageId;
    if (!providerMessageId) throw new Error("Topic resource message scope is unavailable");
    const attachments = collectTopicResources(input.message);
    const snapshotMessage: BotTopicSnapshotMessage = {
      messageId: providerMessageId,
      providerMessageId,
      createdAt: now,
      attachments,
    };
    return this.mutate((archive) => {
      pruneExpired(archive, now);
      const existing = archive.inputs.find(
        (candidate) =>
          candidate.inputId === input.inputId &&
          candidate.taskId === input.taskId &&
          topicArchiveWorkspaceKey(candidate) === workspaceKey,
      );
      const others = archive.inputs.filter((candidate) => candidate !== existing);
      const sameTask = others.filter(
        (candidate) =>
          candidate.taskId === input.taskId && topicArchiveWorkspaceKey(candidate) === workspaceKey,
      );
      const messages = (existing?.messages ?? sameTask.at(-1)?.messages ?? []).filter(
        (candidate) => candidate.messageId !== snapshotMessage.messageId,
      );
      const snapshot: BotTopicInputSnapshot = {
        version: 1,
        workspacePath: input.workspacePath,
        ...(input.workspaceIdentity?.trim()
          ? { workspaceIdentity: input.workspaceIdentity.trim() }
          : {}),
        taskId: input.taskId,
        inputId: input.inputId,
        admission: "accepted",
        admittedAt: now,
        generation: (existing?.generation ?? 0) + 1,
        botId: input.bot.id,
        provider,
        chatId,
        // 授权指纹只取 bot 身份 + 凭据 + 群：凭据轮换/重新绑定会让旧快照自然失效。
        authorizationId: topicResourceAuthorizationId(input.bot, chatId),
        messages: [...messages, snapshotMessage].slice(-64),
      };
      const kept = [...others, snapshot].slice(-BOT_TOPIC_ARCHIVE_MAX_INPUTS);
      return { next: { version: 1, inputs: kept }, value: snapshot };
    });
  }

  /** 按任务归属解析可读资源；找不到就是不可读，不回退到别的任务或别的 workspace。 */
  async lookup(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    inputId?: string;
    messageId: string;
    resourceIndex: number;
    now?: number;
  }): Promise<TopicArchiveLookup> {
    const archive = await this.read();
    const now = params.now ?? Date.now();
    const workspaceKey = topicArchiveWorkspaceKey(params);
    const candidates = archive.inputs.filter(
      (candidate) =>
        candidate.admission === "accepted" &&
        candidate.taskId === params.taskId &&
        topicArchiveWorkspaceKey(candidate) === workspaceKey &&
        candidate.workspacePath === params.workspacePath &&
        now - candidate.admittedAt <= BOT_TOPIC_ARCHIVE_TTL_MS &&
        (!params.inputId || candidate.inputId === params.inputId),
    );
    const snapshot = candidates.at(-1);
    if (!snapshot) throw new Error("Topic resource task scope is unavailable");
    if (params.inputId && candidates.length !== 1) {
      throw new Error("Topic resource input scope is unavailable");
    }
    const message = snapshot.messages.find((candidate) => candidate.messageId === params.messageId);
    if (!message) throw new Error("Topic resource is not in this task's admitted archive");
    const attachment = message.attachments[params.resourceIndex];
    if (!attachment || attachment.index !== params.resourceIndex) {
      throw new Error("Topic resource index unavailable");
    }
    return { snapshot, message, attachment };
  }

  /** 当前任务已接纳资源的索引投影：只列序号与选择器，不展开正文。 */
  async indexAttachment(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<ZCodePromptAttachment | undefined> {
    const archive = await this.read();
    const workspaceKey = topicArchiveWorkspaceKey(params);
    const entries: string[] = [];
    for (const snapshot of archive.inputs) {
      if (
        snapshot.taskId !== params.taskId ||
        topicArchiveWorkspaceKey(snapshot) !== workspaceKey ||
        snapshot.workspacePath !== params.workspacePath
      ) {
        continue;
      }
      for (const message of snapshot.messages) {
        for (const attachment of message.attachments) {
          entries.push(
            `A${entries.length + 1} inputId=${snapshot.inputId} messageId=${message.messageId} index=${attachment.index} kind=${attachment.kind} name=${attachment.filename}`,
          );
        }
      }
    }
    if (entries.length === 0) return undefined;
    const text = [
      "本任务已接纳话题资源索引（读取用 ReadTopicResource，输入只能是表中的 inputId/messageId/index）：",
      ...entries,
    ].join("\n");
    return {
      kind: "file",
      filename: BOT_TOPIC_RESOURCE_INDEX_FILENAME,
      mimeType: "text/plain",
      sizeBytes: Buffer.byteLength(text, "utf8"),
      textContent: text,
    };
  }

  private async read(): Promise<BotsTopicArchiveFile> {
    try {
      return botsTopicArchiveFileSchema.parse(JSON.parse(await readFile(this.filePath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, inputs: [] };
      throw error;
    }
  }

  private async mutate<T>(
    update: (archive: BotsTopicArchiveFile) => { next: BotsTopicArchiveFile; value: T },
  ): Promise<T> {
    await mkdir(join(this.filePath, ".."), { recursive: true });
    return withFileLock(this.filePath, async () => {
      const archive = await this.read();
      const { next, value } = update(archive);
      const parsed = botsTopicArchiveFileSchema.parse(next);
      await atomicWritePrivateTextFile(this.filePath, `${JSON.stringify(parsed, null, 2)}\n`);
      return value;
    });
  }
}

function pruneExpired(archive: BotsTopicArchiveFile, now: number): void {
  archive.inputs = archive.inputs.filter(
    (candidate) => now - candidate.admittedAt <= BOT_TOPIC_ARCHIVE_TTL_MS,
  );
}

function collectTopicResources(message: BotInboundMessage): BotTopicResourceAttachment[] {
  // 只归档真实带 provider 资源键的附件：没有 providerFileId 的条目无法重新下载，
  // 写进索引只会让模型反复触发必然失败的读取。
  return (message.attachments ?? [])
    .slice(0, BOT_TOPIC_RESOURCE_MAX_PER_MESSAGE)
    .flatMap((attachment, index) =>
      attachment.providerFileId
        ? [
            {
              index,
              attachmentId: attachment.id,
              kind: attachment.kind,
              filename: attachment.filename,
              mimeType: attachment.mimeType,
              ...(attachment.sizeBytes !== undefined ? { sizeBytes: attachment.sizeBytes } : {}),
              providerFileId: attachment.providerFileId,
            },
          ]
        : [],
    );
}

export function topicResourceAuthorizationId(bot: BotConfig, chatId: string): string {
  // 修复原因：credentialRef 是按 bot.id 派生的稳定 key，原地更换 appId/凭据不会改变它；
  // 只绑 credentialRef 时，旧快照会在重新绑定后的 bot 上继续被当作已授权。
  // 这里把 bot 的真实身份（appId/providerUserId）也纳入指纹，换代前后必然复核失败。
  return createHash("sha256")
    .update(
      [
        bot.id,
        bot.provider,
        bot.credentialRef ?? "",
        bot.feishuAppId ?? "",
        bot.providerUserId ?? "",
        chatId,
      ].join("\u0000"),
    )
    .digest("hex")
    .slice(0, 32);
}
