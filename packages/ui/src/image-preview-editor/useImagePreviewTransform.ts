import { useEffect, useEffectEvent, useRef, useState } from "react";
import {
  clampOffset,
  zoomAtPoint,
  type Point,
  type Size,
  type Transform,
} from "@/image-preview-editor/geometry.js";

const ZERO = { x: 0, y: 0 };
const ZERO_SIZE: Size = { width: 0, height: 0 };

/**
 * 图片缩放/平移的唯一 owner：viewport 尺寸、transform 与 wheel/pinch 边界。
 * 标注与编辑历史不在这里；调用方通过 applyTransform 复用同一套有界规则。
 */
export function useImagePreviewTransform({
  natural,
  canZoom,
}: {
  natural: Size;
  /** 保存/操作进行中或正在绘图时禁止滚轮缩放。 */
  canZoom: () => boolean;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<Size>(ZERO_SIZE);
  const [transform, setTransform] = useState<Transform>({ scale: 1, offset: ZERO });
  const fit = Math.min(
    1,
    viewport.width / (natural.width || 1),
    viewport.height / (natural.height || 1),
  );
  const size: Size = { width: natural.width * fit, height: natural.height * fit };
  const canPan =
    size.width * transform.scale > viewport.width + 1 ||
    size.height * transform.scale > viewport.height + 1;
  const applyTransform = (value: Transform) =>
    setTransform({ ...value, offset: clampOffset(value.offset, value.scale, size, viewport) });
  const zoom = (scale: number, anchor: Point = ZERO) =>
    applyTransform(zoomAtPoint(transform, Math.min(3, Math.max(0.5, scale)), anchor));
  const reset = () => setTransform({ scale: 1, offset: ZERO });
  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() =>
      setViewport({ width: element.clientWidth, height: element.clientHeight }),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setTransform((current) => ({
      ...current,
      offset: clampOffset(current.offset, current.scale, size, viewport),
    }));
  }, [size.width, size.height, viewport.width, viewport.height]);
  const wheel = useEffectEvent((event: WheelEvent) => {
    if (!canZoom() || !natural.width) return;
    event.preventDefault();
    const rect = viewportRef.current!.getBoundingClientRect();
    const delta =
      event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1);
    zoom(transform.scale * Math.exp(-Math.max(-300, Math.min(300, delta)) * 0.002), {
      x: event.clientX - rect.left - rect.width / 2,
      y: event.clientY - rect.top - rect.height / 2,
    });
  });
  useEffect(() => {
    const element = viewportRef.current;
    // React 的委托 wheel 默认 passive，无法阻止页面滚动；监听仅归当前图片视口所有。
    const listener = (event: WheelEvent) => wheel(event);
    element?.addEventListener("wheel", listener, { passive: false });
    return () => element?.removeEventListener("wheel", listener);
  }, []);
  return {
    viewportRef,
    surfaceRef,
    viewport,
    transform,
    setTransform,
    fit,
    size,
    canPan,
    applyTransform,
    zoom,
    reset,
  };
}
