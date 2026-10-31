import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createProjectGroupedEdgeScroll } from "./grouped-edge-scroll.js";
import type { ProjectTaskGroupMoveInput } from "./contract.js";
import type { ProjectGroupedRow } from "./grouped.js";
import {
  buildProjectGroupedMoveCommand,
  previewProjectGroupedDrag,
  projectGroupedRowsSignature,
  type ProjectGroupedDragSource,
  type ProjectGroupedDropTarget,
} from "./grouped-drag.js";

interface PendingPointer {
  source: ProjectGroupedDragSource;
  pointerId: number;
  startX: number;
  startY: number;
  element: HTMLElement;
  root: HTMLElement;
  epoch: unknown;
}

const INTERACTIVE_SELECTOR =
  "button,input,textarea,select,a,[role='menuitem'],[data-project-grouped-no-drag]";

function readSource(element: Element | null): ProjectGroupedDragSource | null {
  const target = element?.closest<HTMLElement>("[data-project-grouped-drag]");
  if (!target) return null;
  if (target.dataset.projectGroupedDrag === "group") {
    const groupId = target.dataset.projectGroupedGroupId;
    if (!groupId) return null;
    return { type: "group", rowKey: `group:${groupId}`, groupId };
  }
  const rowKey = target.dataset.projectGroupedTaskRow;
  return rowKey ? { type: "task", rowKey } : null;
}

function readDropTarget(element: Element | null, clientY: number): ProjectGroupedDropTarget | null {
  const target = element?.closest<HTMLElement>("[data-project-grouped-drop]");
  if (!target) return null;
  const zone = target.dataset.projectGroupedDrop;
  const rect = target.getBoundingClientRect();
  const side = clientY < rect.top + rect.height / 2 ? "before" : "after";
  if (zone === "task") {
    const rowKey = target.dataset.projectGroupedTaskRow;
    return rowKey ? { zone: "task", rowKey, side } : null;
  }
  if (zone === "group-header") {
    const groupId = target.dataset.projectGroupedGroupId;
    return groupId ? { zone: "group-header", groupId, side } : null;
  }
  if (zone === "group-empty") {
    const groupId = target.dataset.projectGroupedGroupId;
    return groupId ? { zone: "group-empty", groupId } : null;
  }
  return null;
}

/**
 * 项目分组视图的指针手势：只在 UI 内保留 hover preview，提交一次单节点命令。
 * 快照变化时用最新权威行重算预览；真正的并发保护仍是 Repo 内的 source/anchor CAS。
 */
