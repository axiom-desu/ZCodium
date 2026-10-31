import { renderAntialiasedStatusDotPixels } from "./unreadBadge.js";

// 沿用上游 5×7 bitmap：只画角标所需字符，不引入字体或平台字体渲染差异。
const FONT: Readonly<Record<string, readonly number[]>> = {
  "1": [4, 12, 4, 4, 4, 4, 14],
  "2": [14, 17, 1, 6, 8, 16, 31],
  "3": [30, 1, 1, 14, 1, 1, 30],
  "4": [2, 6, 10, 18, 31, 2, 2],
  "5": [31, 16, 30, 1, 1, 17, 14],
  "6": [6, 8, 16, 30, 17, 17, 14],
  "7": [31, 1, 2, 4, 8, 8, 8],
  "8": [14, 17, 17, 14, 17, 17, 14],
  "9": [14, 17, 17, 15, 1, 2, 12],
  "+": [0, 4, 4, 31, 4, 4, 0],
};

/** RGBA 颜色语义，以 Electron bitmap 所需预乘 BGRA 字节输出。 */
export function renderTaskbarNumberPixels(label: string, scale: 1 | 2 = 1): Uint8Array {
  const size = 16 * scale;
  if (!/^(?:[1-9]|9\+)$/.test(label)) return new Uint8Array(size * size * 4);
  // 红点只能表达“有未读”，不能表达数量；扩大红底容纳真实白字，16/32 分别生成。
  const pixels = renderAntialiasedStatusDotPixels({
    size,
    centerX: size / 2,
    centerY: size / 2,
    radius: 7.5 * scale,
  });
  const width = (label.length * 6 - 1) * scale;
  const originX = Math.floor((size - width) / 2);
  const originY = Math.floor((size - 7 * scale) / 2);
  for (let index = 0; index < label.length; index++) {
    const glyph = FONT[label[index]!]!;
    for (let y = 0; y < 7 * scale; y++) {
      for (let x = 0; x < 5 * scale; x++) {
        if (((glyph[Math.floor(y / scale)]! >> (4 - Math.floor(x / scale))) & 1) === 0) continue;
        const offset = ((originY + y) * size + originX + index * 6 * scale + x) * 4;
        // 字形位于不透明圆内部；白字同样满足预乘 alpha，不产生透明像素白边。
        pixels.fill(255, offset, offset + 4);
      }
    }
  }
  return pixels;
}
