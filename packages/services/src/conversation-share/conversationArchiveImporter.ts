import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";
import { withFileLock } from "@zcode/shared/node";
import type { IZCodeSessionService } from "../zcode-session/zcodeSession.js";
import {
  ConversationShareServiceError,
  type ConversationShareImportProgress,
  type ImportConversationShareInput,
  type ImportConversationShareResult,
} from "./conversationShare.js";
import type { DecodedConversationArchive } from "./conversationArchive.js";
import { sha256ConversationShareJson } from "./conversationShareIntegrity.js";
import { formatSharedContextV1 } from "./sharedContextFormatter.js";

const receiptSchema = z
  .object({
    version: z.literal(1),
    archiveSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    sessionId: z.string().regex(/^share-import-[a-f0-9-]{36}$/u),
    contextId: z.string().regex(/^shared-context-[a-f0-9-]{36}$/u),
    phase: z.enum(["preparing", "committing", "complete"]),
  })
  .strict();
type Receipt = z.infer<typeof receiptSchema>;
interface Options {
  sessionService: Pick<IZCodeSessionService, "createSession" | "listSessions">;
  conversationWorkspaceRoot: string;
  report?: (progress: ConversationShareImportProgress) => void;
}

async function readBoundedFile(path: string, maxBytes: number): Promise<Buffer> {
  // 恢复记录和附件可能被外部修改；按上限读取，不能让伪造文件触发无界内存分配。
  if (!(await lstat(path)).isFile())
    throw new ConversationShareServiceError(
      "invalid_contract",
      "Installed conversation file conflicts",
    );
  const handle = await open(path, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes)
      throw new ConversationShareServiceError(
        "invalid_contract",
        "Installed conversation file conflicts",
      );
    const bytes = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > maxBytes)
      throw new ConversationShareServiceError(
        "invalid_contract",
        "Installed conversation file changed",
      );
    return bytes.subarray(0, length);
  } finally {
    await handle.close();
  }
}

/** 每个归档/实际工作区只有一个导入事务，receipt 是可恢复的持久事实。 */
export class ConversationArchiveImporter {
  private readonly inFlight = new Map<string, Promise<ImportConversationShareResult>>();
  constructor(private readonly options: Options) {}

