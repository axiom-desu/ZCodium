import { createUuid } from "@zcode/shared";

export const CONVERSATION_SELECTION_MAX_TEXT_LENGTH = 8_000;
/** 与 shared 的 `CONVERSATION_SELECTION_MAX_COMMENT_LENGTH` 同值：批注输入框就地限长。 */
export const CONVERSATION_SELECTION_MAX_COMMENT_LENGTH = 2_000;
const CONVERSATION_SELECTION_MAX_COUNT = 8;
const CONVERSATION_SELECTION_MAX_TOTAL_LENGTH = 16_000;

export type ConversationSelectionContentType = "user" | "assistant" | "reasoning" | "tool";

export interface ConversationSelectionText {
  text: string;
  path?: string;
  /** 用户对这段选区的批注；只有“批注”动作写入，普通引用缺省。 */
  comment?: string;
  /** 选区来自子 agent 输出时记录 agent 类型。 */
  agent?: string;
}

export interface MessageSelectionReference extends ConversationSelectionText {
  id: string;
  sourceSessionId: string;
  sourceRowId: number;
  /**
   * 选区捕获时的投影代际（snapshot.logEpoch）。发送前准入用它判定「锚点是否还属于同一代」：
   * 同 rowId 在 rewind 重建后可能指向另一条消息，只有 rowId 不足以证明引用仍成立。
   */
  sourceLogEpoch?: string;
  contentType: ConversationSelectionContentType;
}

export interface MarkdownSelectionReference extends ConversationSelectionText {
  id: string;
  contentType: "markdown";
  sourceKey: string;
  sourceTitle: string;
}

export type ConversationSelectionReference = MessageSelectionReference | MarkdownSelectionReference;

export interface MarkdownSelectionTarget {
  sessionId: string | null;
  workspaceKey: string;
}

export type ConversationSelectionDisplayReference =
  | ConversationSelectionText
  | ConversationSelectionReference;

interface ConversationSelectionAddEventDetail {
  targetSessionId: string | null;
  workspaceKey: string;
  reference: ConversationSelectionReference;
  result?: ConversationSelectionAppendResult;
}

export type ConversationSelectionLimitReason = "count" | "single" | "total";
type ConversationSelectionAppendResult =
  | {
      ok: true;
      references: readonly ConversationSelectionDisplayReference[];
      duplicate: boolean;
    }
  | { ok: false; reason: ConversationSelectionLimitReason };

const ADD_EVENT = "zcode:conversation-selection-add";
const USER_SELECT_BLOCK_PATTERN = /(?:\n\n)?# userselect:\n```userselect\n([\s\S]*?)\n```\s*$/;
const LEGACY_BLOCK_PATTERN =
  /(?:\n\n)?# Conversation selections:\n```zcode-conversation-selections\n([\s\S]*?)\n```\s*$/;
// 草稿引用可以有两种来源：本轮选中（带锚点与 id）与队列撤回（只有文本 + 批注）。
// 两者都是“待发送的引用材料”，共用一个草稿 owner，不另建第二份列表。
const referencesByScope = new Map<string, readonly ConversationSelectionDisplayReference[]>();
const limitReasonByScope = new Map<string, ConversationSelectionLimitReason>();

function referenceScopeKey(sessionId: string | null, workspaceKey: string): string {
  return `${workspaceKey}\0${sessionId ?? "__draft__"}`;
}

export function getConversationSelectionReferenceScope(
  sessionId: string | null,
  workspaceKey: string,
): readonly ConversationSelectionDisplayReference[] {
  return referencesByScope.get(referenceScopeKey(sessionId, workspaceKey)) ?? [];
}

export function setConversationSelectionReferenceScope(
  sessionId: string | null,
  workspaceKey: string,
  references: readonly ConversationSelectionDisplayReference[],
): void {
  const key = referenceScopeKey(sessionId, workspaceKey);
  if (references.length > 0) referencesByScope.set(key, references);
  else referencesByScope.delete(key);
  limitReasonByScope.delete(key);
}

export function getConversationSelectionReferenceLimitReason(
  sessionId: string | null,
  workspaceKey: string,
): ConversationSelectionLimitReason | null {
  return limitReasonByScope.get(referenceScopeKey(sessionId, workspaceKey)) ?? null;
}

export function clearConversationSelectionReferenceScope(
  sessionId: string,
  workspaceKey: string,
): void {
  referencesByScope.delete(referenceScopeKey(sessionId, workspaceKey));
  limitReasonByScope.delete(referenceScopeKey(sessionId, workspaceKey));
}

export function clearConversationSelectionReferenceLimitReason(
  sessionId: string | null,
  workspaceKey: string,
): void {
  limitReasonByScope.delete(referenceScopeKey(sessionId, workspaceKey));
}

export function createConversationSelectionReference(
  input: Omit<MessageSelectionReference, "id"> | Omit<MarkdownSelectionReference, "id">,
): ConversationSelectionReference {
  return { ...input, id: createUuid() };
}

