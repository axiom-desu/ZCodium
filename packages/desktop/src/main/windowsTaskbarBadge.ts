import { nativeImage } from "electron";
import type { NativeImage } from "electron";
import { renderTaskbarNumberPixels } from "./taskbarNumberPixels.js";

/** 任务栏数量必须可见：两档原始像素各自绘制，不依赖字体或 Shell 缩放猜测。 */
export function createTaskbarNumberImage(label: string): NativeImage {
  const image = nativeImage.createEmpty();
  for (const scale of [1, 2] as const) {
    image.addRepresentation({
      scaleFactor: scale,
      width: 16 * scale,
      height: 16 * scale,
      buffer: Buffer.from(renderTaskbarNumberPixels(label, scale)),
    });
  }
  return image;
}
