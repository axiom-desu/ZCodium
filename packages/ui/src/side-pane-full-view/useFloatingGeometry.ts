import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type {
  FloatingAnchor,
  SidePaneFullViewFloating,
  SidePaneFullViewHostMode,
} from "@/side-pane-full-view/contract.js";
import {
  FLOATING_DRAG_CLICK_THRESHOLD_PX,
  clampFloatingPosition,
  resolveFloatingFrameMetrics,
  resolveFloatingPosition,
  resolveFloatingTransformOrigin,
  resolveFloatingWidth,
  resolveNearestFloatingAnchor,
  type FloatingPosition,
  type FloatingRect,
} from "@/side-pane-full-view/model.js";

/** 浮窗形态下输入区的测量选择器：只读 DOM 契约，不进入 SessionPane 内部状态。 */
const COMPOSER_DOCK_SELECTOR = '[data-v4-composer-dock="true"]';
const GEOMETRY_PROPERTIES = ["left", "top", "width", "height"] as const;
const GEOMETRY_VARIABLES = [
  "--side-pane-full-view-frame-width",
  "--side-pane-full-view-pane-height",
  "--side-pane-full-view-clip-height",
  "--side-pane-full-view-drawer-height",
] as const;

interface DragSession {
  pointerId: number;
  startX: number;
  startY: number;
  origin: FloatingPosition;
  moved: boolean;
}

