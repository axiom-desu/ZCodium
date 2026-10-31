/* oxlint-disable eslint(max-lines) -- 会话快照、导出及原子导入由同一 Host service 管理。 */
import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";

import { z } from "zod";

import type {
  ConversationShareArtifactDescriptor,
  ConversationShareCapabilities,
} from "@zcode/shared";
import {
  decodeConversationShareContentBlocks,
  decodeConversationShareRows,
  buildConversationPreviewArtifactCandidates,
  CONVERSATION_PREVIEW_CARD_VISIBLE_LIMIT,
  extractConversationPreviewFileReferences,
  projectShareToolDisplay,
  supportsConversationShareContent,
  type ConversationPreviewArtifactCandidate,
} from "@zcode/shared";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import {
  PROTOCOL_V4_LIMITS,
  ZCODE_ATTACHMENT_FAULT_CODES,
  readZCodeAttachmentFaultCode,
} from "@zcode/shared/zcode-protocol-v4";
import { Emitter } from "@zcode/rpc";

import type { IZCodeAgentService } from "../zcode-agent/zcodeAgent.js";
import type { IZCodeSessionService } from "#src/zcode-session/zcodeSession.js";
import { getConversationWorkspaceDir } from "#src/paths.js";
import { createServiceLogger, type ServiceLogger } from "#src/logger/serviceLogger.js";
import {
  ConversationShareServiceError,
  sanitizeConversationShareIssues,
  type IConversationShareService,
  type PublishTextConversationInput,
  type ConversationSharePublishProgress,
  type ConversationShareImportProgress,
  type ConversationShareFailureIssue,
  type ConversationSharePreflightInput,
  type ConversationSharePreflightResult,
  type ConversationShareAllowedArtifact,
  type ConversationShareTurnPreflightResult,
  type ImportConversationShareInput,
  type ImportConversationShareResult,
  type ImportedConversationShare,
} from "./conversationShare.js";
import {
  buildConversationShareArtifactSnapshot,
  getConversationSharePreviewCandidateFingerprint,
  type ConversationSharePreviewPreflightSnapshot,
} from "./conversationShareArtifactDiscovery.js";
import {
  decodeConversationArchive,
  ConversationArchiveError,
  encodeConversationArchive,
} from "./conversationArchive.js";
import { ConversationArchiveExports } from "./conversationArchiveExports.js";
import { conversationArchiveCapabilities } from "./conversationArchiveCapabilities.js";
import { buildConversationSharePublicProjection } from "./conversationSharePublicProjection.js";
import { materializeConversationShareInlineImages } from "./conversationShareInlineImages.js";
import {
  collectConversationShareWorkflowSnapshot,
  isWorkflowShareFallbackRow,
  type ShareWorkflowReader,
} from "./conversationShareWorkflowSnapshot.js";
import type { ConversationShareArtifactSource } from "./conversationShareArtifactSource.js";
import { ConversationArchiveImports } from "./conversationArchiveImports.js";
import { ConversationArchiveImporter } from "./conversationArchiveImporter.js";

const MISSING_ARTIFACT_ERRNOS = new Set(["ENOENT", "ENOTDIR", "EISDIR"]);
// 预检快照的兜底上限：单次分享最多写入所选轮次数量的条目，200 足够覆盖正常会话，
// 又能保证长驻 host 不会因为「一直预检、从不发布」而无限增长。
const PREVIEW_PREFLIGHT_SNAPSHOT_MAX_ENTRIES = 200;
// 预检 stat 的并发上限：本地几乎无差别，SSH/远程 workspace 下每次 stat 都是一次
// 网络往返，串行会让「下一步」长时间停在 checking。上限保证不把远端 host 打爆。
const SHARE_PREFLIGHT_STAT_CONCURRENCY = 6;

/**
 * 有界并发 map，保持输出与输入同序。
 *
 * 预检的每次 stat 在 SSH/远程 workspace 下都是一次网络往返，串行会让「下一步」
 * 长时间停在 checking。并发上限存在的意义是不把远端 host 打爆；结果按下标回填，
 * 因此 issue 的产生顺序仍然是确定的（与串行实现完全一致）。
 */
async function mapWithConcurrency<Input, Output>(
  items: readonly Input[],
  limit: number,
  run: (item: Input, index: number) => Promise<Output>,
): Promise<Output[]> {
  if (items.length === 0) return [];
  const results = Array.from<Output>({ length: items.length });
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await run(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

/** stat 的结果或失败原因；并发阶段只收集，分类仍在同序的第二轮里做。 */
type SettledResult<Value> = { ok: true; value: Value } | { ok: false; error: unknown };

async function settle<Value>(run: () => Promise<Value>): Promise<SettledResult<Value>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, error };
  }
}

function isMissingArtifactReadError(error: unknown): boolean {
  return (
    error instanceof ConversationShareServiceError &&
    error.reasonCode === "artifact_read_failed" &&
    typeof error.diagnostics?.errno === "string" &&
    MISSING_ARTIFACT_ERRNOS.has(error.diagnostics.errno)
  );
}

interface ConversationShareServiceOptions {
  zcodeAgentService: ConversationShareAgentService;
  artifactSource: ConversationShareArtifactSource;
  zcodeSessionService?: Pick<IZCodeSessionService, "createSession" | "listSessions">;
  conversationWorkspaceRoot?: string;
  logger?: ServiceLogger;
}

type ConversationShareAgentService = ShareWorkflowReader &
  Pick<
    IZCodeAgentService,
    | "conversationRowsRangeV4"
    | "conversationFileChangesV4"
    | "conversationAttachmentReadV4"
    | "conversationAttachmentStatV4"
  >;

/** Symbol method 不可由 string-command ProxyChannel 调用，仅供 Desktop Host attachment 装配。 */
export const conversationShareConnectionScopeFactory = Symbol(
  "conversationShareConnectionScopeFactory",
);

const CONNECTION_UNAVAILABLE_ERRORS = new Set([
  "fault.conversation.rowsRangeConnectionUntrusted",
  "fault.connection.handshakeRequired",
  "fault.connection.closed",
]);

function normalizeConversationShareConnectionError(error: unknown): unknown {
  if (error instanceof Error && CONNECTION_UNAVAILABLE_ERRORS.has(error.message)) {
    return new ConversationShareServiceError(
      "connection_unavailable",
      "Conversation share connection is not ready",
    );
  }
  return error;
}

function workspaceKeyOf(path: string | undefined, identity: string | undefined): string {
  return identity?.trim() || path?.trim() || "__default_conversation_workspace__";
}

function previewPreflightKey(
  input: Pick<
    PublishTextConversationInput | ConversationSharePreflightInput,
    "workspacePath" | "workspaceIdentity" | "remoteSessionId" | "sessionId"
  >,
  productTurnId: string,
): string {
  return [
    workspaceKeyOf(input.workspacePath, input.workspaceIdentity),
    input.remoteSessionId ?? "",
    input.sessionId,
    productTurnId,
  ].join("\u0000");
}

/** 本端产出的只读副本格式版本；与 wire 的 schema_version 各自独立演进。 */
const IMPORTED_CONVERSATION_SHARE_FORMAT_VERSION = 2;

/**
 * 落盘的只读副本形状；来自磁盘，渲染前必须校验。
 *
 * formatVersion 与 rows 都刻意宽容：用户在新版导入过会话后回退到旧版时，只读块应该尽量
 * 显示出来（认不出的行跳过 + 顶部软提示），而不是整块静默消失让人以为内容丢了。
 */
const importedConversationShareFileSchema = z
  .object({
    formatVersion: z.number().int().positive(),
    shareId: z.string().trim().min(1),
    contextId: z.string().trim().min(1),
    title: z.string(),
    rows: z.array(z.unknown()),
    /** v2 起携带公开内容块；旧副本没有这个字段，读取端不得当缺数据报错。 */
    content_blocks: z.array(z.unknown()).optional(),
    artifacts: z.array(
      z.object({
        artifactId: z.string().trim().min(1),
        displayName: z.string(),
        mimeType: z.string().optional(),
        workspaceRelativePath: z.string().optional(),
      }),
    ),
  })
  .strip();

interface ConversationRowsRead {
  rows: ConversationRow[];
  revision: number;
  logEpoch: string;
}

function turnOrdinalByProductTurn(rows: readonly ConversationRow[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const row of rows) {
    if (row.kind !== "turnHeader" || !row.productTurnId || result.has(row.productTurnId)) continue;
    result.set(row.productTurnId, result.size + 1);
  }
  return result;
}

function rowTurnOrdinal(row: ConversationRow, ordinals: Map<string, number>): number | undefined {
  return row.productTurnId ? ordinals.get(row.productTurnId) : undefined;
}

function hasUnsafeShareString(value: unknown): boolean {
  if (typeof value === "string") return /^(?:data|file):/iu.test(value);
  if (Array.isArray(value)) return value.some(hasUnsafeShareString);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(([key, entry]) =>
    key === "ref" ? false : hasUnsafeShareString(entry),
  );
}