  import(
    decoded: DecodedConversationArchive,
    sha: string,
    input: ImportConversationShareInput,
    operationId: string,
  ): Promise<ImportConversationShareResult> {
    const remote = input.targetWorkspaceKind === "remote" || Boolean(input.targetWorkspaceIdentity);
    const workspacePath =
      !remote && input.targetWorkspacePath
        ? input.targetWorkspacePath
        : this.options.conversationWorkspaceRoot;
    const fallbackReason = remote
      ? ("remote_workspace" as const)
      : !input.targetWorkspacePath
        ? ("default_workspace" as const)
        : undefined;
    // 远端回退已改变实际所有者，不能把请求中的远端 identity 绑定到本地目录。
    const key = `${workspacePath}\0${sha}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing.then((result) => ({ ...result, fallbackReason, reused: true }));
    const pending = this.install(decoded, sha, workspacePath, input.locale, operationId).finally(
      () => this.inFlight.delete(key),
    );
    this.inFlight.set(key, pending);
    return pending.then((result) => ({ ...result, fallbackReason }));
  }

  private async findSession(workspacePath: string, sessionId: string) {
    const sessions = await this.options.sessionService.listSessions({
      workspacePath,
      sessionIds: [sessionId],
    });
    return sessions.find((session) => session.sessionId === sessionId);
  }

  private async writeReceipt(path: string, receipt: Receipt) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(receipt), { mode: 0o600 });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private report(
    operationId: string,
    phase: ConversationShareImportProgress["phase"],
    completedArtifacts: number,
    totalArtifacts: number,
  ) {
    // 进度监听失败不能回滚已经提交的会话或把成功错误地报告为失败。
    try {
      this.options.report?.({ operationId, phase, completedArtifacts, totalArtifacts });
    } catch {
      /* 进度不是事务事实。 */
    }
  }

  private async install(
    decoded: DecodedConversationArchive,
    sha: string,
    workspacePath: string,
    locale: ImportConversationShareInput["locale"],
    operationId: string,
  ): Promise<ImportConversationShareResult> {
    if (!/^[a-f0-9]{64}$/u.test(sha))
      throw new ConversationShareServiceError(
        "invalid_contract",
        "Invalid conversation archive identity",
      );
    const shareId = `archive-${sha}`;
    const shareRoot = join(workspacePath, ".zcodium-share");
    await mkdir(shareRoot, { recursive: true });
    if (!(await lstat(shareRoot)).isDirectory())
      throw new ConversationShareServiceError(
        "invalid_contract",
        "Conversation import directory is unavailable",
      );
    // 不同窗口有各自的 Host；复用进程间锁，避免把另一 Host 的准备阶段误判为崩溃残留。
    return withFileLock(join(shareRoot, shareId), () =>
      this.installLocked(decoded, sha, workspacePath, locale, operationId),
    );
  }

  private async installLocked(
    decoded: DecodedConversationArchive,
    sha: string,
    workspacePath: string,
    locale: ImportConversationShareInput["locale"],
    operationId: string,
  ): Promise<ImportConversationShareResult> {
    const shareId = `archive-${sha}`;
    const importRoot = join(workspacePath, ".zcodium-share", shareId);
    const receiptPath = join(importRoot, ".zcodium-share-import.json");
    let receipt: Receipt | undefined;
    try {
      const entry = await lstat(importRoot);
      if (!entry.isDirectory())
        throw new ConversationShareServiceError(
          "invalid_contract",
          "Conversation import directory conflicts",
        );
      const raw = receiptSchema.safeParse(
        JSON.parse((await readBoundedFile(receiptPath, 4096)).toString("utf8")),
      );
      if (!raw.success || raw.data.archiveSha256 !== sha)
        throw new ConversationShareServiceError(
          "invalid_contract",
          "Conversation import receipt conflicts",
        );
      receipt = raw.data;
    } catch (error) {
      // 只把目录确实不存在视为新导入；不完整/不可信 receipt 不能授权删除现存文件。
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" ||
        (await lstat(importRoot).then(
          () => true,
          () => false,
        ))
      )
        throw error;
    }
    if (receipt) {
      const existing = await this.findSession(workspacePath, receipt.sessionId);
      if (existing) {
        await this.writeReceipt(receiptPath, { ...receipt, phase: "complete" }).catch(
          () => undefined,
        );
        return {
          workspacePath,
          sessionId: receipt.sessionId,
          contextId: receipt.contextId,
          title: decoded.content.title,
          reused: true,
        };
      }
      if (receipt.phase !== "committing") {
        // 精确 sessionIds 查询已证明没有会话引用，此 owned 目录可安全重新创建。
        await rm(importRoot, { recursive: true, force: true });
        receipt = undefined;
      }
    }
    const recoveringCommit = receipt?.phase === "committing";
    if (!receipt) {
      await mkdir(importRoot);
      receipt = {
        version: 1,
        archiveSha256: sha,
        sessionId: `share-import-${randomUUID()}`,
        contextId: `shared-context-${randomUUID()}`,
        phase: "preparing",
      };
    }
    const currentReceipt = receipt;
    let commitStarted = recoveringCommit;
    const installed = decoded.content.artifacts.map((artifact, index) => {
      const safe =
        basename(artifact.display_name.replace(/\\/gu, "/"))
          .replace(/[<>:"/\\|?*\p{Cc}]/gu, "-")
          .replace(/[. ]+$/u, "")
          .slice(0, 120) || "attachment";
      const name = `file-${index + 1}-${safe}`;
      return {
        artifactId: artifact.artifact_id,
        displayName: artifact.display_name,
        mimeType: artifact.mime_type,
        sha256: artifact.sha256,
        name,
        workspaceRelativePath: `.zcodium-share/${shareId}/shared-artifacts/${name}`,
      };
    });
    const storedConversation = JSON.stringify({
      formatVersion: 1,
      shareId,
      contextId: receipt.contextId,
      title: decoded.content.title,
      rows: decoded.content.rows,
      artifacts: installed.map(({ artifactId, displayName, mimeType, workspaceRelativePath }) => ({
        artifactId,
        displayName,
        mimeType,
        workspaceRelativePath,
      })),
    });
    try {
      if (!recoveringCommit) {
        await this.writeReceipt(receiptPath, receipt);
        const staging = join(importRoot, ".share-import-staging");
        await mkdir(staging);
        for (let index = 0; index < installed.length; index++) {
          const artifact = installed[index]!;
          const bytes = decoded.artifacts.get(artifact.artifactId);
          if (!bytes)
            throw new ConversationShareServiceError(
              "invalid_contract",
              "Conversation import artifact is unavailable",
            );
          await writeFile(join(staging, artifact.name), bytes, { mode: 0o600 });
          this.report(operationId, "installing", index + 1, installed.length);
        }
        await rename(staging, join(importRoot, "shared-artifacts"));
        await writeFile(join(importRoot, "shared-conversation.json"), storedConversation, {
          mode: 0o600,
        });
      } else {
        // 回复丢失时文件可能已被会话使用；重试只验证，绝不覆盖或删除这些引用。
        if (
          (
            await readBoundedFile(
              join(importRoot, "shared-conversation.json"),
              Buffer.byteLength(storedConversation),
            )
          ).toString("utf8") !== storedConversation
        )
          throw new ConversationShareServiceError(
            "invalid_contract",
            "Installed conversation changed",
          );
        for (const artifact of installed) {
          const bytes = await readBoundedFile(
            join(workspacePath, artifact.workspaceRelativePath),
            decoded.artifacts.get(artifact.artifactId)!.length,
          );
          if (!bytes.equals(decoded.artifacts.get(artifact.artifactId)!))
            throw new ConversationShareServiceError(
              "invalid_contract",
              "Installed conversation artifact changed",
            );
        }
      }
      const context = formatSharedContextV1({
        share: { shareId, title: decoded.content.title },
        rows: decoded.content.rows,
        installedArtifacts: installed,
      });
      this.report(operationId, "committing", installed.length, installed.length);
      await this.writeReceipt(receiptPath, { ...receipt, phase: "committing" });
      commitStarted = true;
      await this.options.sessionService.createSession({
        workspacePath,
        sessionId: receipt.sessionId,
        persistence: "immediate",
        importedHistory: {
          source: "sharedContext",
          title: `${locale === "en-US" ? "Imported: " : "导入："}${decoded.content.title}`,
          markdown: context.markdown,
          provenance: {
            shareId,
            contextId: receipt.contextId,
            source: { kind: "localArchive", archiveSha256: sha },
            status: "pending",
            projectionSha256: sha256ConversationShareJson({ rows: decoded.content.rows }),
            artifactSetSha256: sha256ConversationShareJson(decoded.content.artifacts),
            formatterVersion: 1,
            markdownSha256: context.markdownSha256,
            installedArtifacts: installed.map(({ artifactId, workspaceRelativePath }) => ({
              artifactId,
              workspaceRelativePath,
            })),
          },
        },
      });
      await this.writeReceipt(receiptPath, { ...receipt, phase: "complete" }).catch(
        () => undefined,
      );
      this.report(operationId, "complete", installed.length, installed.length);
      return {
        workspacePath,
        sessionId: currentReceipt.sessionId,
        contextId: currentReceipt.contextId,
        title: decoded.content.title,
        reused: false,
      };
    } catch (error) {
      // createSession 的异常可能只是回复丢失；此后必须保留文件与相同 sessionId 供恢复。
      if (!commitStarted)
        await rm(importRoot, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }
}
