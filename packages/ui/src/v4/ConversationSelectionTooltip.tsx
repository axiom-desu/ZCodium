import { SelectionActionMenu } from "@/v4/SelectionActionMenu.js";
import { useTextSelection } from "@/hooks/useTextSelection.js";
import { useCallback, useRef, useState, type RefObject } from "react";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  buildAnnotatedConversationSelection,
  createConversationSelectionReference,
  type ConversationSelectionContentType,
  type ConversationSelectionReference,
} from "@/lib/conversationSelectionReference.js";
import {
  guardConversationSelectionCandidate,
  hasExcludedConversationSelectionEndpoint,
} from "@/lib/conversationSelectionGuard.js";

interface TooltipState {
  center: number;
  bottom: number;
  top: number;
  reference?: ConversationSelectionReference;
  error?: "single";
}

const SELECTABLE_SELECTOR = "[data-conversation-selectable]";

function contentTypeForRow(row: ConversationRow): ConversationSelectionContentType | null {
  if (row.kind === "userInput") return "user";
  if (row.kind === "assistantText") return "assistant";
  if (row.kind === "reasoning") return "reasoning";
  if (row.kind === "toolCall") return "tool";
  return null;
}

function closestRowElement(node: Node | null): HTMLElement | null {
  const element = node instanceof Element ? node : node?.parentElement;
  return element?.closest<HTMLElement>("[data-row-id]") ?? null;
}

export function ConversationSelectionTooltip({
  rootRef,
  rows,
  sourceSessionId,
  sourceLogEpoch,
  enabled,
  sideActionDisabled,
  onAddToCurrentTask,
  onAskInSideChat,
}: {
  rootRef: RefObject<HTMLDivElement | null>;
  rows: readonly ConversationRow[];
  sourceSessionId: string;
  /** 捕获选区时的投影代际；随引用一起交给 composer 草稿 owner。 */
  sourceLogEpoch?: string;
  enabled: boolean;
  sideActionDisabled?: boolean;
  onAddToCurrentTask: (reference: ConversationSelectionReference) => void;
  onAskInSideChat: (reference: ConversationSelectionReference) => void;
}) {
  const { intl } = useZCodeIntl();
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const inspectSelection = useCallback((): TooltipState | null => {
    if (!enabled) return null;
    const root = rootRef.current;
    const selection = window.getSelection();
    if (!root || !selection || selection.isCollapsed || selection.rangeCount !== 1) {
      return null;
    }
    const range = selection.getRangeAt(0);
    const startRow = closestRowElement(range.startContainer);
    const endRow = closestRowElement(range.endContainer);
    if (!startRow || !endRow) return null;
    const startElement =
      range.startContainer instanceof Element
        ? range.startContainer
        : range.startContainer.parentElement;
    const endElement =
      range.endContainer instanceof Element ? range.endContainer : range.endContainer.parentElement;
    // 普通 Markdown 跨选到表格单元格时，Range.cloneContents() 会把 DOM 顺序中夹着的
    // select-none 表格工具栏按钮一并克隆，若据此判断会把合法正文误判为控件选区。控件门禁只看
    // Selection 两个端点；跨 row / selectable region 仍由下面的独立 guard 拒绝。
    const excluded = hasExcludedConversationSelectionEndpoint(startElement, endElement);
    const startContent = startElement?.closest(SELECTABLE_SELECTOR);
    const endContent = endElement?.closest(SELECTABLE_SELECTOR);
    const rowId = Number(startRow.dataset.rowId);
    const row = rowsRef.current.find((candidate) => candidate.rowId === rowId);
    const contentType = row ? contentTypeForRow(row) : null;
    const text = selection.toString().trim();
    const rect = range.getBoundingClientRect();
    const guardResult = guardConversationSelectionCandidate({
      enabled,
      sameRow: startRow === endRow,
      insideTimeline: root.contains(startRow),
      excluded,
      sameSelectableRegion: Boolean(
        startContent && startContent === endContent && startRow.contains(startContent),
      ),
      supportedContent: contentType !== null,
      text,
      hasLayout: rect.width > 0 || rect.height > 0,
    });
    if (guardResult === "ineligible" || !contentType) return null;
    const position = {
      center: rect.left + rect.width / 2,
      top: rect.top,
      bottom: rect.bottom,
    };
    if (guardResult === "single-limit") {
      return { ...position, error: "single" };
    }
    return {
      ...position,
      reference: createConversationSelectionReference({
        sourceSessionId,
        sourceRowId: rowId,
        ...(sourceLogEpoch ? { sourceLogEpoch } : {}),
        contentType,
        text,
      }),
    };
  }, [enabled, rootRef, sourceLogEpoch, sourceSessionId]);
  const [annotating, setAnnotating] = useState(false);
  // 同步标记：批注框获得焦点会让选区塌缩，事件可能早于 React 重渲染到达。
  const annotatingRef = useRef(false);
  const { state, close } = useTextSelection({
    rootRef,
    enabled,
    frozen: annotating,
    frozenRef: annotatingRef,
    inspect: inspectSelection,
    scopeKey: sourceSessionId,
  });
  const handleAnnotationOpenChange = useCallback((open: boolean) => {
    annotatingRef.current = open;
    setAnnotating(open);
  }, []);
  const closeAll = useCallback(() => {
    annotatingRef.current = false;
    setAnnotating(false);
    close();
  }, [close]);

  if (!state) return null;
  return (
    <SelectionActionMenu
      center={state.center}
      top={state.top}
      bottom={state.bottom}
      singleLimit={Boolean(state.error)}
      sideActionDisabled={sideActionDisabled}
      sideDisabledTitle={intl.formatMessage({ id: "chat.selections.sideBlocked" })}
      onAnnotationOpenChange={handleAnnotationOpenChange}
      onAddToCurrentTask={() => {
        if (state.reference) onAddToCurrentTask(state.reference);
        closeAll();
      }}
      onAnnotate={(comment) => {
        if (!state.reference) return;
        // 批注 = 同一条引用 + comment：走同一个草稿 owner，不新建第二份引用。
        // 空/超限批注不产生任何引用（取消路径天然无副作用）。
        const annotated = buildAnnotatedConversationSelection(state.reference, comment);
        if (!annotated.ok) return;
        onAddToCurrentTask(annotated.reference);
        closeAll();
      }}
      onAskInSideChat={() => {
        if (state.reference) onAskInSideChat(state.reference);
        closeAll();
      }}
    />
  );
}