function hasUnsupportedArtifactReference(value: unknown): boolean {
  if (typeof value === "string") return /^zcode-artifact:\/\//iu.test(value);
  if (Array.isArray(value)) return value.some(hasUnsupportedArtifactReference);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(([key, entry]) =>
    key === "ref" ? false : hasUnsupportedArtifactReference(entry),
  );
}

/**
 * V1 公开投影承载不了的已定稿内部结构静默移除：删掉不能公开的字段或整行，保留该轮其余
 * 内容，让发布不再被整体打死，也不把内部渲染结构暴露成用户错误。
 *
 * 只降级「已定稿但无法承载」的内容；运行中的轮次/行/工具/子代理仍由
 * collectShareStructureIssues 阻断 —— 那些内容尚未定稿，跳过等于分享半成品。
 */
function sanitizeUnsupportedShareStructures(rows: readonly ConversationRow[]): ConversationRow[] {
  const sanitized: ConversationRow[] = [];
  for (const row of rows) {
    if (row.kind === "timelineMarker") {
      // 运行中的 marker 留着，让 collectShareStructureIssues 照旧阻断——内容尚未定稿。
      // 被阻断的发布不会进入投影，保留该 marker 无副作用。
      const markerRunning =
        (row.marker.type === "compact" && row.marker.status === "running") ||
        (row.marker.type === "goalVerify" && row.marker.outcome === "running");
      if (markerRunning) {
        sanitized.push(row);
        continue;
      }
      if (
        row.marker.type === "forkNotice" ||
        row.marker.type === "forkCreated" ||
        row.marker.type === "checkpointRestored"
      ) {
        // 分支/回滚 marker 只携带本地会话关系，公开页本来就不渲染；直接移除，不能把
        // 内部时间线结构计入“文件被跳过”或打扰用户。
        continue;
      }
      // 其余 marker 静默剥掉，不打扰分享者：
      // - compact（上下文已压缩）纯运行时记账，对只读读者没有价值；而且它的 lane 是
      //   assistantWork，留在 flow 尾部会顶掉「最终正文」折叠锚点，让整轮过程默认展开
      //   （conversationTurnWorkSegments.ts 的 assistantHistoryDefaultOpen）——这是它必须走的主因。
      // - goalVerify / goalSet / retryNotice 在分享页本来就不渲染，纯占位吃 max_rows 配额。
      // - modelChange 只能显示一句泛化的「模型已切换」，信息量低且暴露内部切模型行为。
      continue;
    }
    if (row.kind === "toolCall" && row.toolName === "EnterPlanMode") {
      // EnterPlanMode 只是内部模式切换边界，渲染层（isVisibleAssistantWorkRow）本来就过滤掉，
      // 但它仍会进 payload 白吃 max_rows / max_payload_bytes 配额，永远不显示。
      continue;
    }
    sanitized.push(row);
  }
  return sanitized;
}

function sanitizeUnsupportedShareArtifacts(
  rows: readonly ConversationRow[],
  capabilities: ConversationShareCapabilities,
  ordinalRows: readonly ConversationRow[],
): { rows: ConversationRow[]; warnings: ConversationShareFailureIssue[] } {
  const ordinals = turnOrdinalByProductTurn(ordinalRows);
  const warnings: ConversationShareFailureIssue[] = [];
  const retained = rows.filter((row) => {
    if (row.kind !== "artifact") return true;
    const extension = fileExtension(row.displayName);
    const mimeType = normalizedMimeType(row.mimeType);
    const allowed = capabilities.allowed_artifacts.find(
      (candidate) =>
        candidate.type === row.artifactType &&
        candidate.extensions.some(
          (value) => value.replace(/^\./u, "").toLowerCase() === extension,
        ) &&
        candidate.mime_types.some((value) => value.toLowerCase() === mimeType),
    );
    if (allowed) return true;
    warnings.push({
      code: "artifact_type_not_allowed",
      scope: "artifact",
      rowId: row.rowId,
      ...(row.productTurnId && ordinals.has(row.productTurnId)
        ? { turnOrdinal: ordinals.get(row.productTurnId) }
        : {}),
      ...(row.productTurnId ? { productTurnId: row.productTurnId } : {}),
      artifactDisplayName: row.displayName,
      artifactType: row.artifactType,
      ...(extension ? { extension } : {}),
      mimeType,
      allowedFormats: allowedFormatLabels(capabilities),
      allowedArtifacts: allowedArtifactSummaries(capabilities),
    });
    return false;
  });
  return { rows: retained, warnings };
}

function collectShareStructureIssues(
  rows: readonly ConversationRow[],
  ordinalRows: readonly ConversationRow[] = rows,
): ConversationShareFailureIssue[] {
  const issues: ConversationShareFailureIssue[] = [];
  const ordinals = turnOrdinalByProductTurn(ordinalRows);
  const add = (row: ConversationRow, code: ConversationShareFailureIssue["code"]) => {
    issues.push({
      code,
      scope: code === "missing_product_turn" ? "conversation" : "turn",
      ...(row.rowId === undefined ? {} : { rowId: row.rowId }),
      ...(rowTurnOrdinal(row, ordinals) === undefined
        ? {}
        : { turnOrdinal: rowTurnOrdinal(row, ordinals) }),
      ...(row.productTurnId ? { productTurnId: row.productTurnId } : {}),
    });
  };
  for (const row of rows) {
    if (!row.productTurnId) add(row, "missing_product_turn");
    if (row.kind === "turnHeader" && row.state === "running") add(row, "running_turn");
    if ((row.kind === "assistantText" || row.kind === "reasoning") && row.state === "streaming") {
      add(row, "streaming_row");
    }
    if (
      row.kind === "toolCall" &&
      (row.status === "inputStreaming" ||
        row.status === "pendingApproval" ||
        row.status === "running")
    ) {
      add(row, "active_tool_call");
    }
    if (row.kind === "subagent" && row.status === "running") add(row, "active_subagent");
    if (row.kind === "timelineMarker") {
      // 只有「运行中」的时间线操作仍阻断；fork/checkpoint/compact summaryRef 已由
      // sanitizeUnsupportedShareStructures 降级为跳过。
      if (
        (row.marker.type === "compact" && row.marker.status === "running") ||
        (row.marker.type === "goalVerify" && row.marker.outcome === "running")
      ) {
        add(row, "unsupported_timeline");
      }
    }
    if (hasUnsafeShareString(row)) add(row, "unsafe_url");
    if (hasUnsupportedArtifactReference(row)) add(row, "artifact_protocol_not_ready");
  }
  return issues;
}

function allowedFormatLabels(capabilities: ConversationShareCapabilities): string[] {
  return capabilities.allowed_artifacts.flatMap((allowed) =>
    allowed.extensions.map(
      (extension) => `${allowed.type.toUpperCase()} (.${extension.replace(/^\./u, "")})`,
    ),
  );
}

function allowedArtifactSummaries(
  capabilities: ConversationShareCapabilities,
): ConversationShareAllowedArtifact[] {
  return capabilities.allowed_artifacts.map((allowed) => ({
    type: allowed.type,
    extensions: [...allowed.extensions],
    mimeTypes: [...allowed.mime_types],
  }));
}

function capabilitiesFingerprint(capabilities: ConversationShareCapabilities): string {
  return createHash("sha256").update(JSON.stringify(capabilities)).digest("hex");
}

function fileExtension(fileName: string): string | undefined {
  const baseName = fileName.replace(/\\/gu, "/").split("/").at(-1) ?? fileName;
  const dot = baseName.lastIndexOf(".");
  return dot > 0 && dot < baseName.length - 1 ? baseName.slice(dot + 1).toLowerCase() : undefined;
}

function normalizedMimeType(mime: string): string {
  return mime.split(";", 1)[0]?.trim().toLowerCase() || "application/octet-stream";
}

function attachmentDisplayName(fileName: string): string {
  return basename(fileName.replace(/\\/gu, "/")) || "附件";
}

function allowedArtifactFor(
  capabilities: ConversationShareCapabilities,
  extension: string | undefined,
  mimeType: string,
) {
  if (!extension) return undefined;
  return capabilities.allowed_artifacts.find(
    (allowed) =>
      allowed.extensions.some((value) => value.replace(/^\./u, "").toLowerCase() === extension) &&
      allowed.mime_types.some((value) => value.toLowerCase() === mimeType),
  );
}

/**
 * 附件错误分类统一走协议侧稳定 fault 码（见 attachment-faults.ts）。
 *
 * 不能按 `error.message` 正则分类：RPC 包装/schema 校验一变就失效——
 * 超大附件的 ZodError 曾因此被误判成「未知」并降级成 deferred，静默丢内容。
 * 仅在 fault 码缺席时保留一条 errno 文本兜底，用于尚未带结构化码的旧 zcode-cli。
 */