export function useProjectGroupedDrag({
  rows,
  epoch,
  onMove,
  onError,
}: {
  rows: readonly ProjectGroupedRow[];
  epoch: unknown;
  onMove: (command: ProjectTaskGroupMoveInput) => Promise<void>;
  onError: (cause: unknown) => void;
}) {
  const [preview, setPreview] = useState<ProjectGroupedRow[] | null>(null);
  const [overlay, setOverlay] = useState<{
    source: ProjectGroupedDragSource;
    x: number;
    y: number;
  } | null>(null);
  const [dropTarget, setDropTarget] = useState<ProjectGroupedDropTarget | null>(null);
  const pendingRef = useRef<PendingPointer | null>(null);
  const activeRef = useRef(false);
  const staleRef = useRef(false);
  const suppressClickRef = useRef(false);
  const originRef = useRef<readonly ProjectGroupedRow[]>(rows);
  const latestRowsRef = useRef<readonly ProjectGroupedRow[]>(rows);
  const latestSignatureRef = useRef(projectGroupedRowsSignature(rows));
  const previewRef = useRef<ProjectGroupedRow[] | null>(null);
  const targetRef = useRef<ProjectGroupedDropTarget | null>(null);
  const sourceRef = useRef<ProjectGroupedDragSource | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const edgeScrollRef = useRef<ReturnType<typeof createProjectGroupedEdgeScroll> | null>(null);
  const epochRef = useRef(epoch);
  epochRef.current = epoch;

  const clear = useCallback(() => {
    edgeScrollRef.current?.stop();
    edgeScrollRef.current = null;
    cleanupRef.current?.();
    cleanupRef.current = null;
    pendingRef.current = null;
    activeRef.current = false;
    staleRef.current = false;
    sourceRef.current = null;
    targetRef.current = null;
    previewRef.current = null;
    setPreview(null);
    setOverlay(null);
    setDropTarget(null);
  }, []);

  // refresh/服务换代即撤销手势；旧 RAF 和旧 pointerup 不得对新 owner 提交。
  useLayoutEffect(() => clear, [clear, epoch]);

  useEffect(() => {
    const signature = projectGroupedRowsSignature(rows);
    latestRowsRef.current = rows;
    if (signature === latestSignatureRef.current) return;
    latestSignatureRef.current = signature;
    const source = sourceRef.current;
    if (!activeRef.current || !source) return;
    if (!rows.some((row) => row.key === source.rowKey)) {
      // 拖动期间权威行已删除来源：取消预览，drop 不再发命令。
      clear();
      return;
    }
    // 只重算当前手势的预览；提交仍用 Repo 的 source/anchor 复检真正的并发编辑。
    originRef.current = rows;
    const target = targetRef.current;
    const next = target ? previewProjectGroupedDrag(rows, source, target) : [...rows];
    previewRef.current = next;
    setPreview(next);
  }, [clear, rows]);

  useEffect(() => {
    if (!overlay) return;
    const previousCursor = document.body.style.cursor;
    const previousSelect = document.body.style.userSelect;
    document.body.style.cursor = "grabbing";
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousSelect;
    };
  }, [overlay]);

  const begin = useCallback((pending: PendingPointer) => {
    const source = pending.source;
    sourceRef.current = source;
    originRef.current = latestRowsRef.current;
    previewRef.current = [...latestRowsRef.current];
    activeRef.current = true;
    staleRef.current = false;
    setPreview([...latestRowsRef.current]);
    const rect = pending.element.getBoundingClientRect();
    setOverlay({ source, x: rect.right - 8, y: rect.top + Math.min(rect.height / 2, 16) });
  }, []);

  const updatePreviewAtPoint = useCallback((x: number, y: number) => {
    const pending = pendingRef.current;
    if (!pending || !activeRef.current || pending.epoch !== epochRef.current) return;
    const element = document.elementFromPoint(x, y);
    if (!element || !pending.root.contains(element)) return;
    const target = readDropTarget(element, y);
    // 预览重排后指针可能落回被拖节点自身；保留上一个有效落点，避免 hover 抖动丢目标。
    if (
      !target ||
      (pending.source.type === "task" &&
        target.zone === "task" &&
        target.rowKey === pending.source.rowKey) ||
      (pending.source.type === "group" &&
        target.zone === "group-header" &&
        target.groupId === pending.source.groupId)
    ) {
      return;
    }
    targetRef.current = target;
    setDropTarget(target);
    const next = previewProjectGroupedDrag(originRef.current, pending.source, target);
    if (
      projectGroupedRowsSignature(next) === projectGroupedRowsSignature(previewRef.current ?? [])
    ) {
      return;
    }
    previewRef.current = next;
    setPreview(next);
  }, []);

  const handlePointerMove = useCallback(
    (event: PointerEvent) => {
      const pending = pendingRef.current;
      if (!pending || event.pointerId !== pending.pointerId || pending.epoch !== epochRef.current)
        return;
      if (!activeRef.current) {
        if (Math.hypot(event.clientX - pending.startX, event.clientY - pending.startY) < 6) return;
        begin(pending);
        edgeScrollRef.current = createProjectGroupedEdgeScroll(pending.root, updatePreviewAtPoint);
      }
      event.preventDefault();
      setOverlay({ source: pending.source, x: event.clientX + 10, y: event.clientY + 6 });
      updatePreviewAtPoint(event.clientX, event.clientY);
      edgeScrollRef.current?.update(event.clientX, event.clientY);
    },
    [begin, updatePreviewAtPoint],
  );

  const handlePointerUp = useCallback(
    (event: PointerEvent) => {
      const pending = pendingRef.current;
      if (!pending || event.pointerId !== pending.pointerId) return;
      if (pending.epoch !== epochRef.current) {
        clear();
        return;
      }
      edgeScrollRef.current?.stop();
      edgeScrollRef.current = null;
      const wasActive = activeRef.current;
      const source = pending.source;
      const origin = originRef.current;
      const next = previewRef.current;
      cleanupRef.current?.();
      cleanupRef.current = null;
      pendingRef.current = null;
      activeRef.current = false;
      sourceRef.current = null;
      targetRef.current = null;
      previewRef.current = null;
      setPreview(null);
      setOverlay(null);
      setDropTarget(null);
      if (!wasActive || staleRef.current) {
        staleRef.current = false;
        return;
      }
      event.preventDefault();
      suppressClickRef.current = true;
      const command = next ? buildProjectGroupedMoveCommand(origin, next, source) : null;
      if (!command) return;
      // 一次 drop 只发一条命令；迟到/外部编辑由 Repo 的 source/anchor 复检拒绝。
      void onMove(command).catch(onError);
    },
    [clear, onError, onMove],
  );

  const handlePointerCancel = useCallback(() => {
    clear();
  }, [clear]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !pendingRef.current) return;
      // Esc 只丢临时预览，不产生任何写入。
      event.preventDefault();
      event.stopPropagation();
      suppressClickRef.current = true;
      clear();
    },
    [clear],
  );

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (event.button !== 0 || pendingRef.current) return;
      suppressClickRef.current = false;
      const element = event.target as Element;
      const interactive = element.closest(INTERACTIVE_SELECTOR);
      if (interactive && !interactive.hasAttribute("data-project-grouped-drag-allowed")) return;
      const source = readSource(element);
      if (!source) return;
      const draggable = element.closest<HTMLElement>("[data-project-grouped-drag]");
      if (!draggable) return;
      pendingRef.current = {
        source,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        element: draggable,
        root: event.currentTarget,
        epoch: epochRef.current,
      };
      const onMove = handlePointerMove;
      const onUp = handlePointerUp;
      const onCancel = handlePointerCancel;
      const onKey = handleKeyDown;
      window.addEventListener("pointermove", onMove, { passive: false });
      window.addEventListener("pointerup", onUp, { capture: true });
      window.addEventListener("pointercancel", onCancel);
      window.addEventListener("blur", onCancel);
      window.addEventListener("keydown", onKey, { capture: true });
      cleanupRef.current = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp, { capture: true });
        window.removeEventListener("pointercancel", onCancel);
        window.removeEventListener("blur", onCancel);
        window.removeEventListener("keydown", onKey, { capture: true });
      };
    },
    [handleKeyDown, handlePointerCancel, handlePointerMove, handlePointerUp],
  );

  const handleClickCapture = useCallback((event: React.MouseEvent<HTMLElement>) => {
    if (!suppressClickRef.current) return;
    suppressClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const handleNativeDragStart = useCallback((event: React.DragEvent<HTMLElement>) => {
    // 分组手势已经接管这次按下：阻止同一次手势再启动 workbench HTML5 拖拽。
    if (!pendingRef.current) return;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  return {
    preview,
    overlay,
    dropTarget,
    dragging: Boolean(overlay),
    handlePointerDown,
    handleClickCapture,
    handleNativeDragStart,
  };
}
