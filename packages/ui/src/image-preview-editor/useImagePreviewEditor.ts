import { useEffect, useLayoutEffect, useEffectEvent, useRef, useState } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { createImagePreviewGestures } from "@/image-preview-editor/imagePreviewGestures.js";
import { saveImagePreviewToComposer } from "@/image-preview-editor/saveEditedImage.js";
import { useImagePreviewTransform } from "@/image-preview-editor/useImagePreviewTransform.js";
import {
  updateHistory,
  undoHistory,
  redoHistory,
  type Point,
  type Annotation,
  type AnnotationTool,
  type History,
  type Transform,
} from "@/image-preview-editor/geometry.js";

type Gesture = { start: Point; transform: Transform; annotation?: Annotation; moving?: boolean };

/**
 * 图片预览编辑的唯一状态 owner：transform、标注历史、手势与保存路径。
 * 组件只负责组合 JSX；“关闭/切图”通过 navigation guard 交给调用方执行。
 */
export function useImagePreviewEditor({
  alt,
  filename,
  onSaved,
  onNavigationGuardChange,
}: {
  alt: string;
  filename?: string;
  onSaved: () => void;
  onNavigationGuardChange?: (guard: ((proceed: () => void) => void) | null) => void;
}) {
  const { intl } = useZCodeIntl();
  const keepEditingRef = useRef<HTMLButtonElement>(null);
  const actionPending = useRef(false);
  const [actionBusy, setActionBusyState] = useState(false);
  const setActionBusy = (busy: boolean) => {
    actionPending.current = busy;
    setActionBusyState(busy);
  };
  const [pendingExit, setPendingExit] = useState<(() => void) | null>(null);
  const [editing, setEditing] = useState(false);
  const [natural, setNatural] = useState({ width: 0, height: 0 });
  const {
    viewportRef,
    surfaceRef,
    transform,
    setTransform,
    viewport,
    fit,
    size,
    canPan,
    applyTransform,
    zoom,
    reset: resetTransform,
  } = useImagePreviewTransform({
    natural,
    canZoom: () => !(saving || actionBusy || pendingExit || gestureRef.current),
  });
  const imageRef = useRef<HTMLImageElement>(null),
    overlayRef = useRef<SVGSVGElement>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const [addPosition, setAddPosition] = useState<{ left: number; top: number } | null>(null);
  const [tool, setTool] = useState<AnnotationTool>("select"),
    [color, setColor] = useState("#ef4444");
  const [history, setHistory] = useState<History<Annotation>>({
    past: [],
    present: [],
    future: [],
  });
  const [draft, setDraft] = useState<Annotation | null>(null),
    [selected, setSelected] = useState<string | null>(null);
  const [textDraft, setTextDraft] = useState<Annotation | null>(null),
    [saving, setSaving] = useState(false),
    [dragging, setDragging] = useState(false);
  const gestureRef = useRef<Gesture | null>(null),
    draftRef = useRef<Annotation | null>(null);
  const pointers = useRef(new Map<number, Point>()),
    pinch = useRef<{ distance: number; transform: Transform } | null>(null);
  const savePending = useRef(false),
    alive = useRef(true);
  const cursor =
    tool === "select"
      ? canPan
        ? dragging
          ? "grabbing"
          : "grab"
        : "default"
      : tool === "text"
        ? "text"
        : "crosshair";
  const displayed = history.present.map((a) => (draft?.id === a.id ? draft : a));
  if (draft && !history.present.some((a) => a.id === draft.id)) displayed.push(draft);
  if (textDraft?.text?.trim()) displayed.push(textDraft);
  const commit = (annotations: Annotation[]) => setHistory((h) => updateHistory(h, annotations));
  const setCurrentDraft = (value: Annotation | null) => {
    draftRef.current = value;
    setDraft(value);
  };
  const undo = () => {
    setHistory(undoHistory);
    setSelected(null);
    setTextDraft(null);
  };
  const redo = () => {
    setHistory(redoHistory);
    setSelected(null);
    setTextDraft(null);
  };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const keyboard = useEffectEvent((event: KeyboardEvent) => {
    if (
      !editing ||
      saving ||
      actionBusy ||
      pendingExit ||
      (event.target instanceof Element &&
        event.target.closest("input,textarea,[contenteditable=true]"))
    )
      return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
    } else if (selected && (event.key === "Delete" || event.key === "Backspace")) {
      event.preventDefault();
      commit(history.present.filter((a) => a.id !== selected));
      setSelected(null);
    }
  });
  useEffect(() => {
    const listener = (e: KeyboardEvent) => keyboard(e);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);
  const { pointerDown, pointerMove, pointerEnd } = createImagePreviewGestures({
    surfaceRef,
    natural,
    transform,
    canPan,
    fit,
    editing,
    tool,
    color,
    history,
    textDraft,
    saving,
    actionBusy,
    pendingExit,
    gestureRef,
    draftRef,
    pointers,
    pinch,
    commit,
    setCurrentDraft,
    setTextDraft,
    setSelected,
    setDragging,
    applyTransform,
  });
  const dirty = displayed.length > 0;
  const activeDrawingId = textDraft?.text?.trim()
    ? textDraft.id
    : (draft?.id ?? displayed.find((item) => item.id === selected)?.id ?? displayed.at(-1)?.id);
  useLayoutEffect(() => {
    const viewportElement = viewportRef.current;
    const button = addButtonRef.current;
    const group = Array.from(overlayRef.current?.children ?? []).find(
      (element) => element.getAttribute("data-annotation-id") === activeDrawingId,
    );
    if (!viewportElement || !button || !group?.firstElementChild) return;
    // 按实际 SVG 图形包围盒定位，不能把整张图片底边当作用户刚画的圆圈底边。
    // 屏幕坐标已包含缩放和平移，文字/箭头也沿用真实渲染尺寸，不另猜路径范围。
    const drawing = group.firstElementChild.getBoundingClientRect();
    const bounds = viewportElement.getBoundingClientRect();
    const halfWidth = button.offsetWidth / 2;
    const left =
      viewportElement.offsetLeft +
      Math.max(
        halfWidth,
        Math.min(bounds.width - halfWidth, drawing.left + drawing.width / 2 - bounds.left),
      );
    const top =
      viewportElement.offsetTop +
      Math.max(8, Math.min(bounds.height + 12, drawing.bottom - bounds.top + 12));
    setAddPosition((previous) =>
      previous?.left === left && previous.top === top ? previous : { left, top },
    );
  }, [activeDrawingId, history.present, draft, textDraft, selected, transform, viewport, natural]);
  useLayoutEffect(() => {
    // 编辑器是唯一修改状态持有者；所有关闭/切图入口只提交离开请求，不自行销毁草稿。
    onNavigationGuardChange?.((proceed) => {
      if (savePending.current || actionPending.current || pendingExit) return;
      if (dirty) {
        // Esc 可能发生在按住绘图期间：先固定可见笔画并释放捕获，防止弹窗背后继续移动或重复提交。
        const mark = draftRef.current;
        const moving = gestureRef.current?.moving;
        if (mark)
          setHistory((current) =>
            updateHistory(
              current,
              moving
                ? current.present.map((item) => (item.id === mark.id ? mark : item))
                : [...current.present, mark],
            ),
          );
        setCurrentDraft(null);
        gestureRef.current = null;
        pinch.current = null;
        const capturedPointers = [...pointers.current.keys()];
        pointers.current.clear();
        for (const id of capturedPointers) {
          if (surfaceRef.current?.hasPointerCapture(id))
            surfaceRef.current.releasePointerCapture(id);
        }
        setDragging(false);
        setPendingExit((current) => current ?? proceed);
      } else proceed();
    });
    return () => onNavigationGuardChange?.(null);
  }, [dirty, pendingExit, onNavigationGuardChange]);
  const save = async () => {
    if (savePending.current || !imageRef.current || !overlayRef.current) return;
    savePending.current = true;
    try {
      await saveImagePreviewToComposer({
        image: imageRef.current,
        overlay: overlayRef.current,
        filename: filename || alt,
        isAlive: () => alive.current,
        onSavingChange: setSaving,
        onSaved,
        noComposerMessage: () => intl.formatMessage({ id: "imageEditor.noComposer" }),
        addedMessage: () => intl.formatMessage({ id: "imageEditor.addedToChat" }),
        failedMessage: () => intl.formatMessage({ id: "imageEditor.saveFailed" }),
      });
    } finally {
      savePending.current = false;
    }
  };
  const commitTextDraft = () => {
    if (textDraft?.text?.trim()) commit([...history.present, textDraft]);
    setTextDraft(null);
  };
  const toggleEditing = () => {
    setEditing(!editing);
    setTool("select");
    setSelected(null);
    commitTextDraft();
  };
  const selectTool = (next: AnnotationTool) => {
    setTool(next);
    setSelected(null);
    commitTextDraft();
  };
  return {
    keepEditingRef,
    setActionBusy,
    commitTextDraft,
    toggleEditing,
    selectTool,
    resetTransform,
    actionBusy,
    pendingExit,
    setPendingExit,
    editing,
    setEditing,
    viewportRef,
    surfaceRef,
    canPan,
    applyTransform,
    fit,
    imageRef,
    overlayRef,
    addButtonRef,
    addPosition,
    natural,
    onImageLoad: setNatural,
    transform,
    setTransform,
    tool,
    setTool,
    color,
    setColor,
    history,
    selected,
    setSelected,
    textDraft,
    setTextDraft,
    saving,
    displayed,
    commit,
    undo,
    redo,
    zoom,
    size,
    cursor,
    dirty,
    pointerDown,
    pointerMove,
    pointerEnd,
    save,
  };
}