function isDefiniteMissingAttachment(error: unknown): boolean {
  const faultCode = readZCodeAttachmentFaultCode(error);
  if (faultCode) {
    return (
      faultCode === ZCODE_ATTACHMENT_FAULT_CODES.shareStatNotFound ||
      faultCode === ZCODE_ATTACHMENT_FAULT_CODES.statNotFile
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return /ENOENT|not found|not_found|statNotFile|is_directory/iu.test(message);
}

function isAttachmentAuthorizationError(error: unknown): boolean {
  const faultCode = readZCodeAttachmentFaultCode(error);
  if (faultCode) {
    return (
      faultCode === ZCODE_ATTACHMENT_FAULT_CODES.shareStatNotAuthorized ||
      faultCode === ZCODE_ATTACHMENT_FAULT_CODES.shareReadNotAuthorized ||
      faultCode === ZCODE_ATTACHMENT_FAULT_CODES.shareStatConnectionUntrusted ||
      faultCode === ZCODE_ATTACHMENT_FAULT_CODES.shareReadConnectionUntrusted
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return /shareStatNotAuthorized|shareReadNotAuthorized|connectionUntrusted/iu.test(message);
}

/** 附件体积超出协议/通道可承载范围：选择阶段就应作为确定阻断呈现。 */
function isAttachmentTooLargeError(error: unknown): boolean {
  const faultCode = readZCodeAttachmentFaultCode(error);
  return (
    faultCode === ZCODE_ATTACHMENT_FAULT_CODES.shareStatTooLarge ||
    faultCode === ZCODE_ATTACHMENT_FAULT_CODES.previewTooLarge
  );
}

function buildTurnPreflightResults(
  productTurnIds: readonly string[],
  turnOrdinalByProductTurnId: ReadonlyMap<string, number>,
  blockingIssues: readonly ConversationShareFailureIssue[],
  skippableWarnings: readonly ConversationShareFailureIssue[],
  deferredIssues: readonly ConversationShareFailureIssue[],
): ConversationShareTurnPreflightResult[] {
  return productTurnIds.map((productTurnId) => {
    const turnOrdinal = turnOrdinalByProductTurnId.get(productTurnId);
    const forTurn = (issues: readonly ConversationShareFailureIssue[]) =>
      issues.filter(
        (issue) =>
          issue.turnOrdinal === turnOrdinal ||
          (issue.turnOrdinal === undefined &&
            issue.rowId === undefined &&
            issue.artifactDisplayName === undefined &&
            (issue.scope === "conversation" || issue.scope === "transport")),
      );
    return {
      productTurnId,
      blockingIssues: forTurn(blockingIssues),
      skippableWarnings: forTurn(skippableWarnings),
      deferredIssues: forTurn(deferredIssues),
    };
  });
}

function removeIndependentArtifactRows(rows: readonly ConversationRow[]): ConversationRow[] {
  // 分享候选只有用户输入附件和最终可见的 Assistant 预览卡片；历史 artifact row
  // 若没有对应预览卡片，不再作为第三条独立发现来源进入公开 projection。
  return rows.filter((row) => row.kind !== "artifact");
}

function throwServiceError(
  kind: ConstructorParameters<typeof ConversationShareServiceError>[0],
  message: string,
): never {
  throw new ConversationShareServiceError(kind, message);
}

function selectRows(
  rows: ConversationRow[],
  selection: PublishTextConversationInput["selection"],
): { rows: ConversationRow[]; productTurnIds: string[] } {
  let selectedProductTurnIds: Set<string>;
  if (selection.kind === "all") {
    selectedProductTurnIds = new Set(
      rows
        .filter((row) => row.kind === "turnHeader")
        .map((row) => row.productTurnId)
        .filter((value): value is string => value !== undefined),
    );
  } else if (selection.kind === "productTurns") {
    if (selection.productTurnIds.length === 0) {
      throwServiceError("invalid_selection", "At least one product turn must be selected");
    }
    selectedProductTurnIds = new Set(selection.productTurnIds);
  } else {
    if (selection.rowIds.length === 0) {
      throwServiceError("invalid_selection", "At least one conversation row must be selected");
    }
    const rowsById = new Map(rows.map((row) => [row.rowId, row]));
    selectedProductTurnIds = new Set<string>();
    for (const rowId of new Set(selection.rowIds)) {
      const row = rowsById.get(rowId);
      if (!row?.productTurnId) {
        throwServiceError("invalid_selection", "A selected row no longer exists");
      }
      selectedProductTurnIds.add(row.productTurnId);
    }
  }

  const orderedProductTurnIds: string[] = [];
  const headerCounts = new Map<string, number>();
  for (const row of rows) {
    if (row.kind !== "turnHeader" || !row.productTurnId) continue;
    headerCounts.set(row.productTurnId, (headerCounts.get(row.productTurnId) ?? 0) + 1);
    if (selectedProductTurnIds.has(row.productTurnId)) {
      orderedProductTurnIds.push(row.productTurnId);
    }
  }
  if (
    orderedProductTurnIds.length === 0 ||
    orderedProductTurnIds.length !== selectedProductTurnIds.size ||
    orderedProductTurnIds.some((productTurnId) => headerCounts.get(productTurnId) !== 1)
  ) {
    throwServiceError("invalid_selection", "Selected product turns are incomplete or ambiguous");
  }

  const selectedTurnIds = new Set(
    rows
      .filter(
        (row) =>
          row.kind === "turnHeader" &&
          row.productTurnId !== undefined &&
          selectedProductTurnIds.has(row.productTurnId),
      )
      .map((row) => row.turnId),
  );

  return {
    productTurnIds: orderedProductTurnIds,
    // 旧投影可能缺 productTurnId；只要 turnId 落在已选轮次也必须保留，让校验显式拒绝，
    // 不能在过滤时静默丢行后发布一份不完整会话。
    rows: rows.filter(
      (row) =>
        (row.productTurnId !== undefined && selectedProductTurnIds.has(row.productTurnId)) ||
        (row.productTurnId === undefined && selectedTurnIds.has(row.turnId)),
    ),
  };
}

export class ConversationShareService implements IConversationShareService {
  private readonly archiveExports = new ConversationArchiveExports();
  private readonly exportOwner = Symbol("conversation-export");
  private readonly zcodeAgentService: ConversationShareAgentService;
  private readonly artifactSource: ConversationShareArtifactSource;
  private readonly progressEmitters = new Map<string, Emitter<ConversationSharePublishProgress>>();
  private readonly importProgressEmitters = new Map<
    string,
    Emitter<ConversationShareImportProgress>
  >();
  private readonly archiveImports = new ConversationArchiveImports();
  private readonly archiveImporter?: ConversationArchiveImporter;
  private readonly logger: ServiceLogger;
  private readonly publishPhases = new Map<string, ConversationSharePublishProgress["phase"]>();
  // 选择阶段与发布阶段共享“最终可见卡片”边界；发布仍会重新 stat/read，但不会重新
  // 纳入选择阶段已经因缺失而被 UI 隐藏的候选。
  //
  // 生命周期：desktop host 是长驻进程，这张表原来只在 stat 未 settle 时删单条，
  // 会随使用时长单调增长。现在有两道回收：发布终态按 session 前缀清理，
  // 以及 set 时的 FIFO 上限兜底（覆盖用户中途放弃分享、永远不发布的路径）。
  private readonly previewPreflightSnapshots = new Map<
    string,
    ConversationSharePreviewPreflightSnapshot
  >();

  constructor(options: ConversationShareServiceOptions) {
    this.zcodeAgentService = options.zcodeAgentService;
    this.artifactSource = options.artifactSource;
    this.logger = options.logger ?? createServiceLogger("conversation-share");
    if (options.zcodeSessionService) {
      this.archiveImporter = new ConversationArchiveImporter({
        sessionService: options.zcodeSessionService,
        conversationWorkspaceRoot:
          options.conversationWorkspaceRoot ?? getConversationWorkspaceDir(),
        report: (progress) => this.importProgressEmitters.get(progress.operationId)?.fire(progress),
      });
    }
  }

  async canImport(): Promise<boolean> {
    return Boolean(this.archiveImporter);
  }

  async getCapabilities() {
    return conversationArchiveCapabilities();
  }

  /** 写入预检快照，并在超过上限时按插入序淘汰最旧条目（Map 保持插入序）。 */
  private setPreviewPreflightSnapshot(
    key: string,
    snapshot: ConversationSharePreviewPreflightSnapshot,
  ): void {
    // 重新写同一 key 时先删再插，让它回到插入序末尾，淘汰才是真正的「最久未更新」。
    this.previewPreflightSnapshots.delete(key);
    this.previewPreflightSnapshots.set(key, snapshot);
    while (this.previewPreflightSnapshots.size > PREVIEW_PREFLIGHT_SNAPSHOT_MAX_ENTRIES) {
      const oldestKey = this.previewPreflightSnapshots.keys().next().value;
      if (oldestKey === undefined) break;
      this.previewPreflightSnapshots.delete(oldestKey);
    }
  }

  /** 分享结束后回收该 workspace+session 的全部预检快照。 */
  private clearPreviewPreflightSnapshots(
    input: Pick<
      PublishTextConversationInput | ConversationSharePreflightInput,
      "workspacePath" | "workspaceIdentity" | "remoteSessionId" | "sessionId"
    >,
  ): void {
    const prefix = previewPreflightKey(input, "");
    for (const key of this.previewPreflightSnapshots.keys()) {
      if (key.startsWith(prefix)) this.previewPreflightSnapshots.delete(key);
    }
  }

  async preflight(
    input: ConversationSharePreflightInput,
  ): Promise<ConversationSharePreflightResult> {
    try {
      return await this.preflightWithAgent(input, this.zcodeAgentService);
    } catch (error) {
      throw normalizeConversationShareConnectionError(error);
    }
  }

  private async preflightWithAgent(
    input: ConversationSharePreflightInput,
    agentService: ConversationShareAgentService,
  ): Promise<ConversationSharePreflightResult> {
    const capabilities = await this.getCapabilities();
    const supportedArtifactTypes = allowedArtifactSummaries(capabilities);
    const conversation = await this.loadAllRows(input, agentService);
    const blockingIssues: ConversationShareFailureIssue[] = [];
    const skippableWarnings: ConversationShareFailureIssue[] = [];
    const deferredIssues: ConversationShareFailureIssue[] = [];

    let selected: { rows: ConversationRow[]; productTurnIds: string[] };
    try {
      selected = selectRows(conversation.rows, input.selection);
    } catch (error) {
      if (error instanceof ConversationShareServiceError) {
        blockingIssues.push({
          code: "invalid_selection",
          scope: "conversation",
        });
      } else {
        throw error;
      }
      return {
        revision: conversation.revision,
        logEpoch: conversation.logEpoch,
        capabilitiesFingerprint: capabilitiesFingerprint(capabilities),
        blockingIssues,
        skippableWarnings,
        deferredIssues,
        supportedArtifactTypes,
        turnResults: [],
      };
    }

    const turnOrdinalByProductTurnId = turnOrdinalByProductTurn(conversation.rows);
    const inlineImages = materializeConversationShareInlineImages(
      removeIndependentArtifactRows(sanitizeUnsupportedShareStructures(selected.rows)),
      capabilities,
      turnOrdinalByProductTurnId,
    );
    const artifactSanitized = sanitizeUnsupportedShareArtifacts(
      inlineImages.rows,
      capabilities,
      conversation.rows,
    );
    const workflowSnapshot = await collectConversationShareWorkflowSnapshot({
      agent: agentService,
      input,
      rows: artifactSanitized.rows,
      allRows: conversation.rows,
      capabilities,
      capturedAt: Date.now(),
      preflight: true,
    });
    if (!supportsConversationShareContent(capabilities, "tool-presentation")) {
      // 服务端不支持 tool-presentation 时，工具展示与内嵌图片无法进入公开载荷，
      // 必须在预检里说出「这部分内容不会包含」，而不是静默少一张图。
      for (const row of selected.rows) {
        if (
          row.kind === "toolCall" &&
          (projectShareToolDisplay(row.output?.display) || row.display?.kind === "node_repl_images")
        )
          inlineImages.warnings.push({
            code: "content_unavailable",
            scope: "turn",
            productTurnId: row.productTurnId,
            rowId: row.rowId,
          });
      }
    }
    const selectedRows = workflowSnapshot.rows;
    const contentWarnings: ConversationShareFailureIssue[] = workflowSnapshot.drafts.flatMap(
      (draft) =>
        draft.payload.unavailable ||
        draft.payload.artifacts.some((artifact) => artifact.unavailable) ||
        !supportsConversationShareContent(capabilities)
          ? [
              {
                code: "content_unavailable",
                scope: "turn",
                productTurnId: draft.productTurnId,
                turnOrdinal: turnOrdinalByProductTurnId.get(draft.productTurnId),
              },
            ]
          : [],
    );
    skippableWarnings.push(
      ...inlineImages.warnings,
      ...artifactSanitized.warnings,
      ...contentWarnings,
    );
    blockingIssues.push(...collectShareStructureIssues(selectedRows, conversation.rows));
    let hasShareableContent = selectedRows.some((row) => {
      if (row.kind === "turnHeader" || row.kind === "timelineMarker") return false;
      if (row.kind === "assistantText" || row.kind === "reasoning")
        return row.text.trim().length > 0;
      if (row.kind === "userInput") return row.text.trim().length > 0;
      if (row.kind === "toolCall") {
        return Boolean(
          row.inputText?.trim() || row.output?.text?.trim() || row.error?.message?.trim(),
        );
      }
      return true;
    });

    // 先把需要 stat 的附件收集齐，再有界并发跑，最后按原顺序分类。
    // 拆成两轮是为了在拿到远程并发收益的同时，让 issue 的产生顺序与串行实现一致。
    const attachmentChecks: {
      row: Extract<ConversationRow, { kind: "userInput" }> & {
        entityId: string;
      };
      attachmentIndex: number;
      attachment: NonNullable<
        Extract<ConversationRow, { kind: "userInput" }>["attachments"]
      >[number];
      allowed: ReturnType<typeof allowedArtifactFor>;
      baseIssue: Omit<ConversationShareFailureIssue, "code">;
    }[] = [];
    for (const row of selectedRows) {
      if (row.kind !== "userInput" || !row.attachments) continue;
      for (const [attachmentIndex, attachment] of row.attachments.entries()) {
        const extension = fileExtension(attachment.fileName);
        const mimeType = normalizedMimeType(attachment.mime);
        const allowed = allowedArtifactFor(capabilities, extension, mimeType);
        const baseIssue = {
          scope: "artifact" as const,
          rowId: row.rowId,
          ...(row.productTurnId && turnOrdinalByProductTurnId.has(row.productTurnId)
            ? { turnOrdinal: turnOrdinalByProductTurnId.get(row.productTurnId) }
            : {}),
          ...(row.productTurnId ? { productTurnId: row.productTurnId } : {}),
          artifactDisplayName: attachmentDisplayName(attachment.fileName),
          ...(extension ? { extension } : {}),
          mimeType,
          ...(allowed ? { artifactType: allowed.type } : { artifactType: extension ?? "unknown" }),
          allowedArtifacts: supportedArtifactTypes,
        } satisfies Partial<ConversationShareFailureIssue>;
        if (!row.entityId) {
          blockingIssues.push({
            code: "input_attachment",
            scope: "artifact",
            rowId: row.rowId,
            ...(baseIssue.turnOrdinal === undefined ? {} : { turnOrdinal: baseIssue.turnOrdinal }),
            ...(baseIssue.productTurnId === undefined
              ? {}
              : { productTurnId: baseIssue.productTurnId }),
            artifactDisplayName: attachmentDisplayName(attachment.fileName),
          });
          continue;
        }
        attachmentChecks.push({
          row: { ...row, entityId: row.entityId },
          attachmentIndex,
          attachment,
          allowed,
          baseIssue,
        });
      }
    }
    const attachmentStats = await mapWithConcurrency(
      attachmentChecks,
      SHARE_PREFLIGHT_STAT_CONCURRENCY,
      (check) =>
        settle(() =>
          agentService.conversationAttachmentStatV4({
            workspacePath: input.workspacePath,
            ...(input.workspaceIdentity ? { workspaceIdentity: input.workspaceIdentity } : {}),
            ...(input.remoteSessionId ? { remoteSessionId: input.remoteSessionId } : {}),
            sessionId: input.sessionId,
            target: { rowId: check.row.rowId, entityId: check.row.entityId },
            attachmentIndex: check.attachmentIndex,
            ref: check.attachment.ref,
          }),
        ),
    );
    for (const [checkIndex, check] of attachmentChecks.entries()) {
      const { row, attachment, allowed, baseIssue } = check;
      const settled = attachmentStats[checkIndex]!;
      if (settled.ok) {
        const stat = settled.value;
        if (!allowed) {
          // 即使类型不支持，也必须先完成选择阶段存在性检查；只有存在的附件才展示
          // artifact_type_not_allowed，避免把已经清理的附件误报成能力问题。
          //
          // 类型判定必须排在体积判定之前：不支持的类型根本不会被上传，它的体积
          // 与分享无关。反过来会把「格式不支持（可跳过）」升级成「体积超限（阻断）」，
          // 用户被一个压缩也解决不了的错误挡住。
          skippableWarnings.push({
            code: "artifact_type_not_allowed",
            ...baseIssue,
          });
        } else if (stat.totalBytes > capabilities.max_artifact_bytes) {
          blockingIssues.push({
            code: "artifact_size_limit",
            ...baseIssue,
            actual: stat.totalBytes,
            limit: capabilities.max_artifact_bytes,
          });
        } else if (attachment.bytes > 0 && stat.totalBytes !== attachment.bytes) {
          skippableWarnings.push({
            code: "artifact_changed",
            ...baseIssue,
            availability: "changed",
          });
        } else {
          hasShareableContent = true;
        }
      } else {
        const error = settled.error;
        if (isAttachmentAuthorizationError(error)) {
          blockingIssues.push({
            code: "artifact_protocol_not_ready",
            scope: "artifact",
            rowId: row.rowId,
            ...(baseIssue.turnOrdinal === undefined ? {} : { turnOrdinal: baseIssue.turnOrdinal }),
            ...(baseIssue.productTurnId === undefined
              ? {}
              : { productTurnId: baseIssue.productTurnId }),
            artifactDisplayName: attachmentDisplayName(attachment.fileName),
          });
        } else if (isAttachmentTooLargeError(error)) {
          // 附件大到连 stat 都无法表达时，仍然是「已知容量超限」这一确定阻断，
          // 绝不能降级成 deferred —— 那会让发布悄悄丢掉这个附件。
          blockingIssues.push({
            code: "artifact_size_limit",
            ...baseIssue,
            limit: capabilities.max_artifact_bytes,
          });
        } else if (isDefiniteMissingAttachment(error)) {
          skippableWarnings.push({
            code: "input_attachment_unavailable",
            ...baseIssue,
            availability: "not_found",
          });
        } else {
          hasShareableContent = true;
          deferredIssues.push({
            code: "artifact_read_failed",
            ...baseIssue,
            availability: "unknown",
          });
        }
      }
    }

    if (!hasShareableContent) {
      blockingIssues.push({
        code: "no_shareable_content",
        scope: "conversation",
      });
    }

    if (blockingIssues.length > 0) {
      const sanitizedBlockingIssues = sanitizeConversationShareIssues(blockingIssues);
      const sanitizedWarnings = sanitizeConversationShareIssues(skippableWarnings);
      const sanitizedDeferred = sanitizeConversationShareIssues(deferredIssues);
      return {
        revision: conversation.revision,
        logEpoch: conversation.logEpoch,
        capabilitiesFingerprint: capabilitiesFingerprint(capabilities),
        blockingIssues: sanitizedBlockingIssues.issues,
        skippableWarnings: sanitizedWarnings.issues,
        deferredIssues: sanitizedDeferred.issues,
        supportedArtifactTypes,
        turnResults: buildTurnPreflightResults(
          selected.productTurnIds,
          turnOrdinalByProductTurnId,
          sanitizedBlockingIssues.issues,
          sanitizedWarnings.issues,
          sanitizedDeferred.issues,
        ),
      };
    }

    const registeredProjection = buildConversationSharePublicProjection({
      rows: selectedRows,
      selectedProductTurnIds: selected.productTurnIds,
      toolPresentation: supportsConversationShareContent(capabilities, "tool-presentation"),
      toolImages: inlineImages.toolImages,
      sourceRows: conversation.rows,
    });
    if (registeredProjection.rows.length > capabilities.max_rows) {
      blockingIssues.push({
        code: "rows_limit",
        scope: "conversation",
        actual: registeredProjection.rows.length,
        limit: capabilities.max_rows,
      });
    }
    const manifestIssues = this.collectArtifactManifestIssues(
      capabilities,
      registeredProjection.artifacts,
    ).map((issue) => {
      // 内嵌图片的容量问题必须带轮次定位，否则拆分 turn 缓存时会漏掉文件级阻断。
      const row = selectedRows.find(
        (candidate) =>
          candidate.kind === "artifact" && candidate.displayName === issue.artifactDisplayName,
      );
      return row
        ? {
            ...issue,
            rowId: row.rowId,
            productTurnId: row.productTurnId,
            turnOrdinal: row.productTurnId
              ? turnOrdinalByProductTurnId.get(row.productTurnId)
              : undefined,
          }
        : issue;
    });
    blockingIssues.push(
      ...manifestIssues.filter((issue) => issue.code !== "artifact_type_not_allowed"),
    );
    skippableWarnings.push(
      ...manifestIssues.filter((issue) => issue.code === "artifact_type_not_allowed"),
    );

    const headersByProductTurnId = new Map<
      string,
      Extract<ConversationRow, { kind: "turnHeader" }>
    >();
    const assistantTextByProductTurnId = new Map<string, string[]>();
    for (const row of selectedRows) {
      if (row.kind === "turnHeader" && row.productTurnId) {
        headersByProductTurnId.set(row.productTurnId, row);
      }
      if (row.kind === "assistantText" && row.productTurnId && !isWorkflowShareFallbackRow(row)) {
        const texts = assistantTextByProductTurnId.get(row.productTurnId) ?? [];
        texts.push(row.text);
        assistantTextByProductTurnId.set(row.productTurnId, texts);
      }
    }

    for (const [productTurnId, textParts] of assistantTextByProductTurnId) {
      const header = headersByProductTurnId.get(productTurnId);
      if (!header) continue;
      const assistantText = textParts.join("\n\n");
      const references = extractConversationPreviewFileReferences(
        assistantText,
        input.workspacePath,
      );
      const needsFileChanges = references.some(
        (reference) => reference.kind === "markdown" || reference.kind === "html",
      );
      let fileChanges: Array<{ path: string; state: "active" | "reverted" }> | undefined;
      if (needsFileChanges && header.fileChanges?.state !== "reverted") {
        if (!header.entityId) {
          deferredIssues.push({
            code: "artifact_read_failed",
            scope: "artifact",
            rowId: header.rowId,
            turnOrdinal: turnOrdinalByProductTurnId.get(productTurnId),
            productTurnId,
            availability: "unknown",
          });
          continue;
        }
        const result = await agentService.conversationFileChangesV4({
          workspacePath: input.workspacePath,
          ...(input.workspaceIdentity ? { workspaceIdentity: input.workspaceIdentity } : {}),
          ...(input.remoteSessionId ? { remoteSessionId: input.remoteSessionId } : {}),
          sessionId: input.sessionId,
          target: { rowId: header.rowId, entityId: header.entityId },
          baseRevision: conversation.revision,
          baseLogEpoch: conversation.logEpoch,
        });
        fileChanges = result.items.map((item) => ({
          path: item.path,
          state: result.state === "reverted" ? ("reverted" as const) : ("active" as const),
        }));
      }

      const candidates = buildConversationPreviewArtifactCandidates({
        assistantText,
        productTurnId,
        workspacePath: input.workspacePath,
        fileChanges,
      });
      const visibleCandidates: ConversationPreviewArtifactCandidate[] = [];
      const previewCanonicalPaths = new Set<string>();
      let previewStatSettled = this.artifactSource.stat !== undefined;
      // stat 并发发起，判定仍按候选原顺序进行：去重和可见卡片上限都依赖顺序，
      // 而每次 stat 在远程 workspace 下都是一次往返。
      const artifactSourceStat = this.artifactSource.stat;
      const candidateStats = artifactSourceStat
        ? await mapWithConcurrency(candidates, SHARE_PREFLIGHT_STAT_CONCURRENCY, (candidate) =>
            settle(() =>
              artifactSourceStat({
                workspacePath: input.workspacePath,
                ref: candidate.sourceRef,
              }),
            ),
          )
        : [];
      for (const [candidateIndex, candidate] of candidates.entries()) {
        const issue = {
          scope: "artifact" as const,
          rowId: header.rowId,
          turnOrdinal: turnOrdinalByProductTurnId.get(productTurnId),
          productTurnId,
          artifactDisplayName: candidate.displayName,
          artifactType: candidate.artifactType,
          extension: fileExtension(candidate.displayName),
          mimeType: candidate.mimeType,
          allowedArtifacts: supportedArtifactTypes,
        } satisfies Omit<ConversationShareFailureIssue, "code">;

        // 先检查候选上限内的全部路径，再从存在的路径里取 UI 同样的可见卡片上限。
        // 这样不会因为前面几个文件存在就漏掉后续候选的存在性检查。
        const settled = candidateStats[candidateIndex];
        if (!settled) {
          previewStatSettled = false;
          deferredIssues.push({
            code: "artifact_read_failed",
            ...issue,
            availability: "unknown",
          });
          continue;
        }
        if (settled.ok) {
          if (previewCanonicalPaths.has(settled.value.canonicalPath)) continue;
          previewCanonicalPaths.add(settled.value.canonicalPath);
        } else {
          if (isMissingArtifactReadError(settled.error)) {
            // Assistant 预览文件已不存在时，UI 也不会显示这张卡片，因此不产生 Share warning。
            continue;
          }
          previewStatSettled = false;
          deferredIssues.push({
            code: "artifact_read_failed",
            ...issue,
            availability: "unknown",
          });
          continue;
        }
        if (visibleCandidates.length < CONVERSATION_PREVIEW_CARD_VISIBLE_LIMIT) {
          visibleCandidates.push(candidate);
        }
      }

      for (const candidate of visibleCandidates) {
        const issue = {
          scope: "artifact" as const,
          rowId: header.rowId,
          turnOrdinal: turnOrdinalByProductTurnId.get(productTurnId),
          productTurnId,
          artifactDisplayName: candidate.displayName,
          artifactType: candidate.artifactType,
          extension: fileExtension(candidate.displayName),
          mimeType: candidate.mimeType,
          allowedArtifacts: supportedArtifactTypes,
        } satisfies Omit<ConversationShareFailureIssue, "code">;
        const allowed =
          candidate.previewKind === "video" || candidate.previewKind === "audio"
            ? undefined
            : allowedArtifactFor(
                capabilities,
                fileExtension(candidate.displayName),
                candidate.mimeType,
              );
        if (!allowed) {
          skippableWarnings.push({ code: "artifact_type_not_allowed", ...issue });
        }
      }
      const snapshotKey = previewPreflightKey(input, productTurnId);
      if (previewStatSettled) {
        this.setPreviewPreflightSnapshot(snapshotKey, {
          revision: conversation.revision,
          logEpoch: conversation.logEpoch,
          capabilitiesFingerprint: capabilitiesFingerprint(capabilities),
          candidateFingerprint: getConversationSharePreviewCandidateFingerprint(candidates),
          visibleSourceRefs: visibleCandidates.map((candidate) => candidate.sourceRef),
        });
      } else {
        this.previewPreflightSnapshots.delete(snapshotKey);
      }
    }

    const sanitizedBlockingIssues = sanitizeConversationShareIssues(blockingIssues);
    const sanitizedWarnings = sanitizeConversationShareIssues(skippableWarnings);
    const sanitizedDeferred = sanitizeConversationShareIssues(deferredIssues);
    return {
      revision: conversation.revision,
      logEpoch: conversation.logEpoch,
      capabilitiesFingerprint: capabilitiesFingerprint(capabilities),
      blockingIssues: sanitizedBlockingIssues.issues,
      skippableWarnings: sanitizedWarnings.issues,
      deferredIssues: sanitizedDeferred.issues,
      supportedArtifactTypes,
      turnResults: buildTurnPreflightResults(
        selected.productTurnIds,
        turnOrdinalByProductTurnId,
        sanitizedBlockingIssues.issues,
        sanitizedWarnings.issues,
        sanitizedDeferred.issues,
      ).map((result) => ({
        ...result,
        // 行数是整组选中项的约束；每个 turn 只带自己的行数与全局上限，
        // 由 UI 在取消/新增轮次后重算合计，不缓存某一批 RPC 的合计值。
        rowBudget: {
          count: registeredProjection.rows.filter(
            (row) =>
              row.productTurnId ===
              registeredProjection.selectedProductTurnIds[
                selected.productTurnIds.indexOf(result.productTurnId)
              ],
          ).length,
          limit: capabilities.max_rows,
        },
      })),
    };
  }

  /** Host attachment 内部 facade：复用同一业务 service，只替换 V4 Rows/File 查询的可信 Agent scope。 */
  [conversationShareConnectionScopeFactory](
    agentService: ConversationShareAgentService,
  ): IConversationShareService {
    const exportOwner = Symbol("attachment-conversation-export");
    return {
      getCapabilities: () => this.getCapabilities(),
      canImport: () => this.canImport(),
      preflight: async (input) => {
        try {
          return await this.preflightWithAgent(input, agentService);
        } catch (error) {
          throw normalizeConversationShareConnectionError(error);
        }
      },
      publish: (input, operationId) =>
        this.publishWithAgent(input, operationId, agentService, exportOwner),
      readExportChunk: async (id, offset) => this.archiveExports.read(exportOwner, id, offset),
      releaseExport: async (id) => this.archiveExports.release(exportOwner, id),
      onDynamicPublishProgress: (operationId) => this.onDynamicPublishProgress(operationId),
      beginArchiveImport: async (size) => this.beginImportWithOwner(size, exportOwner),
      appendArchiveImport: async (id, offset, base64) =>
        this.archiveImports.append(exportOwner, id, offset, base64),
      releaseArchiveImport: async (id) => this.archiveImports.release(exportOwner, id),
      importShare: (input, operationId) => this.importWithOwner(input, operationId, exportOwner),
      onDynamicImportProgress: (operationId) => this.onDynamicImportProgress(operationId),
      getImportedConversation: (input) => this.getImportedConversation(input),
    };
  }

  onDynamicPublishProgress(operationId: string) {
    return this.getProgressEmitter(operationId).event;
  }

  onDynamicImportProgress(operationId: string) {
    return this.getImportProgressEmitter(operationId).event;
  }

  async beginArchiveImport(byteLength: number): Promise<string> {
    return this.beginImportWithOwner(byteLength, this.exportOwner);
  }

  private beginImportWithOwner(byteLength: number, owner: symbol): string {
    if (!this.archiveImporter)
      throw new ConversationShareServiceError(
        "feature_disabled",
        "Conversation import is unavailable",
      );
    return this.archiveImports.begin(owner, byteLength);
  }

  async appendArchiveImport(id: string, offset: number, base64: string): Promise<void> {
    this.archiveImports.append(this.exportOwner, id, offset, base64);
  }

  async releaseArchiveImport(id: string): Promise<void> {
    this.archiveImports.release(this.exportOwner, id);
  }

  async importShare(
    input: ImportConversationShareInput,
    operationId: string,
  ): Promise<ImportConversationShareResult> {
    return this.importWithOwner(input, operationId, this.exportOwner);
  }

  private async importWithOwner(
    input: ImportConversationShareInput,
    operationId: string,
    owner: symbol,
  ): Promise<ImportConversationShareResult> {
    const importer = this.archiveImporter;
    if (!importer)
      throw new ConversationShareServiceError(
        "feature_disabled",
        "Conversation import is unavailable",
      );
    try {
      return await this.archiveImports.consume(owner, input.archiveId, async (bytes) => {
        this.importProgressEmitters
          .get(operationId)
          ?.fire({ operationId, phase: "validating", completedArtifacts: 0, totalArtifacts: 0 });
        const decoded = await decodeConversationArchive(bytes);
        return importer.import(
          decoded,
          createHash("sha256").update(bytes).digest("hex"),
          input,
          operationId,
        );
      });
    } catch (error) {
      if (error instanceof ConversationShareServiceError) throw error;
      if (error instanceof ConversationArchiveError) {
        throw new ConversationShareServiceError(
          error.code === "limit_exceeded"
            ? "limit_exceeded"
            : error.code === "unsupported_version"
              ? "unsupported_schema_version"
              : "invalid_contract",
          "Conversation archive could not be imported",
        );
      }
      throw new ConversationShareServiceError(
        "unknown",
        "Conversation import could not be completed",
        { cause: error },
      );
    }
  }

  /**
   * 按 contextId 找回导入时落盘的公开 rows。
   *
   * 目录名用的是 share_id 而不是 contextId（二者不等价），所以扫 .zcodium-share/ 下各
   * importRoot 并比对文件内的 contextId —— 不额外维护索引，历史导入也能被读到。
   * 内容来自磁盘，属跨存储边界，必须过 schema 再交给渲染层。
   */
  async getImportedConversation(input: {
    workspacePath: string;
    contextId: string;
  }): Promise<ImportedConversationShare | null> {
    const shareRoot = join(input.workspacePath, ".zcodium-share");
    let entries: Dirent[];
    try {
      entries = await readdir(shareRoot, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(
          await readFile(join(shareRoot, entry.name, "shared-conversation.json"), "utf8"),
        );
      } catch {
        continue;
      }
      const validated = importedConversationShareFileSchema.safeParse(parsed);
      if (!validated.success || validated.data.contextId !== input.contextId) continue;
      const decoded = decodeConversationShareRows(validated.data.rows);
      // 内容块同样逐块降级：认不出的块不认领 fallback Row（原位摘要仍可读），
      // 但必须计入软提示，避免旧版查看新版导入副本时静默少一张卡片。
      const decodedBlocks = decodeConversationShareContentBlocks(validated.data.content_blocks);
      // formatVersion 比本端新（用户在新版导入后回退到旧版）时，认不出的行照样计入
      // unsupportedRowCount，让 UI 出软提示——不能静默少内容。
      const unsupportedRowCount =
        decoded.unsupportedCount +
        ((validated.data.content_blocks?.length ?? 0) - decodedBlocks.length) +
        (validated.data.formatVersion > IMPORTED_CONVERSATION_SHARE_FORMAT_VERSION ? 1 : 0);
      if (unsupportedRowCount > 0) {
        this.logger.info(
          undefined,
          "imported conversation share has content this build can't read",
          {
            formatVersion: validated.data.formatVersion,
            kinds: decoded.unsupportedKinds,
            droppedCount: decoded.unsupportedCount,
            keptCount: decoded.rows.length,
          },
        );
      }
      return {
        shareId: validated.data.shareId,
        contextId: validated.data.contextId,
        title: validated.data.title,
        rows: decoded.rows,
        ...(validated.data.content_blocks === undefined
          ? {}
          : { contentBlocks: validated.data.content_blocks }),
        artifacts: validated.data.artifacts,
        unsupportedRowCount,
      };
    }
    return null;
  }

  async readExportChunk(id: string, offset: number): Promise<string> {
    return this.archiveExports.read(this.exportOwner, id, offset);
  }

  async releaseExport(id: string): Promise<void> {
    this.archiveExports.release(this.exportOwner, id);
  }

  async publish(input: PublishTextConversationInput, operationId: string) {
    return this.publishWithAgent(input, operationId, this.zcodeAgentService);
  }

  private async publishWithAgent(
    input: PublishTextConversationInput,
    operationId: string,
    agentService: ConversationShareAgentService,
    exportOwner = this.exportOwner,
  ) {
    this.logger.info(undefined, "conversation share publish started", {
      operationId,
      selectionKind: input.selection.kind,
      remoteWorkspace: Boolean(input.workspaceIdentity || input.remoteSessionId),
    });
    try {
      const result = await this.archiveExports.create(exportOwner, input.title, () =>
        this.publishInternal(input, operationId, agentService),
      );
      this.logger.info(undefined, "conversation share publish completed", {
        operationId,
        phase: "complete",
      });
      // 发布成功即本次分享结束，该 session 的预检快照不再有消费者：立刻回收，
      // 否则长生命周期的 desktop host 会无限累积 workspace+session+turn 条目。
      this.clearPreviewPreflightSnapshots(input);
      return result;
    } catch (rawError) {
      const error = normalizeConversationShareConnectionError(rawError);
      const record =
        error !== null && typeof error === "object" ? (error as Record<string, unknown>) : null;
      this.logger.warn(undefined, "conversation share publish failed", {
        operationId,
        phase: this.publishPhases.get(operationId) ?? "collecting",
        kind: typeof record?.kind === "string" ? record.kind : "unknown",
        ...(typeof record?.reasonCode === "string" ? { reasonCode: record.reasonCode } : {}),
        ...(record?.diagnostics && typeof record.diagnostics === "object"
          ? { diagnostics: record.diagnostics }
          : {}),
        ...(typeof record?.status === "number" ? { status: record.status } : {}),
        ...(typeof record?.code === "number" ? { code: record.code } : {}),
        ...(typeof record?.requestId === "string" ? { requestId: record.requestId } : {}),
        errorName:
          typeof record?.name === "string"
            ? record.name
            : error instanceof Error
              ? error.name
              : "UnknownError",
      });
      throw error;
    } finally {
      this.publishPhases.delete(operationId);
    }
  }

  private async publishInternal(
    input: PublishTextConversationInput,
    operationId?: string,
    agentService: ConversationShareAgentService = this.zcodeAgentService,
  ): Promise<Buffer> {
    const report = (
      phase: ConversationSharePublishProgress["phase"],
      completedArtifacts = 0,
      totalArtifacts = 0,
      warnings?: {
        issues: readonly ConversationShareFailureIssue[];
        issueCount: number;
        omittedIssueCount: number;
      },
    ) => {
      if (!operationId) return;
      this.publishPhases.set(operationId, phase);
      this.logger.info(undefined, "conversation share publish phase changed", {
        operationId,
        phase,
        completedArtifacts,
        totalArtifacts,
        ...(warnings ? { warningCount: warnings.issueCount } : {}),
      });
      this.progressEmitters.get(operationId)?.fire({
        operationId,
        phase,
        completedArtifacts,
        totalArtifacts,
        ...(warnings
          ? { warnings: warnings.issues, omittedWarningCount: warnings.omittedIssueCount }
          : {}),
      });
    };
    report("collecting");
    if (!input.title.trim() || !input.clientRequestId.trim()) {
      throwServiceError("invalid_contract", "Share title and request identity are required");
    }
    if (input.selection.kind === "rowAnchors" && input.selection.rowIds.length === 0) {
      throwServiceError("invalid_selection", "At least one conversation row must be selected");
    }

    const capabilities = await this.getCapabilities();
    const conversation = await this.loadAllRows(input, agentService);
    const selected = selectRows(conversation.rows, input.selection);
    // 无法公开承载的已定稿结构先降级：删字段或丢整行，换成非阻断提示，
    // 后续所有投影与产物发现都基于这份 sanitized rows。
    const turnOrdinalByProductTurnId = turnOrdinalByProductTurn(conversation.rows);
    const inlineImages = materializeConversationShareInlineImages(
      removeIndependentArtifactRows(sanitizeUnsupportedShareStructures(selected.rows)),
      capabilities,
      turnOrdinalByProductTurnId,
    );
    const artifactSanitized = sanitizeUnsupportedShareArtifacts(
      inlineImages.rows,
      capabilities,
      conversation.rows,
    );
    const workflowSnapshot = await collectConversationShareWorkflowSnapshot({
      agent: agentService,
      input,
      rows: artifactSanitized.rows,
      allRows: conversation.rows,
      capabilities,
      capturedAt: Date.now(),
    });
    if (!supportsConversationShareContent(capabilities, "tool-presentation")) {
      for (const row of selected.rows) {
        if (
          row.kind === "toolCall" &&
          (projectShareToolDisplay(row.output?.display) || row.display?.kind === "node_repl_images")
        )
          inlineImages.warnings.push({
            code: "content_unavailable",
            scope: "turn",
            productTurnId: row.productTurnId,
            rowId: row.rowId,
          });
      }
    }
    const selectedRows = workflowSnapshot.rows;
    const contentWarnings: ConversationShareFailureIssue[] = workflowSnapshot.drafts.flatMap(
      (draft) =>
        draft.payload.unavailable ||
        draft.payload.artifacts.some((artifact) => artifact.unavailable) ||
        !supportsConversationShareContent(capabilities)
          ? [
              {
                code: "content_unavailable",
                scope: "turn",
                productTurnId: draft.productTurnId,
                turnOrdinal: turnOrdinalByProductTurnId.get(draft.productTurnId),
              },
            ]
          : [],
    );
    const publishWarnings: ConversationShareFailureIssue[] = [
      ...inlineImages.warnings,
      ...artifactSanitized.warnings,
      ...contentWarnings,
    ];
    // 公开投影不能遇到第一个不支持结构就直接退出，用户要知道还有哪些轮次需要取消；
    // 先完成整组选中内容的结构预检，返回脱敏 issues 让 UI 给出逐项可操作建议。
    const structureIssues = collectShareStructureIssues(selectedRows, conversation.rows);
    if (structureIssues.length > 0) {
      const structureKind = structureIssues.some(
        (issue) => issue.code === "artifact_protocol_not_ready",
      )
        ? "artifact_protocol_not_ready"
        : structureIssues.some((issue) => issue.code === "unsafe_url")
          ? "unsafe_structure"
          : "invalid_conversation";
      throw new ConversationShareServiceError(
        structureKind,
        "Selected conversation contains unsupported structure",
        { issues: structureIssues },
      );
    }
    // 本地运行投影包含 subagent 详情与写入态 ID；导出必须使用独立公开投影，
    // 避免把运行时身份和未选内容放入可移植文件。
    const registeredProjection = buildConversationSharePublicProjection({
      rows: selectedRows,
      selectedProductTurnIds: selected.productTurnIds,
      toolPresentation: supportsConversationShareContent(capabilities, "tool-presentation"),
      toolImages: inlineImages.toolImages,
      sourceRows: conversation.rows,
    });
    this.validateArtifactManifest(capabilities, registeredProjection.artifacts);
    const preflightPreviewSnapshots = new Map<string, ConversationSharePreviewPreflightSnapshot>();
    for (const productTurnId of selected.productTurnIds) {
      const snapshot = this.previewPreflightSnapshots.get(
        previewPreflightKey(input, productTurnId),
      );
      if (snapshot) preflightPreviewSnapshots.set(productTurnId, snapshot);
    }
    const artifactSnapshot = await buildConversationShareArtifactSnapshot({
      zcodeAgentService: agentService,
      artifactSource: this.artifactSource,
      input,
      selectedRows,
      registeredArtifacts: registeredProjection.artifacts,
      inlineBytesBySourceRef: new Map([
        ...inlineImages.bytesBySourceRef,
        ...workflowSnapshot.bytes,
      ]),
      capabilities,
      revision: conversation.revision,
      logEpoch: conversation.logEpoch,
      turnOrdinalByProductTurnId,
      preflightPreviewSnapshots,
      currentCapabilitiesFingerprint: capabilitiesFingerprint(capabilities),
    });
    if (artifactSnapshot.issues.length > 0) {
      throw new ConversationShareServiceError(
        "artifact_not_allowed",
        "Conversation result artifacts are not allowed by server capabilities",
        { issues: artifactSnapshot.issues },
      );
    }
    if (artifactSnapshot.warnings.length > 0) {
      publishWarnings.push(...artifactSnapshot.warnings);
    }
    if (publishWarnings.length > 0) {
      // 非阻断：正文引用的文件或用户输入附件无法物化时，发布照常继续，但要让分享者
      // 知道哪些真实文件没有进入导出文件；内部 marker/inline image 已在前面静默移除。
      report("collecting", 0, 0, sanitizeConversationShareIssues(publishWarnings));
    }
    const publicProjection = buildConversationSharePublicProjection({
      rows: artifactSnapshot.rows,
      selectedProductTurnIds: selected.productTurnIds,
      additionalArtifacts: artifactSnapshot.additionalArtifacts,
      toolPresentation: supportsConversationShareContent(capabilities, "tool-presentation"),
      toolImages: inlineImages.toolImages,
      sourceRows: conversation.rows,
      ...(supportsConversationShareContent(capabilities)
        ? { contentDrafts: workflowSnapshot.drafts }
        : {}),
    });
    this.validateArtifactManifest(capabilities, publicProjection.artifacts);
    if (publicProjection.rows.length > capabilities.max_rows) {
      throw new ConversationShareServiceError(
        "limit_exceeded",
        "Conversation contains too many rows to share",
        {
          issues: [
            {
              code: "rows_limit",
              scope: "conversation",
              actual: publicProjection.rows.length,
              limit: capabilities.max_rows,
            },
          ],
        },
      );
    }

    report("packing", 0, publicProjection.artifacts.length);
    const archive = await encodeConversationArchive({
      title: input.title.trim(),
      selectedProductTurnIds: publicProjection.selectedProductTurnIds,
      rows: publicProjection.rows,
      ...(publicProjection.contentBlocks ? { contentBlocks: publicProjection.contentBlocks } : {}),
      artifacts: publicProjection.artifacts.map((artifact) => {
        const bytes = artifactSnapshot.bytesBySourceRef.get(artifact.sourceRef);
        if (!bytes)
          throw new ConversationShareServiceError(
            "invalid_contract",
            "Conversation export artifact is missing",
          );
        const { original_path: _originalPath, ...descriptor } = artifact.descriptor;
        return { descriptor, bytes };
      }),
    });
    report("complete", publicProjection.artifacts.length, publicProjection.artifacts.length);
    return archive;
  }

  private getProgressEmitter(operationId: string): Emitter<ConversationSharePublishProgress> {
    const existing = this.progressEmitters.get(operationId);
    if (existing) return existing;
    const emitter = new Emitter<ConversationSharePublishProgress>({
      onDidRemoveLastListener: () => {
        this.progressEmitters.delete(operationId);
        emitter.dispose();
      },
    });
    this.progressEmitters.set(operationId, emitter);
    return emitter;
  }

  private getImportProgressEmitter(operationId: string): Emitter<ConversationShareImportProgress> {
    const existing = this.importProgressEmitters.get(operationId);
    if (existing) return existing;
    const emitter = new Emitter<ConversationShareImportProgress>({
      onDidRemoveLastListener: () => {
        this.importProgressEmitters.delete(operationId);
        emitter.dispose();
      },
    });
    this.importProgressEmitters.set(operationId, emitter);
    return emitter;
  }

  private collectArtifactManifestIssues(
    capabilities: ConversationShareCapabilities,
    artifacts: Array<{
      sourceRef: string;
      descriptor: ConversationShareArtifactDescriptor;
    }>,
  ): ConversationShareFailureIssue[] {
    const artifactIds = new Set<string>();
    const issues: ConversationShareFailureIssue[] = [];
    if (artifacts.length > capabilities.max_artifact_count) {
      issues.push({
        code: "artifact_count_limit",
        scope: "conversation",
        actual: artifacts.length,
        limit: capabilities.max_artifact_count,
      });
    }
    let declaredTotalBytes = 0;
    for (const { descriptor } of artifacts) {
      if (artifactIds.has(descriptor.artifact_id)) {
        issues.push({
          code: "artifact_manifest",
          scope: "artifact",
          artifactDisplayName: descriptor.display_name,
        });
        continue;
      }
      artifactIds.add(descriptor.artifact_id);
      declaredTotalBytes += descriptor.size_bytes;
      if (descriptor.size_bytes > capabilities.max_artifact_bytes) {
        issues.push({
          code: "artifact_size_limit",
          scope: "artifact",
          artifactDisplayName: descriptor.display_name,
          artifactType: descriptor.artifact_type,
          extension: descriptor.extension,
          mimeType: descriptor.mime_type,
          actual: descriptor.size_bytes,
          limit: capabilities.max_artifact_bytes,
        });
      }
      const allowed = capabilities.allowed_artifacts.some(
        (candidate) =>
          candidate.type === descriptor.artifact_type &&
          candidate.extensions.some(
            (extension) => extension.replace(/^\./u, "").toLowerCase() === descriptor.extension,
          ) &&
          candidate.mime_types.some(
            (mimeType) => mimeType.toLowerCase() === descriptor.mime_type.toLowerCase(),
          ),
      );
      if (!allowed) {
        issues.push({
          code: "artifact_type_not_allowed",
          scope: "artifact",
          artifactDisplayName: descriptor.display_name,
          artifactType: descriptor.artifact_type,
          extension: descriptor.extension,
          mimeType: descriptor.mime_type,
          allowedFormats: allowedFormatLabels(capabilities),
          allowedArtifacts: allowedArtifactSummaries(capabilities),
        });
      }
    }
    if (declaredTotalBytes > capabilities.max_total_artifact_bytes) {
      issues.push({
        code: "artifact_total_size_limit",
        scope: "conversation",
        actual: declaredTotalBytes,
        limit: capabilities.max_total_artifact_bytes,
      });
    }
    return issues;
  }

  private validateArtifactManifest(
    capabilities: ConversationShareCapabilities,
    artifacts: Array<{
      sourceRef: string;
      descriptor: ConversationShareArtifactDescriptor;
    }>,
  ): void {
    const issues = this.collectArtifactManifestIssues(capabilities, artifacts);
    if (issues.length > 0) {
      const hasTypeIssue = issues.some((issue) => issue.code === "artifact_type_not_allowed");
      throw new ConversationShareServiceError(
        hasTypeIssue ? "artifact_not_allowed" : "limit_exceeded",
        "Conversation artifacts cannot be shared",
        { issues },
      );
    }
  }

  private async loadAllRows(
    input: Pick<
      PublishTextConversationInput,
      "workspacePath" | "workspaceIdentity" | "remoteSessionId" | "sessionId"
    >,
    agentService: ConversationShareAgentService,
  ): Promise<ConversationRowsRead> {
    const pages: ConversationRow[][] = [];
    let beforeRowId: number | undefined;
    let logEpoch: string | undefined;
    let revision: number | undefined;

    while (true) {
      const result = await agentService.conversationRowsRangeV4({
        workspacePath: input.workspacePath,
        ...(input.workspaceIdentity ? { workspaceIdentity: input.workspaceIdentity } : {}),
        ...(input.remoteSessionId ? { remoteSessionId: input.remoteSessionId } : {}),
        sessionId: input.sessionId,
        ...(beforeRowId === undefined ? {} : { beforeRowId }),
        limit: PROTOCOL_V4_LIMITS.rowsRangeMaxLimit,
      });
      if (
        (logEpoch !== undefined && result.atLogEpoch !== logEpoch) ||
        (revision !== undefined && result.atRevision !== revision)
      ) {
        throwServiceError("invalid_conversation", "Conversation changed while preparing share");
      }
      logEpoch = result.atLogEpoch;
      revision = result.atRevision;
      pages.unshift(result.rows);
      if (!result.hasMore) break;
      const firstRowId = result.rows[0]?.rowId;
      if (firstRowId === undefined || firstRowId === beforeRowId) {
        throwServiceError("invalid_contract", "Conversation row pagination did not advance");
      }
      beforeRowId = firstRowId;
    }

    const rows = pages.flat();
    for (let index = 1; index < rows.length; index += 1) {
      const previous = rows[index - 1]!;
      const current = rows[index]!;
      if (previous.rowId >= current.rowId) {
        throwServiceError("invalid_contract", "Conversation rows are not globally ordered");
      }
    }
    if (logEpoch === undefined || revision === undefined) {
      throwServiceError("invalid_contract", "Conversation rows are missing a read watermark");
    }
    return { rows, revision, logEpoch };
  }
}
