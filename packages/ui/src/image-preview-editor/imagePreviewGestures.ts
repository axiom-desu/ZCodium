import type { Dispatch, PointerEvent, RefObject, SetStateAction } from "react";
import {
  type Annotation,
  type AnnotationTool,
  type History,
  type Point,
  type Transform,
} from "@/image-preview-editor/geometry.js";

type Gesture = { start: Point; transform: Transform; annotation?: Annotation; moving?: boolean };
type PointerMap = Map<number, Point>;
type PinchState = { distance: number; transform: Transform } | null;

interface ImagePreviewGestureInput {
  surfaceRef: RefObject<HTMLDivElement | null>;
  natural: { width: number; height: number };
  transform: Transform;
  canPan: boolean;
  fit: number;
  editing: boolean;
  tool: AnnotationTool;
  color: string;
  history: History<Annotation>;
  textDraft: Annotation | null;
  saving: boolean;
  actionBusy: boolean;
  pendingExit: (() => void) | null;
  gestureRef: RefObject<Gesture | null>;
  draftRef: RefObject<Annotation | null>;
  pointers: RefObject<PointerMap>;
  pinch: RefObject<PinchState>;
  commit(annotations: Annotation[]): void;
  setCurrentDraft(value: Annotation | null): void;
  setTextDraft: Dispatch<SetStateAction<Annotation | null>>;
  setSelected: Dispatch<SetStateAction<string | null>>;
  setDragging: Dispatch<SetStateAction<boolean>>;
  applyTransform(transform: Transform): void;
}

/**
 * 指针手势的唯一实现：pinch/拖拽与标注笔画共享同一 transform。
 * 页面组件只接事件，不复制坐标换算或 pointer capture 释放逻辑。
 */
export function createImagePreviewGestures(input: ImagePreviewGestureInput) {
  const {
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
  } = input;
  const point = (client: Point): Point => {
    const rect = surfaceRef.current!.getBoundingClientRect();
    return {
      x: Math.max(
        0,
        Math.min(natural.width, ((client.x - rect.left) / rect.width) * natural.width),
      ),
      y: Math.max(
        0,
        Math.min(natural.height, ((client.y - rect.top) / rect.height) * natural.height),
      ),
    };
  };
  const pointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (saving || actionBusy || pendingExit || event.button !== 0 || !natural.width) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const client = { x: event.clientX, y: event.clientY };
    pointers.current.set(event.pointerId, client);
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { distance: Math.hypot(b!.x - a!.x, b!.y - a!.y), transform };
      setCurrentDraft(null);
      gestureRef.current = null;
      return;
    }
    const start = point(client);
    const id = (event.target as Element)
      .closest("[data-annotation-id]")
      ?.getAttribute("data-annotation-id");
    // 收起标注后只允许预览拖动，不再命中历史标注；隐藏工具栏不能留下隐形编辑入口。
    const annotation = editing ? history.present.find((a) => a.id === id) : undefined;
    if (tool === "text") {
      if (textDraft?.text?.trim()) commit([...history.present, textDraft]);
      setTextDraft({
        id: crypto.randomUUID(),
        tool: "text",
        color,
        width: Math.max(2, 4 / fit),
        points: [start],
        text: "",
      });
      return;
    }
    if (tool === "select") {
      setSelected(annotation?.id ?? null);
      setDragging(Boolean(annotation || canPan));
      gestureRef.current = {
        start: annotation ? start : client,
        transform,
        annotation,
        moving: Boolean(annotation),
      };
      return;
    }
    const mark: Annotation = {
      id: crypto.randomUUID(),
      tool,
      color,
      width: Math.max(2, 3 / fit),
      points: [start],
    };
    gestureRef.current = { start, transform, annotation: mark };
    setCurrentDraft(mark);
  };
  const pointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    const client = { x: event.clientX, y: event.clientY };
    pointers.current.set(event.pointerId, client);
    if (pinch.current && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const scale = Math.min(
        3,
        Math.max(
          0.5,
          (pinch.current.transform.scale * Math.hypot(b!.x - a!.x, b!.y - a!.y)) /
            (pinch.current.distance || 1),
        ),
      );
      applyTransform({ ...pinch.current.transform, scale });
      return;
    }
    const gesture = gestureRef.current;
    if (!gesture) return;
    if (!gesture.annotation) {
      if (canPan)
        applyTransform({
          ...transform,
          offset: {
            x: gesture.transform.offset.x + client.x - gesture.start.x,
            y: gesture.transform.offset.y + client.y - gesture.start.y,
          },
        });
      return;
    }
    const current = point(client),
      mark = gesture.annotation;
    if (gesture.moving) {
      setCurrentDraft({
        ...mark,
        points: mark.points.map((p) => ({
          x: p.x + current.x - gesture.start.x,
          y: p.y + current.y - gesture.start.y,
        })),
      });
      return;
    }
    setCurrentDraft({
      ...mark,
      points:
        mark.tool === "pen"
          ? [...(draftRef.current?.points ?? mark.points), current]
          : [gesture.start, current],
    });
  };
  const pointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    const mark = draftRef.current;
    // 原生取色器关闭后，松手可能先发 lostpointercapture 再发 pointerup；
    // buttons=0 表示已松手，仍需提交笔画，否则完整笔画会被误当取消而丢失。
    // 真正的 cancel / 按住时失去捕获仍丢弃草稿，后续重复结束事件由 pointer 集合过滤。
    const completed =
      event.type === "pointerup" || (event.type === "lostpointercapture" && event.buttons === 0);
    if (completed && mark)
      commit(
        gestureRef.current?.moving
          ? history.present.map((a) => (a.id === mark.id ? mark : a))
          : [...history.present, mark],
      );
    setCurrentDraft(null);
    gestureRef.current = null;
    pinch.current = null;
    setDragging(false);
  };
  return { pointerDown, pointerMove, pointerEnd };
}
