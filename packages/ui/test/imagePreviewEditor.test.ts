import { describe, expect, it, vi } from "vitest";
import {
  clampOffset,
  redoHistory,
  undoHistory,
  updateHistory,
  zoomAtPoint,
  type Annotation,
  type History,
} from "@/image-preview-editor/geometry.js";
import { copyPreviewImage } from "@/lib/copyPreviewImage.js";
import {
  clampImagePreviewOffset,
  downloadImagePreview,
  readBoundedImageBlob,
} from "@/lib/imagePreviewDownload.js";

const image = { width: 400, height: 200 };
const viewport = { width: 200, height: 100 };

describe("image preview geometry", () => {
  it("缩放后平移保持有界；适配尺寸时居中", () => {
    expect(clampOffset({ x: 999, y: -999 }, 1, { width: 100, height: 50 }, viewport)).toEqual({
      x: 0,
      y: 0,
    });
    expect(clampOffset({ x: 999, y: -999 }, 2, image, viewport)).toEqual({
      x: 300,
      y: -150,
    });
    // 与旧 dialog 导出保持同一边界语义（A3/预览复用）。
    expect(clampImagePreviewOffset({ x: 999, y: -999 }, 2, image, viewport)).toEqual(
      clampOffset({ x: 999, y: -999 }, 2, image, viewport),
    );
  });

  it("zoomAtPoint 让锚点下的像素保持不动", () => {
    const start = { scale: 1, offset: { x: 0, y: 0 } };
    const anchor = { x: 50, y: 25 };
    const next = zoomAtPoint(start, 2, anchor);
    expect(next.scale).toBe(2);
    expect(next.offset.x).toBe(anchor.x - (anchor.x - start.offset.x) * 2);
    expect(next.offset.y).toBe(anchor.y - (anchor.y - start.offset.y) * 2);
  });

  it("标注历史 undo/redo 不丢步骤", () => {
    const a: Annotation = {
      id: "a",
      tool: "pen",
      points: [{ x: 0, y: 0 }],
      color: "#f00",
      width: 2,
    };
    const b: Annotation = { ...a, id: "b" };
    let history: History<Annotation> = { past: [], present: [], future: [] };
    history = updateHistory(history, [a]);
    history = updateHistory(history, [a, b]);
    expect(history.present).toHaveLength(2);
    history = undoHistory(history);
    expect(history.present).toHaveLength(1);
    expect(history.future).toHaveLength(1);
    history = redoHistory(history);
    expect(history.present).toHaveLength(2);
    // 新步骤清空 redo 分支。
    history = updateHistory(undoHistory(history), [b]);
    expect(history.future).toEqual([]);
  });
});

describe("image preview download", () => {
  it("按 MIME 推导扩展名，原始字节经 saveFile 保存", async () => {
    const saveFile = vi.fn(async () => ({ success: true, path: "/tmp/copied.png" }));
    const result = await downloadImagePreview(
      { alt: "shot", src: "https://cdn.example.com/a.webp?token=1", mediaType: "image/webp" },
      saveFile,
    );
    expect(result).toEqual({ kind: "saved", path: "/tmp/copied.png" });
    // 文件名优先取展示名（filename/alt），扩展名按已知 MIME 校正，避免把 webp 存成 png。
    expect(saveFile).toHaveBeenCalledWith({
      sourceUrl: "https://cdn.example.com/a.webp?token=1",
      suggestedName: "shot.webp",
    });
  });

  it("取消不是错误，也不返回路径", async () => {
    const result = await downloadImagePreview(
      { alt: "shot", src: "https://cdn.example.com/a.png" },
      vi.fn(async () => ({ success: false, canceled: true })),
    );
    expect(result).toEqual({ kind: "canceled" });
  });

  it("未知 MIME 保留可信后缀，不统一改名 PNG", async () => {
    const saveFile = vi.fn(async () => ({ success: true }));
    await downloadImagePreview(
      { alt: "shot", src: "https://cdn.example.com/a.avif?x=1", mediaType: "image/avif" },
      saveFile,
    );
    expect(saveFile).toHaveBeenCalledWith({
      sourceUrl: "https://cdn.example.com/a.avif?x=1",
      suggestedName: "shot.avif",
    });
  });

  it("无 src 的预览项明确失败", async () => {
    await expect(downloadImagePreview({ alt: "missing" })).rejects.toThrow("download_failed");
  });

  it("离线图片字节读取保留上限错误码", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    try {
      await expect(readBoundedImageBlob("https://cdn.example.com/a.png")).rejects.toThrow();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("image preview clipboard", () => {
  it("没有剪贴板能力时显式拒绝，不静默成功", async () => {
    await expect(copyPreviewImage({} as HTMLImageElement)).rejects.toThrow();
  });
});
