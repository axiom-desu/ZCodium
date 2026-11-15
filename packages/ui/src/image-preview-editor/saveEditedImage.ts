import { toast } from "@/components/ui/toast.js";
import { logger } from "@/logger.js";
import { captureImageComposerTarget } from "@/image-preview-editor/composerTarget.js";
import { exportAnnotatedImage } from "@/image-preview-editor/annotations.js";

/**
 * 异步导出后只向“导出前同步捕获”的 Composer 追加一次；失败保留可编辑历史并提示。
 * 不发送消息、不覆盖原图；接收方在切会话/关闭弹层后自然失效。
 */
export async function saveImagePreviewToComposer(input: {
  image: HTMLImageElement;
  overlay: SVGSVGElement;
  filename: string;
  isAlive(): boolean;
  onSavingChange(saving: boolean): void;
  onSaved(): void;
  noComposerMessage(): string;
  addedMessage(): string;
  failedMessage(): string;
}): Promise<void> {
  const target = captureImageComposerTarget();
  if (!target) {
    toast(input.noComposerMessage());
    return;
  }
  input.onSavingChange(true);
  try {
    const file = await exportAnnotatedImage(input.image, input.overlay, input.filename);
    if (!input.isAlive()) return;
    if (!target.append(file)) throw new Error("Composer rejected the image");
    toast(input.addedMessage());
    input.onSaved();
  } catch (error) {
    if (!input.isAlive()) return;
    logger.warn("[ImagePreviewDialog] 标注图片保存失败", {
      error: error instanceof Error ? error.message : String(error),
    });
    toast(input.failedMessage());
  } finally {
    if (input.isAlive()) input.onSavingChange(false);
  }
}
