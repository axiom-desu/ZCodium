/**
 * 坐标换算（纯函数）。
 *
 * 兼容层契约见 `.agents/specs/computer-use-wayland-input.md` §5。
 *
 * 三个坐标系：
 *   - 窗口 frame：`GetRects` 的 `x,y,w,h`（逻辑/物理混合，含 CSD 阴影）；
 *   - 窗口 buffer：`GetRects` 的 `buffer_x,buffer_y`（去掉 GTK 客户端阴影后的原点）；
 *   - 元素 frame：cua-driver `element.frame`，是 **scale=1、原点偏移** 的中间空间，
 *     不能直接当屏幕坐标。
 *
 * 已验证公式（见 §5.2 / §5.3）：
 *   target_screen = scale × frame_center − (scale × window_origin − buffer_origin)
 * 其中 `scale` 取目标窗口所在 logical monitor 的 scale（本机为 2）。
 */

/** 兼容 `{x,y,w,h}` 与 `{x,y,width,height}` 两种矩形。 */
function rectGeometry(rect) {
  if (!rect || typeof rect !== "object") {
    throw new TypeError("rect must be an object with x/y/w/h");
  }
  const w = rect.w ?? rect.width;
  const h = rect.h ?? rect.height;
  if (![rect.x, rect.y, w, h].every(Number.isFinite)) {
    throw new TypeError("rect must have finite x, y, w, h");
  }
  return { x: rect.x, y: rect.y, w, h };
}

/** 矩形中心点。 */
export function rectCenter(rect) {
  const { x, y, w, h } = rectGeometry(rect);
  return { x: x + w / 2, y: y + h / 2 };
}

/**
 * 每窗口常量 `scale × window_origin − buffer_origin`。
 * 它只与当前窗口位置有关，随窗口移动自动更新（公式的 `2W − B`）。
 */
export function windowOffset(scale, windowOrigin, bufferOrigin) {
  if (!Number.isFinite(scale) || scale <= 0) throw new TypeError("scale must be > 0");
  return {
    x: scale * windowOrigin.x - bufferOrigin.x,
    y: scale * windowOrigin.y - bufferOrigin.y,
  };
}

/** 元素 frame 中心 → 屏幕物理像素。 */
export function frameCenterToScreen(frameCenter, scale, offset) {
  return { x: scale * frameCenter.x - offset.x, y: scale * frameCenter.y - offset.y };
}

/** 元素矩形 + 窗口几何 → 屏幕物理像素（一次算齐 offset）。 */
export function elementToScreen({ element, window, buffer, scale }) {
  const offset = windowOffset(scale, window, buffer);
  return frameCenterToScreen(rectCenter(element), scale, offset);
}

/**
 * 屏幕物理目标 → mutter `NotifyPointerMotionRelative` 的逻辑单位位移。
 * mutter 用逻辑单位，物理位移 = 输入 × scale（见 §5.5）。
 */
export function screenToRelativeMotion(target, cursor, scale) {
  if (!Number.isFinite(scale) || scale <= 0) throw new TypeError("scale must be > 0");
  return { dx: (target.x - cursor.x) / scale, dy: (target.y - cursor.y) / scale };
}

/** 命中测试：返回包含该物理点的 logical monitor；不在任何 monitor 内返回 `undefined`。 */
export function findMonitorForPoint(monitors, point) {
  for (const monitor of Array.isArray(monitors) ? monitors : []) {
    const { x, y, w, h } = rectGeometry(monitor);
    if (point.x >= x && point.x < x + w && point.y >= y && point.y < y + h) return monitor;
  }
  return undefined;
}

/**
 * 目标点所在 logical monitor 的 scale（变 scale 支持，见 §5.6）。
 * 未命中时回退 `fallback`（单一 scale 场景常传 1 或主屏 scale）。
 */
export function scaleAt(monitors, point, fallback = 1) {
  const monitor = findMonitorForPoint(monitors, point);
  if (monitor && Number.isFinite(monitor.scale) && monitor.scale > 0) return monitor.scale;
  return fallback;
}