function getConversationSelectionDedupeKey(
  reference: ConversationSelectionDisplayReference,
): string {
  if (!isConversationSelectionReference(reference)) return ["text", reference.text].join("\0");
  if (reference.contentType === "markdown") {
    return ["markdown", reference.sourceKey, reference.text].join("\0");
  }
  return [
    reference.sourceSessionId,
    reference.sourceRowId,
    reference.contentType,
    reference.text,
  ].join("\0");
}

function appendConversationSelectionReference(
  current: readonly ConversationSelectionDisplayReference[],
  reference: ConversationSelectionReference,
): ConversationSelectionAppendResult {
  if (reference.text.length > CONVERSATION_SELECTION_MAX_TEXT_LENGTH) {
    return { ok: false, reason: "single" };
  }
  const key = getConversationSelectionDedupeKey(reference);
  if (current.some((item) => getConversationSelectionDedupeKey(item) === key)) {
    return { ok: true, references: current, duplicate: true };
  }
  if (current.length >= CONVERSATION_SELECTION_MAX_COUNT) {
    return { ok: false, reason: "count" };
  }
  const totalLength = current.reduce((sum, item) => sum + item.text.length, 0);
  if (totalLength + reference.text.length > CONVERSATION_SELECTION_MAX_TOTAL_LENGTH) {
    return { ok: false, reason: "total" };
  }
  return { ok: true, references: [...current, reference], duplicate: false };
}

export function parsePromptConversationSelections(text: string): {
  visibleContent: string;
  references: readonly ConversationSelectionDisplayReference[];
} {
  const userSelectMatch = text.match(USER_SELECT_BLOCK_PATTERN);
  if (userSelectMatch) {
    return parseConversationSelectionBlock(text, userSelectMatch, (value) => {
      if (!isConversationSelectionText(value)) return null;
      // 旧转录可能带着批注与路径：解析时全部保留，展示才不会再丢掉用户写过的要求。
      return {
        text: value.text,
        ...(value.path?.trim() ? { path: value.path } : {}),
        ...(value.comment?.trim() ? { comment: value.comment } : {}),
        ...(value.agent ? { agent: value.agent } : {}),
      };
    });
  }
  const legacyMatch = text.match(LEGACY_BLOCK_PATTERN);
  if (!legacyMatch) return { visibleContent: text, references: [] };
  return parseConversationSelectionBlock(text, legacyMatch, (value) =>
    isConversationSelectionReference(value) ? value : null,
  );
}

function parseConversationSelectionBlock<T extends ConversationSelectionDisplayReference>(
  text: string,
  match: RegExpMatchArray,
  parseItem: (value: unknown) => T | null,
): { visibleContent: string; references: readonly T[] } {
  try {
    const parsed = JSON.parse(match[1] ?? "[]");
    if (!Array.isArray(parsed)) throw new Error("selection block is not an array");
    const references: T[] = [];
    for (const value of parsed) {
      const reference = parseItem(value);
      if (!reference) throw new Error("invalid selection reference");
      references.push(reference);
    }
    return {
      visibleContent: text.slice(0, match.index).trimEnd(),
      references,
    };
  } catch {
    return { visibleContent: text, references: [] };
  }
}

export function dispatchConversationSelectionAdd(
  detail: Omit<ConversationSelectionAddEventDetail, "result">,
): ConversationSelectionAppendResult {
  const current = getConversationSelectionReferenceScope(
    detail.targetSessionId,
    detail.workspaceKey,
  );
  const result = appendConversationSelectionReference(current, detail.reference);
  if (result.ok) {
    setConversationSelectionReferenceScope(
      detail.targetSessionId,
      detail.workspaceKey,
      result.references,
    );
  } else {
    limitReasonByScope.set(
      referenceScopeKey(detail.targetSessionId, detail.workspaceKey),
      result.reason,
    );
  }
  window.dispatchEvent(new CustomEvent(ADD_EVENT, { detail: { ...detail, result } }));
  return result;
}

/**
 * 发送前锚点准入：选区引用只用 sourceSessionId/sourceRowId 这两个 UI 锚点判定。
 *
 * - 跨会话引用（sourceSessionId 与目标会话不同）拒绝：引用文本属于另一个会话的历史，
 *   塞进当前会话会让模型拿到不属于本上下文的材料。
 * - stale 锚点（sourceRowId 已不在当前投影里，例如 rewind 截断后引用旧行）拒绝：
 *   批注所指向的原文已经不在了，保留下来只会让模型引用一段不存在的内容。
 * - Markdown 选区（文件预览）没有会话锚点，不参与上述判定。
 */