function readSlotRect(slot: HTMLElement): FloatingRect {
  const rect = slot.getBoundingClientRect();
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

/**
 * 完整视图宿主的几何与拖动（spec：docs/specs/side-pane-full-view.md）。
 * 几何值是 DOM 布局投影，直接写到宿主 style，不进入 React state，避免每次测量重渲染对话树。
 */
export function useFloatingGeometry({
  mode,
  floating,
  anchor,
  headerVisible,
  slotElement,
  onAnchorChange,
  onDraggingChange,
}: {
  mode: SidePaneFullViewHostMode;
  floating: SidePaneFullViewFloating;
  anchor: FloatingAnchor;
  headerVisible: boolean;
  slotElement: HTMLElement | null;
  onAnchorChange: (anchor: FloatingAnchor) => void;
  /** 拖动状态由宿主持有：操作栏显隐要参与几何计算，不能反向依赖 hook 内部状态。 */
  onDraggingChange: (dragging: boolean) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const dockHeightRef = useRef(0);
  const dragRef = useRef<DragSession | null>(null);
  const dragPositionRef = useRef<FloatingPosition | null>(null);
  /** 上一次写入的几何是否为最小化形态；用来识别最小化与恢复之间的切换。 */
  const appliedMinimizedRef = useRef<boolean | null>(null);
  const applyGeometryRef = useRef<() => void>(() => {});
  const reportComposerDockHeight = useCallback((heightPx: number) => {
    if (dockHeightRef.current === heightPx) return;
    dockHeightRef.current = heightPx;
    applyGeometryRef.current();
  }, []);
  const isFloating = mode === "floating";
  const isMinimized = isFloating && floating === "minimized";

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (mode === "normal" || !slotElement) {
      for (const property of GEOMETRY_PROPERTIES) host.style.removeProperty(property);
      for (const variable of GEOMETRY_VARIABLES) host.style.removeProperty(variable);
      applyGeometryRef.current = () => {};
      appliedMinimizedRef.current = null;
      return;
    }
    const apply = () => {
      const slot = readSlotRect(slotElement);
      if (mode === "conversation") {
        host.style.left = `${slot.left}px`;
        host.style.top = `${slot.top}px`;
        host.style.width = `${slot.width}px`;
        host.style.height = `${slot.height}px`;
        return;
      }
      const size = resolveFloatingFrameMetrics({
        slot,
        floating,
        headerVisible,
        composerDockHeightPx: dockHeightRef.current,
      });
      // 最小化与恢复之间切换时几何直接到位：宽度从 48px 过渡到浮窗宽度会让输入框
      // 先折行再缩回，浮窗背景先变高再往下掉；改为只做从吸附角缩放 + 淡入。
      const crossingMinimized =
        appliedMinimizedRef.current !== null && appliedMinimizedRef.current !== isMinimized;
      appliedMinimizedRef.current = isMinimized;
      if (crossingMinimized) host.style.transition = "none";
      // 内部内容始终按浮窗宽度排版：最小化期间也不跟着 48px 重排。
      host.style.setProperty(
        "--side-pane-full-view-frame-width",
        `${resolveFloatingWidth(slot.width)}px`,
      );
      host.style.setProperty("--side-pane-full-view-pane-height", `${size.paneHeight}px`);
      host.style.setProperty("--side-pane-full-view-clip-height", `${size.clipHeight}px`);
      host.style.setProperty("--side-pane-full-view-drawer-height", `${size.drawerHeight}px`);
      const position = dragPositionRef.current
        ? clampFloatingPosition(dragPositionRef.current, slot, size)
        : resolveFloatingPosition(anchor, slot, size);
      host.style.left = `${position.left}px`;
      host.style.top = `${position.top}px`;
      host.style.width = `${size.width}px`;
      host.style.height = `${size.height}px`;
      if (crossingMinimized) {
        // 强制提交一次样式，让上面的几何不带过渡生效，再恢复 CSS 过渡。
        void host.offsetWidth;
        host.style.removeProperty("transition");
        host.style.transformOrigin = resolveFloatingTransformOrigin(anchor);
        host.animate?.(
          [
            { opacity: 0, transform: "scale(0.92)" },
            { opacity: 1, transform: "scale(1)" },
          ],
          { duration: 150, easing: "ease-out" },
        );
      }
    };
    applyGeometryRef.current = apply;
    apply();
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(apply);
    resizeObserver?.observe(slotElement);
    window.addEventListener("resize", apply);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", apply);
    };
  }, [anchor, floating, headerVisible, isMinimized, mode, slotElement]);

  // 收起态只露输入区：浮窗内层高度由输入区实测高度决定。
  // 权限/问答卡片替换输入框时 dock 变高，浮窗随之变高。
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host || !isFloating) return;
    const dock = host.querySelector<HTMLElement>(COMPOSER_DOCK_SELECTOR);
    if (!dock) return;
    const report = () => {
      const next = dock.getBoundingClientRect().height;
      if (next === dockHeightRef.current) return;
      dockHeightRef.current = next;
      applyGeometryRef.current();
    };
    report();
    if (typeof ResizeObserver === "undefined") return;
    const resizeObserver = new ResizeObserver(report);
    resizeObserver.observe(dock);
    return () => resizeObserver.disconnect();
  }, [isFloating, mode]);

  const beginDrag = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    const host = hostRef.current;
    if (!host) return;
    // 阻止 Radix 在 pointerdown 时打开菜单；是否打开由松手时是否发生拖动决定。
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const rect = host.getBoundingClientRect();
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: { left: rect.left, top: rect.top },
      moved: false,
    };
  }, []);

  const moveDrag = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const session = dragRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    const dx = event.clientX - session.startX;
    const dy = event.clientY - session.startY;
    if (!session.moved && Math.hypot(dx, dy) < FLOATING_DRAG_CLICK_THRESHOLD_PX) return;
    if (!session.moved) {
      session.moved = true;
      onDraggingChange(true);
    }
    dragPositionRef.current = { left: session.origin.left + dx, top: session.origin.top + dy };
    applyGeometryRef.current();
  }, []);

  const endDrag = useCallback(
    (event: ReactPointerEvent<HTMLElement>, onClick: () => void) => {
      const session = dragRef.current;
      if (!session || session.pointerId !== event.pointerId) return;
      dragRef.current = null;
      if (!session.moved) {
        onClick();
        return;
      }
      const host = hostRef.current;
      const dropped = dragPositionRef.current;
      dragPositionRef.current = null;
      onDraggingChange(false);
      if (!host || !dropped || !slotElement) return;
      const slot = readSlotRect(slotElement);
      const rect = host.getBoundingClientRect();
      const nextAnchor = resolveNearestFloatingAnchor(
        clampFloatingPosition(dropped, slot, rect),
        slot,
        { width: rect.width, height: rect.height },
      );
      if (nextAnchor === anchor) {
        applyGeometryRef.current();
      } else {
        onAnchorChange(nextAnchor);
      }
    },
    [anchor, onAnchorChange, onDraggingChange, slotElement],
  );

  const cancelDrag = useCallback(() => {
    dragRef.current = null;
    dragPositionRef.current = null;
    onDraggingChange(false);
    applyGeometryRef.current();
  }, [onDraggingChange]);

  return {
    hostRef,
    beginDrag,
    moveDrag,
    endDrag,
    cancelDrag,
    reportComposerDockHeight,
  };
}

/** 浮窗内焦点进出：抽屉只在浮窗内有焦点时露出操作栏（同一份 DOM）。 */
export function useFloatingFocusWithin() {
  const [focusWithin, setFocusWithin] = useState(false);
  const onFocusCapture = useCallback(() => setFocusWithin(true), []);
  const onBlurCapture = useCallback((event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    setFocusWithin(false);
  }, []);
  return { focusWithin, onFocusCapture, onBlurCapture };
}
