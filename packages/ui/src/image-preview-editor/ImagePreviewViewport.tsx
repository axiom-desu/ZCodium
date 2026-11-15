import type { PointerEvent, RefObject } from "react";
import { AnnotationLayer } from "@/image-preview-editor/annotations.js";
import type { Annotation, Size, Transform } from "@/image-preview-editor/geometry.js";

/** 图片承载面：手势、缩放与标注覆盖层都在同一 transform 上，避免坐标二次换算。 */
export function ImagePreviewViewport({
  alt,
  src,
  imageTestId,
  imageRef,
  surfaceRef,
  overlayRef,
  viewportRef,
  size,
  transform,
  cursor,
  editing,
  displayed,
  selected,
  natural,
  onPointerDown,
  onPointerMove,
  onPointerEnd,
  onImageLoad,
  onClose,
}: {
  alt: string;
  src: string;
  imageTestId?: string;
  imageRef: RefObject<HTMLImageElement | null>;
  surfaceRef: RefObject<HTMLDivElement | null>;
  overlayRef: RefObject<SVGSVGElement | null>;
  viewportRef: RefObject<HTMLDivElement | null>;
  size: Size;
  transform: Transform;
  cursor: string;
  editing: boolean;
  displayed: readonly Annotation[];
  selected: string | null;
  natural: Size;
  onPointerDown: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerEnd: (event: PointerEvent<HTMLDivElement>) => void;
  onImageLoad: (natural: Size) => void;
  onClose: () => void;
}) {
  return (
    <div
      tabIndex={0}
      aria-label={alt}
      onKeyDown={(event) => {
        if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        event.currentTarget.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: rect.left + rect.width / 2,
            clientY: rect.top + rect.height / 2,
          }),
        );
      }}
      className="absolute inset-x-14 bottom-24 top-20 overflow-hidden sm:inset-x-16"
      data-image-preview-viewport=""
      ref={viewportRef}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        data-image-preview-surface=""
        ref={surfaceRef}
        className="absolute left-1/2 top-1/2 touch-none select-none"
        onClick={(event) => event.stopPropagation()}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onLostPointerCapture={onPointerEnd}
        style={{
          width: size.width,
          height: size.height,
          cursor,
          transform: `translate(-50%, -50%) translate(${transform.offset.x}px, ${transform.offset.y}px) scale(${transform.scale})`,
        }}
      >
        <img
          alt={alt}
          src={src}
          ref={imageRef}
          data-testid={imageTestId}
          draggable={false}
          className="size-full rounded-xl object-contain"
          onLoad={(event) =>
            onImageLoad({
              width: event.currentTarget.naturalWidth,
              height: event.currentTarget.naturalHeight,
            })
          }
        />
        <svg
          ref={overlayRef}
          className={`pointer-events-none absolute inset-0 size-full overflow-hidden text-foreground ${editing ? "" : "[&_*]:pointer-events-none!"}`}
          viewBox={`0 0 ${natural.width || 1} ${natural.height || 1}`}
          xmlns="http://www.w3.org/2000/svg"
        >
          <AnnotationLayer annotations={displayed} selected={selected} />
        </svg>
      </div>
    </div>
  );
}