export function admitConversationSelectionQuotes(input: {
  references: readonly ConversationSelectionDisplayReference[];
  /** 目标会话；草稿首发时是预热会话 id。null 表示还没有会话（只允许 markdown 选区）。 */
  targetSessionId: string | null;
  /** 当前投影窗口里的 rowId；空集合表示投影尚未到达，不做 stale 判定。 */
  liveRowIds: ReadonlySet<number>;
  /** 当前投影代际；与引用捕获时不同说明日志被重建（rewind/compact），锚点不再可信。 */
  liveLogEpoch?: string;
}):
  | { ok: true; quotes: ConversationSelectionText[] }
  | { ok: false; reason: "crossSession" | "staleAnchor" | "staleGeneration" } {
  const quotes: ConversationSelectionText[] = [];
  for (const reference of input.references) {
    const selection = reference as ConversationSelectionDisplayReference & {
      contentType?: ConversationSelectionContentType | "markdown";
      sourceSessionId?: string;
      sourceRowId?: number;
      sourceLogEpoch?: string;
    };
    if (selection.contentType !== "markdown") {
      if (
        selection.sourceSessionId &&
        input.targetSessionId &&
        selection.sourceSessionId !== input.targetSessionId
      ) {
        return { ok: false, reason: "crossSession" };
      }
      if (
        input.liveLogEpoch &&
        selection.sourceLogEpoch &&
        selection.sourceLogEpoch !== input.liveLogEpoch
      ) {
        // 同一 rowId 在重建后的日志里可能指向另一条消息：行号复活不等于锚点复活。
        return { ok: false, reason: "staleGeneration" };
      }
      if (
        input.liveRowIds.size > 0 &&
        typeof selection.sourceRowId === "number" &&
        !input.liveRowIds.has(selection.sourceRowId)
      ) {
        return { ok: false, reason: "staleAnchor" };
      }
    }
    quotes.push({
      text: reference.text,
      ...(reference.path?.trim() ? { path: reference.path } : {}),
      ...(selection.comment?.trim() ? { comment: selection.comment } : {}),
      ...(selection.agent ? { agent: selection.agent } : {}),
    });
  }
  return { ok: true, quotes };
}

/**
 * 批注确认（唯一判定）：comment 只在“非空且不超限”时写进引用。
 *
 * 批注输入框属于选中动作的确认步骤：没确认 = 不产生引用，因此取消不需要额外回滚，
 * 也不会进入 Composer 草稿或 accepted 输入。空批注不写成空串，保持与线格式“缺省即无批注”一致。
 */
export function buildAnnotatedConversationSelection(
  reference: ConversationSelectionReference,
  comment: string,
):
  | { ok: true; reference: ConversationSelectionReference }
  | { ok: false; reason: "empty" | "tooLong" } {
  const trimmed = comment.trim();
  if (trimmed.length === 0) return { ok: false, reason: "empty" };
  if (trimmed.length > CONVERSATION_SELECTION_MAX_COMMENT_LENGTH) {
    return { ok: false, reason: "tooLong" };
  }
  return { ok: true, reference: { ...reference, comment: trimmed } };
}

/**
 * 历史 user row 的引用展示：结构化 metadata（row.conversationQuotes）优先，
 * 旧转录可能仍带着正文尾块解析结果，两者合并显示（不写回正文）。
 */
export function mergeRowConversationSelections(
  metadataQuotes: readonly ConversationSelectionText[] | undefined,
  parsedSelections: readonly ConversationSelectionDisplayReference[],
): readonly ConversationSelectionDisplayReference[] {
  return (metadataQuotes?.length ?? 0) > 0
    ? [...(metadataQuotes ?? []), ...parsedSelections]
    : parsedSelections;
}

export function isConversationSelectionAddEvent(
  event: Event,
): event is CustomEvent<ConversationSelectionAddEventDetail> {
  return event.type === ADD_EVENT && event instanceof CustomEvent;
}

export function getConversationSelectionAddEventName(): string {
  return ADD_EVENT;
}

const CONVERSATION_SELECTION_TEXT_KEYS = new Set(["text", "path", "comment", "agent"]);

function isConversationSelectionText(value: unknown): value is ConversationSelectionText {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<ConversationSelectionText>;
  return (
    typeof candidate.text === "string" &&
    (!("path" in value) ||
      (typeof candidate.path === "string" && candidate.path.trim().length > 0)) &&
    (!("comment" in value) || typeof candidate.comment === "string") &&
    (!("agent" in value) || typeof candidate.agent === "string") &&
    // 批注与子 agent 来源是选区事实的一部分：旧转录解析出它们时不能整条丢弃。
    Object.keys(value).every((key) => CONVERSATION_SELECTION_TEXT_KEYS.has(key))
  );
}

export function isConversationSelectionReference(
  value: unknown,
): value is ConversationSelectionReference {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ConversationSelectionReference>;
  if (candidate.contentType === "markdown") {
    return (
      typeof candidate.id === "string" &&
      typeof candidate.text === "string" &&
      typeof candidate.sourceKey === "string" &&
      typeof candidate.sourceTitle === "string"
    );
  }
  return (
    typeof candidate.id === "string" &&
    "sourceSessionId" in candidate &&
    typeof candidate.sourceSessionId === "string" &&
    "sourceRowId" in candidate &&
    typeof candidate.sourceRowId === "number" &&
    typeof candidate.text === "string" &&
    ["user", "assistant", "reasoning", "tool"].includes(candidate.contentType ?? "")
  );
}
