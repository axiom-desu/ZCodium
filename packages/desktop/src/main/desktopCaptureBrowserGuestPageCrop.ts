import type { CaptureBrowserGuestPageClip } from "@zcode/shared";

/**
 * 把 guest CSS px 的裁剪区域换算成实际帧像素。比例取「帧宽 / CSS 视口宽」而不是宿主 DPR：
 * 自由尺寸（DPR 固定 1 但 Retina 原生 surface 是 2x）、Desktop 缩放补偿和 Windows 125% / 150%
 * 小数 DPR 下，帧与 CSS 的比例都可能不等于 screen DPR，只有实测比例在所有情况下一致。
 * 边界向外取整，避免小数 DPR 下元素缺一像素边；超出视口的部分裁掉，完全不可见时返回 null。
 */
export function resolveGuestCaptureCropRect(
  clip: CaptureBrowserGuestPageClip,
  image: { width: number; height: number },
): { x: number; y: number; width: number; height: number } | null {
  const values = [clip.x, clip.y, clip.width, clip.height, clip.viewportWidth, clip.viewportHeight];
  if (!values.every(Number.isFinite) || clip.viewportWidth <= 0 || clip.viewportHeight <= 0) {
    return null;
  }
  const scaleX = image.width / clip.viewportWidth;
  const scaleY = image.height / clip.viewportHeight;
  const left = Math.max(0, Math.floor(clip.x * scaleX));
  const top = Math.max(0, Math.floor(clip.y * scaleY));
  const right = Math.min(image.width, Math.ceil((clip.x + clip.width) * scaleX));
  const bottom = Math.min(image.height, Math.ceil((clip.y + clip.height) * scaleY));
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}
